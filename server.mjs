#!/usr/bin/env node
// Static host for the app plus a translation proxy that keeps the DeepSeek key server-side.
//
// The browser never sees the key: it POSTs to /api/translate on this same origin and the key is
// added here from the environment. Rate limits are enforced per client IP and globally per day so a
// public deployment cannot be used to drain the account. No dependencies, Node built-ins only.
//
//   DEEPSEEK_API_KEY   required for /api/translate; without it the app is served but the proxy 503s
//   DEEPSEEK_BASE_URL  default https://api.deepseek.com (point this at a stub in tests)
//   DEEPSEEK_MODEL     default deepseek-flash
//   PORT / HOST        default 8787 / 0.0.0.0
//   RATE_PER_MIN       sustained requests per minute per IP, default 60
//   RATE_BURST         burst allowance per IP, default 20
//   IP_DAILY_CAP       requests per IP per UTC day, default 500
//   GLOBAL_DAILY_CAP   requests per UTC day across all IPs, default 2000
//   ALLOWED_ORIGINS    comma-separated browser origins; empty allows any (see README)
//   CLIENT_TOKEN       optional shared secret required in x-app-token
//   TRUST_PROXY        1 to read the client IP from x-forwarded-for
//   MAX_INPUT_CHARS    default 200
//   STATIC_ROOT        default the directory holding this file
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
};

const LANGS = { uk: 'Ukrainian', ru: 'Russian', en: 'English', fi: 'Finnish' };
const CYRILLIC = /\p{Script=Cyrillic}/u;
const LATIN = /[A-Za-z]/;

const dayKey = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

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
        return { ok: false, status: 429, reason: 'global daily cap reached', retryAfter: 60 };
      }
      const ipDay = ipDays.get(ip);
      if (!ipDay || ipDay.day !== day) ipDays.set(ip, { day, count: 0 });
      const rec = ipDays.get(ip);
      if (rec.count >= ipDailyCap) {
        return { ok: false, status: 429, reason: 'daily limit for this client reached', retryAfter: 3600 };
      }
      const b = buckets.get(ip) || { tokens: burst, at: now };
      b.tokens = Math.min(burst, b.tokens + (now - b.at) * refillPerMs);
      b.at = now;
      if (b.tokens < 1) {
        buckets.set(ip, b);
        return { ok: false, status: 429, reason: 'rate limit exceeded', retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / refillPerMs / 1000)) };
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

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return { headers: {}, origin: null, allowed: true };
  const allowed = config.allowedOrigins.length === 0 || config.allowedOrigins.includes(origin);
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
      temperature: 0,
      max_tokens: 200,
    }),
    signal: AbortSignal.timeout(config.upstreamTimeoutMs),
  });
  if (!res.ok) throw Object.assign(new Error(`upstream ${res.status}`), { upstreamStatus: res.status });
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('upstream returned no content');
  let parsed;
  try { parsed = JSON.parse(content); } catch { throw new Error('upstream returned non-JSON content'); }
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
  '.md': 'text/plain; charset=utf-8',
};

// Server source and tests are not part of the app payload; dotfiles are never served.
const BLOCKED = [/^\/server\.mjs$/, /^\/tests(\/|$)/, /(^|\/)\./];

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  if (BLOCKED.some((re) => re.test(pathname))) { send(res, 404, { error: 'not found' }); return; }
  const file = join(config.staticRoot, normalize(pathname));
  if (!file.startsWith(config.staticRoot + sep) && file !== config.staticRoot) { send(res, 403, { error: 'forbidden' }); return; }
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

async function handleTranslate(req, res, cors) {
  if (!config.apiKey) { send(res, 503, { error: 'translation server has no API key configured' }, cors.headers); return; }
  const ip = clientIp(req);
  const verdict = limiter.check(ip);
  if (!verdict.ok) {
    console.warn(`rate limited ${ip}: ${verdict.reason}`);
    send(res, verdict.status, { error: verdict.reason }, { ...cors.headers, 'retry-after': String(verdict.retryAfter) });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    if (e.status === 413) {
      send(res, 413, { error: 'request body too large' }, { ...cors.headers, connection: 'close' });
      res.on('finish', () => req.destroy());
      return;
    }
    send(res, 400, { error: 'invalid JSON body' }, cors.headers);
    return;
  }
  const q = typeof payload?.q === 'string' ? payload.q.trim() : '';
  const source = String(payload?.source || 'uk');
  const target = String(payload?.target || 'en');
  if (!q) { send(res, 400, { error: 'missing q' }, cors.headers); return; }
  if (q.length > config.maxInputChars) { send(res, 400, { error: `q longer than ${config.maxInputChars} characters` }, cors.headers); return; }
  if (!LANGS[source] || !LANGS[target] || source === target) { send(res, 400, { error: 'unsupported language pair' }, cors.headers); return; }
  try {
    const raw = await callDeepSeek(q, source, target);
    const cleaned = cleanTranslation(q, raw, target);
    if (!cleaned.ok) { send(res, 502, { error: cleaned.reason }, cors.headers); return; }
    send(res, 200, { text: cleaned.text, provider: 'deepseek', model: config.model, remaining: verdict.remaining }, cors.headers);
  } catch (err) {
    // Log the detail, return a generic message: upstream errors can echo request metadata.
    console.error('translate failed:', err.message);
    const status = err.upstreamStatus === 401 || err.upstreamStatus === 403 ? 502 : 502;
    send(res, status, { error: 'translation upstream failed' }, cors.headers);
  }
}

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const cors = corsHeaders(req);

    if (req.method === 'OPTIONS') {
      if (!cors.allowed) { send(res, 403, { error: 'origin not allowed' }); return; }
      res.writeHead(204, cors.headers);
      res.end();
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (!cors.allowed) { send(res, 403, { error: 'origin not allowed' }); return; }
      // Health is deliberately open (model name and limits only, never the key): the app probes it
      // to detect whether a proxy is deployed at all, including in token-protected deployments.
      if (url.pathname === '/api/health') {
        send(res, 200, {
          ok: true,
          provider: 'deepseek',
          model: config.model,
          keyConfigured: Boolean(config.apiKey),
          limits: limiter.snapshot(clientIp(req)),
        }, cors.headers);
        return;
      }
      if (config.clientToken && req.headers['x-app-token'] !== config.clientToken) {
        send(res, 401, { error: 'missing or wrong app token' }, cors.headers);
        return;
      }
      if (url.pathname === '/api/translate' && req.method === 'POST') {
        await handleTranslate(req, res, cors);
        return;
      }
      send(res, 404, { error: 'unknown endpoint' }, cors.headers);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, { error: 'method not allowed' }); return; }
    await serveStatic(req, res, url);
  });
}

export const app = createApp();

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  app.listen(config.port, config.host, () => {
    console.log(`Ukrainian Flash Cards server on http://${config.host}:${config.port}`);
    console.log(`  static root: ${config.staticRoot}`);
    console.log(`  proxy:       POST /api/translate -> ${config.baseUrl} (${config.model})`);
    console.log(`  api key:     ${config.apiKey ? 'configured' : 'MISSING — /api/translate will return 503'}`);
    console.log(`  limits:      ${config.ratePerMin}/min burst ${config.rateBurst} per IP, ${config.ipDailyCap}/day per IP, ${config.globalDailyCap}/day total`);
    console.log(`  origins:     ${config.allowedOrigins.length ? config.allowedOrigins.join(', ') : 'any'}`);
  });
}
