// End-to-end smoke test of the web app as Docker Compose runs it: talks to
// the frontend (nginx) on :8080, which proxies /api to the web backend, which
// is the MCP client of the server. Plays the browser, including the payment page.
import { WebRun } from './webApi.js';

const webUrl = (process.env.WEB_URL ?? 'http://localhost:8080').replace(/\/$/, '');

function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(`smoke-web: ${msg}`);
}

const page = await fetch(webUrl);
assert(page.ok && (await page.text()).includes('Trip Planner'), 'frontend did not load');

const info = (await (await fetch(`${webUrl}/api/info`)).json()) as { connected: boolean };
assert(info.connected, 'web backend is not connected to the MCP server');

const plan = await WebRun.start(webUrl, 'plan_trip', { destination: 'Kyoto' });
const form = await plan.next('prompt');
assert(form.kind === 'form', 'expected a form prompt');
await plan.answer(form.promptId, {
    action: 'accept',
    content: { departureDate: '2027-04-01', nights: 4, travelers: 1, cabin: 'economy', extras: [], contactEmail: 'smoke@example.com' }
});
const quoted = await plan.next('done');
const quoteId = (quoted.outcome.structuredContent as { id?: string } | undefined)?.id;
assert(quoteId, `expected a quote, got ${quoted.outcome.text}`);
console.log(`quote ${quoteId}`);

const checkout = await WebRun.start(webUrl, 'checkout', { quoteId });
const link = await checkout.next('prompt');
assert(link.kind === 'url', 'expected a URL prompt');
console.log(`payment url ${link.params.url}`);
await checkout.answer(link.promptId, { action: 'accept' });
const paid = await fetch(`${link.params.url}/confirm`, { method: 'POST' });
assert(paid.ok, 'payment confirm failed');
const booked = await checkout.next('done', 30_000);
const code = (booked.outcome.structuredContent as { confirmationCode?: string } | undefined)?.confirmationCode;
assert(/^TRIP-/.test(code ?? ''), `expected a booking, got ${booked.outcome.text}`);
console.log(booked.outcome.text);

plan.disconnect();
checkout.disconnect();
console.log('smoke-web: ok');
