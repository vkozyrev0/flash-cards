#!/usr/bin/env node
// Opt-in browser checks: drives the real app in headless Edge/Chrome over CDP.
// Requires a Chromium-based browser. Set EDGE_PATH when it is not at the default Windows path.
//
//   node tests/browser.test.mjs
//
// The check covers the bundle, quiz focus and announcements, keyboard menus, cell editing, the
// dialog key guard, service-worker precache, a stale-tab save, and the pre-homonym migration.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!existsSync(EDGE)) {
  console.log('SKIP browser checks: set EDGE_PATH to a Chromium-based browser');
  process.exit(0);
}

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
const APP_PORT = await freePort();
let DEBUG_PORT = await freePort();
while (DEBUG_PORT === APP_PORT) DEBUG_PORT = await freePort();
const APP = `http://127.0.0.1:${APP_PORT}/language-cards.html`;

const appServerLog = [];
const appServer = spawn(process.execPath, [join(REPO, 'server.mjs')], {
  // Headless Chrome's UA is classified as a crawler, which would block the bundle it needs.
  env: { ...process.env, PORT: String(APP_PORT), HOST: '127.0.0.1', STATIC_ROOT: REPO, DEEPSEEK_API_KEY: '', SERVE_STATIC: '1', BOT_POLICY: 'off' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
appServer.stdout.on('data', (d) => appServerLog.push(String(d)));
appServer.stderr.on('data', (d) => appServerLog.push(String(d)));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'fc-edge-'))}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
], { stdio: 'ignore' });

async function connectPage(wsUrl, { collect = false } = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(data.error.message)); else resolve(data.result);
    } else if (collect && data.method) {
      events.push(data);
    }
  };
  const send = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const evaluate = async (expression) => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) throw new Error(`page exception: ${out.exceptionDetails.text}`);
    return out.result.value;
  };
  const waitFor = async (expression, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try { if (await evaluate(expression)) return true; } catch {}
      await sleep(150);
    }
    throw new Error(`timed out waiting for: ${expression}`);
  };
  await send('Runtime.enable');
  if (collect) { await send('Page.enable'); await send('Log.enable'); }
  return { send, evaluate, waitFor, events, close: () => ws.close() };
}

async function openTarget() {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' });
  return await res.json();
}
async function closeBrowser() {
  try {
    const version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await sleep(300);
  } catch {}
  edge.kill();
}

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });
const STATE_LOADED = `typeof state !== 'undefined' && state.cards && Object.keys(state.cards).length > 5000`;

try {
  for (let i = 0; i < 100; i++) {
    try { const res = await fetch(APP); if (res.ok) break; } catch {}
    await sleep(100);
  }
  let page = null;
  for (let i = 0; i < 100 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page');
    } catch {}
    if (!page) await sleep(100);
  }
  if (!page) throw new Error('the browser did not expose a page target');

  const main = await connectPage(page.webSocketDebuggerUrl, { collect: true });
  await main.send('Page.navigate', { url: APP });
  await main.waitFor("document.readyState === 'complete'");
  await main.waitFor(STATE_LOADED, 30000);

  const ids = await main.evaluate("Object.keys(state.cards).filter(id => id.includes('#')).sort()");
  const cardCount = await main.evaluate('Object.keys(state.cards).length');
  check('bundle loads every card', cardCount === 5875, `cards=${cardCount}`);
  check('collided bundle entries are distinct', ['можна#may-i', 'можна#it-is-allowed', 'правда#really', 'по-друге#secondly-phrase'].every((id) => ids.includes(id)), `hash ids=${ids.length}`);
  check('pool header matches the pool', (await main.evaluate("document.getElementById('poolCount').textContent")) === String(cardCount));
  check('theme tokens resolve', await main.evaluate("getComputedStyle(document.body).getPropertyValue('--bg').trim().length > 0"));

  // Quiz flow, including the live region and focus placement.
  await main.evaluate("document.querySelector('.tab[data-tab=\"quiz\"]').click()");
  await main.evaluate("document.getElementById('startBtn').click()");
  await main.waitFor("!document.getElementById('quizSection').classList.contains('hidden')");
  const prompt = await main.evaluate("document.getElementById('prompt').textContent");
  const live = await main.evaluate("document.getElementById('quizLive').textContent");
  check('quiz shows a prompt', prompt.trim().length > 0, prompt.slice(0, 30));
  check('quiz announces prompt and direction', live.includes(prompt) && /Translate|Переклад|Перевед/.test(live), live.slice(0, 80));
  check('first choice receives focus', await main.evaluate("document.activeElement.classList.contains('choice')"));
  await main.evaluate("document.querySelector('#choices button.choice').click()");
  await sleep(120);
  check('answer feedback is announced', (await main.evaluate("document.getElementById('quizLive').textContent")).length > 0);
  check('continue button receives focus', (await main.evaluate("document.activeElement.id")) === 'continueBtn');
  check('continue row is visible', (await main.evaluate("document.getElementById('continueRow').style.display")) === 'flex');

  // Cancel the session and dismiss the confirm. While it is open, quiz keys must be ignored.
  await main.evaluate("document.getElementById('cancelSessionBtn').click()");
  await sleep(100);
  if (await main.evaluate("!!document.querySelector('dialog[open]')")) {
    const promptBeforeDialog = await main.evaluate("document.getElementById('prompt').textContent");
    await main.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}))");
    await sleep(100);
    check('quiz keys are ignored while a dialog is open',
      (await main.evaluate("document.getElementById('prompt').textContent")) === promptBeforeDialog
      && (await main.evaluate("!!document.querySelector('dialog[open]')")));
    await main.evaluate("document.getElementById('appNoticeOk').click()");
    await sleep(100);
  }
  check('session exits back to the tabs', await main.evaluate("!document.body.classList.contains('quiz-active')"));

  // Deck picker keyboard: ArrowDown enters the list, Escape returns to the trigger.
  await main.evaluate("document.getElementById('deckPickerBtn').focus()");
  await main.evaluate("document.getElementById('deckPickerBtn').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))");
  await sleep(150);
  check('deck picker ArrowDown focuses an option', await main.evaluate("document.activeElement.classList.contains('deck-picker-item')"), await main.evaluate('document.activeElement.className'));
  await main.evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  await sleep(80);
  check('deck picker Escape closes and restores focus', await main.evaluate("document.getElementById('deckPickerMenu').hidden && document.activeElement.id === 'deckPickerBtn'"));

  // Enhanced select keyboard: open with ArrowDown, move, choose with Enter.
  await main.evaluate("document.querySelector('.tab[data-tab=\"settings\"]').click()");
  const providerBefore = await main.evaluate("document.getElementById('setProvider').value");
  await main.evaluate("(() => { const sel=document.getElementById('setProvider'); const btn=sel.previousElementSibling.querySelector('button'); btn.focus(); btn.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})); })()");
  await sleep(80);
  check('custom select ArrowDown opens and focuses an option', await main.evaluate("document.activeElement.getAttribute('role') === 'option'"), await main.evaluate("document.activeElement.className"));
  await main.evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))");
  await sleep(40);
  await main.evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
  await sleep(120);
  check('custom select Enter changes the value', (await main.evaluate("document.getElementById('setProvider').value")) !== providerBefore, `${providerBefore} -> ${await main.evaluate("document.getElementById('setProvider').value")}`);
  await main.evaluate("(() => { const sel=document.getElementById('setProvider'); sel.value='google'; sel.dispatchEvent(new Event('change',{bubbles:true})); })()");

  // Inline cell edit keeps focus on the cell after Enter.
  await main.evaluate("document.querySelector('.tab[data-tab=\"words\"]').click()");
  await main.evaluate("(() => { const cell=document.querySelector('#poolList .lang-cell'); cell.focus(); cell.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()");
  await sleep(60);
  check('cell edit focuses its input', await main.evaluate("!!document.querySelector('#poolList .lang-cell input') && document.activeElement.tagName === 'INPUT'"));
  await main.evaluate("(() => { const inp=document.querySelector('#poolList .lang-cell input'); inp.value='zzz-audit'; inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()");
  await sleep(80);
  check('cell edit restores focus to the cell', await main.evaluate("document.activeElement.classList.contains('lang-cell') && document.activeElement.textContent === 'zzz-audit'"), await main.evaluate('document.activeElement.textContent'));

  // Add an existing lexicon word: creates a deck without any network call.
  await main.evaluate("document.getElementById('wordsInput').value='привіт'; document.querySelector('input[name=\"addSourceLang\"][value=\"uk\"]').checked=true; document.getElementById('addBtn').click()");
  await sleep(600);
  const activeDeck = await main.evaluate('state.active');
  check('adding an existing word creates the batch deck', typeof activeDeck === 'string' && activeDeck.startsWith('Deck '), activeDeck);
  check('the new deck holds the existing card', (await main.evaluate('state.decks[state.active].uk.length')) >= 1);

  // Reload proves the new deck and the edit persisted through localStorage.
  await main.send('Page.reload');
  await main.waitFor("document.readyState === 'complete'");
  await main.waitFor(STATE_LOADED, 30000);
  check('state persists across reload', (await main.evaluate('state.active')) === activeDeck, await main.evaluate('state.active'));

  const swInfo = await main.evaluate(`(async () => {
    await navigator.serviceWorker.ready;
    const keys = await caches.keys();
    const cache = await caches.open(keys[0]);
    const reqs = await cache.keys();
    return { controlled: !!navigator.serviceWorker.controller, urls: reqs.map((r) => new URL(r.url).pathname) };
  })()`);
  check('service worker controls the page', swInfo.controlled);
  check('raster icons are precached', ['/icon-180.png', '/icon-192.png', '/icon-512.png'].every((p) => swInfo.urls.includes(p)), swInfo.urls.join(','));

  // A second tab makes a newer save; the first tab is now stale and must refuse to overwrite it.
  const second = await connectPage((await openTarget()).webSocketDebuggerUrl);
  await second.waitFor(STATE_LOADED, 30000);
  const newer = await second.evaluate(`(() => {
    localStorage.setItem('ukr-cards-v3-rev', '100');
    _savedRev = 100;
    state.decks['CrossTab'] = { uk: [] };
    state.active = 'CrossTab';
    saveState();
    return { active: state.active, rev: localStorage.getItem('ukr-cards-v3-rev') };
  })()`);
  await sleep(800);
  const stale = await main.evaluate(`(() => {
    _savedRev = 100;
    state.settings.uiLang = 'uk';
    saveState();
    const stored = JSON.parse(localStorage.getItem('ukr-cards-v3'));
    return { warned: _otherTabWarned, active: stored.active, lang: stored.settings.uiLang };
  })()`);
  check('a stale tab refuses to overwrite and warns',
    newer.active === 'CrossTab' && stale.warned === true && stale.active === 'CrossTab' && stale.lang === 'en',
    JSON.stringify({ newer, stale }));
  second.close();

  // Upgrade path: a pre-rekey state holds the old surviving sentence under the plain id. The load
  // migration moves it, freeing the plain id; Sync then adds the plain word beside it.
  await main.evaluate(`localStorage.setItem('ukr-cards-v3', JSON.stringify({
    cards: { 'можна': { id: 'можна', uk: 'Можна.', ru: 'Можно.', en: 'It is allowed.', fi: 'Saa.', categories: ['sentence'], addedAt: 1, streak: 3, rightCount: 3, wrongCount: 0, nextDue: 1, lastSeen: 1 } },
    decks: { default: { uk: ['можна'] } },
    active: 'default',
    settings: { uiLang: 'en' },
    deletedIds: [],
    bootstrapped: true,
    rev: 0,
  })); localStorage.removeItem('ukr-cards-v3-rev');`);
  await main.send('Page.reload');
  await main.waitFor("document.readyState === 'complete'");
  await main.waitFor("typeof state !== 'undefined' && state.cards && !!state.cards['можна#it-is-allowed']", 20000);
  const migrated = await main.evaluate(`({
    base: state.cards['можна'] ? state.cards['можна'].uk : null,
    sentence: state.cards['можна#it-is-allowed'] ? { uk: state.cards['можна#it-is-allowed'].uk, streak: state.cards['можна#it-is-allowed'].streak } : null,
    deck: state.decks.default.uk.slice(),
  })`);
  check('old collided state migrates to the rekeyed id',
    migrated.base === null && migrated.sentence && migrated.sentence.uk === 'Можна.' && migrated.sentence.streak === 3,
    JSON.stringify(migrated));
  check('the default deck follows the migration',
    migrated.deck.includes('можна#it-is-allowed') && !migrated.deck.includes('можна'), migrated.deck.join(','));

  await main.evaluate("document.querySelector('.tab[data-tab=\"settings\"]').click(); document.getElementById('setSyncBtn').click()");
  await main.waitFor("typeof state !== 'undefined' && state.cards && state.cards['можна'] && state.cards['можна'].uk === 'можна'", 40000);
  check('bundle sync adds the plain word after migration',
    await main.evaluate("state.cards['можна'].uk === 'можна' && state.cards['можна#it-is-allowed'].streak === 3"));

  // The profile loads enterprise browser extensions whose telemetry fails in headless mode. Count
  // only this page's errors, and ignore the expected headless vibrate intervention.
  const appOrigin = new URL(APP).origin;
  const ours = (url) => typeof url === 'string' && url.startsWith(appOrigin);
  const errors = main.events.filter((e) => {
    if (e.method === 'Runtime.exceptionThrown') {
      const details = e.params.exceptionDetails;
      return ours(details.url) || (details.stackTrace?.callFrames || []).some((f) => ours(f.url));
    }
    if (e.method === 'Log.entryAdded') {
      const entry = e.params.entry;
      return entry.level === 'error' && (entry.source === 'network' || entry.source === 'javascript') && ours(entry.url);
    }
    if (e.method === 'Runtime.consoleAPICalled') {
      return e.params.type === 'error' && (e.params.stackTrace?.callFrames || []).some((f) => ours(f.url));
    }
    return false;
  });
  check('no console errors or page exceptions', errors.length === 0, errors.map((e) => JSON.stringify(e.params).slice(0, 160)).join(' | '));

  const shot = await main.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(tmpdir(), 'flashcards-browser-check.png'), Buffer.from(shot.data, 'base64'));
  main.close();
} catch (err) {
  if (appServerLog.length) console.error('server log:', appServerLog.join(''));
  throw err;
} finally {
  await closeBrowser();
  appServer.kill();
}

for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? ` :: ${r.detail}` : ''}`);
const failed = results.filter((r) => !r.ok).length;
if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nall browser checks passed');
