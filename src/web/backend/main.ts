import { createWebApp } from './app.js';

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '127.0.0.1';
const mcpUrl = process.env.MCP_URL ?? 'http://localhost:3000/mcp';

const app = createWebApp({ mcpUrl });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        app.close().finally(() => process.exit(0));
    });
}

app.httpServer.listen(port, host, () => {
    console.log(`Web backend on http://${host}:${port}/api, MCP client for ${mcpUrl}`);
});
await app.connect();
console.log('Connected to the MCP server');
