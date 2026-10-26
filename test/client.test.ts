import type { AddressInfo } from 'node:net';

import { Client, StreamableHTTPClientTransport, type ElicitResult } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runTool, type Ui } from '../src/client/flow.js';
import { checkMulti, checkText, fieldsFromSchema } from '../src/client/schema.js';
import { reviewUrl } from '../src/client/url.js';
import { createApp, type App } from '../src/server/app.js';
import { tripDetailsSchema } from '../src/server/tools/planTrip.js';

describe('schema helpers', () => {
    const fields = fieldsFromSchema(tripDetailsSchema as never);
    const byKey = Object.fromEntries(fields.map(f => [f.key, f]));

    it('maps each property to a prompt kind', () => {
        expect(fields.map(f => [f.key, f.kind])).toEqual([
            ['departureDate', 'text'],
            ['nights', 'number'],
            ['travelers', 'number'],
            ['cabin', 'select'],
            ['extras', 'multi'],
            ['contactEmail', 'text']
        ]);
        expect(byKey.cabin).toMatchObject({ default: 'economy', options: [{ value: 'economy', title: 'Economy' }, {}, {}] });
        expect(byKey.nights).toMatchObject({ integer: true, min: 1, max: 14, default: 3, required: true });
        expect(byKey.extras).toMatchObject({ required: false });
    });

    it('validates formats', () => {
        const date = byKey.departureDate as Parameters<typeof checkText>[0];
        const email = byKey.contactEmail as Parameters<typeof checkText>[0];
        expect(checkText(date, '2026-12-01')).toBeUndefined();
        expect(checkText(date, '12/01/2026')).toMatch(/YYYY-MM-DD/);
        expect(checkText(email, 'ada@example.com')).toBeUndefined();
        expect(checkText(email, 'nope')).toBeDefined();
        expect(checkText(email, '')).toBe('Required');
        expect(checkMulti({ kind: 'multi', key: 'k', label: 'k', required: false, options: [], maxItems: 1 }, ['a', 'b'])).toBeDefined();
    });
});

describe('reviewUrl', () => {
    it('shows the host and flags risky links', () => {
        expect(reviewUrl('http://localhost:3000/pay/x')).toMatchObject({ host: 'localhost:3000', warnings: [] });
        expect(reviewUrl('http://pay.example.com/x').warnings.join()).toMatch(/Not HTTPS/);
        expect(reviewUrl('https://xn--pypal-4ve.com/').warnings.join()).toMatch(/Punycode/);
        expect(reviewUrl('javascript:alert(1)').warnings.join()).toMatch(/scheme/);
        expect(reviewUrl('not a url').warnings.join()).toMatch(/not a valid URL/);
    });
});

// End to end: the real client flow against the real server, with a scripted UI.

let app: App;
let baseUrl: string;

beforeAll(async () => {
    app = createApp({
        publicUrl: 'http://localhost:3000',
        allowedHosts: ['127.0.0.1'],
        stateSecret: 'client-test-secret-client-test-secret',
        settleWaitMs: 200
    });
    await new Promise<void>(resolve => app.httpServer.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(app.httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await app.close();
});

class ScriptedUi implements Ui {
    seen: string[] = [];
    constructor(
        private readonly answers: {
            form?: ElicitResult;
            url?: ElicitResult;
            onUrl?: (url: string) => Promise<void> | void;
            retry?: boolean[];
        }
    ) {}
    async form(server: string, params: { message: string }) {
        this.seen.push(`form:${server}:${params.message}`);
        return this.answers.form ?? { action: 'cancel' as const };
    }
    async url(server: string, params: { url: string }) {
        this.seen.push(`url:${server}`);
        await this.answers.onUrl?.(params.url);
        return this.answers.url ?? { action: 'cancel' as const };
    }
    async retryPending() {
        this.seen.push('retry');
        return this.answers.retry?.shift() ?? false;
    }
    waiting() {}
    wire() {}
}

async function connect() {
    const client = new Client(
        { name: 'flow-test', version: '0.0.0' },
        {
            capabilities: { elicitation: { form: {}, url: {} } },
            versionNegotiation: { mode: { pin: '2026-07-28' } },
            inputRequired: { autoFulfill: false }
        }
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    return client;
}

const details = {
    departureDate: '2026-12-01',
    nights: 2,
    travelers: 1,
    cabin: 'economy',
    extras: [],
    contactEmail: 'ada@example.com'
};

const localUrl = (u: string) => u.replace('http://localhost:3000', baseUrl);

async function quote(client: Client): Promise<string> {
    const r = await runTool(client, new ScriptedUi({ form: { action: 'accept', content: details } }), 'plan_trip', { destination: 'Oslo' });
    return (r.structuredContent as { id: string }).id;
}

describe('runTool (form mode)', () => {
    it.each([
        ['accept', { action: 'accept', content: details }, /Quote Q-.*\n.*\nTotal: €240/],
        ['decline', { action: 'decline' }, /declined/],
        ['cancel', { action: 'cancel' }, /dismissed/]
    ] as const)('%s', async (_, answer, expected) => {
        const client = await connect();
        const ui = new ScriptedUi({ form: answer as ElicitResult });
        const r = await runTool(client, ui, 'plan_trip', { destination: 'Oslo' });
        expect(r.status).toBe('complete');
        expect(r.text).toMatch(expected);
        expect(ui.seen[0]).toMatch(/^form:Trip Planner \(elicitation demo\):Tell me about your trip to Oslo/);
        await client.close();
    });
});

describe('runTool (URL mode)', () => {
    it('accept, then pay in the browser', async () => {
        const client = await connect();
        const quoteId = await quote(client);
        const ui = new ScriptedUi({
            url: { action: 'accept' },
            // Simulate the user paying shortly after opening the link.
            onUrl: url => void setTimeout(() => fetch(`${localUrl(url)}/confirm`, { method: 'POST' }), 50)
        });
        const r = await runTool(client, ui, 'checkout', { quoteId });
        expect(r.text).toMatch(/Booked!/);
        await client.close();
    });

    it('accept, still pending, check again, then pay', async () => {
        const client = await connect();
        const quoteId = await quote(client);
        let payUrl = '';
        const ui = new ScriptedUi({ url: { action: 'accept' }, onUrl: url => void (payUrl = url), retry: [true] });
        const origRetry = ui.retryPending.bind(ui);
        ui.retryPending = async () => {
            await fetch(`${localUrl(payUrl)}/confirm`, { method: 'POST' });
            return origRetry();
        };
        const r = await runTool(client, ui, 'checkout', { quoteId });
        expect(ui.seen).toContain('retry');
        expect(r.text).toMatch(/Booked!/);
        await client.close();
    });

    it('accept, then give up waiting', async () => {
        const client = await connect();
        const quoteId = await quote(client);
        const r = await runTool(client, new ScriptedUi({ url: { action: 'accept' }, retry: [false] }), 'checkout', { quoteId });
        expect(r.status).toBe('stopped');
        await client.close();
    });

    it.each([
        ['decline', /declined/],
        ['cancel', /dismissed/]
    ] as const)('%s', async (action, expected) => {
        const client = await connect();
        const quoteId = await quote(client);
        const r = await runTool(client, new ScriptedUi({ url: { action } }), 'checkout', { quoteId });
        expect(r.text).toMatch(expected);
        await client.close();
    });
});
