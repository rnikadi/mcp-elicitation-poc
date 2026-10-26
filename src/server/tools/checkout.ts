import {
    CLIENT_CAPABILITIES_META_KEY,
    inputRequired,
    inputResponse,
    type McpServer,
    type RequestStateCodec,
    type ServerContext
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { Store } from '../store.js';

// URL mode: card details must never pass through the MCP client, so the
// server sends the user to its own payment page instead. The client only
// learns that the user agreed to open the URL; the server finds out whether
// they paid from its own records when the client retries the call.

export const PAYMENT_KEY = 'payment';

export interface CheckoutState {
    paymentId: string;
}

export interface CheckoutOptions {
    /** Base URL the user's browser can reach, e.g. http://localhost:3000 */
    publicUrl: string;
    /** How long one retry waits for the payment page before asking the client to retry again. */
    settleWaitMs: number;
    stateCodec: RequestStateCodec<CheckoutState>;
}

// On 2026-07-28 the client declares its capabilities on every request.
function clientSupportsUrlElicitation(ctx: ServerContext): boolean {
    const envelope = ctx.mcpReq.envelope as Record<string, { elicitation?: { url?: object } } | undefined> | undefined;
    return envelope?.[CLIENT_CAPABILITIES_META_KEY]?.elicitation?.url !== undefined;
}

function text(t: string) {
    return { content: [{ type: 'text' as const, text: t }] };
}

export function registerCheckout(server: McpServer, store: Store, opts: CheckoutOptions): void {
    server.registerTool(
        'checkout',
        {
            title: 'Check out',
            description: 'Pays for a trip quote. Sends the user to a secure payment page with a URL-mode elicitation.',
            inputSchema: z.object({ quoteId: z.string().describe('Quote id returned by plan_trip') })
        },
        async ({ quoteId }, ctx) => {
            const quote = store.getQuote(quoteId);
            if (!quote) {
                return { ...text(`Unknown quote "${quoteId}". Run plan_trip first.`), isError: true };
            }

            if (!clientSupportsUrlElicitation(ctx)) {
                // Servers MUST NOT send a mode the client didn't declare.
                return {
                    ...text('This client cannot open payment pages (no URL-mode elicitation support), so checkout is unavailable.'),
                    isError: true
                };
            }

            // The SDK has already verified the HMAC, expiry and binding before we get here.
            const state = ctx.mcpReq.requestState<CheckoutState>();
            const payment = state ? store.getPayment(state.paymentId) : undefined;

            if (!payment || payment.quoteId !== quoteId) {
                // First round: open a payment session and ask the user to visit the page.
                const started = store.startPayment(quoteId);
                return inputRequired({
                    inputRequests: {
                        [PAYMENT_KEY]: inputRequired.elicitUrl({
                            message: `Pay €${quote.totalEur} for quote ${quote.id} (${quote.destination}) on the secure payment page.`,
                            url: `${opts.publicUrl}/pay/${started.id}`
                        })
                    },
                    requestState: await opts.stateCodec.mint({ paymentId: started.id }, ctx)
                });
            }

            const view = inputResponse(ctx.mcpReq.inputResponses, PAYMENT_KEY);
            if (view.kind === 'elicit' && view.action === 'decline') {
                store.settlePayment(payment.id, 'abandoned');
                return text(`Payment declined. Quote ${quote.id} is still on hold if you change your mind.`);
            }
            if (view.kind === 'elicit' && view.action === 'cancel') {
                store.settlePayment(payment.id, 'abandoned');
                return text(`Checkout dismissed. Nothing was charged. Run checkout again to retry.`);
            }

            // Accepted (or a plain status re-check): the outcome happens out of band,
            // so wait for the payment page to report back.
            const settled = await store.waitForSettlement(payment.id, opts.settleWaitMs, ctx.mcpReq.signal);
            switch (settled?.status) {
                case 'paid':
                    return {
                        ...text(
                            `Booked! ${quote.destination}, ${quote.nights} nights from ${quote.departureDate}. ` +
                                `Confirmation ${settled.confirmationCode}, €${quote.totalEur} charged.`
                        ),
                        structuredContent: { quoteId: quote.id, confirmationCode: settled.confirmationCode }
                    };
                case 'cancelled_on_page':
                    return text(`You cancelled on the payment page. Nothing was charged.`);
                case 'abandoned':
                    return text(`This checkout was already closed. Run checkout again to retry.`);
                default:
                    // Still pending: ask the client to retry later, echoing the same state.
                    return inputRequired({
                        requestState: await opts.stateCodec.mint({ paymentId: payment.id }, ctx)
                    });
            }
        }
    );
}
