// Helpers for turning a form-mode requestedSchema into prompts. The spec
// limits it to a flat object of primitives, so each property maps to one
// question. Kept pure so it can be unit tested.

export type Field =
    | { kind: 'text'; key: string; label: string; required: boolean; default?: string; format?: string; minLength?: number; maxLength?: number }
    | { kind: 'number'; key: string; label: string; required: boolean; default?: number; integer: boolean; min?: number; max?: number }
    | { kind: 'boolean'; key: string; label: string; required: boolean; default?: boolean }
    | { kind: 'select'; key: string; label: string; required: boolean; default?: string; options: Array<{ value: string; title: string }> }
    | { kind: 'multi'; key: string; label: string; required: boolean; default?: string[]; options: Array<{ value: string; title: string }>; minItems?: number; maxItems?: number };

type Prop = Record<string, any>;

export function fieldsFromSchema(schema: { properties: Record<string, Prop>; required?: string[] }): Field[] {
    const required = new Set(schema.required ?? []);
    return Object.entries(schema.properties).map(([key, p]) => {
        const base = { key, label: labelFor(key, p), required: required.has(key) };
        if (p.type === 'boolean') return { kind: 'boolean', ...base, default: p.default };
        if (p.type === 'number' || p.type === 'integer') {
            return { kind: 'number', ...base, default: p.default, integer: p.type === 'integer', min: p.minimum, max: p.maximum };
        }
        if (p.type === 'array') {
            const items = p.items ?? {};
            const options = items.anyOf
                ? items.anyOf.map((o: Prop) => ({ value: o.const, title: o.title ?? o.const }))
                : (items.enum ?? []).map((v: string) => ({ value: v, title: v }));
            return { kind: 'multi', ...base, default: p.default, options, minItems: p.minItems, maxItems: p.maxItems };
        }
        if (p.oneOf || p.enum) {
            const options = p.oneOf
                ? p.oneOf.map((o: Prop) => ({ value: o.const, title: o.title ?? o.const }))
                : p.enum.map((v: string, i: number) => ({ value: v, title: p.enumNames?.[i] ?? v }));
            return { kind: 'select', ...base, default: p.default, options };
        }
        return {
            kind: 'text',
            ...base,
            default: p.default,
            format: p.format,
            minLength: p.minLength,
            maxLength: p.maxLength
        };
    });
}

function labelFor(key: string, p: Prop): string {
    const title = p.title ?? key;
    return p.description ? `${title} (${p.description})` : title;
}

/** Returns an error message, or undefined if the value is acceptable. */
export function checkText(field: Extract<Field, { kind: 'text' }>, value: string): string | undefined {
    if (!value) return field.required ? 'Required' : undefined;
    if (field.minLength !== undefined && value.length < field.minLength) return `At least ${field.minLength} characters`;
    if (field.maxLength !== undefined && value.length > field.maxLength) return `At most ${field.maxLength} characters`;
    switch (field.format) {
        case 'email':
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? undefined : 'Enter an email address';
        case 'date':
            return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) ? undefined : 'Use YYYY-MM-DD';
        case 'date-time':
            return Number.isNaN(Date.parse(value)) ? 'Use an ISO date-time' : undefined;
        case 'uri':
            return URL.canParse(value) ? undefined : 'Enter a full URL';
    }
    return undefined;
}

export function checkMulti(field: Extract<Field, { kind: 'multi' }>, values: string[]): string | undefined {
    if (field.minItems !== undefined && values.length < field.minItems) return `Pick at least ${field.minItems}`;
    if (field.maxItems !== undefined && values.length > field.maxItems) return `Pick at most ${field.maxItems}`;
    return undefined;
}
