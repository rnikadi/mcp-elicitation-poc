import type { ElicitRequestFormParams, ElicitRequestURLParams, ElicitResult } from '@modelcontextprotocol/client';

import { checkMulti, checkText, fieldsFromSchema, type Field } from '../../client/schema.js';
import { reviewUrl } from '../../client/url.js';
import type { PromptAnswer, RunEvent, ServerInfo, ToolName } from '../shared.js';

// The browser half of the web client. The backend runs the MCP session and
// streams each run's events; this page renders the elicitations as dialogs
// and posts the user's answer (accept, decline or cancel) back.

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: Record<string, string | number | boolean | undefined> = {},
    ...children: Child[]
): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === false) continue;
        el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
    return el;
}

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const statusEl = byId('status');
const timeline = byId<HTMLOListElement>('timeline');
const wireList = byId<HTMLOListElement>('wire');
const dialog = byId<HTMLDialogElement>('prompt');
const planForm = byId<HTMLFormElement>('plan-form');
const checkoutForm = byId<HTMLFormElement>('checkout-form');
const destinationInput = byId<HTMLInputElement>('destination');
const quoteInput = byId<HTMLInputElement>('quote-id');

let serverName = 'MCP server';

// ---------- connection status ----------

async function refreshStatus(): Promise<void> {
    try {
        const info = (await (await fetch('/api/info')).json()) as ServerInfo;
        if (info.connected) {
            serverName = info.server?.title ?? info.server?.name ?? serverName;
            statusEl.className = 'status ok';
            statusEl.replaceChildren(
                h('span', { class: 'dot' }),
                h('span', {}, h('strong', {}, serverName), ` · protocol ${info.protocolVersion} · elicitation: form + url`)
            );
            return;
        }
        statusEl.className = 'status warn';
        statusEl.textContent = `Connecting to ${info.mcpUrl}…`;
    } catch {
        statusEl.className = 'status err';
        statusEl.textContent = 'Web backend unreachable';
    }
    setTimeout(refreshStatus, 2_000);
}

// ---------- runs ----------

interface RunView {
    id: string;
    tool: ToolName;
    steps: HTMLOListElement;
    source: EventSource;
    /** The user's action per mode, for the checklist. */
    actions: { form?: string; url?: string };
    spinner?: HTMLElement;
    openPromptId?: string;
    /** Mode of the latest elicitation, so its answer lands in the right checklist column. */
    mode?: 'form' | 'url';
    paymentUrl?: string;
}

let active: RunView | undefined;

function setBusy(busy: boolean): void {
    for (const b of document.querySelectorAll<HTMLButtonElement>('.tool button')) b.disabled = busy;
}

async function startRun(tool: ToolName, args: Record<string, unknown>): Promise<void> {
    if (active) return;
    setBusy(true);
    timeline.querySelector('.empty')?.remove();

    const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool, arguments: args })
    }).catch(() => undefined);
    const body = (await res?.json().catch(() => ({}))) as { runId?: string; error?: string };
    if (!res?.ok || !body.runId) {
        timeline.prepend(h('li', { class: 'run' }, h('div', { class: 'result err' }, body?.error ?? 'Could not start the tool call')));
        setBusy(false);
        return;
    }

    const steps = h('ol', { class: 'steps' });
    const argText = Object.entries(args)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join(', ');
    timeline.prepend(
        h(
            'li',
            { class: 'run' },
            h('div', { class: 'run-head' }, h('code', {}, `tools/call ${tool}`), h('span', { class: 'muted' }, `{ ${argText} }`)),
            steps
        )
    );

    const source = new EventSource(`/api/runs/${body.runId}/events`);
    const view: RunView = { id: body.runId, tool, steps, source, actions: {} };
    active = view;
    source.onmessage = e => handle(view, JSON.parse(e.data) as RunEvent);
}

function step(view: RunView, cls: string, ...children: Child[]): HTMLLIElement {
    view.spinner?.remove();
    view.spinner = undefined;
    const li = h('li', { class: `step ${cls}` }, ...children);
    view.steps.append(li);
    return li;
}

function handle(view: RunView, ev: RunEvent): void {
    switch (ev.type) {
        case 'started':
            break;
        case 'wire':
            addWire(ev.direction, ev.payload);
            break;
        case 'prompt':
            view.openPromptId = ev.promptId;
            if (ev.kind !== 'retry') view.mode = ev.kind;
            if (ev.kind === 'form') {
                step(view, 'ask', h('span', { class: 'badge form' }, 'form'), ' ', h('strong', {}, ev.server), ` asked: ${ev.params.message}`);
                showForm(view, ev.promptId, ev.server, ev.params);
            } else if (ev.kind === 'url') {
                view.paymentUrl = ev.params.url;
                const host = reviewUrl(ev.params.url).host;
                step(view, 'ask', h('span', { class: 'badge url' }, 'url'), ' ', h('strong', {}, ev.server), ' asked you to open ', h('code', {}, host));
                showUrl(view, ev.promptId, ev.server, ev.params);
            } else {
                step(view, 'ask', '⏳ The payment page has not reported back yet.');
                showRetry(view, ev.promptId);
            }
            break;
        case 'answered': {
            if (view.openPromptId === ev.promptId) {
                view.openPromptId = undefined;
                if (dialog.open) dialog.close();
            }
            const a = ev.answer;
            if ('retry' in a) {
                step(view, 'you', a.retry ? 'You: check again' : 'You: stop waiting');
                break;
            }
            const mode = view.mode ?? 'form';
            view.actions[mode] = a.action;
            const li = step(
                view,
                'you',
                ev.by === 'disconnect' ? 'Page closed, so the client answered ' : 'You: ',
                h('span', { class: `action ${a.action}` }, a.action)
            );
            if (a.content) li.append(h('div', { class: 'kv' }, ...kvRows(a.content)));
            if (mode === 'url' && a.action === 'accept' && view.paymentUrl) {
                li.append(
                    ' ',
                    h('a', { href: view.paymentUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open the payment page again')
                );
            }
            break;
        }
        case 'waiting':
            view.spinner?.remove();
            view.spinner = h('li', { class: 'step waiting' }, h('span', { class: 'spin' }), ev.message);
            view.steps.append(view.spinner);
            break;
        case 'done': {
            const o = ev.outcome;
            const declinedOrCancelled = Object.values(view.actions).some(a => a !== 'accept') || o.status === 'stopped';
            const tone = o.isError ? 'err' : declinedOrCancelled ? 'warn' : 'ok';
            const li = step(view, 'done', h('div', { class: `result ${tone}` }, o.text));
            const data = o.structuredContent as { id?: string; totalEur?: number; confirmationCode?: string } | undefined;
            if (data?.id && data.totalEur !== undefined) {
                quoteInput.value = data.id;
                const go = h('button', { type: 'button', class: 'primary small' }, `Check out ${data.id} →`);
                go.onclick = () => checkoutForm.requestSubmit();
                li.append(go);
            }
            if (data?.confirmationCode) li.append(h('div', { class: 'booked' }, '✓ Booked · ', h('code', {}, data.confirmationCode)));
            for (const [mode, action] of Object.entries(view.actions)) tick(`${mode}:${action}`);
            finish(view);
            break;
        }
        case 'failed':
            step(view, 'done', h('div', { class: 'result err' }, `Error: ${ev.error}`));
            finish(view);
            break;
    }
}

function finish(view: RunView): void {
    view.source.close();
    if (dialog.open) dialog.close();
    active = undefined;
    setBusy(false);
}

function kvRows(content: Record<string, unknown>): Node[] {
    return Object.entries(content).flatMap(([k, v]) => [h('span', { class: 'k' }, k), h('span', {}, JSON.stringify(v))]);
}

function tick(key: string): void {
    const cell = document.querySelector<HTMLElement>(`#checklist [data-k="${key}"]`);
    if (cell) {
        cell.textContent = '✓';
        cell.classList.add('ticked');
    }
}

/** Each prompt is answered once, however many buttons or Esc presses race for it. */
const answered = new Set<string>();

async function answer(view: RunView, promptId: string, a: PromptAnswer): Promise<void> {
    if (answered.has(promptId)) return;
    answered.add(promptId);
    onEscape = undefined;
    const res = await fetch(`/api/runs/${view.id}/prompts/${promptId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(a)
    });
    if (!res.ok) {
        const { error } = (await res.json().catch(() => ({}))) as { error?: string };
        step(view, 'done', h('div', { class: 'result err' }, `Answer rejected: ${error ?? res.status}`));
    }
    if (dialog.open) dialog.close();
}

// ---------- the prompt dialog ----------

/** Esc on the dialog is "dismissed without choosing", which the spec calls cancel. */
let onEscape: (() => void) | undefined;
dialog.addEventListener('cancel', e => {
    e.preventDefault();
    onEscape?.();
});

function openDialog(...children: Child[]): void {
    dialog.replaceChildren(...(children.filter(Boolean) as Node[]));
    if (!dialog.open) dialog.showModal();
}

function dialogHead(server: string, mode: 'form' | 'url', message: string): HTMLElement {
    return h(
        'header',
        { class: 'dlg-head' },
        h('div', { class: 'asker' }, h('span', { class: 'server' }, server), ' is asking ', h('span', { class: `badge ${mode}` }, `${mode} mode`)),
        h('h2', { id: 'prompt-title' }, message)
    );
}

function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
    const b = h('button', { type: 'button', class: cls }, label);
    b.onclick = onClick;
    return b;
}

function showForm(view: RunView, promptId: string, server: string, params: ElicitRequestFormParams): void {
    const schema = params.requestedSchema as { properties: Record<string, Record<string, unknown>>; required?: string[] };
    const fields = fieldsFromSchema(schema as never);
    const readers: Array<() => { key: string; value?: unknown; error?: string }> = [];

    const formEl = h('form', { class: 'elicit', novalidate: true });
    for (const f of fields) {
        const prop = schema.properties[f.key] ?? {};
        const { control, read } = renderField(f, prop);
        const error = h('small', { class: 'error' });
        const hint = typeof prop.description === 'string' ? h('small', { class: 'hint' }, prop.description) : null;
        const title = (prop.title as string | undefined) ?? f.key;
        const label = h(
            f.kind === 'multi' ? 'fieldset' : 'label',
            { class: 'field' },
            h(f.kind === 'multi' ? 'legend' : 'span', {}, title, f.required ? h('b', { class: 'req' }, ' *') : h('i', { class: 'muted' }, ' optional')),
            control,
            hint,
            error
        );
        formEl.append(label);
        readers.push(() => {
            const r = read();
            error.textContent = r.error ?? '';
            label.classList.toggle('invalid', !!r.error);
            return { key: f.key, ...r };
        });
    }

    const decline = () => answer(view, promptId, { action: 'decline' });
    const cancel = () => answer(view, promptId, { action: 'cancel' });
    onEscape = cancel;

    const review = h('div', { class: 'review', hidden: true });
    const editActions = h(
        'footer',
        { class: 'dlg-actions' },
        button('Decline', 'ghost', decline),
        button('Cancel', 'ghost', cancel),
        h('span', { class: 'grow' }),
        h('button', { type: 'submit', class: 'primary', form: 'elicit-form' }, 'Review →')
    );
    formEl.id = 'elicit-form';

    let content: ElicitResult['content'] = {};
    formEl.onsubmit = e => {
        e.preventDefault();
        const results = readers.map(r => r());
        if (results.some(r => r.error)) return;
        content = Object.fromEntries(results.filter(r => r.value !== undefined).map(r => [r.key, r.value])) as ElicitResult['content'];
        // The spec asks clients to let the user review what will be sent.
        review.replaceChildren(
            h('p', {}, 'This is exactly what goes back to ', h('strong', {}, server), ':'),
            h('pre', { class: 'json' }, JSON.stringify({ action: 'accept', content }, null, 2)),
            h(
                'footer',
                { class: 'dlg-actions' },
                button('Decline', 'ghost', decline),
                button('Cancel', 'ghost', cancel),
                h('span', { class: 'grow' }),
                button('← Edit', 'ghost', () => {
                    review.hidden = true;
                    formEl.hidden = false;
                    editActions.hidden = false;
                }),
                button('Send', 'primary', () => answer(view, promptId, { action: 'accept', content }))
            )
        );
        formEl.hidden = true;
        editActions.hidden = true;
        review.hidden = false;
    };

    openDialog(
        dialogHead(server, 'form', params.message),
        formEl,
        editActions,
        review,
        h('p', { class: 'note' }, 'Form answers travel through this client to the server. Never enter passwords, card numbers or API keys here.')
    );
    formEl.querySelector<HTMLElement>('input, select')?.focus();
}

function renderField(f: Field, prop: Record<string, unknown>): { control: HTMLElement; read(): { value?: unknown; error?: string } } {
    switch (f.kind) {
        case 'text': {
            const type = f.format === 'date' ? 'date' : f.format === 'email' ? 'email' : f.format === 'uri' ? 'url' : 'text';
            const input = h('input', { type, name: f.key, value: f.default, minlength: f.minLength, maxlength: f.maxLength });
            return {
                control: input,
                read: () => {
                    const v = input.value.trim();
                    return { value: v || undefined, error: checkText(f, v) };
                }
            };
        }
        case 'number': {
            const input = h('input', { type: 'number', name: f.key, value: f.default, min: f.min, max: f.max, step: f.integer ? 1 : 'any' });
            return {
                control: input,
                read: () => {
                    if (input.value === '') return { error: f.required ? 'Required' : undefined };
                    const n = Number(input.value);
                    if (!Number.isFinite(n)) return { error: 'Enter a number' };
                    if (f.integer && !Number.isInteger(n)) return { error: 'Enter a whole number' };
                    if (f.min !== undefined && n < f.min) return { error: `At least ${f.min}` };
                    if (f.max !== undefined && n > f.max) return { error: `At most ${f.max}` };
                    return { value: n };
                }
            };
        }
        case 'boolean': {
            const input = h('input', { type: 'checkbox', name: f.key, checked: f.default === true });
            return { control: h('span', { class: 'check' }, input, (prop.title as string) ?? f.key), read: () => ({ value: input.checked }) };
        }
        case 'select': {
            const select = h(
                'select',
                { name: f.key },
                !f.required && h('option', { value: '' }, '—'),
                ...f.options.map(o => h('option', { value: o.value, selected: o.value === f.default }, o.title))
            );
            return {
                control: select,
                read: () => (select.value ? { value: select.value } : { error: f.required ? 'Required' : undefined })
            };
        }
        case 'multi': {
            const chosen = new Set(f.default ?? []);
            const boxes = f.options.map(o => ({ o, input: h('input', { type: 'checkbox', value: o.value, checked: chosen.has(o.value) }) }));
            return {
                control: h('div', { class: 'multi' }, ...boxes.map(({ o, input }) => h('label', { class: 'check' }, input, o.title))),
                read: () => {
                    const values = boxes.filter(b => b.input.checked).map(b => b.o.value);
                    return { value: values, error: checkMulti(f, values) };
                }
            };
        }
    }
}

function showUrl(view: RunView, promptId: string, server: string, params: ElicitRequestURLParams): void {
    const review = reviewUrl(params.url);
    const invalid = review.host === '(invalid URL)';
    const decline = () => answer(view, promptId, { action: 'decline' });
    const cancel = () => answer(view, promptId, { action: 'cancel' });
    onEscape = cancel;

    const open = button('Open link', 'primary', () => {
        // The browser opens the page; neither this page nor the backend fetches it.
        window.open(review.full, '_blank', 'noopener,noreferrer');
        void answer(view, promptId, { action: 'accept' });
    });
    open.disabled = invalid;

    openDialog(
        dialogHead(server, 'url', params.message),
        h(
            'div',
            { class: 'urlbox' },
            h('div', { class: 'muted small' }, 'You will be sent to'),
            h('div', { class: 'host' }, review.host),
            h('code', { class: 'full' }, review.full),
            ...review.warnings.map(w => h('div', { class: 'warning' }, `⚠ ${w}`))
        ),
        h(
            'p',
            { class: 'note' },
            'The page talks to the server directly. This app never sees what you enter there; it only tells the server that you agreed to open it.'
        ),
        h('footer', { class: 'dlg-actions' }, button('Decline', 'ghost', decline), button('Cancel', 'ghost', cancel), h('span', { class: 'grow' }), open)
    );
    open.focus();
}

function showRetry(view: RunView, promptId: string): void {
    const stop = () => answer(view, promptId, { retry: false });
    onEscape = stop;
    openDialog(
        h('header', { class: 'dlg-head' }, h('h2', { id: 'prompt-title' }, 'Still waiting on the payment page')),
        h('p', {}, 'The server has not heard back from the payment page yet. Finish there, then check again.'),
        h('footer', { class: 'dlg-actions' }, button('Stop waiting', 'ghost', stop), h('span', { class: 'grow' }), button('Check again', 'primary', () => answer(view, promptId, { retry: true })))
    );
}

// ---------- protocol panel ----------

let round = 0;

function addWire(direction: 'send' | 'recv', payload: unknown): void {
    const p = payload as {
        method?: string;
        params?: { name?: string; inputResponses?: object; requestState?: string };
        resultType?: string;
        inputRequests?: Record<string, { method: string; params: { mode?: string } }>;
        isError?: boolean;
    };
    let summary: string;
    if (direction === 'send') {
        round++;
        const extras = [p.params?.inputResponses && 'inputResponses', p.params?.requestState && 'requestState'].filter(Boolean);
        summary = `→ ${p.method} ${p.params?.name ?? ''}${extras.length ? ` + ${extras.join(' + ')}` : ''}`;
    } else if (p.resultType === 'input_required') {
        const asks = Object.values(p.inputRequests ?? {}).map(r => `${r.method} (${r.params.mode ?? 'form'})`);
        summary = `← input_required${asks.length ? `: ${asks.join(', ')}` : ' (retry later)'}`;
    } else {
        summary = `← result${p.isError ? ' (isError)' : ''}`;
    }
    for (const d of wireList.querySelectorAll('details[open]')) d.removeAttribute('open');
    wireList.prepend(
        h(
            'li',
            { class: direction },
            h('details', { open: true }, h('summary', {}, h('span', { class: 'round' }, `#${round}`), summary), h('pre', { class: 'json' }, JSON.stringify(payload, null, 2)))
        )
    );
}

// ---------- wiring ----------

planForm.onsubmit = e => {
    e.preventDefault();
    const destination = destinationInput.value.trim();
    if (destination) void startRun('plan_trip', { destination });
};

checkoutForm.onsubmit = e => {
    e.preventDefault();
    const quoteId = quoteInput.value.trim();
    if (quoteId) void startRun('checkout', { quoteId });
};

byId('clear').onclick = () => {
    if (active) return;
    timeline.replaceChildren(h('li', { class: 'empty muted' }, 'Run a tool to start. Each elicitation opens as a dialog from the server.'));
    wireList.replaceChildren();
    round = 0;
};

byId<HTMLInputElement>('show-wire').onchange = e => {
    document.body.classList.toggle('hide-wire', !(e.target as HTMLInputElement).checked);
};

void refreshStatus();
