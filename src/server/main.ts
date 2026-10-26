import { randomBytes } from 'node:crypto';

import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const publicUrl = (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, '');
const allowedHosts = (process.env.ALLOWED_HOSTS ?? 'localhost,127.0.0.1').split(',').map(h => h.trim());

// A per-process random key is fine for a single instance. Set STATE_SECRET
// (32+ bytes) when several instances must accept each other's requestState.
const stateSecret = process.env.STATE_SECRET ?? randomBytes(32);

const app = createApp({ publicUrl, allowedHosts, stateSecret });

app.httpServer.listen(port, host, () => {
    console.log(`Trip planner MCP server on http://${host}:${port}/mcp`);
    console.log(`Payment pages served at ${publicUrl}/pay/...`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        app.close().finally(() => process.exit(0));
    });
}
