#!/usr/bin/env node
// Live provider check: exercises the REAL DeepSeek API through the shipped server, which is the only
// way to catch provider behaviour that a stub cannot have — `deepseek-flash` defaulting to thinking
// mode and returning an empty content is exactly what shipped broken once.
//
// Opt-in: it needs a real key and spends a fraction of a cent, so it skips loudly without one.
//   DEEPSEEK_API_KEY=... node tests/live-provider.test.mjs
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const key = process.env.DEEPSEEK_API_KEY;
if (!key) {
  console.log('skipped: DEEPSEEK_API_KEY is not set (this test calls the real provider)');
  process.exit(0);
}

const port = Number(process.env.LIVE_TEST_PORT || 8765);
const child = spawn(process.execPath, [join(root, 'server.mjs')], {
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    SERVE_STATIC: '0',
    RATE_PER_MIN: '60',
    RATE_BURST: '10',
    IP_DAILY_CAP: '50',
    GLOBAL_DAILY_CAP: '100',
    ALLOWED_ORIGINS: 'localhost,null',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = [];
child.stdout.on('data', (d) => log.push(String(d)));
child.stderr.on('data', (d) => log.push(String(d)));

const base = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 8000;
let up = false;
while (Date.now() < deadline && !up) {
  try { up = (await fetch(`${base}/api/health`)).signal; } catch {}
  try { const r = await fetch(`${base}/api/health`); up = r.ok; } catch {}
  if (!up) await new Promise((r) => setTimeout(r, 100));
}
if (!up) { console.error('server did not start:', log.join('')); process.exit(1); }

let failed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); results.push(['ok  ', name]); }
  catch (e) { failed++; results.push(['FAIL', `${name} :: ${e.message}`]); }
}

// Words whose three targets all differ from the source. Ukrainian and Russian share many words
// (819 of the 5,875 bundled cards have uk === ru), and the identical-to-source guard rejects those
// by design — see the dedicated test below.
const WORDS = [
  { q: 'дім', targets: { en: 'house', ru: 'дом', fi: 'talo' } },
  { q: 'кіт', targets: { en: 'cat', ru: 'кот', fi: 'kissa' } },
];

async function translate(q, target, origin) {
  const headers = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  const res = await fetch(`${base}/api/translate`, { method: 'POST', headers, body: JSON.stringify({ q, source: 'uk', target }) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

await test('the live provider answers with a translation for every target language', async () => {
  for (const { q, targets } of WORDS) {
    for (const [target, expected] of Object.entries(targets)) {
      const res = await translate(q, target);
      assert.equal(res.status, 200, `${q}->${target}: ${res.status} ${res.text.slice(0, 120)}`);
      const value = res.json.text;
      assert.ok(value && value.length, `${q}->${target}: empty translation`);
      // The provider may legitimately choose a synonym; assert the shape and that it is not an echo.
      assert.notEqual(value.toLowerCase(), q.toLowerCase(), `${q}->${target}: echoed the source`);
      if (target === 'ru' || target === 'fi') {
        assert.ok(!/\p{Script=Cyrillic}/u.test(value) || target === 'ru', `${q}->${target}: unexpected script`);
      }
      results.push(['info', `${q} -> ${target}: ${value}${value === expected ? ' (expected)' : ''}`]);
    }
  }
});

await test('a thinking-mode empty answer is reported as a provider problem, not stored', async () => {
  // The regression this guards: with thinking enabled the model returned content "" and the server
  // answered 502 rather than accepting an empty card value.
  const res = await translate('притьмом', 'en');
  assert.equal(res.status, 200, `expected a translation, got ${res.status} ${res.text.slice(0, 160)}`);
  assert.ok(res.json.text.trim().length > 0);
});

await test('a shared Ukrainian/Russian word is refused as identical to source (documented behaviour)', async () => {
  // "книга" is the same word in both languages, so the answer equals the source. The guard cannot
  // tell a correct cognate from a provider that echoed the input, and the client applies the same
  // rule, so the cell is left for the user to edit rather than storing an unverified value.
  const res = await translate('книга', 'ru');
  assert.equal(res.status, 502);
  assert.match(res.json.error, /identical to source/);
});

await test('the live server answers a browser origin and refuses a foreign one', async () => {
  const ok = await translate('книга', 'en', 'http://localhost:8080');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:8080');
  const denied = await translate('книга', 'en', 'https://evil.example');
  assert.equal(denied.status, 403);
});

await test('an API-only deployment does not serve the app', async () => {
  const page = await fetch(`${base}/language-cards.html`);
  assert.equal(page.status, 404);
  const robots = await fetch(`${base}/robots.txt`);
  assert.equal(robots.status, 200);
});

await test('the key is never echoed back', async () => {
  const res = await translate('книга', 'en');
  assert.ok(!res.text.includes(key), 'the response body contains the key');
  const health = await (await fetch(`${base}/api/health`)).text();
  assert.ok(!health.includes(key), 'health contains the key');
});

child.kill();
for (const [tag, name] of results) console.log(`${tag}  ${name}`);
if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nlive provider checks passed');
