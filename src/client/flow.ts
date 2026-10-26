import type { Client, ElicitRequestFormParams, ElicitRequestURLParams, ElicitResult } from '@modelcontextprotocol/client';

// The client side of the 2026-07-28 multi round-trip flow, kept free of any
// terminal code so tests can drive it with a scripted UI.
//
//   tools/call ──▶ server answers input_required { inputRequests, requestState }
//   client asks the user for each input request
//   tools/call again (new request id) with inputResponses + the exact requestState
//   ...until the server returns a normal result

export interface Ui {
    /** Shows a form-mode request and returns the user's choice. */
    form(server: string, params: ElicitRequestFormParams): Promise<ElicitResult>;
    /** Shows a URL-mode request and returns whether the user agreed to open it. */
    url(server: string, params: ElicitRequestURLParams): Promise<ElicitResult>;
    /** The server wants a retry with no new questions (e.g. payment still pending). Return false to stop. */
    retryPending(): Promise<boolean>;
    /** Called before each retry that may block while the user finishes something out of band. */
    waiting(message: string): void;
    /** Raw protocol traffic, for the "show protocol" view. */
    wire(direction: 'send' | 'recv', payload: unknown): void;
}

export interface ToolOutcome {
    status: 'complete' | 'stopped';
    text: string;
    isError?: boolean;
    structuredContent?: unknown;
}

interface InputRequiredShape {
    resultType: 'input_required';
    inputRequests?: Record<string, { method: string; params: Record<string, unknown> }>;
    requestState?: string;
}

interface CallResultShape {
    resultType?: string;
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
}

const MAX_ROUNDS = 20;

export async function runTool(
    client: Client,
    ui: Ui,
    name: string,
    args: Record<string, unknown>
): Promise<ToolOutcome> {
    const server = serverLabel(client);
    let extra: { inputResponses?: Record<string, ElicitResult>; requestState?: string } = {};

    for (let round = 1; round <= MAX_ROUNDS; round++) {
        const params = { name, arguments: args, ...extra };
        ui.wire('send', { method: 'tools/call', params });
        // allowInputRequired hands input_required back to us instead of the SDK
        // auto-answering it, so the demo can show every round.
        const result = (await client.callTool(params, { allowInputRequired: true, timeout: 5 * 60_000 })) as
            | InputRequiredShape
            | CallResultShape;
        ui.wire('recv', result);

        if (result.resultType !== 'input_required') {
            const done = result as CallResultShape;
            return {
                status: 'complete',
                text: (done.content ?? []).map(c => c.text ?? '').join('\n'),
                isError: done.isError,
                structuredContent: done.structuredContent
            };
        }

        const { inputRequests = {}, requestState } = result as InputRequiredShape;
        const inputResponses: Record<string, ElicitResult> = {};
        let blocksOnUser = false;

        for (const [key, request] of Object.entries(inputRequests)) {
            if (request.method !== 'elicitation/create') {
                throw new Error(`This demo client only handles elicitation, not ${request.method}`);
            }
            // Requests without a mode are form mode (backwards compatibility).
            if (request.params.mode === 'url') {
                const answer = await ui.url(server, request.params as unknown as ElicitRequestURLParams);
                inputResponses[key] = answer;
                blocksOnUser ||= answer.action === 'accept';
            } else {
                inputResponses[key] = await ui.form(server, request.params as unknown as ElicitRequestFormParams);
            }
        }

        if (Object.keys(inputRequests).length === 0 && !(await ui.retryPending())) {
            return { status: 'stopped', text: 'Stopped waiting. You can run the tool again later.' };
        }
        if (blocksOnUser || Object.keys(inputRequests).length === 0) {
            ui.waiting('Waiting for the server (finish in your browser)...');
        }

        // Echo requestState byte for byte; omit it if the server sent none.
        extra = {
            ...(Object.keys(inputResponses).length ? { inputResponses } : {}),
            ...(requestState !== undefined ? { requestState } : {})
        };
    }
    throw new Error(`Gave up after ${MAX_ROUNDS} rounds`);
}

function serverLabel(client: Client): string {
    const info = client.getServerVersion();
    return info?.title ?? info?.name ?? 'MCP server';
}
