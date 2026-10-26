import { styleText } from 'node:util';

import { checkbox, confirm, input, number, select } from '@inquirer/prompts';
import type { ElicitRequestFormParams, ElicitRequestURLParams, ElicitResult } from '@modelcontextprotocol/client';

import type { Ui } from './flow.js';
import { checkMulti, checkText, fieldsFromSchema, type Field } from './schema.js';
import { reviewUrl } from './url.js';

const dim = (s: string) => styleText('dim', s);
const bold = (s: string) => styleText('bold', s);

// Ctrl+C inside a prompt counts as "dismissed without choosing", i.e. cancel.
function isPromptExit(err: unknown): boolean {
    return err instanceof Error && err.name === 'ExitPromptError';
}

function banner(server: string, mode: string, message: string): void {
    console.log();
    console.log(styleText(['bgBlue', 'white', 'bold'], ` ${server} `) + ' ' + dim(`is asking (${mode} mode)`));
    console.log(`  ${message}`);
    console.log();
}

export class TerminalUi implements Ui {
    showWire = false;

    async form(server: string, params: ElicitRequestFormParams): Promise<ElicitResult> {
        banner(server, 'form', params.message);
        try {
            const first = await select({
                message: 'How do you want to respond?',
                choices: [
                    { name: 'Fill in the form', value: 'fill' },
                    { name: 'Decline (no thanks)', value: 'decline' },
                    { name: 'Cancel (decide later)', value: 'cancel' }
                ]
            });
            if (first !== 'fill') return { action: first as 'decline' | 'cancel' };

            const fields = fieldsFromSchema(params.requestedSchema as never);
            let answers: Record<string, unknown> = {};
            for (;;) {
                answers = await askFields(fields, answers);
                // The spec asks clients to let users review before sending.
                console.log();
                console.log(bold('  You are about to send:'));
                for (const f of fields) {
                    if (answers[f.key] !== undefined) console.log(`  ${dim(f.key.padEnd(16))} ${JSON.stringify(answers[f.key])}`);
                }
                console.log();
                const next = await select({
                    message: `Send this to ${server}?`,
                    choices: [
                        { name: 'Send', value: 'send' },
                        { name: 'Edit answers', value: 'edit' },
                        { name: 'Decline', value: 'decline' },
                        { name: 'Cancel', value: 'cancel' }
                    ]
                });
                if (next === 'send') return { action: 'accept', content: answers as ElicitResult['content'] };
                if (next === 'decline' || next === 'cancel') return { action: next };
            }
        } catch (err) {
            if (isPromptExit(err)) return { action: 'cancel' };
            throw err;
        }
    }

    async url(server: string, params: ElicitRequestURLParams): Promise<ElicitResult> {
        banner(server, 'URL', params.message);
        const review = reviewUrl(params.url);
        console.log(`  ${dim('Site:')} ${styleText(['bold', 'yellow'], review.host)}`);
        console.log(`  ${dim('Full link:')} ${review.full}`);
        for (const w of review.warnings) console.log(styleText('red', `  ⚠ ${w}`));
        console.log(dim('  The page talks to the server directly. This client never sees what you enter there.'));
        console.log();
        try {
            const choice = await select({
                message: 'Open this link?',
                choices: [
                    { name: 'Open it (I will continue in my browser)', value: 'accept' },
                    { name: 'Decline', value: 'decline' },
                    { name: 'Cancel', value: 'cancel' }
                ]
            });
            if (choice === 'accept') {
                // Running in a container we can't launch a browser, so hand the link over.
                console.log();
                console.log(`  ${bold('Open this link in your browser:')}`);
                console.log(`  ${styleText(['underline', 'cyan'], review.full)}`);
            }
            return { action: choice as ElicitResult['action'] };
        } catch (err) {
            if (isPromptExit(err)) return { action: 'cancel' };
            throw err;
        }
    }

    async retryPending(): Promise<boolean> {
        try {
            return await confirm({ message: 'The server is still waiting on the browser step. Check again?', default: true });
        } catch (err) {
            if (isPromptExit(err)) return false;
            throw err;
        }
    }

    waiting(message: string): void {
        console.log(dim(`  ${message}`));
    }

    wire(direction: 'send' | 'recv', payload: unknown): void {
        if (!this.showWire) return;
        const arrow = direction === 'send' ? styleText('green', '→ client to server') : styleText('magenta', '← server to client');
        console.log(`\n${arrow}`);
        console.log(dim(JSON.stringify(payload, null, 2)));
    }
}

async function askFields(fields: Field[], previous: Record<string, unknown>): Promise<Record<string, unknown>> {
    const answers: Record<string, unknown> = {};
    for (const f of fields) {
        const prior = previous[f.key];
        const label = f.required ? f.label : `${f.label} ${dim('(optional)')}`;
        switch (f.kind) {
            case 'text': {
                const value = await input({
                    message: label,
                    default: (prior as string | undefined) ?? f.default,
                    validate: v => checkText(f, v.trim()) ?? true
                });
                if (value.trim()) answers[f.key] = value.trim();
                break;
            }
            case 'number': {
                const value = await number({
                    message: label,
                    default: (prior as number | undefined) ?? f.default,
                    min: f.min,
                    max: f.max,
                    step: f.integer ? 1 : 'any',
                    required: f.required
                });
                if (value !== undefined) answers[f.key] = value;
                break;
            }
            case 'boolean':
                answers[f.key] = await confirm({ message: label, default: (prior as boolean | undefined) ?? f.default ?? false });
                break;
            case 'select':
                answers[f.key] = await select({
                    message: label,
                    choices: f.options.map(o => ({ name: o.title, value: o.value })),
                    default: (prior as string | undefined) ?? f.default
                });
                break;
            case 'multi': {
                const chosen = new Set((prior as string[] | undefined) ?? f.default ?? []);
                answers[f.key] = await checkbox({
                    message: label,
                    choices: f.options.map(o => ({ name: o.title, value: o.value, checked: chosen.has(o.value) })),
                    validate: items => checkMulti(f, items.map(i => i.value)) ?? true
                });
                break;
            }
        }
    }
    return answers;
}
