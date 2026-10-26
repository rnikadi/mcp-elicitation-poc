import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { hostHeaderValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, createRequestStateCodec, McpServer } from '@modelcontextprotocol/server';

import { renderDone, renderNotFound, renderPaymentPage } from './paymentPage.js';
import { Store } from './store.js';
import { registerCheckout, type CheckoutState } from './tools/checkout.js';
import { registerPlanTrip } from './tools/planTrip.js';

export interface AppOptions {
    /** Base URL the user's browser uses to reach the payment page. */
    publicUrl: string;
    /** Host header values accepted on /mcp (DNS-rebinding protection). */
    allowedHosts: string[];
    /** HMAC key for requestState, at least 32 bytes. */
    stateSecret: string | Uint8Array;
    /** How long one checkout retry waits for the payment page. */
    settleWaitMs?: number;
}

export interface App {
    httpServer: Server;
    store: Store;
    close(): Promise<void>;
}

export function createApp(opts: AppOptions): App {
    const store = new Store();
    const stateCodec = createRequestStateCodec<CheckoutState>({
        key: opts.stateSecret,
        ttlSeconds: 15 * 60,
        // Bind state to the tool it was minted for, so it can't be replayed elsewhere.
        // With MCP authorization you would also bind the user (e.g. authInfo.clientId / sub).
        bind: ctx => `${ctx.mcpReq.method}`
    });

    // createMcpHandler builds a fresh McpServer per HTTP request (stateless
    // serving); shared state lives in the store. Only 2026-07-28 clients are
    // served, since older protocol versions use a different elicitation flow.
    const handler = createMcpHandler(() => {
        const server = new McpServer(
            { name: 'trip-planner', title: 'Trip Planner (elicitation demo)', version: '0.1.0' },
            { requestState: { verify: stateCodec.verify } }
        );
        registerPlanTrip(server, store);
        registerCheckout(server, store, {
            publicUrl: opts.publicUrl,
            settleWaitMs: opts.settleWaitMs ?? 60_000,
            stateCodec
        });
        return server;
    }, { legacy: 'reject' });
    const mcp = toNodeHandler(handler);
    const validHost = hostHeaderValidation(opts.allowedHosts);

    const httpServer = createServer((req, res) => {
        route(req, res).catch(err => {
            console.error(err);
            if (!res.headersSent) send(res, 500, 'text/plain', 'Internal error');
        });
    });

    async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://localhost');

        if (url.pathname === '/mcp') {
            if (!validHost(req, res)) return;
            return mcp(req, res);
        }
        if (url.pathname === '/healthz') {
            return send(res, 200, 'text/plain', 'ok');
        }

        const match = /^\/pay\/([0-9a-f-]{36})(?:\/(confirm|cancel))?$/.exec(url.pathname);
        if (match) {
            const [, paymentId, action] = match;
            const payment = store.getPayment(paymentId!);
            const quote = payment && store.getQuote(payment.quoteId);
            if (!payment || !quote) return send(res, 404, 'text/html', renderNotFound());

            if (!action && req.method === 'GET') {
                return send(res, 200, 'text/html', renderPaymentPage(payment, quote));
            }
            if (action && req.method === 'POST') {
                req.resume(); // the card fields are mock data; discard them
                store.settlePayment(payment.id, action === 'confirm' ? 'paid' : 'cancelled_on_page');
                return send(res, 200, 'text/html', renderDone(store.getPayment(payment.id)!));
            }
            return send(res, 405, 'text/plain', 'Method not allowed');
        }

        send(res, 404, 'text/plain', 'Not found');
    }

    return {
        httpServer,
        store,
        async close() {
            await handler.close();
            await new Promise<void>(resolve => httpServer.close(() => resolve()));
        }
    };
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
    res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
    res.end(body);
}
