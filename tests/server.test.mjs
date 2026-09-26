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
import { dirname, join } from 'node:path';
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
const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    upstreamCalls.push({ url: req.url, auth: req.headers.authorization, body });
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
let nextPort = 8791;
async function startServer(env = {}) {
  const port = nextPort++;
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
  assert.equal(upstreamCalls.length, 1);
});

await test('the key is sent to the upstream as a bearer token, never by the client', () => {
  assert.equal(upstreamCalls[0].auth, `Bearer ${KEY}`);
});

await test('the upstream request asks for JSON and names the model', () => {
  const body = JSON.parse(upstreamCalls[0].body);
  assert.equal(body.model, 'deepseek-flash');
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(body.temperature, 0);
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

await test('the API key never appears in any response body', () => {
  assert.ok(seenBodies.length > 10, 'expected the client to have made calls');
  for (const body of seenBodies) assert.ok(!body.includes(KEY), 'key leaked in a body');
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
  const res = await fetch(`${main.base}/../package.json`, { redirect: 'manual' });
  assert.ok(res.status === 404 || res.status === 403, `got ${res.status}`);
});

await test('a POST to a static path is refused', async () => {
  const res = await fetch(`${main.base}/language-cards.html`, { method: 'POST', body: 'x' });
  assert.equal(res.status, 405);
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

for (const s of servers) s.kill();
upstream.close();

for (const [tag, name] of results) console.log(`${tag}  ${name}`);
if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall server tests passed');
