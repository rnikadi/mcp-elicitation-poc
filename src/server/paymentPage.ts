import type { Payment, Quote } from './store.js';

// A mock payment provider page. The card form posts straight back to the
// server, never to the MCP client: that is the point of URL mode.
//
// Demo shortcut: a real page MUST check that the person opening it is the
// same user who started the checkout (for example with a session cookie),
// or a shared link could be paid or hijacked by someone else.

const escape = (s: string) =>
    s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function layout(title: string, body: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --fg:#1a1d21; --muted:#5f6670; --accent:#3b5bdb; --line:#dde1e6; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14161a; --card:#1d2025; --fg:#e8eaed; --muted:#9aa1ab; --accent:#748ffc; --line:#30343b; } }
  body { margin:0; font:16px/1.5 system-ui, sans-serif; background:var(--bg); color:var(--fg); display:grid; place-items:center; min-height:100vh; padding:16px; box-sizing:border-box; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:28px; width:100%; max-width:420px; box-sizing:border-box; }
  h1 { font-size:20px; margin:0 0 4px; }
  .muted { color:var(--muted); font-size:14px; }
  .amount { font-size:32px; font-weight:700; margin:16px 0; }
  label { display:block; font-size:13px; color:var(--muted); margin:12px 0 4px; }
  input { width:100%; box-sizing:border-box; padding:10px; border:1px solid var(--line); border-radius:8px; background:transparent; color:inherit; font:inherit; }
  .row { display:flex; gap:12px; } .row > div { flex:1; }
  .actions { display:flex; gap:12px; margin-top:20px; }
  button { flex:1; padding:12px; border-radius:8px; font:inherit; font-weight:600; cursor:pointer; border:1px solid var(--line); background:transparent; color:inherit; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  .badge { display:inline-block; font-size:12px; padding:2px 8px; border-radius:99px; border:1px solid var(--line); color:var(--muted); }
</style>
</head>
<body><main class="card">${body}</main></body>
</html>`;
}

export function renderPaymentPage(payment: Payment, quote: Quote): string {
    if (payment.status !== 'pending') {
        return renderDone(payment);
    }
    return layout(
        'Demo Pay',
        `<span class="badge">Demo Pay · test mode</span>
<h1>Pay for your trip</h1>
<div class="muted">Quote ${escape(quote.id)} · ${escape(quote.destination)} · ${quote.nights} nights · ${quote.travelers} traveler(s)</div>
<div class="amount">€${quote.totalEur}</div>
<form method="post">
  <label for="card">Card number</label>
  <input id="card" name="card" value="4242 4242 4242 4242" autocomplete="off">
  <div class="row">
    <div><label for="exp">Expiry</label><input id="exp" name="exp" value="12/30"></div>
    <div><label for="cvc">CVC</label><input id="cvc" name="cvc" value="123"></div>
  </div>
  <div class="actions">
    <button type="submit" formaction="/pay/${payment.id}/cancel">Cancel</button>
    <button type="submit" class="primary" formaction="/pay/${payment.id}/confirm">Pay €${quote.totalEur}</button>
  </div>
</form>
<p class="muted">These card details stay between your browser and this server. The MCP client never sees them.</p>`
    );
}

export function renderDone(payment: Payment): string {
    const message =
        payment.status === 'paid'
            ? `<h1>Payment complete</h1><p>Confirmation <strong>${escape(payment.confirmationCode ?? '')}</strong>.</p>`
            : `<h1>No payment taken</h1><p>This checkout was cancelled.</p>`;
    return layout('Demo Pay', `${message}<p class="muted">You can close this tab and return to your terminal.</p>`);
}

export function renderNotFound(): string {
    return layout('Demo Pay', `<h1>Link not found</h1><p class="muted">This payment link is unknown or has expired.</p>`);
}
