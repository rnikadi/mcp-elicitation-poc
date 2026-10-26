import { randomUUID } from 'node:crypto';

import type { Client, ElicitRequestFormParams, ElicitRequestURLParams, ElicitResult } from '@modelcontextprotocol/client';

import { runTool, type Ui } from '../../client/flow.js';
import type { Prompt, PromptAnswer, RunEvent, ToolName } from '../shared.js';

// One run is one tool call, including every input_required round. It reuses
// the terminal client's MRTR loop (runTool) with a Ui that, instead of
// prompting on a TTY, publishes each question as an event and waits for the
// browser to answer it.

export type Listener = (event: RunEvent, index: number) => void;

/** Finished runs are kept briefly so a reconnecting page can replay them. */
const KEEP_FINISHED_MS = 10 * 60_000;

interface Pending {
    prompt: Prompt;
    resolve(answer: PromptAnswer): void;
}

export class Run implements Ui {
    readonly id = randomUUID();
    readonly events: RunEvent[] = [];
    finished = false;
    private readonly listeners = new Set<Listener>();
    private readonly pending = new Map<string, Pending>();
    private orphanTimer?: NodeJS.Timeout;

    constructor(
        private readonly onFinished: (run: Run) => void,
        /** If the browser goes away with a question open, the user dismissed it: that is a cancel. */
        private readonly disconnectGraceMs: number
    ) {}

    start(client: Client, tool: ToolName, args: Record<string, unknown>): void {
        this.emit({ type: 'started', tool, arguments: args });
        runTool(client, this, tool, args)
            .then(outcome => this.emit({ type: 'done', outcome }))
            .catch((err: unknown) => this.emit({ type: 'failed', error: err instanceof Error ? err.message : String(err) }))
            .finally(() => {
                this.finished = true;
                this.onFinished(this);
            });
    }

    /** Replays events after `from` (for SSE Last-Event-ID), then streams new ones. */
    subscribe(listener: Listener, from = -1): () => void {
        this.events.forEach((e, i) => i > from && listener(e, i));
        this.listeners.add(listener);
        clearTimeout(this.orphanTimer);
        return () => {
            this.listeners.delete(listener);
            if (this.listeners.size === 0 && this.pending.size > 0) {
                clearTimeout(this.orphanTimer);
                this.orphanTimer = setTimeout(() => this.dismissAll(), this.disconnectGraceMs);
            }
        };
    }

    /** Returns an error message if the answer doesn't fit the open prompt. */
    answer(promptId: string, answer: unknown): string | undefined {
        const open = this.pending.get(promptId);
        if (!open) return 'No open prompt with that id';
        const problem = checkAnswer(open.prompt, answer);
        if (problem) return problem;
        this.settle(promptId, answer as PromptAnswer, 'user');
        return undefined;
    }

    // --- Ui, called by runTool ---

    form(server: string, params: ElicitRequestFormParams): Promise<ElicitResult> {
        return this.ask({ kind: 'form', server, params }) as Promise<ElicitResult>;
    }

    url(server: string, params: ElicitRequestURLParams): Promise<ElicitResult> {
        return this.ask({ kind: 'url', server, params }) as Promise<ElicitResult>;
    }

    async retryPending(): Promise<boolean> {
        const answer = (await this.ask({ kind: 'retry' })) as { retry: boolean };
        return answer.retry;
    }

    waiting(message: string): void {
        this.emit({ type: 'waiting', message });
    }

    wire(direction: 'send' | 'recv', payload: unknown): void {
        this.emit({ type: 'wire', direction, payload });
    }

    // --- internals ---

    private ask(prompt: Prompt): Promise<PromptAnswer> {
        const promptId = randomUUID();
        return new Promise(resolve => {
            this.pending.set(promptId, { prompt, resolve });
            this.emit({ type: 'prompt', promptId, ...prompt });
            if (this.listeners.size === 0) {
                clearTimeout(this.orphanTimer);
                this.orphanTimer = setTimeout(() => this.dismissAll(), this.disconnectGraceMs);
            }
        });
    }

    private settle(promptId: string, answer: PromptAnswer, by: 'user' | 'disconnect'): void {
        const open = this.pending.get(promptId)!;
        this.pending.delete(promptId);
        this.emit({ type: 'answered', promptId, answer, by });
        open.resolve(answer);
    }

    private dismissAll(): void {
        for (const [id, { prompt }] of this.pending) {
            this.settle(id, prompt.kind === 'retry' ? { retry: false } : { action: 'cancel' }, 'disconnect');
        }
    }

    private emit(event: RunEvent): void {
        this.events.push(event);
        const index = this.events.length - 1;
        for (const l of this.listeners) l(event, index);
    }
}

function checkAnswer(prompt: Prompt, answer: unknown): string | undefined {
    if (typeof answer !== 'object' || answer === null) return 'Answer must be an object';
    const a = answer as Record<string, unknown>;
    if (prompt.kind === 'retry') {
        return typeof a.retry === 'boolean' && Object.keys(a).length === 1 ? undefined : 'Expected { retry: boolean }';
    }
    if (a.action !== 'accept' && a.action !== 'decline' && a.action !== 'cancel') {
        return 'action must be accept, decline or cancel';
    }
    // Only an accepted form carries content; URL mode never does (the data went to the page).
    const allowed = prompt.kind === 'form' && a.action === 'accept' ? ['action', 'content'] : ['action'];
    if (Object.keys(a).some(k => !allowed.includes(k))) return `Only ${allowed.join(' and ')} allowed here`;
    if (prompt.kind === 'form' && a.action === 'accept') {
        const c = a.content;
        if (typeof c !== 'object' || c === null || Array.isArray(c)) return 'An accepted form needs content';
        // The schema is flat: values are primitives or arrays of strings. The server validates the rest.
        const ok = Object.values(c).every(
            v => ['string', 'number', 'boolean'].includes(typeof v) || (Array.isArray(v) && v.every(x => typeof x === 'string'))
        );
        if (!ok) return 'Form values must be strings, numbers, booleans or string arrays';
    }
    return undefined;
}

export class Runs {
    private readonly runs = new Map<string, Run>();

    constructor(private readonly disconnectGraceMs = 5_000) {}

    create(): Run {
        const run = new Run(r => setTimeout(() => this.runs.delete(r.id), KEEP_FINISHED_MS).unref(), this.disconnectGraceMs);
        this.runs.set(run.id, run);
        return run;
    }

    get(id: string): Run | undefined {
        return this.runs.get(id);
    }
}
