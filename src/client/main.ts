import { styleText } from 'node:util';

import { input, select } from '@inquirer/prompts';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { runTool } from './flow.js';
import { TerminalUi } from './terminalUi.js';

const mcpUrl = process.env.MCP_URL ?? 'http://localhost:3000/mcp';

const client = new Client(
    { name: 'elicitation-demo-client', title: 'Elicitation demo client', version: '0.1.0' },
    {
        // Declaring both modes is what allows the server to send them.
        capabilities: { elicitation: { form: {}, url: {} } },
        versionNegotiation: { mode: { pin: '2026-07-28' } },
        // We run the input_required rounds ourselves so each one is visible.
        inputRequired: { autoFulfill: false }
    }
);

const ui = new TerminalUi();
ui.showWire = process.env.SHOW_PROTOCOL === '1';

await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
const server = client.getServerVersion();
console.log(styleText('bold', `Connected to ${server?.title ?? server?.name} at ${mcpUrl}`));
console.log(styleText('dim', 'Protocol 2026-07-28 · elicitation: form + url\n'));

let lastQuoteId: string | undefined;

try {
    for (;;) {
        const action = await select({
            message: 'What next?',
            choices: [
                { name: 'Plan a trip (form mode)', value: 'plan' },
                { name: `Check out${lastQuoteId ? ` quote ${lastQuoteId}` : ''} (URL mode)`, value: 'checkout' },
                { name: `${ui.showWire ? 'Hide' : 'Show'} protocol messages`, value: 'wire' },
                { name: 'Quit', value: 'quit' }
            ]
        });
        if (action === 'quit') break;
        if (action === 'wire') {
            ui.showWire = !ui.showWire;
            continue;
        }

        let outcome;
        if (action === 'plan') {
            const destination = await input({ message: 'Where to?', default: 'Lisbon' });
            outcome = await runTool(client, ui, 'plan_trip', { destination });
            const quote = outcome.structuredContent as { id?: string } | undefined;
            if (quote?.id) lastQuoteId = quote.id;
        } else {
            const quoteId = lastQuoteId ?? (await input({ message: 'Quote id', required: true }));
            outcome = await runTool(client, ui, 'checkout', { quoteId });
        }

        const color = outcome.isError ? 'red' : outcome.status === 'complete' ? 'green' : 'yellow';
        console.log('\n' + styleText(color, outcome.text) + '\n');
    }
} catch (err) {
    // Ctrl+C at the main menu just quits.
    if (!(err instanceof Error && err.name === 'ExitPromptError')) throw err;
} finally {
    await client.close();
}
