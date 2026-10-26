import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';

// In-memory state for the demo. A real server would persist this and bind
// every record to the authenticated user (see the spec's statefulness notes).

export type Cabin = 'economy' | 'premium' | 'business';
export type Extra = 'breakfast' | 'airport-transfer' | 'travel-insurance';

export interface Quote {
    id: string;
    destination: string;
    departureDate: string;
    nights: number;
    travelers: number;
    cabin: Cabin;
    extras: Extra[];
    contactEmail: string;
    totalEur: number;
}

export type PaymentStatus = 'pending' | 'paid' | 'cancelled_on_page' | 'abandoned';

export interface Payment {
    id: string;
    quoteId: string;
    status: PaymentStatus;
    confirmationCode?: string;
}

export class Store {
    private readonly quotes = new Map<string, Quote>();
    private readonly payments = new Map<string, Payment>();
    private readonly events = new EventEmitter();

    addQuote(quote: Omit<Quote, 'id'>): Quote {
        const id = `Q-${randomBytes(3).toString('hex').toUpperCase()}`;
        const stored = { id, ...quote };
        this.quotes.set(id, stored);
        return stored;
    }

    getQuote(id: string): Quote | undefined {
        return this.quotes.get(id);
    }

    startPayment(quoteId: string): Payment {
        // The id appears in the payment URL, so it must be unguessable.
        const payment: Payment = { id: randomUUID(), quoteId, status: 'pending' };
        this.payments.set(payment.id, payment);
        return payment;
    }

    getPayment(id: string): Payment | undefined {
        return this.payments.get(id);
    }

    /** Moves a pending payment to a final status. Returns false if it was already final. */
    settlePayment(id: string, status: Exclude<PaymentStatus, 'pending'>): boolean {
        const payment = this.payments.get(id);
        if (!payment || payment.status !== 'pending') return false;
        payment.status = status;
        if (status === 'paid') {
            payment.confirmationCode = `TRIP-${randomBytes(3).toString('hex').toUpperCase()}`;
        }
        this.events.emit(id, payment);
        return true;
    }

    /** Resolves when the payment leaves `pending`, or after `timeoutMs` with whatever it is then. */
    async waitForSettlement(id: string, timeoutMs: number, signal?: AbortSignal): Promise<Payment | undefined> {
        const payment = this.payments.get(id);
        if (!payment || payment.status !== 'pending') return payment;
        return new Promise(resolve => {
            const done = () => {
                clearTimeout(timer);
                this.events.off(id, done);
                signal?.removeEventListener('abort', done);
                resolve(this.payments.get(id));
            };
            const timer = setTimeout(done, timeoutMs);
            this.events.on(id, done);
            signal?.addEventListener('abort', done, { once: true });
        });
    }
}
