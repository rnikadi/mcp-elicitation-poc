// End-to-end smoke test against a running server (used by CI after
// `docker compose up`). Plays the client and the browser: fills the form,
// consents to the payment URL, pays on the page, and checks the booking.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const mcpUrl = process.env.MCP_URL ?? 'http://localhost:3000/mcp';

type Round = {
    resultType?: string;
    inputRequests?: Record<string, { params: Record<string, any> }>;
    requestState?: string;
    content?: Array<{ text?: string }>;
    structuredContent?: any;
};

function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(`smoke: ${msg}`);
}

const client = new Client(
    { name: 'smoke', version: '0.0.0' },
    {
        capabilities: { elicitation: { form: {}, url: {} } },
        versionNegotiation: { mode: { pin: '2026-07-28' } },
        inputRequired: { autoFulfill: false }
    }
);
await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
const call = async (name: string, args: object, extra: object = {}) =>
    (await client.callTool({ name, arguments: args as Record<string, unknown>, ...extra }, { allowInputRequired: true })) as Round;

const tools = await client.listTools();
assert(tools.tools.map(t => t.name).sort().join() === 'checkout,plan_trip', 'unexpected tool list');

const ask = await call('plan_trip', { destination: 'Kyoto' });
assert(ask.inputRequests?.trip_details?.params.mode === 'form', 'expected a form elicitation');

const quote = await call(
    'plan_trip',
    { destination: 'Kyoto' },
    {
        inputResponses: {
            trip_details: {
                action: 'accept',
                content: { departureDate: '2027-04-01', nights: 4, travelers: 1, cabin: 'economy', contactEmail: 'smoke@example.com' }
            }
        }
    }
);
const quoteId = quote.structuredContent?.id;
assert(quoteId, 'expected a quote');
console.log(`quote ${quoteId}: €${quote.structuredContent.totalEur}`);

const pay = await call('checkout', { quoteId });
const url = pay.inputRequests?.payment?.params.url as string;
assert(pay.inputRequests?.payment?.params.mode === 'url' && url, 'expected a URL elicitation');
console.log(`payment url ${url}`);

const page = await fetch(url);
assert(page.ok && (await page.text()).includes('Pay €'), 'payment page did not render');

const booking = call('checkout', { quoteId }, { inputResponses: { payment: { action: 'accept' } }, requestState: pay.requestState });
const confirm = await fetch(`${url}/confirm`, { method: 'POST' });
assert(confirm.ok, 'payment confirm failed');
const done = await booking;
assert(/^TRIP-/.test(done.structuredContent?.confirmationCode ?? ''), `expected a booking, got ${JSON.stringify(done)}`);
console.log(done.content?.[0]?.text);

await client.close();
console.log('smoke: ok');
