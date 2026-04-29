// Mustache-lite engine: only {{var}} substitution. No conditionals, no expressions.
// Unknown placeholders are replaced with empty string and logged separately by caller.

const TOKEN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;

const builtins = (): Record<string, string> => {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return {
    today_date: `${yyyy}-${mm}-${dd}`,
    current_year: String(yyyy),
  };
};

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export interface RenderResult {
  output: string;
  missing: string[];
}

const lookup = (vars: Record<string, unknown>, key: string): unknown => {
  if (key in vars) return vars[key];
  // dotted path
  if (key.includes('.')) {
    const parts = key.split('.');
    let cur: unknown = vars;
    for (const p of parts) {
      if (cur && typeof cur === 'object' && p in (cur as any)) cur = (cur as any)[p];
      else return undefined;
    }
    return cur;
  }
  return undefined;
};

export const render = (
  template: string,
  vars: Record<string, unknown>,
  opts: { html?: boolean } = {}
): RenderResult => {
  const all = { ...builtins(), ...vars };
  const missing = new Set<string>();
  const output = template.replace(TOKEN, (_m, key: string) => {
    let val = lookup(all, key);
    if (val === undefined || val === null) {
      missing.add(key);
      val = '';
    }
    const str = String(val);
    return opts.html ? escapeHtml(str) : str;
  });
  return { output, missing: [...missing] };
};

export const buildVars = (recipient: {
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  payload_json?: unknown;
}, global: Record<string, unknown> = {}): Record<string, unknown> => {
  const fn = recipient.first_name || '';
  const ln = recipient.last_name || '';
  const fullName = [fn, ln].filter(Boolean).join(' ').trim();
  const extras = (recipient.payload_json && typeof recipient.payload_json === 'object')
    ? (recipient.payload_json as Record<string, unknown>)
    : {};
  return {
    ...global,
    ...extras,
    email: recipient.email,
    first_name: fn,
    last_name: ln,
    full_name: fullName || recipient.email,
  };
};
