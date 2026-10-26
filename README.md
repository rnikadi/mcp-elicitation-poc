# MCP elicitation demo

A small, runnable demo of [MCP elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)
on the **2026-07-28** spec. It covers both modes, plus all three ways a user can answer (accept, decline, cancel):

| Mode | Tool | What the server asks for | Why this mode |
| --- | --- | --- | --- |
| **Form** | `plan_trip` | Dates, nights, travelers, cabin, extras, email | Ordinary details the client may see, collected from a flat JSON Schema |
| **URL** | `checkout` | Card payment on a hosted page | Card data must **never** pass through the MCP client |

There are two clients for the same server: a **web app** (browser UI plus a TypeScript backend) and a
**terminal client**.

![Web app](docs/web-app.png)

## Run it

You need Docker. Everything runs from Docker Compose.

```sh
docker compose up --build -d      # MCP server, payment page, and the web app
```

Then open **http://localhost:8080**. Plan a trip, fill in the form the server asks for, then check out and pay
on the page that opens in a new tab. Every elicitation opens as a dialog with **Decline** and **Cancel** next to
the main button (Esc also cancels), the right-hand panel shows each JSON-RPC round, and the demo checklist ticks
off all six accept/decline/cancel paths as you go.

| Service | What it is | Port |
| --- | --- | --- |
| `server` | Trip planner MCP server (`/mcp`) and the payment page (`/pay/...`) | `localhost:3000` |
| `web-backend` | Web app backend: the **MCP client**. Runs tool calls and relays elicitations to the browser over SSE | internal `3001` |
| `web` | Web app frontend: TypeScript UI built with Vite, served by nginx, which proxies `/api` to the backend | `localhost:8080` |
| `client` | Interactive terminal client (profile `client`, not started by `up`) | n/a |

### Terminal client

```sh
docker compose run --rm client    # interactive terminal client
```

The client opens a menu. Pick **Plan a trip**, fill in the form, then **Check out**. When the client prints
the payment link, open it in your browser and press **Pay** (or **Cancel**). Choose **Show protocol messages**
in the menu, or start the client with `SHOW_PROTOCOL=1 docker compose run --rm client`, to see every JSON-RPC round.

Stop everything with `docker compose down`.

**Without Docker** (Node 22+): `npm install`, then `npm run dev:server` in one terminal and `npm run dev:client`
in another. For the web app, run `npm run dev:server`, `npm run dev:web-backend` and `npm run dev:web` (three
terminals), then open http://localhost:5173.

### How the web app is wired

```text
browser (localhost:8080)          web-backend (MCP client)              server (MCP server)
  │ POST /api/runs plan_trip ───────▶│ tools/call plan_trip ──────────────▶│
  │                                  │◀── input_required (form) ───────────│
  │◀── SSE: prompt {form, schema} ───│                                     │
  │ renders form, user reviews       │                                     │
  │ POST /api/runs/:id/prompts/:p ──▶│ tools/call + inputResponses ───────▶│
  │◀── SSE: done {quote} ────────────│◀── result ──────────────────────────│
```

The backend reuses the terminal client's MRTR loop (`runTool` in `src/client/flow.ts`) with a different `Ui`:
each question becomes an SSE event, and the browser's POST answers it. The browser reuses the same schema and
URL-review helpers. For URL mode the browser opens the payment page itself; neither the frontend nor the backend
fetches it. If the page is closed while a dialog is open, the backend answers `cancel` after 5 seconds, since
the user dismissed it without choosing.

For presenting, see the [5-minute run sheet](docs/run-sheet.md). If the live demo fails, there's a recording
in [`docs/demo.mp4`](docs/demo.mp4) (or `asciinema play docs/demo.cast`).

## How elicitation works on 2026-07-28

This spec revision replaced server-to-client requests with **multi round-trip requests (MRTR)**. The server
no longer sends `elicitation/create` while it holds the tool call open. Instead it *answers* the tool call with
`input_required`, and the client retries:

```text
client                                   server
  │ tools/call plan_trip {destination}      │
  │────────────────────────────────────────▶│ needs details
  │   resultType: input_required            │
  │   inputRequests.trip_details =          │
  │     elicitation/create (mode: form)     │
  │◀────────────────────────────────────────│
  │ user fills in the form                  │
  │ tools/call plan_trip (new request id)   │
  │   inputResponses.trip_details =         │
  │     { action: accept, content: {...} }  │
  │────────────────────────────────────────▶│ validates, prices
  │   result: Quote Q-1A2B3C, €1210         │
  │◀────────────────────────────────────────│
```

URL mode uses the same loop, plus an opaque `requestState` that the client must echo back unchanged:

1. `checkout` returns `input_required` with an `elicitation/create` in **URL mode** (`url: http://localhost:3000/pay/<uuid>`)
   and a signed `requestState` that records which payment session this is.
2. The client shows the full URL with the host highlighted and asks for consent. It never fetches the link itself.
3. On **accept** the user pays in the browser, and the card form posts straight to the server. The client retries
   the call with `{ action: "accept" }` and the same `requestState`.
4. The server reads the state, waits for the payment page to report back, and returns the booking. If the payment
   is still pending after 60 seconds, it returns `input_required` again with only `requestState`, and the client
   offers to check again.

**Accept** only means "the user agreed to open the link". The server learns the outcome from its own records,
never from the client.

### Accept, decline, cancel

| Action | Meaning | Form mode (`plan_trip`) | URL mode (`checkout`) |
| --- | --- | --- | --- |
| `accept` | User submitted / agreed | Validates and returns a quote. Re-asks if the data is invalid | Waits for the page, then books, or reports a cancel on the page |
| `decline` | User explicitly said no | "You declined to share trip details" | "Payment declined. Quote still on hold" |
| `cancel` | User dismissed it (Esc, Ctrl+C) | "Dismissed, ask again whenever" | "Checkout dismissed. Nothing charged" |

## What to look at in the code

| File | Shows |
| --- | --- |
| [`src/server/tools/planTrip.ts`](src/server/tools/planTrip.ts) | `inputRequired.elicit`, the restricted schema (date, integer range, titled enum, multi-select, email), server-side re-validation with `acceptedContent` |
| [`src/server/tools/checkout.ts`](src/server/tools/checkout.ts) | `inputRequired.elicitUrl`, signed `requestState`, waiting for out-of-band completion, capability check |
| [`src/server/app.ts`](src/server/app.ts) | `createRequestStateCodec` (HMAC, TTL, binding), stateless `createMcpHandler`, Host header validation, payment routes |
| [`src/client/flow.ts`](src/client/flow.ts) | The client side of the MRTR loop: answer `inputRequests`, retry with `inputResponses` and the exact `requestState` |
| [`src/client/terminalUi.ts`](src/client/terminalUi.ts) | Required client UX: which server is asking, review before sending, decline and cancel everywhere, URL consent |
| [`src/client/url.ts`](src/client/url.ts) | URL review: full link, highlighted host, warnings for non-HTTPS, Punycode, odd schemes |
| [`src/web/backend/runs.ts`](src/web/backend/runs.ts) | Web backend: a `Ui` that turns each elicitation into an event and waits for the browser's answer; closing the page counts as cancel |
| [`src/web/backend/app.ts`](src/web/backend/app.ts) | Web backend HTTP API: start a run, stream its events (SSE), answer a prompt |
| [`src/web/frontend/main.ts`](src/web/frontend/main.ts) | Browser UI: renders form-mode schemas as forms with a review step, URL consent dialog, Esc as cancel, protocol panel |

Built with the TypeScript SDK v2 (`@modelcontextprotocol/server` and `@modelcontextprotocol/client` 2.4.0).

## Security notes (and demo shortcuts)

What the demo does, following the spec:

- No sensitive data in form mode. Card details only ever go to the payment page (URL mode).
- The server re-validates every accepted form answer. It treats client input as untrusted.
- `requestState` is HMAC-signed, expires after 15 minutes, and is bound to the method, so a tampered state is rejected.
- Payment URLs carry only an unguessable session id: no user data and nothing pre-authenticated.
- The server never sends a mode the client didn't declare. A form-only client gets a clear error from `checkout`.
- `/mcp` checks the Host header to block DNS rebinding.

What a production server must add:

- **Real user identity.** Use MCP authorization, and bind `requestState` and the payment session to the user's `sub`.
- **Phishing protection on the URL page.** The page must check that the person who opens it is the same user who
  started the checkout (for example with a session cookie). Otherwise a shared link could be completed by someone
  else, which is the account-takeover risk the spec describes.
- HTTPS everywhere, persistent storage, and a shared `STATE_SECRET` across instances.

## Development

```sh
npm install
npm test           # 35 tests: server, terminal client flow, web backend, over real HTTP
npm run typecheck
npm run smoke      # end-to-end check against a running server (used in CI)
npm run smoke:web  # end-to-end check through the web app on :8080 (used in CI)
```

CI (GitHub Actions) runs typecheck, tests and build, then brings the stack up with Docker Compose and runs both
smoke tests.

To re-record the demo: start the server, then run `python3 scripts/record-demo.py`. This writes `docs/demo.cast`.
