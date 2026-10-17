#!/usr/bin/env node
// Drives the shipped server.mjs over real HTTP with a stubbed DeepSeek upstream.
// The stub records what the proxy sent, so the tests can prove the key is used server-side only
// and never appears in any response the browser sees.
//
// Limits are checked before input validation on purpose (a bad request must not be free), so the
// functional tests run against a server with generous limits and each limit test gets its own
// instance with the limit under test turned down.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'sk-secret-key-must-not-leak-0123456789';

let failed = 0;
const results = [];
async function test(name, body) {
  try {
    await body();
    results.push(['ok  ', name]);
  } catch (err) {
    failed++;
    results.push(['FAIL', `${name} :: ${err.message}`]);
  }
}

// ---- stub upstream -------------------------------------------------------------------------
const upstreamCalls = [];
let upstreamMode = 'ok';
let upstreamDelayMs = 0;
const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    upstreamCalls.push({ url: req.url, auth: req.headers.authorization, body });
    if (upstreamDelayMs) await new Promise((r) => setTimeout(r, upstreamDelayMs));
    const send = (status, payload) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    if (upstreamMode === 'unauthorized') return send(401, { error: { message: 'Authentication Fails, Your api key: ****789 is invalid' } });
    if (upstreamMode === 'garbage') return send(200, { choices: [{ message: { content: 'I think the word means book.' } }] });
    if (upstreamMode === 'identical') return send(200, { choices: [{ message: { content: '{"text":"книга"}' } }] });
    if (upstreamMode === 'empty') return send(200, { choices: [{ message: { content: '{"text":"  "}' } }] });
    if (upstreamMode === 'wrongscript') return send(200, { choices: [{ message: { content: '{"text":"книга"}' } }] });
    const target = /into (\w+)/.exec(body)?.[1] || 'English';
    const table = { Ukrainian: 'книга', English: 'book', Russian: 'книга', Finnish: 'kirja' };
    return send(200, { choices: [{ message: { content: JSON.stringify({ text: table[target] || 'x' }) } }] });
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamPort = upstream.address().port;

// ---- server instances ----------------------------------------------------------------------
const servers = [];
async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}
async function startServer(env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(root, 'server.mjs')], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DEEPSEEK_API_KEY: KEY,
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      DEEPSEEK_MODEL: 'deepseek-flash',
      RATE_PER_MIN: '600',
      RATE_BURST: '100',
      IP_DAILY_CAP: '1000',
      GLOBAL_DAILY_CAP: '1000',
      ALLOWED_ORIGINS: 'http://localhost:5173',
      STATIC_ROOT: root,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) { servers.push(child); return { base, child, log, health: await res.json() }; }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`server did not start: ${log.join('')}`);
}

const seenBodies = [];
function makeClient(base) {
  return async (path, body, headers = {}, method = 'POST') => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetch(base + path, init);
    const text = await res.text();
    seenBodies.push(text);
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, headers: res.headers };
  };
}

const main = await startServer();
const post = makeClient(main.base);

// ---- helpers for the socket / connection / concurrency checks ------------------------------
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// One connection per request (agent: false) so concurrent calls really overlap.
function httpCall(port, path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

function connect(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => resolve(socket));
    socket.on('error', () => {});
  });
}

// Resolves when the socket closes, or with timedOut after the grace period.
function untilClose(socket, graceMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let data = '';
    socket.on('data', (d) => { data += d; });
    const timer = setTimeout(() => { socket.destroy(); resolve({ ms: Date.now() - t0, data, timedOut: true }); }, graceMs);
    socket.on('close', () => { clearTimeout(timer); resolve({ ms: Date.now() - t0, data, timedOut: false }); });
  });
}

async function health(port) {
  const res = await httpCall(port, '/api/health');
  assert.equal(res.status, 200, 'health status');
  return JSON.parse(res.body);
}

await test('health reports the model, that a key is configured, and the limits', () => {
  assert.equal(main.health.ok, true);
  assert.equal(main.health.provider, 'deepseek');
  assert.equal(main.health.model, 'deepseek-flash');
  assert.equal(main.health.keyConfigured, true);
  assert.equal(main.health.limits.ratePerMin, 600);
});

await test('translates through the proxy and returns the cleaned text', async () => {
  const res = await post('/api/translate', { q: 'книга', source: 'uk', target: 'en' });
  assert.equal(res.status, 200);
  assert.equal(res.json.text, 'book');
  assert.equal(res.json.provider, 'deepseek');
  assert.equal(typeof res.json.remaining.ipDay, 'number', 'the response reports the remaining daily quota');
  assert.equal(typeof res.json.remaining.globalDay, 'number');
  assert.equal(upstreamCalls.length, 1);
});

await test('the key is sent to the upstream as a bearer token, never by the client', () => {
  assert.equal(upstreamCalls[0].auth, `Bearer ${KEY}`);
});

await await test('the upstream request asks for JSON and names the model', () => {
  const body = JSON.parse(upstreamCalls[0].body);
  assert.equal(body.model, 'deepseek-flash');
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(body.temperature, 0);
  // deepseek-flash defaults to thinking mode, which returns an empty content field and breaks
  // every translation. This is the regression the README documents.
  assert.equal(body.thinking.type, 'disabled', 'thinking mode must stay disabled');
  assert.equal(upstreamCalls[0].url, '/chat/completions', 'the upstream path must be the chat endpoint');
  assert.match(body.messages[0].content, /json/i);
  assert.ok(body.messages[1].content.includes('книга'));
  assert.match(body.messages[1].content, /into English/);
});

await test('every target language round-trips', async () => {
  for (const [target, expected] of [['ru', 'книга'], ['fi', 'kirja']]) {
    const res = await post('/api/translate', { q: 'слово', source: 'uk', target });
    assert.equal(res.status, 200, `${target} status`);
    assert.equal(res.json.text, expected, `${target} text`);
  }
});

await test('an identical-to-source answer is rejected as untranslated', async () => {
  upstreamMode = 'identical';
  const res = await post('/api/translate', { q: 'книга', source: 'uk', target: 'en' });
  assert.equal(res.status, 502);
  assert.match(res.json.error, /identical/);
  upstreamMode = 'ok';
});

await test('an empty answer and a wrong-script answer are rejected', async () => {
  upstreamMode = 'empty';
  const empty = await post('/api/translate', { q: 'книга', source: 'uk', target: 'en' });
  assert.equal(empty.status, 502);
  assert.match(empty.json.error, /empty/);
  upstreamMode = 'wrongscript';
  const wrong = await post('/api/translate', { q: 'book', source: 'en', target: 'en' });
  assert.equal(wrong.status, 400); // same pair is refused before the upstream is touched
  const wrong2 = await post('/api/translate', { q: 'hello', source: 'en', target: 'fi' });
  assert.equal(wrong2.status, 502);
  assert.match(wrong2.json.error, /not fi text/);
  upstreamMode = 'ok';
});

await test('a non-JSON upstream answer is rejected without echoing it', async () => {
  upstreamMode = 'garbage';
  const res = await post('/api/translate', { q: 'книга', source: 'uk', target: 'en' });
  assert.equal(res.status, 502);
  assert.equal(res.json.error, 'translation upstream failed');
  assert.ok(!res.text.includes('I think'), 'upstream prose must not be echoed');
  upstreamMode = 'ok';
});

await test('an upstream auth failure is a 502 with a generic message and no key', async () => {
  upstreamMode = 'unauthorized';
  const res = await post('/api/translate', { q: 'книга', source: 'uk', target: 'en' });
  assert.equal(res.status, 502);
  assert.equal(res.json.error, 'translation upstream failed');
  assert.ok(!res.text.includes('****789'), 'upstream error text must not be echoed');
  assert.ok(!res.text.includes(KEY));
  upstreamMode = 'ok';
});

await test('rejects missing, over-long and unsupported input', async () => {
  const missing = await post('/api/translate', { source: 'uk', target: 'en' });
  assert.equal(missing.status, 400);
  assert.match(missing.json.error, /missing q/);
  const long = await post('/api/translate', { q: 'я'.repeat(201), source: 'uk', target: 'en' });
  assert.equal(long.status, 400);
  assert.match(long.json.error, /longer than/);
  const pair = await post('/api/translate', { q: 'книга', source: 'uk', target: 'uk' });
  assert.equal(pair.status, 400);
  assert.match(pair.json.error, /language pair/);
  const bad = await post('/api/translate', { q: 'книга', source: 'uk', target: 'de' });
  assert.equal(bad.status, 400);
});

await test('rejects a malformed body and an oversized body', async () => {
  const bad = await post('/api/translate', 'not json at all');
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /invalid JSON/);
  const big = await post('/api/translate', { q: 'x'.repeat(9000) });
  assert.equal(big.status, 413);
});

await test('an unknown endpoint under /api is a 404 JSON response', async () => {
  const res = await post('/api/nope', {});
  assert.equal(res.status, 404);
  assert.match(res.json.error, /unknown endpoint/);
});

await test('a browser origin that is not allowed is refused', async () => {
  const res = await post('/api/translate', { q: 'книга', source: 'uk', target: 'en' }, { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.match(res.json.error, /origin not allowed/);
});

await test('an allowed origin gets CORS headers on the preflight and the response', async () => {
  const pre = await fetch(`${main.base}/api/translate`, {
    method: 'OPTIONS',
    headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const res = await post('/api/translate', { q: 'книга', source: 'uk', target: 'en' }, { origin: 'http://localhost:5173' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
});

await test('the API key never appears in any response body', async () => {
  assert.ok(seenBodies.length > 10, 'expected the client to have made calls');
  for (const body of seenBodies) assert.ok(!body.includes(KEY), 'key leaked in a body');
  const port = Number(new URL(main.base).port);
  const healthBody = (await httpCall(port, '/api/health')).body;
  assert.ok(!healthBody.includes(KEY), 'health must not report the key');
});

await test('serves the app itself and refuses to serve its own source or tests', async () => {
  const app = await fetch(`${main.base}/language-cards.html`);
  assert.equal(app.status, 200);
  assert.match(app.headers.get('content-type'), /text\/html/);
  const body = await app.text();
  assert.match(body, /Ukrainian Flash Cards/);
  assert.ok(!body.includes(KEY), 'the served app must not contain the key');
  assert.equal((await fetch(`${main.base}/`)).status, 200);
  assert.equal((await fetch(`${main.base}/server.mjs`)).status, 404);
  assert.equal((await fetch(`${main.base}/tests/logic.test.mjs`)).status, 404);
  assert.equal((await fetch(`${main.base}/.gitignore`)).status, 404);
});

await test('path traversal is refused', async () => {
  // fetch() resolves dot segments before sending, so use the encoded spelling the server sees.
  const port = Number(new URL(main.base).port);
  const res = await httpCall(port, '/%2e%2e%2fpackage.json');
  assert.ok(res.status === 404 || res.status === 403, `got ${res.status}`);
});

await test('a POST to a static path is refused', async () => {
  const res = await fetch(`${main.base}/language-cards.html`, { method: 'POST', body: 'x' });
  assert.equal(res.status, 405);
});

function rawRequest(port, text) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    let data = '';
    socket.on('data', (d) => { data += d; });
    socket.on('error', () => resolve(data));
    socket.on('close', () => resolve(data));
    setTimeout(() => { socket.destroy(); resolve(data); }, 3000);
  });
}

await test('a malformed path or Host header is a 400, not a process crash', async () => {
  const srv = await startServer({ RATE_PER_MIN: '600', RATE_BURST: '10' });
  const port = Number(new URL(srv.base).port);
  const badPath = await rawRequest(port, 'GET /% HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  assert.match(badPath, /HTTP\/1\.1 400/, `decoded path failure must be a 400, got ${JSON.stringify(badPath.slice(0, 80))}`);
  const badHost = await rawRequest(port, 'GET /language-cards.html HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n');
  assert.match(badHost, /HTTP\/1\.1 400/, `malformed Host must be a 400, got ${JSON.stringify(badHost.slice(0, 80))}`);
  // The point of the test: the process is still alive and serving.
  assert.equal((await health(port)).ok, true);
  assert.equal((await httpCall(port, '/language-cards.html')).status, 200);
});

await test('the static blocklist holds for Windows path spellings', async () => {
  const srv = await startServer({ RATE_PER_MIN: '600', RATE_BURST: '10' });
  const port = Number(new URL(srv.base).port);
  // Windows treats "\" as a separator, ignores case, and accepts "file::$DATA"; each spelling
  // must still resolve to the blocklist rather than disclose server source or dotfiles.
  for (const path of ['/%5cserver.mjs', '/%5c.git%5cconfig', '/%5c.claude%5csettings.local.json', '/SERVER.MJS', '/server.mjs.', '/server.mjs::$DATA', '/Tests/logic.test.mjs', '/%2ftests/logic.test.mjs', '/%5ctests%5clogic.test.mjs', '/%2fserver.mjs']) {
    const res = await httpCall(port, path);
    assert.notEqual(res.status, 200, `${path} must not be served (got ${res.status})`);
  }
  assert.equal((await httpCall(port, '/language-cards.html')).status, 200, 'the app itself still serves');
});

// ---- limit instances -----------------------------------------------------------------------
await test('the per-minute rate limit returns 429 with retry-after', async () => {
  const tight = await startServer({ RATE_PER_MIN: '1', RATE_BURST: '1', IP_DAILY_CAP: '1000' });
  const call = makeClient(tight.base);
  const first = await call('/api/translate', { q: 'книга', source: 'uk', target: 'en' });
  assert.equal(first.status, 200);
  const second = await call('/api/translate', { q: 'книга', source: 'uk', target: 'en' });
  assert.equal(second.status, 429);
  assert.match(second.json.error, /rate limit exceeded/);
  assert.ok(Number(second.headers.get('retry-after')) >= 1, 'retry-after must be set');
});

await test('the per-IP daily cap is enforced and reported', async () => {
  const tight = await startServer({ RATE_PER_MIN: '600', RATE_BURST: '10', IP_DAILY_CAP: '3' });
  const call = makeClient(tight.base);
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    const res = await call('/api/translate', { q: 'книга', source: 'uk', target: 'en' });
    statuses.push(res.status);
  }
  assert.deepEqual(statuses.slice(0, 3), [200, 200, 200], `first three should pass: ${statuses.join(',')}`);
  assert.equal(statuses[3], 429, `fourth should be capped: ${statuses.join(',')}`);
  const capped = await call('/api/translate', { q: 'книга', source: 'uk', target: 'en' });
  assert.match(capped.json.error, /daily limit/);
  const health = await call('/api/health', undefined, {}, 'GET');
  assert.equal(health.json.limits.ipDayUsed, 3);
});

await test('invalid numeric env values fall back to the documented limits instead of disabling them', async () => {
  const srv = await startServer({
    RATE_PER_MIN: 'abc', RATE_BURST: 'abc', IP_DAILY_CAP: 'abc', GLOBAL_DAILY_CAP: 'abc',
    MAX_INFLIGHT: 'abc', API_MAX_INFLIGHT: 'abc',
  });
  const h = await health(Number(new URL(srv.base).port));
  assert.deepEqual(
    [h.limits.ratePerMin, h.limits.rateBurst, h.limits.ipDailyCap, h.limits.globalDailyCap],
    [60, 20, 500, 2000],
    'NaN must not become an unbounded limiter',
  );
  assert.deepEqual([h.inflight.maxTotal, h.inflight.maxApi], [128, 8]);
});

await test('a negative burst falls back, and a zero refill rate still answers a finite retry-after', async () => {
  const negative = await startServer({ RATE_BURST: '-1', RATE_PER_MIN: '600' });
  assert.equal((await health(Number(new URL(negative.base).port))).limits.rateBurst, 20);
  const stuck = await startServer({ RATE_PER_MIN: '0', RATE_BURST: '0' });
  const res = await makeClient(stuck.base)('/api/translate', { q: 'книга', source: 'uk', target: 'en' });
  assert.equal(res.status, 429);
  assert.match(res.headers.get('retry-after'), /^\d+$/, 'retry-after must be a finite integer');
});

await test('a request deadline below the header deadline is raised instead of crashing at startup', async () => {
  const srv = await startServer({ HEADERS_TIMEOUT_MS: '5000', REQUEST_TIMEOUT_MS: '100' });
  assert.equal((await health(Number(new URL(srv.base).port))).ok, true);
});

await test('a malformed request still consumes quota', async () => {
  // The limiter runs before body validation on purpose: a bad request must not be free.
  const tight = await startServer({ IP_DAILY_CAP: '1', RATE_PER_MIN: '600', RATE_BURST: '10' });
  const call = makeClient(tight.base);
  const bad = await call('/api/translate', 'not json');
  assert.equal(bad.status, 400);
  const good = await call('/api/translate', { q: 'книга', source: 'uk', target: 'en' });
  assert.equal(good.status, 429, 'the malformed call must have spent the single daily slot');
});

await test('TRUST_PROXY uses the hop the proxy appended, not the client-supplied prefix', async () => {
  const body = JSON.stringify({ q: 'книга', source: 'uk', target: 'en' });
  const trusted = await startServer({ TRUST_PROXY: '1', IP_DAILY_CAP: '1', RATE_PER_MIN: '600', RATE_BURST: '10' });
  const trustedPort = Number(new URL(trusted.base).port);
  const callTrusted = (xff, fly = null) => httpCall(trustedPort, '/api/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': xff, ...(fly ? { 'fly-client-ip': fly } : {}) },
    body,
  });
  assert.equal((await callTrusted('10.0.0.1, 203.0.113.1')).status, 200);
  assert.equal((await callTrusted('10.0.0.2, 203.0.113.1')).status, 429, 'rotating the prefix must not reset the cap');
  assert.equal((await callTrusted('10.0.0.3, 203.0.113.2')).status, 200, 'a different last hop is a different client');

  const fly = await startServer({ TRUST_PROXY: '1', IP_DAILY_CAP: '1', RATE_PER_MIN: '600', RATE_BURST: '10', FLY_APP_NAME: 'test' });
  const flyPort = Number(new URL(fly.base).port);
  const callFly = (xff, flyIp) => httpCall(flyPort, '/api/translate', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': xff, 'fly-client-ip': flyIp }, body,
  });
  assert.equal((await callFly('10.0.0.1', '198.51.100.1')).status, 200);
  assert.equal((await callFly('10.0.0.2', '198.51.100.1')).status, 429, 'Fly-Client-IP wins over the chain');

  const plain = await startServer({ TRUST_PROXY: '0', IP_DAILY_CAP: '1', RATE_PER_MIN: '600', RATE_BURST: '10' });
  const plainPort = Number(new URL(plain.base).port);
  const callPlain = (xff) => httpCall(plainPort, '/api/translate', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': xff }, body,
  });
  assert.equal((await callPlain('203.0.113.1')).status, 200);
  assert.equal((await callPlain('203.0.113.2')).status, 429, 'without TRUST_PROXY every caller shares the socket address');
});

await test('a same-origin browser request is allowed even with a restricted allowlist', async () => {
  const srv = await startServer({ ALLOWED_ORIGINS: 'https://allowed.example', RATE_PER_MIN: '600', RATE_BURST: '10' });
  const port = Number(new URL(srv.base).port);
  const body = JSON.stringify({ q: 'книга', source: 'uk', target: 'en' });
  const own = `http://127.0.0.1:${port}`;
  const same = await httpCall(port, '/api/translate', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: own }, body,
  });
  assert.equal(same.status, 200, 'the app served by this process must be able to call its own API');
  assert.equal(same.headers['access-control-allow-origin'], own);
  const evil = await httpCall(port, '/api/translate', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body,
  });
  assert.equal(evil.status, 403, 'a foreign origin is still refused');
});

await test('the global daily cap stops the server even for a fresh client', async () => {
  const tight = await startServer({ RATE_PER_MIN: '600', RATE_BURST: '10', IP_DAILY_CAP: '1000', GLOBAL_DAILY_CAP: '2' });
  const call = makeClient(tight.base);
  const a = await call('/api/translate', { q: 'книга', source: 'uk', target: 'en' });
  const b = await call('/api/translate', { q: 'книга', source: 'uk', target: 'en' });
  const c = await call('/api/translate', { q: 'книга', source: 'uk', target: 'en' });
  assert.deepEqual([a.status, b.status, c.status], [200, 200, 429]);
  assert.match(c.json.error, /global daily cap/);
  const health = await call('/api/health', undefined, {}, 'GET');
  assert.equal(health.json.limits.globalDayUsed, 2);
});

await test('without a key the app is still served and the proxy says so', async () => {
  const nokey = await startServer({ DEEPSEEK_API_KEY: '', RATE_PER_MIN: '600', RATE_BURST: '10' });
  const call = makeClient(nokey.base);
  const res = await call('/api/translate', { q: 'книга', source: 'uk', target: 'en' });
  assert.equal(res.status, 503);
  assert.match(res.json.error, /no API key configured/);
  const health = await call('/api/health', undefined, {}, 'GET');
  assert.equal(health.json.keyConfigured, false);
  assert.equal((await fetch(`${nokey.base}/language-cards.html`)).status, 200);
});

await test('the optional shared app token is enforced when configured', async () => {
  const tokened = await startServer({ CLIENT_TOKEN: 'shared-secret', RATE_PER_MIN: '600', RATE_BURST: '10' });
  const call = makeClient(tokened.base);
  const denied = await call('/api/translate', { q: 'книга', source: 'uk', target: 'en' });
  assert.equal(denied.status, 401);
  const allowed = await call('/api/translate', { q: 'книга', source: 'uk', target: 'en' }, { 'x-app-token': 'shared-secret' });
  assert.equal(allowed.status, 200);
});

// ---- hardening: slow clients, header caps, connections, concurrency, crawlers, counters -------

await test('a half-open client is cut off inside the bound while normal requests keep working', async () => {
  const srv = await startServer({ HEADERS_TIMEOUT_MS: '400', RATE_PER_MIN: '600', RATE_BURST: '10' });
  const slow = await connect(srv.port ?? Number(new URL(srv.base).port));
  const port = Number(new URL(srv.base).port);
  slow.write('GET /language-cards.html HTTP/1.1\r\nHost: x\r\n'); // headers never terminated
  // A concurrent ordinary request must still be served while the slow socket is held open.
  const normal = await httpCall(port, '/language-cards.html');
  assert.equal(normal.status, 200, 'a normal request during a slow-client attack must succeed');
  const closed = await untilClose(slow, 5000);
  assert.equal(closed.timedOut, false, 'the server must close a half-open socket inside the bound');
  assert.ok(closed.ms < 1000, `closed after ${closed.ms}ms, expected well under the 400ms bound plus slack`);
  const h = await health(port);
  assert.ok(h.refusals.timeout >= 1, `timeout counter should rise, got ${h.refusals.timeout}`);
});

await test('a header count over the cap is refused and counted', async () => {
  const srv = await startServer({ MAX_HEADERS_COUNT: '10', HEADERS_TIMEOUT_MS: '2000', RATE_PER_MIN: '600', RATE_BURST: '10' });
  const port = Number(new URL(srv.base).port);
  const padding = Array.from({ length: 20 }, (_, i) => `X-H${i}: a\r\n`).join('');
  const result = await rawRequest(port, `GET /language-cards.html HTTP/1.1\r\nHost: x\r\n${padding}Connection: close\r\n\r\n`);
  assert.match(result, /431|400/, `expected a refusal, got ${JSON.stringify(result.slice(0, 60))}`);
  assert.ok((await health(port)).refusals.headers_too_large >= 1, 'the header cap must be counted');
});

await test('oversized request headers are refused and counted', async () => {
  const srv = await startServer({ MAX_HEADER_BYTES: '2048', HEADERS_TIMEOUT_MS: '2000', RATE_PER_MIN: '600', RATE_BURST: '10' });
  const port = Number(new URL(srv.base).port);
  const socket = await connect(port);
  socket.write('GET /language-cards.html HTTP/1.1\r\nHost: x\r\n');
  for (let i = 0; i < 80; i++) socket.write(`X-Pad-${i}: ${'a'.repeat(60)}\r\n`);
  socket.write('\r\n');
  const result = await untilClose(socket, 5000);
  assert.equal(result.timedOut, false, 'the server must close or answer an oversized header set');
  assert.match(result.data, /431|400/, `expected a 431/400 answer, got ${JSON.stringify(result.data.slice(0, 60))}`);
  const h = await health(port);
  assert.ok(h.refusals.headers_too_large >= 1, `headers_too_large counter should rise, got ${h.refusals.headers_too_large}`);
});

await test('a client cannot hold more connections than the per-IP cap', async () => {
  const srv = await startServer({ MAX_CONNECTIONS_PER_IP: '2', HEADERS_TIMEOUT_MS: '5000', RATE_PER_MIN: '600', RATE_BURST: '10' });
  const port = Number(new URL(srv.base).port);
  const held = [await connect(port), await connect(port)];
  held.forEach((s) => s.write('GET / HTTP/1.1\r\nHost: x\r\n'));
  const extra = await connect(port);
  const extraResult = await untilClose(extra, 3000);
  assert.equal(extraResult.timedOut, false, 'the connection over the cap must be dropped, not held');
  assert.ok(extraResult.ms < 2000, `dropped after ${extraResult.ms}ms`);
  held.forEach((s) => s.destroy());
  // Read the status endpoint only after releasing the held sockets: with the cap at 2, the probe
  // itself would be the connection over the limit. Poll instead of guessing a fixed delay.
  let h = null;
  for (let i = 0; i < 40 && !h; i++) {
    try { h = await health(port); } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  assert.ok(h, 'health must recover after the held sockets close');
  assert.ok(h.refusals.connection_cap >= 1, `connection_cap counter should rise, got ${h.refusals.connection_cap}`);
  assert.equal(h.connections.maxPerIp, 2);
});

await test('one connection is limited to the configured number of requests', async () => {
  const srv = await startServer({ MAX_REQUESTS_PER_SOCKET: '2', HEADERS_TIMEOUT_MS: '5000', KEEP_ALIVE_TIMEOUT_MS: '2000', RATE_PER_MIN: '600', RATE_BURST: '10' });
  const port = Number(new URL(srv.base).port);
  const socket = await connect(port);
  for (let i = 0; i < 3; i++) socket.write('GET /language-cards.html HTTP/1.1\r\nHost: x\r\n\r\n');
  const result = await untilClose(socket, 4000);
  const responses = (result.data.match(/HTTP\/1\.1 200/g) || []).length;
  assert.equal(responses, 2, `expected exactly 2 responses on one socket, got ${responses}`);
  assert.ok(/connection: close/i.test(result.data), 'the last response must close the connection');
});

await test('a stalled request body gets a 408 and is counted', async () => {
  const srv = await startServer({ HEADERS_TIMEOUT_MS: '300', REQUEST_TIMEOUT_MS: '500', RATE_PER_MIN: '600', RATE_BURST: '10' });
  const port = Number(new URL(srv.base).port);
  const result = await rawRequest(port, 'POST /api/translate HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"q":');
  assert.match(result, /HTTP\/1\.1 408/, 'a body that never finishes must hit the whole-request deadline');
  assert.ok((await health(port)).refusals.timeout >= 1, 'the timeout must be counted');
});

await test('HEAD returns headers without a body for the app, robots and health', async () => {
  const port = Number(new URL(main.base).port);
  const page = await httpCall(port, '/language-cards.html', { method: 'HEAD' });
  assert.equal(page.status, 200);
  assert.ok(Number(page.headers['content-length']) > 0, 'HEAD keeps the representation length');
  assert.equal(page.body, '', 'HEAD must not send a body');
  for (const path of ['/robots.txt', '/api/health']) {
    const res = await httpCall(port, path, { method: 'HEAD' });
    assert.equal(res.status, 200, `${path} HEAD status`);
    assert.equal(res.body, '', `${path} HEAD body`);
  }
});

await test('excess concurrent API requests are shed with retry-after, then service recovers', async () => {
  const srv = await startServer({ API_MAX_INFLIGHT: '2', MAX_INFLIGHT: '64', RATE_PER_MIN: '6000', RATE_BURST: '200', IP_DAILY_CAP: '1000' });
  const port = Number(new URL(srv.base).port);
  upstreamDelayMs = 500;
  const body = JSON.stringify({ q: 'книга', source: 'uk', target: 'en' });
  const burst = await Promise.all(Array.from({ length: 8 }, () => httpCall(port, '/api/translate', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  })));
  const shed = burst.filter((r) => r.status === 503);
  const served = burst.filter((r) => r.status === 200);
  assert.ok(served.length <= 2, `the API cap is 2, so at most 2 overlap; got ${served.length}`);
  assert.ok(shed.length >= 6, `the other 6 must be shed; got statuses ${burst.map((r) => r.status).join(',')}`);
  assert.ok(shed.every((r) => Number(r.headers['retry-after']) >= 1), 'shed responses must carry retry-after');
  assert.match(shed[0].body, /server busy/);
  upstreamDelayMs = 0;
  // Recovery: with load gone, a single request is served again.
  const after = await httpCall(port, '/api/translate', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(after.status, 200, 'the server must serve normally once load drops');
  const h = await health(port);
  assert.ok(h.refusals.concurrency_shed >= 1, `concurrency_shed counter should rise, got ${h.refusals.concurrency_shed}`);
  assert.ok(h.inflight.total <= h.inflight.maxTotal);
});

await test('crawlers are refused on the protected paths and served everywhere else', async () => {
  const srv = await startServer({ RATE_PER_MIN: '600', RATE_BURST: '10' });
  const port = Number(new URL(srv.base).port);
  const botUa = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
  const body = JSON.stringify({ q: 'книга', source: 'uk', target: 'en' });

  const botApi = await httpCall(port, '/api/translate', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': botUa }, body });
  assert.equal(botApi.status, 403, 'a crawler must not use the translation API');

  const botBundle = await httpCall(port, '/ukr-cards-categorized.json', { headers: { 'user-agent': botUa } });
  assert.equal(botBundle.status, 403, 'a crawler must not pull the large bundle');

  const botLexicon = await httpCall(port, '/lexicon.json', { headers: { 'user-agent': botUa } });
  assert.equal(botLexicon.status, 403, 'a crawler must not pull the lexicon');

  const botPage = await httpCall(port, '/language-cards.html', { headers: { 'user-agent': botUa } });
  assert.equal(botPage.status, 200, 'the app page stays reachable for crawlers');

  const botRobots = await httpCall(port, '/robots.txt', { headers: { 'user-agent': botUa } });
  assert.equal(botRobots.status, 200, 'robots.txt stays reachable for crawlers');

  const humanApi = await httpCall(port, '/api/translate', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': BROWSER_UA }, body });
  assert.equal(humanApi.status, 200, 'the same call with a browser User-Agent succeeds');

  const h = await health(port);
  assert.ok(h.refusals.bot_blocked >= 3, `bot_blocked counter should rise, got ${h.refusals.bot_blocked}`);
});

await test('percent-encoded protected paths are still refused to crawlers', async () => {
  const srv = await startServer({ RATE_PER_MIN: '600', RATE_BURST: '10' });
  const port = Number(new URL(srv.base).port);
  const botUa = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
  for (const path of ['/%75kr-cards-categorized.json', '/lexicon%2Ejson', '/%61pi/translate']) {
    const res = await httpCall(port, path, { headers: { 'user-agent': botUa } });
    assert.equal(res.status, 403, `${path} must be behind the crawler policy`);
  }
  const human = await httpCall(port, '/%75kr-cards-categorized.json', { headers: { 'user-agent': BROWSER_UA } });
  assert.equal(human.status, 200, 'decoding must not break the static route for real clients');
});

await test('encoded traversal cannot read outside the static root', async () => {
  const staticRoot = mkdtempSync(join(tmpdir(), 'fc-static-'));
  const secretName = `secret-${basename(staticRoot)}.txt`;
  writeFileSync(join(staticRoot, 'inside.txt'), 'inside');
  writeFileSync(join(staticRoot, '..', secretName), 'SECRET-OUTSIDE');
  const srv = await startServer({ STATIC_ROOT: staticRoot, RATE_PER_MIN: '600', RATE_BURST: '10' });
  const port = Number(new URL(srv.base).port);
  for (const path of [`/..%2f${secretName}`, `/%2e%2e%2f${secretName}`, `/..%5c${secretName}`]) {
    const res = await httpCall(port, path);
    assert.notEqual(res.status, 200, `${path} must not be served`);
    assert.ok(!res.body.includes('SECRET-OUTSIDE'), `${path} leaked a file outside the root`);
  }
  assert.equal((await httpCall(port, '/inside.txt')).status, 200, 'files inside the root still serve');
});

await test('robots.txt declares the policy the server enforces', async () => {
  const srv = await startServer({ RATE_PER_MIN: '600', RATE_BURST: '10' });
  const port = Number(new URL(srv.base).port);
  const res = await httpCall(port, '/robots.txt');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/plain/);
  assert.match(res.body, /User-agent: \*/);
  // The file and the code must not drift: every path the server protects for crawlers is disallowed.
  const source = await import('node:fs').then((fs) => fs.readFileSync(join(root, 'server.mjs'), 'utf8'));
  const protectedPaths = JSON.parse(/CRAWLER_PROTECTED_PATHS = (\[[^\]]+\])/.exec(source)[1].replace(/'/g, '"'));
  assert.ok(protectedPaths.length >= 3, `expected the protected list, got ${protectedPaths.length}`);
  const disallowed = res.body.split('\n').filter((l) => /^Disallow:/i.test(l.trim())).map((l) => l.split(':')[1].trim());
  for (const p of protectedPaths) {
    assert.ok(disallowed.some((d) => p === d || p.startsWith(d)), `${p} is not covered by a Disallow rule (${disallowed.join(', ')})`);
  }
  assert.match(res.body, /Allow: \//);
});

await test('every refusal reason is counted and readable from the status endpoint', async () => {
  // Generous rate limits on purpose: the limiter is checked before the body is read, so a tight
  // bucket would answer 429 first and mask the refusal under test. The caps get their own tests.
  const srv = await startServer({
    RATE_PER_MIN: '6000', RATE_BURST: '200', MAX_INPUT_CHARS: '10', API_MAX_INFLIGHT: '1',
    HEADERS_TIMEOUT_MS: '300', MAX_HEADER_BYTES: '2048', ALLOWED_ORIGINS: 'http://localhost:5173',
    CLIENT_TOKEN: 'shared-secret',
  });
  const port = Number(new URL(srv.base).port);
  const auth = { 'x-app-token': 'shared-secret' };
  const before = (await health(port)).refusals;

  // app_token: no token at all
  await httpCall(port, '/api/translate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  // origin_not_allowed
  await httpCall(port, '/api/translate', { method: 'POST', headers: { 'content-type': 'application/json', ...auth, origin: 'https://evil.example' }, body: JSON.stringify({ q: 'книга', source: 'uk', target: 'en' }) });
  // bad_request: missing q, then an over-long q
  await httpCall(port, '/api/translate', { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ source: 'uk', target: 'en' }) });
  await httpCall(port, '/api/translate', { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ q: 'я'.repeat(11), source: 'uk', target: 'en' }) });
  // body_too_large (the body cap is 8 KB)
  await httpCall(port, '/api/translate', { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ q: 'x'.repeat(9000) }) });
  // bot_blocked
  await httpCall(port, '/api/translate', { method: 'POST', headers: { 'content-type': 'application/json', ...auth, 'user-agent': 'Mozilla/5.0 (compatible; AhrefsBot/7.0)' }, body: JSON.stringify({ q: 'книга', source: 'uk', target: 'en' }) });
  // upstream_failed
  upstreamMode = 'unauthorized';
  await httpCall(port, '/api/translate', { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ q: 'книга', source: 'uk', target: 'en' }) });
  upstreamMode = 'ok';
  // concurrency_shed: hold the single API slot with a slow upstream and fire the rest at once
  upstreamDelayMs = 600;
  const overlapping = Array.from({ length: 4 }, () => httpCall(port, '/api/translate', {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth, 'user-agent': BROWSER_UA }, body: JSON.stringify({ q: 'книга', source: 'uk', target: 'en' }),
  }));
  const overlapResults = await Promise.all(overlapping);
  upstreamDelayMs = 0;
  assert.ok(overlapResults.some((r) => r.status === 503), `expected a shed request, got ${overlapResults.map((r) => r.status).join(',')}`);
  // timeout: a half-open socket
  const slow = await connect(port);
  slow.write('GET / HTTP/1.1\r\nHost: x\r\n');
  await untilClose(slow, 4000);
  // headers_too_large
  const big = await connect(port);
  big.write('GET / HTTP/1.1\r\nHost: x\r\n');
  for (let i = 0; i < 80; i++) big.write(`X-Pad-${i}: ${'a'.repeat(60)}\r\n`);
  big.write('\r\n');
  await untilClose(big, 4000);

  const after = (await health(port)).refusals;
  const expected = ['app_token', 'origin_not_allowed', 'bad_request', 'body_too_large', 'bot_blocked', 'upstream_failed', 'concurrency_shed', 'timeout', 'headers_too_large'];
  const flat = [];
  for (const reason of expected) {
    assert.ok(typeof after[reason] === 'number', `${reason} missing from the status endpoint`);
    if (!(after[reason] > (before[reason] || 0))) flat.push(`${reason}=${after[reason]}`);
  }
  assert.deepEqual(flat, [], `these counters did not rise: ${flat.join(', ')}`);
  // Every reason the server can record is exposed, so an operator can see the whole picture.
  const exposed = Object.keys(after);
  for (const reason of ['rate_limit', 'ip_daily_cap', 'global_daily_cap', 'concurrency_shed', 'connection_cap', 'bot_blocked', 'timeout', 'headers_too_large', 'body_too_large', 'bad_request', 'origin_not_allowed', 'app_token', 'upstream_failed']) {
    assert.ok(exposed.includes(reason), `${reason} is not exposed by /api/health`);
  }
});

await test('the rate limit and the daily caps are counted too', async () => {
  // rate_limit: burst 1 with a 1/min refill means the second call has no tokens.
  const rate = await startServer({ RATE_PER_MIN: '1', RATE_BURST: '1', IP_DAILY_CAP: '1000' });
  const ratePort = Number(new URL(rate.base).port);
  const call = (port) => httpCall(port, '/api/translate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: 'книга', source: 'uk', target: 'en' }) });
  await call(ratePort);
  const limited = await call(ratePort);
  assert.equal(limited.status, 429, 'the second call must be rate limited');
  const rateHealth = await health(ratePort);
  assert.ok(rateHealth.refusals.rate_limit >= 1, `rate_limit counter should rise, got ${rateHealth.refusals.rate_limit}`);

  const perIp = await startServer({ RATE_PER_MIN: '600', RATE_BURST: '10', IP_DAILY_CAP: '2', GLOBAL_DAILY_CAP: '1000' });
  const perIpPort = Number(new URL(perIp.base).port);
  for (let i = 0; i < 3; i++) await call(perIpPort);
  const ipHealth = await health(perIpPort);
  assert.ok(ipHealth.refusals.ip_daily_cap >= 1, `ip_daily_cap counter should rise, got ${ipHealth.refusals.ip_daily_cap}`);

  const global = await startServer({ RATE_PER_MIN: '600', RATE_BURST: '10', IP_DAILY_CAP: '1000', GLOBAL_DAILY_CAP: '2' });
  const globalPort = Number(new URL(global.base).port);
  for (let i = 0; i < 3; i++) await call(globalPort);
  const globalHealth = await health(globalPort);
  assert.ok(globalHealth.refusals.global_daily_cap >= 1, `global_daily_cap counter should rise, got ${globalHealth.refusals.global_daily_cap}`);
});

await test('BOT_POLICY=off leaves crawlers served, and health stays open for monitors', async () => {
  const srv = await startServer({ BOT_POLICY: 'off', RATE_PER_MIN: '600', RATE_BURST: '10' });
  const port = Number(new URL(srv.base).port);
  const botUa = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
  const api = await httpCall(port, '/api/translate', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': botUa }, body: JSON.stringify({ q: 'книга', source: 'uk', target: 'en' }) });
  assert.equal(api.status, 200, 'with BOT_POLICY=off crawlers are not blocked');
  const healthAsBot = await httpCall(port, '/api/health', { headers: { 'user-agent': 'Mozilla/5.0 (compatible; UptimeRobot/2.0)' } });
  assert.equal(healthAsBot.status, 200, 'a monitoring bot must still reach /api/health');
});

await test('SERVE_STATIC=0 serves the API only, and keeps robots.txt', async () => {
  const srv = await startServer({ SERVE_STATIC: '0', RATE_PER_MIN: '600', RATE_BURST: '10' });
  const port = Number(new URL(srv.base).port);
  const page = await httpCall(port, '/language-cards.html');
  assert.equal(page.status, 404, 'the app must not be served by an API-only deployment');
  assert.match(page.body, /serves only/);
  const root = await httpCall(port, '/');
  assert.equal(root.status, 404);
  const robots = await httpCall(port, '/robots.txt');
  assert.equal(robots.status, 200, 'robots.txt still declares the API crawl policy');
  assert.match(robots.body, /Disallow: \/api\//);
  const health = await httpCall(port, '/api/health');
  assert.equal(health.status, 200);
  const tr = await httpCall(port, '/api/translate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: 'книга', source: 'uk', target: 'en' }) });
  assert.equal(tr.status, 200, 'the API keeps working');
  assert.equal(JSON.parse(tr.body).text, 'book');
});

await test('a locally-served app can call a remote server (localhost and null origins)', async () => {
  // ALLOWED_ORIGINS=localhost,null is the API-only deployment default: the app runs from the user's
  // own machine, so its origin is http://localhost:<any port> or "null" when opened from file://.
  const srv = await startServer({ ALLOWED_ORIGINS: 'localhost,null', RATE_PER_MIN: '600', RATE_BURST: '10' });
  const port = Number(new URL(srv.base).port);
  const body = JSON.stringify({ q: 'книга', source: 'uk', target: 'en' });
  for (const origin of ['http://localhost:8080', 'http://127.0.0.1:5173', 'https://localhost:3000', 'null']) {
    const res = await httpCall(port, '/api/translate', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body });
    assert.equal(res.status, 200, `${origin} should be allowed, got ${res.status} ${res.body.slice(0, 80)}`);
    assert.equal(res.headers['access-control-allow-origin'], origin, `${origin} must be echoed back`);
  }
  const evil = await httpCall(port, '/api/translate', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body });
  assert.equal(evil.status, 403, 'a foreign origin must still be refused');
  const evilLocal = await httpCall(port, '/api/translate', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://localhost.evil.example' }, body });
  assert.equal(evilLocal.status, 403, 'a lookalike host must not match the localhost token');
});

await test('originAllowed matches exactly what it claims to', async () => {
  const { originAllowed, config } = await import('../server.mjs');
  if (process.env.ALLOWED_ORIGINS === undefined) {
    assert.deepEqual(config.allowedOrigins, ['localhost', 'null'], 'the default allowlist is the local app, not any origin');
  }
  assert.equal(originAllowed(undefined, ['localhost']), true, 'no Origin (curl, monitors) is allowed');
  assert.equal(originAllowed('http://localhost:8787', ['localhost']), true);
  assert.equal(originAllowed('http://127.0.0.1:1', ['localhost']), true);
  assert.equal(originAllowed('https://localhost', ['localhost']), true);
  assert.equal(originAllowed('null', ['localhost', 'null']), true);
  assert.equal(originAllowed('null', ['localhost']), false);
  assert.equal(originAllowed('http://localhost.evil.example', ['localhost']), false);
  assert.equal(originAllowed('file://', ['localhost']), false);
  assert.equal(originAllowed('https://app.example', ['https://app.example']), true);
  assert.equal(originAllowed('https://other.example', ['https://app.example']), false);
  assert.equal(originAllowed('https://anything.example', []), true, 'empty list means any origin');
});

for (const s of servers) s.kill();
upstream.close();

for (const [tag, name] of results) console.log(`${tag}  ${name}`);
if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall server tests passed');
