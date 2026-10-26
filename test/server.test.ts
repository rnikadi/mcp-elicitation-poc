import { request } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client, type ClientCapabilities, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp, type App } from '../src/server/app.js';

let app: App;
let baseUrl: string;

beforeAll(async () => {
    app = createApp({
        publicUrl: 'http://localhost:3000',
        allowedHosts: ['127.0.0.1', 'localhost'],
        stateSecret: 'test-secret-test-secret-test-secret-123',
        settleWaitMs: 300
    });
    await new Promise<void>(resolve => app.httpServer.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(app.httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await app.close();
});

async function connect(elicitation: ClientCapabilities['elicitation'] = { form: {}, url: {} }) {
    const client = new Client(
        { name: 'test-client', version: '0.0.0' },
        {
            capabilities: { elicitation },
            versionNegotiation: { mode: { pin: '2026-07-28' } },
            inputRequired: { autoFulfill: false }
        }
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    return client;
}

type Round = {
    resultType?: string;
    inputRequests?: Record<string, { method: string; params: Record<string, any> }>;
    requestState?: string;
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: any;
    isError?: boolean;
};

async function call(client: Client, name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return (await client.callTool({ name, arguments: args, ...extra }, { allowInputRequired: true })) as Round;
}

const text = (r: Round) => r.content?.map(c => c.text).join('\n') ?? '';

const goodDetails = {
    departureDate: '2026-12-01',
    nights: 3,
    travelers: 2,
    cabin: 'premium',
    extras: ['breakfast', 'airport-transfer'],
    contactEmail: 'ada@example.com'
};

async function makeQuote(client: Client): Promise<string> {
    const r = await call(
        client,
        'plan_trip',
        { destination: 'Lisbon' },
        { inputResponses: { trip_details: { action: 'accept', content: goodDetails } } }
    );
    return r.structuredContent.id;
}

describe('plan_trip (form mode)', () => {
    it('asks for trip details with a form elicitation first', async () => {
        const client = await connect();
        const r = await call(client, 'plan_trip', { destination: 'Lisbon' });
        expect(r.resultType).toBe('input_required');
        const req = r.inputRequests!.trip_details!;
        expect(req.method).toBe('elicitation/create');
        expect(req.params.mode).toBe('form');
        expect(req.params.requestedSchema.required).toContain('departureDate');
        await client.close();
    });

    it('returns a priced quote on accept', async () => {
        const client = await connect();
        const r = await call(
            client,
            'plan_trip',
            { destination: 'Lisbon' },
            { inputResponses: { trip_details: { action: 'accept', content: goodDetails } } }
        );
        expect(r.resultType ?? 'complete').toBe('complete');
        // premium 180 * 3 nights * 2 travelers + breakfast 15 * 3 * 2 + transfer 40
        expect(r.structuredContent.totalEur).toBe(1210);
        expect(text(r)).toContain('Quote Q-');
        await client.close();
    });

    it('handles decline and cancel differently', async () => {
        const client = await connect();
        const declined = await call(
            client,
            'plan_trip',
            { destination: 'Lisbon' },
            { inputResponses: { trip_details: { action: 'decline' } } }
        );
        expect(text(declined)).toMatch(/declined/);
        const cancelled = await call(
            client,
            'plan_trip',
            { destination: 'Lisbon' },
            { inputResponses: { trip_details: { action: 'cancel' } } }
        );
        expect(text(cancelled)).toMatch(/dismissed/);
        await client.close();
    });

    it('re-asks when accepted content fails validation', async () => {
        const client = await connect();
        const r = await call(
            client,
            'plan_trip',
            { destination: 'Lisbon' },
            { inputResponses: { trip_details: { action: 'accept', content: { ...goodDetails, nights: 99 } } } }
        );
        expect(r.resultType).toBe('input_required');
        expect(r.inputRequests!.trip_details!.params.message).toMatch(/invalid/);
        await client.close();
    });
});

describe('checkout (URL mode)', () => {
    it('sends a URL elicitation with signed requestState', async () => {
        const client = await connect();
        const quoteId = await makeQuote(client);
        const r = await call(client, 'checkout', { quoteId });
        expect(r.resultType).toBe('input_required');
        const req = r.inputRequests!.payment!;
        expect(req.params.mode).toBe('url');
        expect(req.params.url).toMatch(/^http:\/\/localhost:3000\/pay\/[0-9a-f-]{36}$/);
        expect(r.requestState).toMatch(/^v1\./);
        await client.close();
    });

    it('completes after the user pays on the page', async () => {
        const client = await connect();
        const quoteId = await makeQuote(client);
        const first = await call(client, 'checkout', { quoteId });
        const payPath = new URL(first.inputRequests!.payment!.params.url).pathname;

        // The payment page renders and the user submits it (out of band).
        const page = await fetch(`${baseUrl}${payPath}`);
        expect(await page.text()).toContain('Pay €1210');
        const retry = call(
            client,
            'checkout',
            { quoteId },
            { inputResponses: { payment: { action: 'accept' } }, requestState: first.requestState }
        );
        await fetch(`${baseUrl}${payPath}/confirm`, { method: 'POST' });
        const done = await retry;
        expect(text(done)).toMatch(/Booked!/);
        expect(done.structuredContent.confirmationCode).toMatch(/^TRIP-/);
        await client.close();
    });

    it('asks the client to retry while payment is still pending', async () => {
        const client = await connect();
        const quoteId = await makeQuote(client);
        const first = await call(client, 'checkout', { quoteId });
        const pending = await call(
            client,
            'checkout',
            { quoteId },
            { inputResponses: { payment: { action: 'accept' } }, requestState: first.requestState }
        );
        expect(pending.resultType).toBe('input_required');
        expect(Object.keys(pending.inputRequests ?? {})).toHaveLength(0);
        expect(pending.requestState).toBeTruthy();
        await client.close();
    });

    it('reports a cancel on the payment page', async () => {
        const client = await connect();
        const quoteId = await makeQuote(client);
        const first = await call(client, 'checkout', { quoteId });
        await fetch(`${first.inputRequests!.payment!.params.url.replace('http://localhost:3000', baseUrl)}/cancel`, {
            method: 'POST'
        });
        const r = await call(
            client,
            'checkout',
            { quoteId },
            { inputResponses: { payment: { action: 'accept' } }, requestState: first.requestState }
        );
        expect(text(r)).toMatch(/cancelled on the payment page/);
        await client.close();
    });

    it('handles decline and cancel of the URL prompt', async () => {
        const client = await connect();
        const quoteId = await makeQuote(client);
        for (const [action, pattern] of [
            ['decline', /declined/],
            ['cancel', /dismissed/]
        ] as const) {
            const first = await call(client, 'checkout', { quoteId });
            const r = await call(
                client,
                'checkout',
                { quoteId },
                { inputResponses: { payment: { action } }, requestState: first.requestState }
            );
            expect(text(r)).toMatch(pattern);
        }
        await client.close();
    });

    it('rejects tampered requestState', async () => {
        const client = await connect();
        const quoteId = await makeQuote(client);
        const first = await call(client, 'checkout', { quoteId });
        const tampered = first.requestState!.replace(/.$/, c => (c === 'A' ? 'B' : 'A'));
        await expect(
            call(client, 'checkout', { quoteId }, { inputResponses: { payment: { action: 'accept' } }, requestState: tampered })
        ).rejects.toThrow();
        await client.close();
    });

    it('does not send URL elicitations to a form-only client', async () => {
        const client = await connect({});
        const quoteId = await makeQuote(client);
        const r = await call(client, 'checkout', { quoteId });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/cannot open payment pages/);
        await client.close();
    });
});

describe('http surface', () => {
    it('rejects an unexpected Host header on /mcp', async () => {
        // fetch() won't let us spoof Host, so use node:http directly.
        const status = await new Promise<number | undefined>((resolve, reject) => {
            const req = request(`${baseUrl}/mcp`, { method: 'POST', headers: { host: 'evil.example' } }, res => {
                res.resume();
                resolve(res.statusCode);
            });
            req.on('error', reject);
            req.end('{}');
        });
        expect(status).toBe(403);
    });

    it('404s unknown payment links', async () => {
        const res = await fetch(`${baseUrl}/pay/00000000-0000-0000-0000-000000000000`);
        expect(res.status).toBe(404);
    });
});
