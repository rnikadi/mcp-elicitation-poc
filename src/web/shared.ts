import type { ElicitRequestFormParams, ElicitRequestURLParams, ElicitResult } from '@modelcontextprotocol/client';

import type { ToolOutcome } from '../client/flow.js';

// The contract between the web backend and the browser. The backend is the
// MCP client; it streams these events over SSE and the browser answers
// prompts with POST /api/runs/:runId/prompts/:promptId.

export type ToolName = 'plan_trip' | 'checkout';

export type Prompt =
    | { kind: 'form'; server: string; params: ElicitRequestFormParams }
    | { kind: 'url'; server: string; params: ElicitRequestURLParams }
    | { kind: 'retry' };

/** What the browser posts back for a prompt. */
export type PromptAnswer = ElicitResult | { retry: boolean };

export type RunEvent =
    | { type: 'started'; tool: ToolName; arguments: Record<string, unknown> }
    | { type: 'wire'; direction: 'send' | 'recv'; payload: unknown }
    | ({ type: 'prompt'; promptId: string } & Prompt)
    | { type: 'answered'; promptId: string; answer: PromptAnswer; by: 'user' | 'disconnect' }
    | { type: 'waiting'; message: string }
    | { type: 'done'; outcome: ToolOutcome }
    | { type: 'failed'; error: string };

export interface ServerInfo {
    connected: boolean;
    mcpUrl: string;
    protocolVersion: string;
    server?: { name: string; title?: string; version: string };
    tools: Array<{ name: string; title?: string; description?: string }>;
}
