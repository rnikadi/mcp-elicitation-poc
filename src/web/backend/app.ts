import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import type { ServerInfo, ToolName } from '../shared.js';
import { Runs } from './runs.js';

// The web app's backend. It is the MCP client: it holds the connection to the
// trip planner server, runs the tool calls and the input_required rounds, and
// relays each elicitation to the browser over Server-Sent Events.
//
//   POST /api/runs                        { tool, arguments }   → { runId }
//   GET  /api/runs/:runId/events          SSE stream of RunEvent
//   POST /api/runs/:runId/prompts/:id     the user's answer to one prompt
//   GET  /api/info                        which server we're connected to

export const PROTOCOL_VERSION = '2026-07-28';
const TOOLS: ToolName[] = ['plan_trip', 'checkout'];
const MAX_BODY = 64 * 1024;

export function createMcpClient(): Client {
    return new Client(
        { name: 'elicitation-demo-web', title: 'Elicitation demo web app', version: '0.1.0' },
        {
            // Declaring both modes is what allows the server to send them.
            capabilities: { elicitation: { form: {}, url: {} } },
            versionNegotiation: { mode: { pin: PROTOCOL_VERSION } },
            // We run the input_required rounds ourselves so the browser sees each one.
            inputRequired: { autoFulfill: false }
        }
    );
}

export interface WebApp {
    httpServer: Server;
    runs: Runs;
    /** Connects to the MCP server, retrying until it is up. */
    connect(): Promise<void>;
    close(): Promise<void>;
}

export function createWebApp(opts: { mcpUrl: string; retryMs?: number; disconnectGraceMs?: number }): WebApp {
    const client = createMcpClient();
    const runs = new Runs(opts.disconnectGraceMs);
    const info: ServerInfo = { connected: false, mcpUrl: opts.mcpUrl, protocolVersion: PROTOCOL_VERSION, tools: [] };
    const streams = new Set<ServerResponse>();

    async function connect(): Promise<void> {
        for (;;) {
            try {
                await client.connect(new StreamableHTTPClientTransport(new URL(opts.mcpUrl)));
                break;
            } catch (err) {
                console.warn(`MCP server not reachable at ${opts.mcpUrl} (${(err as Error).message}), retrying`);
                await new Promise(r => setTimeout(r, opts.retryMs ?? 2_000));
            }
        }
        const { tools } = await client.listTools();
        info.tools = tools.map(t => ({ name: t.name, title: t.title, description: t.description }));
        info.server = client.getServerVersion();
        info.connected = true;
    }

    const httpServer = createServer((req, res) => {
        route(req, res).catch(err => {
            console.error(err);
            if (!res.headersSent) json(res, 500, { error: 'Internal error' });
        });
    });

    async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;

        if (path === '/healthz') return json(res, info.connected ? 200 : 503, { ok: info.connected });
        if (path === '/api/info' && req.method === 'GET') return json(res, 200, info);

        if (path === '/api/runs' && req.method === 'POST') {
            if (!info.connected) return json(res, 503, { error: 'Not connected to the MCP server yet' });
            const body = await readJson(req);
            if (!body.ok) return json(res, 400, { error: body.error });
            const { tool, arguments: args } = body.value as { tool?: unknown; arguments?: unknown };
            if (!TOOLS.includes(tool as ToolName)) return json(res, 400, { error: `tool must be one of ${TOOLS.join(', ')}` });
            if (typeof args !== 'object' || args === null || Array.isArray(args)) {
                return json(res, 400, { error: 'arguments must be an object' });
            }
            const run = runs.create();
            run.start(client, tool as ToolName, args as Record<string, unknown>);
            return json(res, 201, { runId: run.id });
        }

        let m = /^\/api\/runs\/([0-9a-f-]{36})\/events$/.exec(path);
        if (m && req.method === 'GET') {
            const run = runs.get(m[1]!);
            if (!run) return json(res, 404, { error: 'Unknown run' });
            res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-store',
                connection: 'keep-alive',
                // Tell nginx (the frontend container) not to buffer the stream.
                'x-accel-buffering': 'no'
            });
            streams.add(res);
            const lastId = Number(req.headers['last-event-id'] ?? -1);
            const unsubscribe = run.subscribe((event, index) => {
                res.write(`id: ${index}\ndata: ${JSON.stringify(event)}\n\n`);
            }, Number.isFinite(lastId) ? lastId : -1);
            const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
            res.on('close', () => {
                clearInterval(ping);
                unsubscribe();
                streams.delete(res);
            });
            return;
        }

        m = /^\/api\/runs\/([0-9a-f-]{36})\/prompts\/([0-9a-f-]{36})$/.exec(path);
        if (m && req.method === 'POST') {
            const run = runs.get(m[1]!);
            if (!run) return json(res, 404, { error: 'Unknown run' });
            const body = await readJson(req);
            if (!body.ok) return json(res, 400, { error: body.error });
            const problem = run.answer(m[2]!, body.value);
            return problem ? json(res, 409, { error: problem }) : json(res, 200, { ok: true });
        }

        json(res, 404, { error: 'Not found' });
    }

    return {
        httpServer,
        runs,
        connect,
        async close() {
            for (const s of streams) s.end();
            await client.close();
            await new Promise<void>(resolve => {
                httpServer.close(() => resolve());
                httpServer.closeAllConnections();
            });
        }
    };
}

function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    // Requiring JSON also keeps plain cross-site form posts out.
    if (!req.headers['content-type']?.startsWith('application/json')) return { ok: false, error: 'Expected application/json' };
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) return { ok: false, error: 'Body too large' };
        chunks.push(chunk as Buffer);
    }
    try {
        return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    } catch {
        return { ok: false, error: 'Invalid JSON' };
    }
}
