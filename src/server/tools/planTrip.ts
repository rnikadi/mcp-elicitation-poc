import {
    acceptedContent,
    type ElicitRequestFormParams,
    inputRequired,
    inputResponse,
    type McpServer
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { Cabin, Extra, Store } from '../store.js';

// Form mode: the server asks the client to render a form from a restricted,
// flat JSON Schema. The answers travel through the client, so nothing
// sensitive (passwords, card numbers, API keys) belongs here.

export const TRIP_DETAILS_KEY = 'trip_details';

export const tripDetailsSchema: ElicitRequestFormParams['requestedSchema'] = {
    type: 'object',
    properties: {
        departureDate: {
            type: 'string',
            format: 'date',
            title: 'Departure date',
            description: 'YYYY-MM-DD'
        },
        nights: { type: 'integer', title: 'Nights', minimum: 1, maximum: 14, default: 3 },
        travelers: { type: 'integer', title: 'Travelers', minimum: 1, maximum: 6, default: 2 },
        cabin: {
            type: 'string',
            title: 'Cabin class',
            oneOf: [
                { const: 'economy', title: 'Economy' },
                { const: 'premium', title: 'Premium economy' },
                { const: 'business', title: 'Business' }
            ],
            default: 'economy'
        },
        extras: {
            type: 'array',
            title: 'Extras',
            items: { type: 'string', enum: ['breakfast', 'airport-transfer', 'travel-insurance'] },
            default: []
        },
        contactEmail: { type: 'string', format: 'email', title: 'Contact email' }
    },
    required: ['departureDate', 'nights', 'travelers', 'cabin', 'contactEmail']
};

// The client's answer is untrusted input, so it is validated again on the server.
const tripDetails = z.object({
    departureDate: z.iso.date(),
    nights: z.int().min(1).max(14),
    travelers: z.int().min(1).max(6),
    cabin: z.enum(['economy', 'premium', 'business']),
    extras: z.array(z.enum(['breakfast', 'airport-transfer', 'travel-insurance'])).default([]),
    contactEmail: z.email()
});

const NIGHTLY_RATE_EUR: Record<Cabin, number> = { economy: 120, premium: 180, business: 260 };

export function priceTrip(d: { nights: number; travelers: number; cabin: Cabin; extras: Extra[] }): number {
    let total = NIGHTLY_RATE_EUR[d.cabin] * d.nights * d.travelers;
    if (d.extras.includes('breakfast')) total += 15 * d.nights * d.travelers;
    if (d.extras.includes('airport-transfer')) total += 40;
    if (d.extras.includes('travel-insurance')) total += 25 * d.travelers;
    return total;
}

function text(t: string) {
    return { content: [{ type: 'text' as const, text: t }] };
}

export function registerPlanTrip(server: McpServer, store: Store): void {
    server.registerTool(
        'plan_trip',
        {
            title: 'Plan a trip',
            description: 'Builds a priced trip quote. Asks the user for trip details with a form-mode elicitation.',
            inputSchema: z.object({ destination: z.string().min(1).describe('City to travel to') })
        },
        async ({ destination }, ctx) => {
            const responses = ctx.mcpReq.inputResponses;
            const view = inputResponse(responses, TRIP_DETAILS_KEY);

            if (view.kind === 'elicit' && view.action === 'decline') {
                return text(`No trip planned. You declined to share trip details for ${destination}.`);
            }
            if (view.kind === 'elicit' && view.action === 'cancel') {
                return text(`Trip planning for ${destination} was dismissed. Ask again whenever you're ready.`);
            }

            const details = acceptedContent(responses, TRIP_DETAILS_KEY, tripDetails);
            if (!details) {
                // First round, or the accepted answer failed validation: ask (again).
                const retry = view.kind === 'elicit' && view.action === 'accept';
                return inputRequired({
                    inputRequests: {
                        [TRIP_DETAILS_KEY]: inputRequired.elicit({
                            mode: 'form',
                            message: retry
                                ? `Some trip details for ${destination} were invalid. Please check them and try again.`
                                : `Tell me about your trip to ${destination}.`,
                            requestedSchema: tripDetailsSchema
                        })
                    }
                });
            }

            const quote = store.addQuote({ destination, ...details, totalEur: priceTrip(details) });
            const extras = quote.extras.length ? quote.extras.join(', ') : 'none';
            return {
                ...text(
                    [
                        `Quote ${quote.id}: ${quote.nights} nights in ${destination} from ${quote.departureDate}`,
                        `${quote.travelers} traveler(s), ${quote.cabin} cabin, extras: ${extras}`,
                        `Total: €${quote.totalEur}. Confirmation will go to ${quote.contactEmail}.`,
                        `Call checkout with quoteId "${quote.id}" to pay.`
                    ].join('\n')
                ),
                structuredContent: quote
            };
        }
    );
}
