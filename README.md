# Ukrainian Flash Cards

A local-first PWA for studying Ukrainian vocabulary with parallel Russian, English, and Finnish. Progress uses a simple spaced-repetition schedule and stays in this browser (`localStorage` key `ukr-cards-v3`). Nothing is uploaded except translation requests when you add new words.

## Run it

Open `language-cards.html` over HTTP (not `file://` if you want the service worker and JSON bundle):

```bash
npx --yes serve .
# or: python -m http.server 8765
```

Logic checks (no browser): `node tests/logic.test.mjs`

Then visit the printed URL. `index.html` redirects to the app.

First visit loads ~5,875 cards from `ukr-cards-categorized.json`. After that the pool is yours: deleting a card is sticky, and **Settings → Sync with bundle** only adds *new* bundled cards (not ones you deleted).

## Study

- **Words** — paste one entry per line (phrases with commas are fine). Common lemmas hit a built-in dictionary (`lexicon.json`); otherwise the preferred provider is used, then the other if the result looks empty, identical, or the wrong script. After adding, the new deck opens for review. Click a translation to edit it; **↻** re-translates that cell.
- **Quiz** — sessions take due cards first, then new, then the rest. **Due only** matches the header (studied cards that are due), not unseen cards. Answers save as you go; canceling keeps progress on cards you already answered.
- **Decks / Settings / Help** — manage decks, quiz direction, audio, export/import.

## Data

- Export / import a JSON backup from Settings. Import offers **Merge**, **Replace all**, or **Cancel**.
- If the browser storage quota is full, the app warns instead of failing silently — export a backup, then delete unused words.
- Installed copies update the HTML, card JSON, and lexicon over the network (service worker cache `ukr-cards-v3`). Other assets stay cache-first.

## Privacy

No accounts and no telemetry. Dictionary hits stay on-device. Anything not in the lexicon is sent to Google Translate’s public `gtx` endpoint and/or MyMemory.
