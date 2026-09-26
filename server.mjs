#!/usr/bin/env node
// Static host for the app plus a translation proxy that keeps the DeepSeek key server-side.
//
// The browser never sees the key: it POSTs to /api/translate on this same origin and the key is
// added here from the environment. The process is hardened against the attacks a single Node
// process can actually stop — slow/half-open clients, header floods, request floods, crawlers
// burning the translation budget — and sheds load instead of queueing it.
//
// What this cannot do: absorb a volumetric or distributed (L3/L4) flood. That must be handled at the
// edge (CDN, cloud connection limits, scrubbing) before traffic reaches this process. See README.
//
//   DEEPSEEK_API_KEY        required for /api/translate; without it the app is served but the proxy 503s
//   DEEPSEEK_BASE_URL       default https://api.deepseek.com (point this at a stub in tests)
//   DEEPSEEK_MODEL          default deepseek-flash
//   PORT / HOST             default 8787 / 0.0.0.0
//   RATE_PER_MIN            sustained requests per minute per IP, default 60
//   RATE_BURST              burst allowance per IP, default 20
//   IP_DAILY_CAP            requests per IP per UTC day, default 500
//   GLOBAL_DAILY_CAP        requests per UTC day across all IPs, default 2000
//   ALLOWED_ORIGINS         comma-separated browser origins; empty allows any (see README)
//   CLIENT_TOKEN            optional shared secret required in x-app-token
//   TRUST_PROXY             1 to read the client IP from x-forwarded-for
//   MAX_INPUT_CHARS         default 200
//   STATIC_ROOT             default the directory holding this file
//   HEADERS_TIMEOUT_MS      deadline for a client to finish sending request headers, default 10000
//   REQUEST_TIMEOUT_MS      deadline for a whole request, default 25000 (above the upstream timeout)
//   KEEP_ALIVE_TIMEOUT_MS   idle keep-alive timeout, default 5000
//   MAX_REQUESTS_PER_SOCKET requests allowed on one connection, default 100
//   MAX_HEADERS_COUNT       header count cap, default 100
//   MAX_HEADER_BYTES        header size cap, default 8192
//   MAX_INFLIGHT            requests in flight before any path is shed, default 128
//   API_MAX_INFLIGHT        requests in flight before /api/* is shed, default 8
//   MAX_CONNECTIONS         open sockets before new ones are dropped, default 512
//   MAX_CONNECTIONS_PER_IP  open sockets per client IP, default 32
//   BOT_POLICY              'block' (default) or 'off' for crawlers on the protected paths
//   BOT_PATTERNS            extra comma-separated User-Agent substrings to treat as crawlers
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '0.0.0.0',
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  baseUrl: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
  model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
  ratePerMin: Number(process.env.RATE_PER_MIN || 60),
  rateBurst: Number(process.env.RATE_BURST || 20),
  ipDailyCap: Number(process.env.IP_DAILY_CAP || 500),
  globalDailyCap: Number(process.env.GLOBAL_DAILY_CAP || 2000),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  clientToken: process.env.CLIENT_TOKEN || '',
  trustProxy: process.env.TRUST_PROXY === '1',
  maxInputChars: Number(process.env.MAX_INPUT_CHARS || 200),
  staticRoot: resolve(process.env.STATIC_ROOT || HERE),
  maxBodyBytes: 8192,
  upstreamTimeoutMs: 20000,
  headersTimeoutMs: Number(process.env.HEADERS_TIMEOUT_MS || 10000),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 25000),
  keepAliveTimeoutMs: Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 5000),
  maxRequestsPerSocket: Number(process.env.MAX_REQUESTS_PER_SOCKET || 100),
  maxHeadersCount: Number(process.env.MAX_HEADERS_COUNT || 100),
  maxHeaderBytes: Number(process.env.MAX_HEADER_BYTES || 8192),
  maxInflight: Number(process.env.MAX_INFLIGHT || 128),
  apiMaxInflight: Number(process.env.API_MAX_INFLIGHT || 8),
  maxConnections: Number(process.env.MAX_CONNECTIONS || 512),
  maxConnectionsPerIp: Number(process.env.MAX_CONNECTIONS_PER_IP || 32),
  botPolicy: process.env.BOT_POLICY === 'off' ? 'off' : 'block',
  botPatterns: (process.env.BOT_PATTERNS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  // API-only mode: the app is served from the user's own disk/host and only translation is remote.
  serveStatic: process.env.SERVE_STATIC !== '0',
};

const LANGS = { uk: 'Ukrainian', ru: 'Russian', en: 'English', fi: 'Finnish' };
const CYRILLIC = /\p{Script=Cyrillic}/u;
const LATIN = /[A-Za-z]/;

const dayKey = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

// ---- refusal counters ------------------------------------------------------------------------
// Every refusal path is counted by reason and readable from /api/health. Logging is throttled: an
// unbounded log under a flood is itself a way to exhaust the process.
export const counters = {
  rate_limit: 0,
  ip_daily_cap: 0,
  global_daily_cap: 0,
  concurrency_shed: 0,
  connection_cap: 0,
  bot_blocked: 0,
  timeout: 0,
  headers_too_large: 0,
  body_too_large: 0,
  bad_request: 0,
  origin_not_allowed: 0,
  app_token: 0,
  upstream_failed: 0,
};

const logState = { windowStart: Date.now(), emitted: 0, suppressed: 0, maxPerWindow: 20, windowMs: 1000 };
function logRefusal(reason, detail) {
  const now = Date.now();
  if (now - logState.windowStart >= logState.windowMs) {
    if (logState.suppressed) {
      console.warn(`refused ${logState.suppressed} more request(s) in the previous second (log throttled)`);
      logState.suppressed = 0;
    }
    logState.windowStart = now;
    logState.emitted = 0;
  }
  if (logState.emitted >= logState.maxPerWindow) { logState.suppressed++; return; }
  logState.emitted++;
  const bits = [detail && detail.ip && `ip=${detail.ip}`, detail && detail.path && `path=${detail.path}`, detail && detail.ua && `ua=${String(detail.ua).slice(0, 60)}`].filter(Boolean);
  console.warn(`refused ${reason}${bits.length ? ' ' + bits.join(' ') : ''}`);
}

export function countRefusal(reason, detail = {}) {
  counters[reason] = (counters[reason] || 0) + 1;
  logRefusal(reason, detail);
}

// ---- rate limiting ---------------------------------------------------------------------------
// Token bucket per IP plus a per-IP and a global daily ceiling. In-memory on purpose: one process,
// no shared state to keep in sync, and a restart only forgives limits (never overspends the day).
export function createLimiter(opts = {}) {
  const perMin = opts.ratePerMin ?? config.ratePerMin;
  const burst = opts.rateBurst ?? config.rateBurst;
  const ipDailyCap = opts.ipDailyCap ?? config.ipDailyCap;
  const globalDailyCap = opts.globalDailyCap ?? config.globalDailyCap;
  const buckets = new Map();
  const ipDays = new Map();
  let global = { day: dayKey(), count: 0 };
  const refillPerMs = perMin / 60000;

  return {
    check(ip, now = Date.now()) {
      const day = dayKey(now);
      if (global.day !== day) global = { day, count: 0 };
      if (global.count >= globalDailyCap) {
        return { ok: false, status: 429, reason: 'global daily cap reached', counter: 'global_daily_cap', retryAfter: 60 };
      }
      const ipDay = ipDays.get(ip);
      if (!ipDay || ipDay.day !== day) ipDays.set(ip, { day, count: 0 });
      const rec = ipDays.get(ip);
      if (rec.count >= ipDailyCap) {
        return { ok: false, status: 429, reason: 'daily limit for this client reached', counter: 'ip_daily_cap', retryAfter: 3600 };
      }
      const b = buckets.get(ip) || { tokens: burst, at: now };
      b.tokens = Math.min(burst, b.tokens + (now - b.at) * refillPerMs);
      b.at = now;
      if (b.tokens < 1) {
        buckets.set(ip, b);
        return { ok: false, status: 429, reason: 'rate limit exceeded', counter: 'rate_limit', retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / refillPerMs / 1000)) };
      }
      b.tokens -= 1;
      buckets.set(ip, b);
      rec.count += 1;
      global.count += 1;
      return { ok: true, remaining: { ipDay: ipDailyCap - rec.count, globalDay: globalDailyCap - global.count } };
    },
    snapshot(ip, now = Date.now()) {
      const day = dayKey(now);
      const rec = ipDays.get(ip);
      return {
        day,
        globalDayUsed: global.day === day ? global.count : 0,
        globalDailyCap,
        ipDayUsed: rec && rec.day === day ? rec.count : 0,
        ipDailyCap,
        ratePerMin: perMin,
        rateBurst: burst,
      };
    },
  };
}

const limiter = createLimiter();

export function clientIp(req) {
  const raw = config.trustProxy && req.headers['x-forwarded-for']
    ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
    : req.socket.remoteAddress || 'unknown';
  return raw.replace(/^::ffff:/, '');
}

// ---- admission control -----------------------------------------------------------------------
// Bounded concurrency: past the cap a request is refused immediately with a retryable status rather
// than being accepted and queued, which is what turns overload into a stall.
export function createAdmission(max) {
  let inflight = 0;
  return {
    max,
    acquire() { if (inflight >= max) return false; inflight += 1; return true; },
    release() { if (inflight > 0) inflight -= 1; },
    get inflight() { return inflight; },
  };
}

const globalAdmission = createAdmission(config.maxInflight);
const apiAdmission = createAdmission(config.apiMaxInflight);

// ---- crawler policy --------------------------------------------------------------------------
// Named crawlers and browser-automation frameworks. Generic HTTP clients (curl, wget,
// python-requests, Node's fetch) are deliberately NOT classified as crawlers: they are how scripts
// and monitors talk to the API, and UA sniffing cannot tell a scraper built on them from a
// legitimate caller. The rate and concurrency caps are what bound those. UA matching is advisory in
// any case — a hostile client can spoof it — so this reduces crawler cost, it is not a boundary.
const CRAWLER_PATTERNS = [
  'googlebot', 'bingbot', 'msnbot', 'slurp', 'duckduckbot', 'yandexbot', 'yandeximages', 'baiduspider',
  'sogou', 'exabot', 'ia_archiver', 'archive.org_bot', 'facebookexternalhit', 'twitterbot', 'telegrambot',
  'whatsapp', 'discordbot', 'slackbot', 'linkedinbot', 'pinterest', 'applebot', 'amazonbot', 'bytespider',
  'petalbot', 'semrush', 'ahrefs', 'mj12bot', 'dotbot', 'dataforseo', 'serpstat', 'blexbot', 'seznam',
  'uptimerobot', 'pingdom', 'statuscake', 'headlesschrome', 'phantomjs', 'puppeteer', 'playwright',
  'selenium', 'webdriver', 'scrapy', 'httrack', 'spider', 'crawler', 'scrape', 'bot/',
];

export function classifyClient(userAgent, extraPatterns = config.botPatterns) {
  const ua = String(userAgent || '').toLowerCase();
  if (!ua) return { bot: false, reason: 'no user agent' };
  for (const p of [...CRAWLER_PATTERNS, ...extraPatterns]) {
    if (ua.includes(p)) return { bot: true, reason: p };
  }
  return { bot: false, reason: '' };
}

// The expensive paths: the translation API (which spends money) and the large bundles (which spend
// bandwidth). The app page, robots.txt, the icon and /api/health stay reachable for everyone, so
// monitors and legitimate crawlers of the page are unaffected.
export const CRAWLER_PROTECTED_PATHS = ['/api/translate', '/ukr-cards-categorized.json', '/lexicon.json'];
export function isCrawlerProtected(pathname) {
  return CRAWLER_PROTECTED_PATHS.includes(pathname);
}

// ---- sockets ---------------------------------------------------------------------------------
// Node's headersTimeout only takes effect on the connectionsCheckingInterval tick (30s by default),
// so a client that opens a socket and sends nothing is not actually cut off at the configured bound
// until then. This timer is the one that enforces the bound; Node's check stays as a backstop.
const HEADER_TIMER = Symbol('headerTimer');
const COMPLETED = Symbol('completedRequest');
const SAW_DATA = Symbol('sawDataSinceResponse');
const connectionsByIp = new Map();
let openConnections = 0;

function armHeaderDeadline(socket) {
  clearTimeout(socket[HEADER_TIMER]);
  socket[HEADER_TIMER] = setTimeout(() => {
    if (socket.destroyed) return;
    // Count only a client that never finished a request (or started another and stalled); an idle
    // keep-alive socket is closed silently, and Node's keepAliveTimeout normally gets there first.
    if (!socket[COMPLETED] || socket[SAW_DATA]) {
      countRefusal('timeout', { ip: socket.remoteAddress, path: 'headers' });
    }
    socket.destroy();
  }, config.headersTimeoutMs);
}

function releaseConnection(ip, socket) {
  clearTimeout(socket[HEADER_TIMER]);
  const n = (connectionsByIp.get(ip) || 1) - 1;
  if (n <= 0) connectionsByIp.delete(ip); else connectionsByIp.set(ip, n);
  openConnections = Math.max(0, openConnections - 1);
}

function onConnection(socket) {
  const ip = String(socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
  if (openConnections >= config.maxConnections) {
    countRefusal('connection_cap', { ip, path: 'global' });
    socket.destroy();
    return;
  }
  const perIp = (connectionsByIp.get(ip) || 0) + 1;
  if (perIp > config.maxConnectionsPerIp) {
    countRefusal('connection_cap', { ip, path: 'per-ip' });
    socket.destroy();
    return;
  }
  connectionsByIp.set(ip, perIp);
  openConnections += 1;
  socket[COMPLETED] = false;
  socket[SAW_DATA] = false;
  socket.on('data', () => { socket[SAW_DATA] = true; });
  socket.on('close', () => releaseConnection(ip, socket));
  socket.on('error', () => {});
  armHeaderDeadline(socket);
}

// Origins allowed to call the API from a browser. Entries are exact origins plus two tokens that a
// locally-served app needs: `localhost` matches http(s)://localhost:* and http://127.0.0.1:* (any
// port, since the local port varies), and `null` matches the "null" origin a page loaded from
// file:// sends. Empty list = any origin.
export function originAllowed(origin, allowed = config.allowedOrigins) {
  if (!origin) return true;
  if (allowed.length === 0) return true;
  if (allowed.includes(origin)) return true;
  if (allowed.includes('null') && origin === 'null') return true;
  if (allowed.includes('localhost')) {
    try {
      const { hostname, protocol } = new URL(origin);
      if ((protocol === 'http:' || protocol === 'https:') && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]')) return true;
    } catch { return false; }
  }
  return false;
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return { headers: {}, origin: null, allowed: true };
  const allowed = originAllowed(origin);
  return {
    origin,
    allowed,
    headers: allowed
      ? {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'POST, GET, OPTIONS',
        'access-control-allow-headers': 'content-type, x-app-token',
        'access-control-max-age': '600',
        vary: 'Origin',
      }
      : {},
  };
}

function send(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...extraHeaders });
  res.end(body);
}

const shed = (res, cors, retryAfter = 1) => send(res, 503, { error: 'server busy, retry shortly' }, { ...cors.headers, 'retry-after': String(retryAfter) });

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > config.maxBodyBytes) {
        // Stop buffering and reject; the caller answers, then closes the socket once the 413 has
        // been flushed (destroying here would reset the connection before the client can read it).
        req.pause();
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Mirrors the client-side guard in language-cards.html (looksUntranslated/isValidFor) so a bad
// upstream answer is rejected here rather than stored on a card.
export function cleanTranslation(source, text, target) {
  const cleaned = String(text || '').trim().replace(/^["'“”«»]+|["'“”«»]+$/g, '').trim();
  if (!cleaned) return { ok: false, reason: 'empty translation' };
  if (cleaned.toLowerCase() === String(source || '').trim().toLowerCase()) return { ok: false, reason: 'translation identical to source' };
  const hasCyrillic = CYRILLIC.test(cleaned);
  if ((target === 'ru' || target === 'uk') && !hasCyrillic) return { ok: false, reason: `not ${target} text` };
  if ((target === 'en' || target === 'fi') && (hasCyrillic || !LATIN.test(cleaned))) return { ok: false, reason: `not ${target} text` };
  return { ok: true, text: cleaned };
}

async function callDeepSeek(text, source, target) {
  const prompt = [
    'You are a translation engine for a flashcard app. Reply with JSON only, no prose.',
    `Translate the ${LANGS[source] || source} text below into ${LANGS[target] || target}.`,
    'Keep it to the shortest natural equivalent (one word or a short phrase).',
    `Input: ${text}`,
  ].join('\n');
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: 'Translate and answer in JSON: {"text": "<translation>"}.' },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      // deepseek-flash defaults to thinking mode, which spends the whole max_tokens budget on
      // reasoning_content and returns an empty content with finish_reason "length" — measured
      // against the live API. Disabled, the same call answers in ~1s using 8 output tokens.
      thinking: { type: 'disabled' },
      temperature: 0,
      max_tokens: 200,
    }),
    signal: AbortSignal.timeout(config.upstreamTimeoutMs),
  });
  if (!res.ok) throw Object.assign(new Error(`upstream ${res.status}`), { upstreamStatus: res.status });
  const data = await res.json();
  const message = data?.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    // Name the failure precisely: an empty content with reasoning present means thinking mode ate
    // the budget, which is a different problem from a provider outage.
    throw new Error(message?.reasoning_content ? 'upstream returned reasoning only (thinking mode)' : 'upstream returned no content');
  }
  // Models sometimes wrap JSON in a fenced block even in JSON mode.
  const bare = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(bare); } catch { throw new Error(`upstream returned non-JSON content: ${bare.slice(0, 80)}`); }
  const value = parsed?.text ?? parsed?.translation;
  if (typeof value !== 'string') throw new Error('upstream JSON had no text field');
  return value;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

// Server source and tests are not part of the app payload; dotfiles are never served.
const BLOCKED = [/^\/server\.mjs$/, /^\/tests(\/|$)/, /(^|\/)\./];

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  if (BLOCKED.some((re) => re.test(pathname))) { send(res, 404, { error: 'not found' }); return; }
  const file = join(config.staticRoot, normalize(pathname));
  if (!file.startsWith(config.staticRoot + sep) && file !== config.staticRoot) {
    countRefusal('bad_request', { path: pathname });
    send(res, 403, { error: 'forbidden' });
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

async function handleTranslate(req, res, cors, ip) {
  if (!config.apiKey) { send(res, 503, { error: 'translation server has no API key configured' }, cors.headers); return; }
  const verdict = limiter.check(ip);
  if (!verdict.ok) {
    countRefusal(verdict.counter, { ip, path: '/api/translate' });
    send(res, verdict.status, { error: verdict.reason }, { ...cors.headers, 'retry-after': String(verdict.retryAfter) });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    if (e.status === 413) {
      countRefusal('body_too_large', { ip, path: '/api/translate' });
      send(res, 413, { error: 'request body too large' }, { ...cors.headers, connection: 'close' });
      res.on('finish', () => req.destroy());
      return;
    }
    countRefusal('bad_request', { ip, path: '/api/translate' });
    send(res, 400, { error: 'invalid JSON body' }, cors.headers);
    return;
  }
  const q = typeof payload?.q === 'string' ? payload.q.trim() : '';
  const source = String(payload?.source || 'uk');
  const target = String(payload?.target || 'en');
  if (!q) { countRefusal('bad_request', { ip, path: '/api/translate' }); send(res, 400, { error: 'missing q' }, cors.headers); return; }
  if (q.length > config.maxInputChars) { countRefusal('bad_request', { ip, path: '/api/translate' }); send(res, 400, { error: `q longer than ${config.maxInputChars} characters` }, cors.headers); return; }
  if (!LANGS[source] || !LANGS[target] || source === target) { countRefusal('bad_request', { ip, path: '/api/translate' }); send(res, 400, { error: 'unsupported language pair' }, cors.headers); return; }
  try {
    const raw = await callDeepSeek(q, source, target);
    const cleaned = cleanTranslation(q, raw, target);
    if (!cleaned.ok) { countRefusal('upstream_failed', { ip, path: `/api/translate (${cleaned.reason})` }); send(res, 502, { error: cleaned.reason }, cors.headers); return; }
    send(res, 200, { text: cleaned.text, provider: 'deepseek', model: config.model, remaining: verdict.remaining }, cors.headers);
  } catch (err) {
    // Log the detail, return a generic message: upstream errors can echo request metadata.
    countRefusal('upstream_failed', { ip, path: `/api/translate (${err.message})` });
    send(res, 502, { error: 'translation upstream failed' }, cors.headers);
  }
}

export function createApp() {
  const server = createServer({
    maxHeaderSize: config.maxHeaderBytes,
    headersTimeout: config.headersTimeoutMs,
    requestTimeout: config.requestTimeoutMs,
    keepAliveTimeout: config.keepAliveTimeoutMs,
    // Node checks these deadlines on this interval; the 30s default would make a 10s bound
    // unenforced for up to 30s, so keep it well under the smallest deadline.
    connectionsCheckingInterval: Math.max(100, Math.min(1000, Math.floor(config.headersTimeoutMs / 2))),
  });
  // maxRequestsPerSocket is not honoured as a constructor option (verified), so set it directly.
  server.maxRequestsPerSocket = config.maxRequestsPerSocket;
  server.maxHeadersCount = config.maxHeadersCount;
  server.on('connection', onConnection);
  server.on('clientError', (err, socket) => {
    // Header overflow and malformed request lines are refused by the parser before any handler runs.
    const tooLarge = err.code === 'HPE_HEADER_OVERFLOW';
    countRefusal(tooLarge ? 'headers_too_large' : 'bad_request', { path: tooLarge ? 'headers' : err.code });
    if (socket.writable) {
      const body = JSON.stringify({ error: tooLarge ? 'request headers too large' : 'malformed request' });
      socket.end(`HTTP/1.1 ${tooLarge ? 431 : 400} ${tooLarge ? 'Request Header Fields Too Large' : 'Bad Request'}\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
    } else {
      socket.destroy();
    }
  });

  server.on('request', async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const ip = clientIp(req);
    const socket = req.socket;
    socket[COMPLETED] = true;
    clearTimeout(socket[HEADER_TIMER]);
    socket[SAW_DATA] = false;

    // Whole-request deadline. The upstream call has its own shorter timeout, so a slow upstream
    // surfaces as a 502 rather than as this 408.
    const requestTimer = setTimeout(() => {
      countRefusal('timeout', { ip, path: url.pathname });
      if (!res.headersSent) send(res, 408, { error: 'request timeout' });
      else res.destroy();
    }, config.requestTimeoutMs);
    res.on('close', () => {
      clearTimeout(requestTimer);
      if (!socket.destroyed) armHeaderDeadline(socket);
    });

    // Admission control: refuse rather than queue once the caps are reached.
    if (!globalAdmission.acquire()) {
      countRefusal('concurrency_shed', { ip, path: `${url.pathname} (global)` });
      shed(res, { headers: {} });
      return;
    }
    let apiHeld = false;
    res.on('close', () => { if (apiHeld) apiAdmission.release(); globalAdmission.release(); });

    const cors = corsHeaders(req);

    if (url.pathname.startsWith('/api/') && !apiAdmission.acquire()) {
      countRefusal('concurrency_shed', { ip, path: `${url.pathname} (api)` });
      shed(res, cors);
      return;
    }
    if (url.pathname.startsWith('/api/')) apiHeld = true;

    if (config.botPolicy !== 'off' && isCrawlerProtected(url.pathname)) {
      const verdict = classifyClient(req.headers['user-agent']);
      if (verdict.bot) {
        countRefusal('bot_blocked', { ip, path: url.pathname, ua: req.headers['user-agent'] });
        send(res, 403, { error: 'crawlers are not allowed here; see /robots.txt' }, cors.headers);
        return;
      }
    }

    if (req.method === 'OPTIONS') {
      if (!cors.allowed) { countRefusal('origin_not_allowed', { ip, path: url.pathname }); send(res, 403, { error: 'origin not allowed' }); return; }
      res.writeHead(204, cors.headers);
      res.end();
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (!cors.allowed) { countRefusal('origin_not_allowed', { ip, path: url.pathname }); send(res, 403, { error: 'origin not allowed' }); return; }
      // Health is deliberately open (model name, limits and counters only, never the key): the app
      // probes it to detect whether a proxy is deployed, including in token-protected deployments.
      if (url.pathname === '/api/health') {
        send(res, 200, {
          ok: true,
          provider: 'deepseek',
          model: config.model,
          keyConfigured: Boolean(config.apiKey),
          limits: limiter.snapshot(ip),
          refusals: { ...counters },
          inflight: { total: globalAdmission.inflight, api: apiAdmission.inflight, maxTotal: config.maxInflight, maxApi: config.apiMaxInflight },
          connections: { open: openConnections, max: config.maxConnections, maxPerIp: config.maxConnectionsPerIp },
          uptimeSeconds: Math.round(process.uptime()),
        }, cors.headers);
        return;
      }
      if (config.clientToken && req.headers['x-app-token'] !== config.clientToken) {
        countRefusal('app_token', { ip, path: url.pathname });
        send(res, 401, { error: 'missing or wrong app token' }, cors.headers);
        return;
      }
      if (url.pathname === '/api/translate' && req.method === 'POST') {
        await handleTranslate(req, res, cors, ip);
        return;
      }
      send(res, 404, { error: 'unknown endpoint' }, cors.headers);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, { error: 'method not allowed' }); return; }
    // API-only deployment: the app is served from the user's own disk or host. robots.txt is still
    // served, because the crawl policy is about this API.
    if (!config.serveStatic && url.pathname !== '/robots.txt') {
      send(res, 404, { error: 'this deployment serves only /api/translate, /api/health and /robots.txt' });
      return;
    }
    await serveStatic(req, res, url);
  });

  return server;
}

export const app = createApp();

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  app.listen(config.port, config.host, () => {
    console.log(`Ukrainian Flash Cards server on http://${config.host}:${config.port}`);
    console.log(`  static root: ${config.serveStatic ? config.staticRoot : 'not served (SERVE_STATIC=0: API-only)'}`);
    console.log(`  proxy:       POST /api/translate -> ${config.baseUrl} (${config.model})`);
    console.log(`  api key:     ${config.apiKey ? 'configured' : 'MISSING — /api/translate will return 503'}`);
    console.log(`  limits:      ${config.ratePerMin}/min burst ${config.rateBurst} per IP, ${config.ipDailyCap}/day per IP, ${config.globalDailyCap}/day total`);
    console.log(`  origins:     ${config.allowedOrigins.length ? config.allowedOrigins.join(', ') : 'any'}`);
    console.log(`  bounds:      headers ${config.headersTimeoutMs}ms, request ${config.requestTimeoutMs}ms, ${config.maxInflight} in flight (${config.apiMaxInflight} for /api), ${config.maxConnections} sockets (${config.maxConnectionsPerIp}/IP)`);
    console.log(`  crawlers:    ${config.botPolicy === 'off' ? 'not blocked' : `blocked on ${CRAWLER_PROTECTED_PATHS.join(', ')}`}`);
  });
}
