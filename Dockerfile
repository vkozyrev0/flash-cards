# API-only image: the app stays on the user's own disk or host, and this container only proxies
# translation. The DeepSeek key is never baked in — it arrives as a Fly secret at runtime.
FROM node:22-alpine

WORKDIR /app
# EXPOSE must name the port the process actually listens on; fly.toml sets the same values.
ENV NODE_ENV=production SERVE_STATIC=0 PORT=8080 HOST=0.0.0.0

# Only the proxy and the crawl policy for the API.
COPY server.mjs robots.txt ./

EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
