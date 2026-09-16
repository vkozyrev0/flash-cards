# Ukrainian Flash Cards

A local-first PWA for studying Ukrainian vocabulary with parallel Russian, English, and Finnish. Progress uses a simple spaced-repetition schedule and stays in this browser (`localStorage` key `ukr-cards-v3`). Nothing is uploaded except translation requests when you add new words.

## Files

- `language-cards.html` — the app (UI + logic)
- `ukr-cards-categorized.json` — vocabulary bundle loaded on first visit
- `lexicon.json` — high-frequency lemma dictionary (tried before machine translation)
- `index.html` — redirect shim to `language-cards.html`
- `manifest.json` — PWA manifest
- `sw.js` — service worker (network-first for HTML/JSON)
- `icon.svg` — app icon
- `tests/logic.test.mjs` — logic checks (no browser)

## Run it

Open `language-cards.html` over HTTP (not `file://` if you want the service worker and JSON bundle):

```bash
npx --yes serve .
# or: python -m http.server 8765
```

Then visit the printed URL. `index.html` redirects to the app.

Logic checks (no browser): `node tests/logic.test.mjs`

First visit loads ~5,875 cards from `ukr-cards-categorized.json`. After that the pool is yours: deleting a card is sticky, and **Settings → Sync with bundle** only adds *new* bundled cards (not ones you deleted).

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

No accounts and no telemetry. Dictionary hits stay on-device. Anything not in the lexicon is sent to Google Translate’s public `gtx` endpoint and/or MyMemory.
