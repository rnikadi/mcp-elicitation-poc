// A tiny client for the web backend's HTTP API, playing the browser's part.
// Used by the tests and by the Compose smoke test (through nginx).
import type { PromptAnswer, RunEvent } from '../src/web/shared.js';

export class WebRun {
    private buffer: RunEvent[] = [];
    private wake?: () => void;
    private readonly abort = new AbortController();

    private constructor(
        readonly base: string,
        readonly id: string
    ) {}

    static async start(base: string, tool: string, args: Record<string, unknown>): Promise<WebRun> {
        const res = await fetch(`${base}/api/runs`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tool, arguments: args })
        });
        const body = (await res.json()) as { runId?: string; error?: string };
        if (!res.ok || !body.runId) throw new Error(`start failed: ${res.status} ${body.error}`);
        const run = new WebRun(base, body.runId);
        await run.listen();
        return run;
    }

    private async listen(): Promise<void> {
        const res = await fetch(`${this.base}/api/runs/${this.id}/events`, { signal: this.abort.signal });
        if (!res.ok || !res.body) throw new Error(`events failed: ${res.status}`);
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        void (async () => {
            let pending = '';
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    pending += value;
                    let cut;
                    while ((cut = pending.indexOf('\n\n')) >= 0) {
                        const frame = pending.slice(0, cut);
                        pending = pending.slice(cut + 2);
                        const data = frame.split('\n').find(l => l.startsWith('data: '));
                        if (data) this.buffer.push(JSON.parse(data.slice(6)) as RunEvent);
                    }
                    this.wake?.();
                }
            } catch {
                // aborted by disconnect()
            }
        })();
    }

    /** Waits for the next event of the given type, skipping others. */
    async next<T extends RunEvent['type']>(type: T, timeoutMs = 10_000): Promise<Extract<RunEvent, { type: T }>> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const i = this.buffer.findIndex(e => e.type === type);
            if (i >= 0) return this.buffer.splice(0, i + 1).pop() as Extract<RunEvent, { type: T }>;
            const failed = this.buffer.find(e => e.type === 'failed');
            if (failed) throw new Error(`run failed: ${JSON.stringify(failed)}`);
            if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
            await new Promise<void>(resolve => {
                this.wake = resolve;
                setTimeout(resolve, 100);
            });
        }
    }

    async answer(promptId: string, answer: PromptAnswer | Record<string, unknown>): Promise<Response> {
        return fetch(`${this.base}/api/runs/${this.id}/prompts/${promptId}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(answer)
        });
    }

    /** Like closing the browser tab. */
    disconnect(): void {
        this.abort.abort();
    }
}
