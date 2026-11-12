# Serves the app itself and proxies translation. SERVE_STATIC=0 turns this back into the API-only
# image, where the app stays on the user's own disk and only translation is remote.
# The DeepSeek key is never baked in — it arrives as a Fly secret at runtime.
FROM node:22-alpine

WORKDIR /app
# EXPOSE must name the port the process actually listens on; fly.toml sets the same values.
ENV NODE_ENV=production SERVE_STATIC=1 PORT=8080 HOST=0.0.0.0

COPY server.mjs robots.txt ./
# The payload the server serves: app shell, card bundle, lexicon, manifest, service worker, icons.
COPY index.html language-cards.html manifest.json sw.js lexicon.json ukr-cards-categorized.json ./
COPY icon.svg icon-180.png icon-192.png icon-512.png ./

EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
