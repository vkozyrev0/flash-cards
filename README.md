# Ukrainian Flash Cards

A local-first PWA for studying Ukrainian vocabulary with parallel Russian, English, and Finnish. Progress uses a simple spaced-repetition schedule and stays in this browser (`localStorage` key `ukr-cards-v3`). Nothing is uploaded except translation requests when you add new words.

## Files

- `language-cards.html` — the app (UI + logic)
- `ukr-cards-categorized.json` — vocabulary bundle loaded on first visit
- `lexicon.json` — high-frequency lemma dictionary (tried before machine translation)
- `index.html` — redirect shim to `language-cards.html`
- `manifest.json` — PWA manifest
- `sw.js` — service worker (network-first for HTML/JSON, never caches `/api/`)
- `icon.svg` — vector app icon
- `icon-180.png`, `icon-192.png`, `icon-512.png` — raster icons for iOS and the PWA manifest
- `robots.txt` — crawl policy (API and bundles disallowed; the server enforces the same paths)
- `server.mjs` — optional translation server (static host + `/api/translate` proxy; holds the DeepSeek key)
- `Dockerfile`, `.dockerignore`, `fly.toml` — the API-only Fly.io deployment (see below)
- `tests/logic.test.mjs` — logic checks (no browser)
- `tests/server.test.mjs` — server checks (no browser)
- `tests/browser.test.mjs` — opt-in headless browser checks (needs Edge/Chrome; set `EDGE_PATH` if it is not the default Windows path)
- `tests/live-provider.test.mjs` — opt-in check against the real DeepSeek API (needs `DEEPSEEK_API_KEY`)
- `README.md` — this file
- `.gitignore` — local scratch dirs, OS and editor cruft

## Run it

Open `language-cards.html` over HTTP (not `file://` if you want the service worker and JSON bundle):

```bash
npx --yes serve .
# or: python -m http.server 8765
```

Then visit the printed URL. `index.html` redirects to the app.

Logic checks (no browser): `node tests/logic.test.mjs`
Server checks (no browser): `node tests/server.test.mjs`
Browser flows (opt-in, headless Edge/Chrome): `node tests/browser.test.mjs`

First visit loads ~5,875 cards from `ukr-cards-categorized.json`. After that the pool is yours: deleting a card is sticky, and **Settings → Sync with bundle** only adds *new* bundled cards (not ones you deleted).

## Optional translation server

`server.mjs` serves the app and proxies translation to DeepSeek, so the API key stays in the process
environment and never reaches the browser. Without it the app behaves exactly as before (Google `gtx`,
then MyMemory); with it, choose **App server** under Settings → Translation → Default provider — the
Settings screen probes `/api/health` and says whether a server answered.

```bash
DEEPSEEK_API_KEY=sk-... node server.mjs        # http://localhost:8787
```

| Env var | Default | Purpose |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | — | required for `/api/translate`; without it the app is still served and the proxy answers 503 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | upstream base URL |
| `DEEPSEEK_MODEL` | `deepseek-flash` | model used for translation |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | listen address. Set `HOST=0.0.0.0` in a container or to serve the LAN |
| `RATE_PER_MIN` / `RATE_BURST` | `60` / `20` | per-client token bucket |
| `IP_DAILY_CAP` | `500` | requests per client per UTC day |
| `GLOBAL_DAILY_CAP` | `2000` | requests per UTC day across all clients — the budget guard |
| `ALLOWED_ORIGINS` | `localhost,null` | comma-separated browser origins allowed to call the API. Same-origin requests are always allowed, so the app served by this process works without listing its public hostname. Two tokens cover a locally-served app: `localhost` matches `http(s)://localhost:*` and `http://127.0.0.1:*` on any port, and `null` matches the origin a page opened from `file://` sends. An explicit empty value allows any origin (not recommended). Requests with no `Origin` (curl, monitors) are always allowed |
| `SERVE_STATIC` | on | `0` makes the deployment API-only: only `/api/translate`, `/api/health` and `/robots.txt` are served, so the app can stay on your own disk |
| `CLIENT_TOKEN` | — | optional shared secret, required in `x-app-token` (closed deployments) |
| `TRUST_PROXY` | off | `1` behind a proxy. Prefers `fly-client-ip` when the process is running on Fly (`FLY_APP_NAME` is set), otherwise takes the **last** `x-forwarded-for` hop (the one your proxy appended). Earlier hops are client-supplied and must not be trusted; behind a CDN, configure the CDN to pass the real address |
| `MAX_INPUT_CHARS` | `200` | longest accepted input |
| `HEADERS_TIMEOUT_MS` | `10000` | deadline for a client to finish sending request headers |
| `REQUEST_TIMEOUT_MS` | `25000` | deadline for a whole request (above the upstream timeout, so a slow upstream reports as 502) |
| `KEEP_ALIVE_TIMEOUT_MS` | `5000` | idle keep-alive timeout |
| `MAX_REQUESTS_PER_SOCKET` | `100` | requests allowed on one connection before it is closed |
| `MAX_HEADERS_COUNT` / `MAX_HEADER_BYTES` | `100` / `8192` | header count and size caps (exceeding either is a 431) |
| `MAX_INFLIGHT` | `128` | requests in flight before any path starts shedding |
| `API_MAX_INFLIGHT` | `8` | requests in flight before `/api/*` starts shedding |
| `MAX_CONNECTIONS` / `MAX_CONNECTIONS_PER_IP` | `512` / `32` | open sockets allowed in total and per peer address. Behind a proxy the peer is the proxy itself, so the per-IP cap is effectively deployment-wide |
| `BOT_POLICY` | `block` | `off` to serve crawlers on the protected paths |
| `BOT_PATTERNS` | — | extra comma-separated User-Agent substrings to treat as crawlers |

`POST /api/translate` takes `{q, source, target}` and returns `{text, remaining}`; `GET /api/health`
returns the model, the configured limits, the caller's remaining quota, the live in-flight and
connection counts, and the refusal counters (never the key). Answers are cleaned and validated
server-side (empty, identical-to-source and wrong-script results are rejected), mirroring the
client-side checks.

Deploy it anywhere that runs Node (Fly.io, Railway, Render, a VPS) — it is not a static host, because
the key lives in the process environment. `sw.js` never caches `/api/`, so health checks and
translations always reach the server.

The upstream call disables DeepSeek's thinking mode (`thinking: { type: 'disabled' }`). That is not
cosmetic: `deepseek-flash` defaults to thinking, which spends the whole `max_tokens` budget on
`reasoning_content` and returns an empty `content` with `finish_reason: "length"` — measured against
the live API. Without it the proxy records `upstream returned reasoning only (thinking mode)` and the
client receives a generic 502.

### Deploying the server only (app stays local)

Set `SERVE_STATIC=0` and the deployment serves only the API plus `robots.txt`; the app keeps working
from your own disk or host and reaches the remote server for translation:

1. Serve the app locally (any static host, or `python -m http.server 8765`) and open it.
2. Settings → Translation → **Translation server** → paste the server URL, for example
   `https://flash-cards-ukr.fly.dev`.
3. Settings → **Default provider** → **App server**. The line under it says whether the server
   answered, and how much of your daily quota is left.

The server needs `ALLOWED_ORIGINS=localhost,null` for that setup, so a page on `localhost:<any port>`
or opened from `file://` may call it. `fly.toml` and the `Dockerfile` in this repo are that deployment
(API-only image, `ams` region, scale-to-zero, secrets for the key and the origin list):

```bash
fly apps create flash-cards-ukr                       # or change app = ... in fly.toml and every -a below
fly secrets set -a flash-cards-ukr DEEPSEEK_API_KEY=sk-...         # never in fly.toml
fly secrets set -a flash-cards-ukr ALLOWED_ORIGINS=localhost,null  # secrets override [env]
fly deploy
```

`node tests/live-provider.test.mjs` exercises the real provider through the shipped server (it skips
loudly without `DEEPSEEK_API_KEY`). It is what catches provider behaviour a stub cannot have — the
thinking-mode regression above is exactly that.

## What the server defends against

Everything a single Node process can defend, with every bound configurable and every refusal counted:

- **Slow and half-open clients.** A connection that opens and never finishes its headers, or dribbles
  them, is closed by an explicit deadline (`HEADERS_TIMEOUT_MS`). This does not rely on Node's
  `headersTimeout`, which is only enforced on the `connectionsCheckingInterval` tick — with the 30 s
  default, a 10 s bound would go unenforced for up to 30 s. A whole-request deadline
  (`REQUEST_TIMEOUT_MS`) answers 408 if the body stalls.
- **Header floods.** Header count and size are capped (`MAX_HEADERS_COUNT`, `MAX_HEADER_BYTES`);
  the parser answers 431 before any handler runs.
- **Connection floods.** Total and per-IP socket caps (`MAX_CONNECTIONS`, `MAX_CONNECTIONS_PER_IP`)
  drop excess connections immediately, and `MAX_REQUESTS_PER_SOCKET` stops one connection from
  being reused forever.
- **Request floods.** Concurrency is bounded (`MAX_INFLIGHT`, and a tighter `API_MAX_INFLIGHT` for
  the money path). Past the cap a request gets **503 with `retry-after`** immediately instead of
  being queued — queueing is what turns overload into a stall. Service resumes as soon as load
  drops.
- **Crawlers.** `robots.txt` declares the policy (the API and both bundles are disallowed) and the
  server enforces the same paths for known crawler and browser-automation User-Agents with a 403.
  The app page, `robots.txt` and `/api/health` stay reachable, so monitors and page crawlers are
  unaffected. `BOT_POLICY=off` disables the block.
- **Observability.** Every refusal increments a counter by reason (`rate_limit`, `ip_daily_cap`,
  `global_daily_cap`, `concurrency_shed`, `connection_cap`, `bot_blocked`, `timeout`,
  `headers_too_large`, `body_too_large`, `bad_request`, `origin_not_allowed`, `app_token`,
  `upstream_failed`), readable at `GET /api/health` and logged. Logging is throttled to 20
  lines/second so a flood cannot exhaust the process through its own log.

### What this cannot do

A volumetric or distributed (L3/L4) flood has to be absorbed at the edge — CDN, cloud connection
limits, scrubbing — before it reaches this process. Nothing in `server.mjs` stops that, and the
in-memory limits and counters are per-instance and reset on restart: a horizontally scaled deployment
would need shared state, which is deliberately out of scope here. The Fly config scales to zero, so
the daily caps restart with the machine and bound one warm window, not a UTC day. For a hard daily
ceiling, set `auto_stop_machines = false` and `min_machines_running = 1`, or move the counters to
shared storage. `User-Agent` matching and `robots.txt` are advisory (a hostile client can spoof a UA
and ignore robots); they cut crawler cost,
they are not a security boundary — the rate and concurrency caps are what actually bound a caller.
For a public deployment, put a CDN in front and set `TRUST_PROXY=1` so the per-client limits see the
real client IP. The server trusts the last `x-forwarded-for` hop or `fly-client-ip`, never the earlier
client-supplied hops. A CDN in front of Fly needs its own trusted-proxy configuration, because Fly then
sees the CDN address rather than the visitor.

## Study

- **Words** — paste one entry per line (phrases with commas are fine). Common lemmas hit a built-in dictionary (`lexicon.json`); otherwise the preferred provider is used, then the other if the result looks empty, identical, or the wrong script. After adding, the new deck opens for review. Click a translation to edit it; **↻** re-translates that cell.
- **Quiz** — sessions take due cards first, then new, then the rest. **Due only** matches the header (studied cards that are due), not unseen cards. Answers save as you go; canceling keeps progress on cards you already answered.
- **Decks / Settings / Help** — manage decks, quiz direction, audio, export/import.

## Data

- Export / import a JSON backup from Settings. Import offers **Merge**, **Replace all**, or **Cancel**.
- If the browser storage quota is full, the app warns instead of failing silently — export a backup, then delete unused words.
- Installed copies update the HTML, card JSON, and lexicon over the network (service worker cache `ukr-cards-v3`). The icon and other cached assets are cache-first. Browsers fetch `manifest.json` outside the service worker, so the SW's copy does not affect which manifest they read.
- A state saved by an older bundle is migrated when it loads: the cards the old bundle collapsed are moved to their distinct ids. Run **Sync with bundle** once after the upgrade to pull the plain words in beside them.

## Deploying

Any static host works. HTML and JSON are fetched network-first, so shipped updates reach installed users without a cache-name bump. Bump `CACHE_VERSION` in `sw.js` when changing the cached icons. Browsers fetch `manifest.json` outside the service worker, so the manifest needs no bump for the browser to see it (the SW still precaches a copy for the offline shell).

## Privacy

No accounts and no telemetry. Dictionary hits stay on-device. Anything not in the lexicon is sent to Google Translate’s public `gtx` endpoint and/or MyMemory — or, if you deploy `server.mjs` and select **App server**, to your own server, which forwards it to DeepSeek with a key the browser never sees.
