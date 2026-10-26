import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WebRun } from '../scripts/webApi.js';
import { createApp, type App } from '../src/server/app.js';
import { createWebApp, type WebApp } from '../src/web/backend/app.js';

// The web backend over real HTTP: MCP server ← web backend (MCP client) ← this test as the browser.

let server: App;
let web: WebApp;
let serverUrl: string;
let webUrl: string;

const port = (s: { address(): unknown }) => (s.address() as AddressInfo).port;

beforeAll(async () => {
    server = createApp({
        publicUrl: 'http://localhost:3000',
        allowedHosts: ['127.0.0.1'],
        stateSecret: 'web-test-secret-web-test-secret-web',
        settleWaitMs: 200
    });
    await new Promise<void>(resolve => server.httpServer.listen(0, '127.0.0.1', resolve));
    serverUrl = `http://127.0.0.1:${port(server.httpServer)}`;

    web = createWebApp({ mcpUrl: `${serverUrl}/mcp`, disconnectGraceMs: 100 });
    await new Promise<void>(resolve => web.httpServer.listen(0, '127.0.0.1', resolve));
    webUrl = `http://127.0.0.1:${port(web.httpServer)}`;
    await web.connect();
});

afterAll(async () => {
    await web.close();
    await server.close();
});

const details = { departureDate: '2026-12-01', nights: 2, travelers: 1, cabin: 'economy', extras: [], contactEmail: 'ada@example.com' };
const localUrl = (u: string) => u.replace('http://localhost:3000', serverUrl);

async function quote(): Promise<string> {
    const run = await WebRun.start(webUrl, 'plan_trip', { destination: 'Oslo' });
    const p = await run.next('prompt');
    await run.answer(p.promptId, { action: 'accept', content: details });
    const done = await run.next('done');
    run.disconnect();
    return (done.outcome.structuredContent as { id: string }).id;
}

describe('web backend', () => {
    it('reports the connected server and its tools', async () => {
        const info = await (await fetch(`${webUrl}/api/info`)).json();
        expect(info).toMatchObject({ connected: true, protocolVersion: '2026-07-28', server: { name: 'trip-planner' } });
        expect(info.tools.map((t: { name: string }) => t.name).sort()).toEqual(['checkout', 'plan_trip']);
    });

    it.each([
        ['accept', { action: 'accept', content: details }, /Quote Q-.*Total: €240/s],
        ['decline', { action: 'decline' }, /declined/],
        ['cancel', { action: 'cancel' }, /dismissed/]
    ] as const)('form %s', async (_, answer, expected) => {
        const run = await WebRun.start(webUrl, 'plan_trip', { destination: 'Oslo' });
        const p = await run.next('prompt');
        expect(p).toMatchObject({ kind: 'form', server: 'Trip Planner (elicitation demo)' });
        expect(p.kind === 'form' && p.params.requestedSchema.properties).toHaveProperty('contactEmail');
        expect((await run.answer(p.promptId, answer)).status).toBe(200);
        expect(await run.next('answered')).toMatchObject({ answer: { action: answer.action }, by: 'user' });
        expect((await run.next('done')).outcome.text).toMatch(expected);
        run.disconnect();
    });

    it('URL accept: the user pays on the page and the booking comes back', async () => {
        const run = await WebRun.start(webUrl, 'checkout', { quoteId: await quote() });
        const p = await run.next('prompt');
        if (p.kind !== 'url') throw new Error('expected a URL prompt');
        expect(p.params.url).toMatch(/^http:\/\/localhost:3000\/pay\//);
        await run.answer(p.promptId, { action: 'accept' });
        await run.next('waiting');
        await fetch(`${localUrl(p.params.url)}/confirm`, { method: 'POST' });
        const done = await run.next('done');
        expect(done.outcome.structuredContent).toMatchObject({ confirmationCode: expect.stringMatching(/^TRIP-/) });
        run.disconnect();
    });

    it('URL accept, then the page is slow: the user is asked whether to keep waiting', async () => {
        const run = await WebRun.start(webUrl, 'checkout', { quoteId: await quote() });
        const p = await run.next('prompt');
        await run.answer(p.promptId, { action: 'accept' });
        const retry = await run.next('prompt');
        expect(retry.kind).toBe('retry');
        await run.answer(retry.promptId, { retry: false });
        expect((await run.next('done')).outcome).toMatchObject({ status: 'stopped' });
        run.disconnect();
    });

    it.each([
        ['decline', /Payment declined/],
        ['cancel', /Checkout dismissed/]
    ] as const)('URL %s', async (action, expected) => {
        const run = await WebRun.start(webUrl, 'checkout', { quoteId: await quote() });
        const p = await run.next('prompt');
        await run.answer(p.promptId, { action });
        expect((await run.next('done')).outcome.text).toMatch(expected);
        run.disconnect();
    });

    it('rejects answers that do not fit the prompt', async () => {
        const run = await WebRun.start(webUrl, 'checkout', { quoteId: await quote() });
        const p = await run.next('prompt');
        // URL mode never carries content: the data goes to the page, not the client.
        expect((await run.answer(p.promptId, { action: 'accept', content: { card: '4242' } })).status).toBe(409);
        expect((await run.answer(p.promptId, { action: 'maybe' })).status).toBe(409);
        expect((await run.answer(p.promptId, { action: 'decline' })).status).toBe(200);
        expect((await run.answer(p.promptId, { action: 'decline' })).status).toBe(409);
        await run.next('done');
        run.disconnect();
    });

    it('treats closing the page with a prompt open as cancel', async () => {
        const run = await WebRun.start(webUrl, 'plan_trip', { destination: 'Oslo' });
        await run.next('prompt');
        run.disconnect();
        // Past the grace period (a quick reconnect would keep the prompt open),
        // reconnect to read what happened, replaying from the start.
        await new Promise(r => setTimeout(r, 300));
        const res = await fetch(`${webUrl}/api/runs/${run.id}/events`);
        const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
        let text = '';
        while (!text.includes('"type":"done"')) {
            const { value, done } = await reader.read();
            if (done) break;
            text += value;
        }
        await reader.cancel();
        expect(text).toContain('"by":"disconnect"');
        expect(text).toMatch(/was dismissed/);
    });

    it('validates new runs', async () => {
        const post = (body: unknown, type = 'application/json') =>
            fetch(`${webUrl}/api/runs`, { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) });
        expect((await post({ tool: 'rm_rf', arguments: {} })).status).toBe(400);
        expect((await post({ tool: 'plan_trip', arguments: [] })).status).toBe(400);
        expect((await post({ tool: 'plan_trip', arguments: {} }, 'text/plain')).status).toBe(400);
    });
});
