# 5-minute demo run sheet

## Before you start (2 minutes, before the audience arrives)

```sh
docker compose up --build -d
docker compose ps                 # server, web-backend and web should be "healthy"
```

- Open a browser tab ready to paste the payment link into.
- Use a large terminal font, about 100 columns wide.
- Keep [`demo.mp4`](demo.mp4) open in another tab as a fallback.

Start the client:

```sh
docker compose run --rm client
```

## The demo

Each scenario is about 30 to 45 seconds. Talking points are in *italics*.

### 1. Form mode, accept (the happy path)

1. Menu: **Show protocol messages**. *"We'll watch the actual JSON-RPC."*
2. Menu: **Plan a trip**, destination `Lisbon`.
3. Point at the `← server to client` block: `resultType: "input_required"` and `inputRequests.trip_details`
   with `mode: "form"`. *"The server doesn't call us back. It answers the tool call with 'I need input'. That's new in 2026-07-28."*
4. **Fill in the form**: `2026-12-01`, Enter, Enter, Premium economy, tick breakfast, `ada@example.com`.
5. Show the review screen. *"The spec requires the user to see and edit what they send, and to know which server is asking."*
6. **Send**. Point at `→ client to server`: same tool call, new id, `inputResponses` carrying `action: "accept"`.
7. Quote comes back (€1170).

### 2. Form mode, decline and cancel

1. **Plan a trip** again, then choose **Decline**. Reply: *"No trip planned. You declined..."*
2. **Plan a trip** again, then press **Ctrl+C** at the first question. Reply: *"...was dismissed. Ask again whenever."*
   *"Decline is an explicit no. Cancel means the user walked away. Servers should treat them differently."*

### 3. URL mode, accept and pay

1. **Hide protocol messages** to keep the screen calm (optional).
2. **Check out quote Q-...**.
3. Point at the consent screen: full link, host highlighted. *"Card numbers must never pass through the client
   or the LLM, so the server sends a URL instead. The client shows the exact link and doesn't touch it."*
4. **Open it**, then paste the link into the browser and show the payment page. Click **Pay**.
5. Terminal: **Booked! ... Confirmation TRIP-...**. *"Accept only meant 'I'll go to the page'. The server learned
   the payment result from its own page, not from the client."*

### 4. URL mode, decline, cancel, and cancel on the page (pick one if short on time)

- Plan a new trip, check out, choose **Decline**: *"Payment declined. Quote still on hold."*
- Check out, press **Ctrl+C**: *"Checkout dismissed. Nothing charged."*
- Check out, **Open it**, click **Cancel on the web page**: *"You cancelled on the payment page."* This shows that
  the client said accept, but the real outcome happened out of band.

### Close (30 seconds)

*"Two modes: form for ordinary data, URL for anything sensitive. Three answers: accept, decline, cancel. And on
2026-07-28 it's all request and retry, with signed requestState, so the server can stay stateless between rounds."*

## Browser version (same scenarios, no terminal)

`docker compose up --build -d` also starts the web app. Open **http://localhost:8080** and wait for the green
"Trip Planner (elicitation demo)" pill at the top right.

1. **Form accept.** Destination `Lisbon`, **Plan trip**. The dialog names the server that is asking and shows the
   form built from the server's JSON Schema. Fill it in, **Review →** shows the exact JSON that will be sent, then
   **Send**. Point at the Protocol panel: `input_required`, then the retry with `inputResponses`.
2. **Form decline and cancel.** Plan again and press **Decline**; plan again and press **Esc**.
3. **URL accept.** **Check out Q-... →** on the quote. The dialog highlights the host and shows the full link.
   **Open link** opens the payment page in a new tab; press **Pay** there and come back to the booking.
4. **URL decline and cancel.** Check out again and press **Decline**, then again and press **Cancel**.

The demo checklist on the left ticks off each of the six paths. *"The browser is the UI; the backend is the MCP
client. Card details go from the payment page straight to the server, never through either of them."*

## If something goes wrong

| Problem | Fix |
| --- | --- |
| Client says it can't connect | `docker compose ps`. Wait for `healthy`, or check `docker compose logs server` |
| Payment link doesn't open | Make sure nothing else uses port 3000 on the host. The link must be `http://localhost:3000/...` |
| Took too long on the page | The client asks "Check again?". Answer yes |
| Web app says "Connecting…" | `docker compose logs web-backend`. It retries until the server is up |
| Payment tab didn't open | The browser blocked the pop-up. Use **Open the payment page again** in the activity list |
| Anything else | Play `docs/demo.mp4` |

Reset between rehearsals with `docker compose restart server`. State is in memory.
