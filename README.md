# Ukrainian Flash Cards

A local-first PWA for studying Ukrainian vocabulary with parallel Russian, English, and Finnish. Progress uses a simple spaced-repetition schedule and stays in this browser (`localStorage` key `ukr-cards-v3`). Nothing is uploaded except translation requests when you add new words.

## Files

- `language-cards.html` — the app (UI + logic)
- `ukr-cards-categorized.json` — vocabulary bundle loaded on first visit
- `lexicon.json` — high-frequency lemma dictionary (tried before machine translation)
- `index.html` — redirect shim to `language-cards.html`
- `manifest.json` — PWA manifest
- `sw.js` — service worker (network-first for HTML/JSON, never caches `/api/`)
- `icon.svg` — app icon
- `server.mjs` — optional translation server (static host + `/api/translate` proxy; holds the DeepSeek key)
- `tests/logic.test.mjs` — logic checks (no browser)
- `tests/server.test.mjs` — server checks (no browser)
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
| `PORT` / `HOST` | `8787` / `0.0.0.0` | listen address |
| `RATE_PER_MIN` / `RATE_BURST` | `60` / `20` | per-client token bucket |
| `IP_DAILY_CAP` | `500` | requests per client per UTC day |
| `GLOBAL_DAILY_CAP` | `2000` | requests per UTC day across all clients — the budget guard |
| `ALLOWED_ORIGINS` | any | comma-separated browser origins allowed to call the API |
| `CLIENT_TOKEN` | — | optional shared secret, required in `x-app-token` (closed deployments) |
| `TRUST_PROXY` | off | `1` to take the client IP from `x-forwarded-for` — set it behind a load balancer, or every client shares one bucket |
| `MAX_INPUT_CHARS` | `200` | longest accepted input |

`POST /api/translate` takes `{q, source, target}` and returns `{text, remaining}`; `GET /api/health`
returns the model, the configured limits and the caller's remaining quota (never the key). Answers are
cleaned and validated server-side (empty, identical-to-source and wrong-script results are rejected),
mirroring the client-side checks. Rate limits are in-memory and single-process: a restart forgives
rate limits but never the spent budget, so keep `GLOBAL_DAILY_CAP` where you want the ceiling.

Deploy it anywhere that runs Node (Fly.io, Railway, Render, a VPS) — it is not a static host, because
the key lives in the process environment. `sw.js` never caches `/api/`, so health checks and
translations always reach the server.

## Study

- **Words** — paste one entry per line (phrases with commas are fine). Common lemmas hit a built-in dictionary (`lexicon.json`); otherwise the preferred provider is used, then the other if the result looks empty, identical, or the wrong script. After adding, the new deck opens for review. Click a translation to edit it; **↻** re-translates that cell.
- **Quiz** — sessions take due cards first, then new, then the rest. **Due only** matches the header (studied cards that are due), not unseen cards. Answers save as you go; canceling keeps progress on cards you already answered.
- **Decks / Settings / Help** — manage decks, quiz direction, audio, export/import.

## Data

- Export / import a JSON backup from Settings. Import offers **Merge**, **Replace all**, or **Cancel**.
- If the browser storage quota is full, the app warns instead of failing silently — export a backup, then delete unused words.
- Installed copies update the HTML, card JSON, and lexicon over the network (service worker cache `ukr-cards-v3`). Other assets stay cache-first.

## Deploying

Any static host works. HTML and JSON are fetched network-first, so shipped updates reach installed users without a cache-name bump. Bump `CACHE_VERSION` in `sw.js` when changing other cached assets (icon, manifest).

## Privacy

No accounts and no telemetry. Dictionary hits stay on-device. Anything not in the lexicon is sent to Google Translate’s public `gtx` endpoint and/or MyMemory — or, if you deploy `server.mjs` and select **App server**, to your own server, which forwards it to DeepSeek with a key the browser never sees.
