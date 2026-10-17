#!/usr/bin/env node
// Extracts pure helpers from language-cards.html and asserts the audit-fix behaviors.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'language-cards.html'), 'utf8');
const scriptStart = html.indexOf('<script>');
const scriptEnd = html.lastIndexOf('</script>');
assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, 'app script tag');
const script = html.slice(scriptStart + '<script>'.length, scriptEnd);

function extractDecl(src, kind, name) {
  const startToken = kind === 'function' ? `function ${name}(` : `const ${name} =`;
  const start = src.indexOf(startToken);
  if (start < 0) throw new Error(`missing ${kind} ${name}`);
  if (kind === 'const') {
    const end = src.indexOf(';', start);
    if (end < 0) throw new Error(`unterminated const ${name}`);
    return src.slice(start, end + 1);
  }
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced function ${name}`);
}

const namesFn = [
  'trimText', 'norm', 'isValidFor', 'cleanMt', 'looksUntranslated',
  'splitAddInput', 'applySrs', 'normalizeDeletedIds',
  'indexLexicon', 'lookupLexicon', 'lexiconHitsCard',
  'normalizeCard', 'shuffle', 'pickSessionCards',
  'prunePoolFilters', 'applyPoolFilters',
  'activeDeckIsValid', 'pickCardId', 'safeDeckName', 'addCardUnique', 'mergeImport', 'sameCard',
  'migrateBundleHomonyms', 'pickNewCardId', 'shouldStoreCard', 'blockedByTombstone',
];
const namesConst = ['cardIsStudied', 'cardIsDue', 'cardIsNew'];
const srsLine = script.match(/const SRS_INTERVALS = \[[^\]]+\];/);
assert.ok(srsLine, 'SRS_INTERVALS');

const prelude = [
  'let LEXICON = { by: { uk: new Map(), ru: new Map(), en: new Map(), fi: new Map() }, size: 0 };',
  srsLine[0],
  extractDecl(script, 'const', 'LEGACY_BUNDLE_MOVES'),
  ...namesConst.map((n) => extractDecl(script, 'const', n)),
  ...namesFn.map((n) => extractDecl(script, 'function', n)),
].join('\n');

const fn = new Function(`${prelude}
  return {
    trimText, norm, isValidFor, cleanMt, looksUntranslated, splitAddInput,
    applySrs, SRS_INTERVALS, cardIsStudied, cardIsDue, cardIsNew,
    indexLexicon, lookupLexicon, lexiconHitsCard, normalizeCard,
    shuffle, pickSessionCards, normalizeDeletedIds,
    prunePoolFilters, applyPoolFilters, activeDeckIsValid, pickCardId, safeDeckName,
    addCardUnique, mergeImport, sameCard, migrateBundleHomonyms, pickNewCardId,
    shouldStoreCard, blockedByTombstone,
  };
`);
const L = fn();

let failed = 0;
function test(name, body) {
  try {
    body();
    console.log('ok  ', name);
  } catch (err) {
    failed++;
    console.error('FAIL', name, err.message);
  }
}

test('trimText collapses whitespace, keeps case', () => {
  assert.equal(L.trimText('  Hello   World  '), 'Hello World');
});

test('norm lowercases and strips edge punct for matching only', () => {
  assert.equal(L.norm('Hello!'), 'hello');
  assert.equal(L.norm('  Книга. '), 'книга');
});

test('isValidFor accepts 24/7 as English and rejects Latin as Ukrainian', () => {
  assert.equal(L.isValidFor('24/7', 'en'), true);
  assert.equal(L.isValidFor('hello', 'uk'), false);
  assert.equal(L.isValidFor('книга', 'uk'), true);
  assert.equal(L.isValidFor('kirja', 'fi'), true);
});

test('splitAddInput keeps comma phrases when newlines are present', () => {
  assert.deepEqual(L.splitAddInput('hello, world\nthanks'), ['hello, world', 'thanks']);
  assert.deepEqual(L.splitAddInput('hello, world, thanks'), ['hello', 'world', 'thanks']);
});

test('splitAddInput leaves 24/7 and equals signs literal', () => {
  assert.deepEqual(L.splitAddInput('24/7'), ['24/7']);
  assert.deepEqual(L.splitAddInput('hello/world'), ['hello', 'world']);
  assert.deepEqual(L.splitAddInput('кіт = cat'), ['кіт = cat']);
});

test('safeDeckName keeps internal and prototype names out of the deck namespace', () => {
  assert.equal(L.safeDeckName('food'), 'food');
  assert.equal(L.safeDeckName('cat:food'), 'deck:cat:food');
  assert.equal(L.safeDeckName('__proto__'), 'deck:__proto__');
  assert.equal(L.safeDeckName('constructor'), 'deck:constructor');
});

test('looksUntranslated catches same-text and MyMemory junk', () => {
  assert.equal(L.looksUntranslated('книга', 'книга', 'en'), true);
  assert.equal(L.looksUntranslated('книга', 'book', 'en'), false);
  assert.equal(L.looksUntranslated('книга', 'MYMEMORY WARNING: quota', 'en'), true);
});

test('cleanMt strips MyMemory warning prefix', () => {
  assert.equal(L.cleanMt('MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY.\nbook'), 'book');
});

test('applySrs advances on right and resets on wrong', () => {
  const c = { streak: 0, rightCount: 0, wrongCount: 0, nextDue: 0 };
  const t0 = Date.now();
  L.applySrs(c, true);
  assert.equal(c.streak, 1);
  assert.equal(c.rightCount, 1);
  assert.ok(c.nextDue >= t0 + L.SRS_INTERVALS[1] - 5);
  L.applySrs(c, false);
  assert.equal(c.streak, 0);
  assert.equal(c.wrongCount, 1);
  assert.ok(c.nextDue <= Date.now() + 50);
});

test('cardIsDue excludes unseen cards; cardIsNew is the complement', () => {
  const fresh = { streak: 0, rightCount: 0, wrongCount: 0, nextDue: 0 };
  const due = { streak: 2, rightCount: 2, wrongCount: 0, nextDue: Date.now() - 1000 };
  const later = { streak: 3, rightCount: 3, wrongCount: 0, nextDue: Date.now() + 86400000 };
  assert.equal(L.cardIsNew(fresh), true);
  assert.equal(L.cardIsDue(fresh), false);
  assert.equal(L.cardIsDue(due), true);
  assert.equal(L.cardIsDue(later), false);
});

test('pickSessionCards is due-first then new, and dueOnly drops new', () => {
  const cards = [
    { id: 'new', streak: 0, rightCount: 0, wrongCount: 0, nextDue: 0 },
    { id: 'due', streak: 1, rightCount: 1, wrongCount: 0, nextDue: 1 },
    { id: 'later', streak: 4, rightCount: 4, wrongCount: 0, nextDue: Date.now() + 9e8 },
  ];
  const mixed = L.pickSessionCards(cards, 3, false).map((c) => c.id);
  assert.deepEqual(mixed, ['due', 'new', 'later']);
  const onlyDue = L.pickSessionCards(cards, 10, true).map((c) => c.id);
  assert.deepEqual(onlyDue, ['due']);
});

test('lexicon exact match wins; ambiguous reverse lookup is ignored', () => {
  L.indexLexicon([
    { uk: 'книга', ru: 'книга', en: 'book', fi: 'kirja' },
    { uk: 'стіл', ru: 'стол', en: 'table', fi: 'pöytä' },
    { uk: 'стіл (кухня)', ru: 'кухня', en: 'cuisine', fi: 'keittiö' },
  ]);
  assert.equal(L.lookupLexicon('книга', 'uk').fi, 'kirja');
  assert.equal(L.lookupLexicon('BOOK', 'en').uk, 'книга');
  assert.equal(L.lookupLexicon('table', 'en').uk, 'стіл');
});

test('ambiguous reverse lookup is ignored instead of picking a homonym', () => {
  L.indexLexicon([
    { uk: 'стіл', ru: 'стол', en: 'table', fi: 'pöytä' },
    { uk: 'таблиця', ru: 'таблица', en: 'table', fi: 'taulukko' },
  ]);
  assert.equal(L.lookupLexicon('table', 'en'), null, 'two Ukrainian words share this English form');
  assert.equal(L.lookupLexicon('стіл', 'uk').en, 'table', 'a forward lookup stays unambiguous');
  L.indexLexicon([
    { uk: 'книга', ru: 'книга', en: 'book', fi: 'kirja' },
    { uk: 'стіл', ru: 'стол', en: 'table', fi: 'pöytä' },
    { uk: 'стіл (кухня)', ru: 'кухня', en: 'cuisine', fi: 'keittiö' },
  ]);
});

test('normalizeCard preserves an explicit homonym id', () => {
  const n = L.normalizeCard({ id: 'лист#leaf', uk: 'лист', en: 'leaf' });
  assert.equal(n.id, 'лист#leaf', 'an id that differs from uk is the stable identity');
});

test('pickCardId keeps a second source word as a homonym instead of overwriting the first', () => {
  const cards = { 'книга': { id: 'книга', uk: 'книга', ru: 'книга', en: 'book', fi: 'kirja' } };
  assert.equal(L.pickCardId(cards, { id: 'книга', uk: 'книга' }, 'en', 'book'), 'книга', 'the same source word maps to the same card');
  assert.equal(L.pickCardId(cards, { id: 'книга', uk: 'книга' }, 'en', 'volume'), 'книга#volume');
  cards['книга#volume'] = { id: 'книга#volume', uk: 'книга', en: 'volume' };
  assert.equal(L.pickCardId(cards, { id: 'книга', uk: 'книга' }, 'en', 'volume'), 'книга#volume', 'a repeated add is idempotent');
  assert.equal(L.pickCardId(cards, { id: 'книга', uk: 'книга' }, 'en', 'tome'), 'книга#tome');
});

test('addCardUnique suffixes a colliding id instead of overwriting', () => {
  const cards = {};
  assert.equal(L.addCardUnique(cards, { id: 'можна', uk: 'можна' }), 'можна');
  assert.equal(L.addCardUnique(cards, { id: 'можна', uk: 'Можна?' }), 'можна#2');
  assert.equal(cards['можна'].uk, 'можна');
  assert.equal(cards['можна#2'].uk, 'Можна?');
  assert.equal(L.addCardUnique(cards, { id: 'можна', uk: 'Можна.' }), 'можна#3');
});

test('shouldStoreCard rejects a card with no Ukrainian side', () => {
  assert.equal(L.shouldStoreCard({ uk: '', en: 'chat' }, 'ru'), false, 'a failed uk translation is not stored');
  assert.equal(L.shouldStoreCard({ uk: 'кіт', en: 'cat' }, 'ru'), true);
  assert.equal(L.shouldStoreCard({ uk: '' }, 'uk'), true, 'the uk source always supplies its own text');
});

test('a tombstone blocks its exact id, not a homonym', () => {
  assert.equal(L.blockedByTombstone({ id: 'можна' }, ['можна']), true);
  assert.equal(L.blockedByTombstone({ id: 'можна#may-i' }, ['можна']), false);
  assert.equal(L.blockedByTombstone({ id: 'можна' }, null), false);
});

test('pickNewCardId keeps a tombstoned plain id free for the plain word', () => {
  const tombstoned = (id) => id === 'можна';
  assert.equal(L.pickNewCardId({}, { id: 'можна', uk: 'можна' }, 'uk', 'можна', tombstoned), 'можна', 'a deliberate re-add reuses its id');
  assert.equal(L.pickNewCardId({}, { id: 'можна', uk: 'Можна?' }, 'uk', 'Можна?', tombstoned), 'можна#2', 'a sentence must not claim the plain tombstone');
});

test('addCardUnique reuses the same card repeated across decks', () => {
  const cards = {};
  const card = { id: 'x', uk: 'x', ru: 'x', en: 'ex', fi: 'x' };
  assert.equal(L.addCardUnique(cards, { ...card }), 'x');
  assert.equal(L.addCardUnique(cards, { ...card }), 'x', 'a repeat must not become x#2');
  assert.equal(Object.keys(cards).length, 1);
});

test('mergeImport keeps local progress and unions decks', () => {
  const target = { cards: { x: { id: 'x', uk: 'x', streak: 5 } }, decks: { default: { uk: ['x'] } } };
  const cards = { x: { id: 'x', uk: 'x', streak: 99 }, y: { id: 'y', uk: 'y', streak: 1 } };
  const decks = { default: { uk: ['x', 'y'] }, extra: { uk: ['y'] } };
  L.mergeImport(target, cards, decks);
  assert.equal(target.cards.x.streak, 5, 'the local card wins, including its history');
  assert.equal(target.cards.y.streak, 1, 'a new imported card is added');
  assert.deepEqual(target.decks.default.uk, ['x', 'y']);
  assert.deepEqual(target.decks.extra.uk, ['y']);
});

test('migrateBundleHomonyms moves the old collided survivor to its rekeyed id', () => {
  const s = {
    cards: {
      'можна': { id: 'можна', uk: 'Можна.', ru: 'Можно.', en: 'It is allowed.', fi: 'Saa.', streak: 3, rightCount: 3, wrongCount: 0, nextDue: 1 },
    },
    decks: { default: { uk: ['можна'] }, mine: { uk: ['можна', 'x'] } },
  };
  assert.equal(L.migrateBundleHomonyms(s), 1);
  assert.ok(!s.cards['можна'], 'the plain id is freed for the bundle word');
  assert.equal(s.cards['можна#it-is-allowed'].streak, 3, 'progress moves with the card');
  assert.deepEqual(s.decks.mine.uk, ['можна#it-is-allowed', 'x']);
  assert.deepEqual(s.decks.default.uk, ['можна#it-is-allowed']);
});

test('migrateBundleHomonyms merges into a rekeyed card that already exists', () => {
  const s = {
    cards: {
      'можна': { id: 'можна', uk: 'Можна.', ru: 'Можно.', en: 'It is allowed.', fi: 'Saa.', streak: 4, rightCount: 4, wrongCount: 0, nextDue: 5 },
      'можна#it-is-allowed': { id: 'можна#it-is-allowed', uk: 'Можна.', ru: 'Можно.', en: 'It is allowed.', fi: 'Saa.', streak: 0, rightCount: 0, wrongCount: 0, nextDue: 0 },
    },
    decks: { default: { uk: ['можна', 'можна#it-is-allowed'] } },
  };
  assert.equal(L.migrateBundleHomonyms(s), 1);
  assert.ok(!s.cards['можна']);
  assert.equal(s.cards['можна#it-is-allowed'].streak, 4);
  assert.deepEqual(s.decks.default.uk, ['можна#it-is-allowed']);
});

test('migrateBundleHomonyms leaves the plain card alone', () => {
  const s = { cards: { 'можна': { id: 'можна', uk: 'можна' } }, decks: { default: { uk: ['можна'] } } };
  assert.equal(L.migrateBundleHomonyms(s), 0);
  assert.equal(s.cards['можна'].uk, 'можна');
});

test('activeDeckIsValid rejects inherited and stale names', () => {
  const cards = { x: { categories: ['noun'] } };
  assert.equal(L.activeDeckIsValid(cards, { default: { uk: [] } }, 'default'), true);
  assert.equal(L.activeDeckIsValid(cards, {}, 'cat:noun'), true);
  assert.equal(L.activeDeckIsValid(cards, {}, 'cat:verb'), false);
  assert.equal(L.activeDeckIsValid(cards, {}, '__proto__'), false);
  assert.equal(L.activeDeckIsValid(cards, {}, undefined), false);
});

test('SRS_INTERVALS match the documented schedule', () => {
  assert.deepEqual(L.SRS_INTERVALS, [
    0,
    10 * 60e3,
    24 * 3600e3,
    3 * 24 * 3600e3,
    7 * 24 * 3600e3,
    14 * 24 * 3600e3,
    30 * 24 * 3600e3,
  ]);
});

test('lexiconHitsCard skips disambiguated homonym ids', () => {
  const hit = { uk: 'стіл', en: 'table', fi: 'pöytä' };
  assert.equal(L.lexiconHitsCard(hit, { id: 'стіл', uk: 'стіл' }), true);
  assert.equal(L.lexiconHitsCard(hit, { id: 'стіл#cuisine', uk: 'стіл' }), false);
});

test('normalizeCard keeps display casing and stable ids', () => {
  const n = L.normalizeCard({ id: 'Hello', uk: 'Hello!', ru: 'Привет', en: 'Hi', fi: 'Hei' });
  assert.equal(n.uk, 'Hello!');
  assert.equal(n.id, 'hello');
  assert.equal(n.en, 'Hi');
});

test('normalizeDeletedIds uniques and norms', () => {
  assert.deepEqual(L.normalizeDeletedIds(['Книга', 'книга', '']), ['книга']);
});

test('HTML no longer inlines the card bundle', () => {
  assert.equal(html.includes('id="bundledData"'), false);
  assert.match(script, /fetch(?:WithTimeout)?\('\.\/ukr-cards-categorized\.json'/);
  assert.match(script, /fetch(?:WithTimeout)?\('\.\/lexicon\.json'/);
});

const lexicon = JSON.parse(readFileSync(join(root, 'lexicon.json'), 'utf8'));
const bundle = JSON.parse(readFileSync(join(root, 'ukr-cards-categorized.json'), 'utf8'));
const sw = readFileSync(join(root, 'sw.js'), 'utf8');

test('lexicon and bundle JSON parse with expected shape', () => {
  assert.ok(Object.keys(lexicon).length > 50);
  assert.ok(bundle.cards && Object.keys(bundle.cards).length > 1000);
  for (const [k, e] of Object.entries(lexicon)) {
    assert.ok(e.uk && e.en && e.fi, `lexicon ${k} missing langs`);
  }
});

test('the PWA manifest ships raster icons that exist', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  for (const size of ['192x192', '512x512']) {
    const icon = (manifest.icons || []).find((i) => i.sizes === size);
    assert.ok(icon, `manifest is missing a ${size} icon`);
    assert.ok(existsSync(join(root, icon.src.replace(/^\.\//, ''))), `${icon.src} does not exist`);
  }
  assert.ok(existsSync(join(root, 'icon-180.png')), 'the iOS touch icon exists');
});

test('service worker is v3 and lists lexicon + bundle', () => {
  assert.match(sw, /ukr-cards-v3/);
  assert.match(sw, /lexicon\.json/);
  assert.match(sw, /ukr-cards-categorized\.json/);
  assert.match(sw, /network-first|isAppShell/);
});

test('every bundle card has a unique id after normalization', () => {
  const ids = Object.entries(bundle.cards).map(([key, c]) => L.normalizeCard({ id: key, ...c }).id);
  assert.equal(new Set(ids).size, ids.length, 'normalization must not collapse two bundle cards');
});

const loadFrom = (() => {
  const statePrelude = [
    'let store = {};',
    "const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };",
    "const STORAGE_KEY = 'ukr-cards-v3';",
    extractDecl(script, 'const', 'DEFAULT_SETTINGS'),
    ...['trimText', 'norm', 'normalizeCard', 'sameCard', 'addCardUnique', 'normalizeDeletedIds', 'safeDeckName', 'activeDeckIsValid', 'normalizeSettings', 'loadState']
      .map((n) => extractDecl(script, 'function', n)),
  ].join('\n');
  return new Function(`${statePrelude}
    return (seed) => { store = seed; return loadState(); };
  `)();
})();

test('loadState keeps the cards when active is missing', () => {
  const s = loadFrom({
    'ukr-cards-v3': JSON.stringify({
      cards: { x: { id: 'x', uk: 'x', en: 'ex' } },
      decks: { default: { uk: ['x'] } },
    }),
  });
  assert.equal(s.active, 'default');
  assert.equal(s.cards.x.en, 'ex', 'cards must survive a state without an active deck');
});

test('loadState falls back from a stale category deck but keeps a live one', () => {
  const cards = { x: { id: 'x', uk: 'x', en: 'ex', categories: ['noun'] } };
  const stale = loadFrom({
    'ukr-cards-v3': JSON.stringify({ cards, decks: { default: { uk: ['x'] } }, active: 'cat:verb' }),
  });
  assert.equal(stale.active, 'default');
  const live = loadFrom({
    'ukr-cards-v3': JSON.stringify({ cards, decks: { default: { uk: ['x'] } }, active: 'cat:noun' }),
  });
  assert.equal(live.active, 'cat:noun');
});

test('loadState creates a default deck when the state has none', () => {
  const s = loadFrom({
    'ukr-cards-v3': JSON.stringify({ cards: { x: { id: 'x', uk: 'x' } }, decks: {} }),
  });
  assert.equal(s.active, 'default');
  assert.equal(s.cards.x.uk, 'x');
  assert.deepEqual(s.decks.default, { uk: [] });
});

test('known-bad corpus rows were patched', () => {
  assert.equal(bundle.cards['ґудзик'].fi, 'nappi');
  assert.equal(bundle.cards['щодо'].en, 'regarding');
  assert.equal(bundle.cards['заохочення'].en, 'encouragement');
});

// ---- Audit-fix regressions ----

test('pool search matches regardless of the case in the card', () => {
  const cards = [
    { id: 'knyha', uk: 'Книга', ru: 'Книга', en: 'Book', fi: 'Kirja', categories: ['noun'], streak: 0, rightCount: 0, wrongCount: 0, nextDue: 0, addedAt: 3 },
    { id: 'stil', uk: 'Стіл', ru: 'Стол', en: 'Table', fi: 'Pöytä', categories: ['household'], streak: 0, rightCount: 0, wrongCount: 0, nextDue: 0, addedAt: 2 },
  ];
  const base = { q: '', category: '__all', status: '__all', sort: 'recent' };
  const ids = (over) => L.applyPoolFilters(cards, { ...base, ...over }).map((c) => c.id);
  // The search box lower-cases the query, so a capitalised card value must still match.
  assert.deepEqual(ids({ q: 'книга' }), ['knyha']);
  assert.deepEqual(ids({ q: 'book' }), ['knyha']);
  assert.deepEqual(ids({ q: 'kirja' }), ['knyha']);
  assert.deepEqual(ids({ q: 'стіл' }), ['stil']);
  assert.deepEqual(ids({ q: 'zzz' }), []);
  assert.deepEqual(ids({ category: 'noun' }), ['knyha']);
  assert.deepEqual(ids({ status: 'new' }), ['knyha', 'stil']);
  assert.deepEqual(ids({ sort: 'alpha' }), ['knyha', 'stil']);
});

test('prunePoolFilters clears a category that left the pool, keeps a live one', () => {
  const filters = { q: '', category: 'verb', status: '__all', sort: 'recent' };
  assert.deepEqual(L.prunePoolFilters(filters, ['verb', 'food']), filters);
  assert.deepEqual(L.prunePoolFilters(filters, ['food']), { ...filters, category: '__all' });
  assert.deepEqual(L.prunePoolFilters(filters, []), { ...filters, category: '__all' });
  const all = { ...filters, category: '__all' };
  assert.equal(L.prunePoolFilters(all, []), all);
});

test('every element id the script looks up exists in the markup', () => {
  const markup = html.slice(0, scriptStart);
  const declared = new Set([...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const referenced = new Set([
    ...[...script.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
    ...[...script.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]),
  ]);
  assert.deepEqual([...referenced].filter((id) => !declared.has(id)), []);
});

const STRINGS = (() => {
  const start = script.indexOf('const STRINGS = {');
  assert.ok(start >= 0, 'STRINGS block');
  const open = script.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}') {
      depth--;
      if (depth === 0) return new Function(`return ${script.slice(open, i + 1)}`)();
    }
  }
  throw new Error('unterminated STRINGS');
})();
const i18nRefs = new Set([...html.matchAll(/data-i18n(?:-placeholder|-title|-aria-label)?="([^"]+)"/g)].map((m) => m[1]));
for (const m of script.matchAll(/(?<![\w.$])t\('([a-zA-Z0-9.]+)'/g)) i18nRefs.add(m[1]);

test('every referenced UI string is translated in all three languages', () => {
  for (const key of i18nRefs) {
    for (const lang of ['en', 'uk', 'ru']) {
      assert.ok(STRINGS[lang][key], `${lang} is missing "${key}"`);
    }
  }
});

test('no translation is defined but never used', () => {
  assert.deepEqual(Object.keys(STRINGS.en).filter((k) => !i18nRefs.has(k)), []);
});

test('uk and ru define exactly the English key set', () => {
  const en = Object.keys(STRINGS.en).sort();
  assert.deepEqual(Object.keys(STRINGS.uk).sort(), en);
  assert.deepEqual(Object.keys(STRINGS.ru).sort(), en);
});

test('the documented SRS schedule matches SRS_INTERVALS', () => {
  assert.equal(STRINGS.en['settings.srsIntervals'].split('→').length, L.SRS_INTERVALS.length - 1);
});

test('filled accent surfaces use the on-accent token that dark mode flips', () => {
  const cssRule = (selector) => {
    const at = html.indexOf(`\n  ${selector} {`);
    assert.ok(at >= 0, `rule ${selector}`);
    return html.slice(at, html.indexOf('}', at));
  };
  assert.match(html, /--on-accent: #ffffff;/);
  assert.match(html, /--on-accent: #10131a;/);
  for (const selector of ['button.primary', '.pill:has(input:checked)', '.tab.active', '.deck-picker-item.active']) {
    assert.match(cssRule(selector), /color: var\(--on-accent\)/, selector);
  }
  // button:hover would otherwise repaint the active tab a light colour under white text.
  assert.match(cssRule('.tab.active:hover'), /background: var\(--accent\)/);
  // The light --bad-bg tint would leave --bad (#e88080) unreadable on the danger chip.
  assert.match(html, /--bad-bg: rgba\(232, 128, 128, 0\.18\);/);
});

test('every CSS custom property a var() reads is defined', () => {
  const styleBlock = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const defined = new Set([...styleBlock.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const referenced = new Set([...styleBlock.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
  // An undefined name silently falls back to a hardcoded colour, which is theme-blind:
  // .help-mock used var(--paper-2, #f0ebde) and painted a cream panel in dark mode.
  assert.deepEqual([...referenced].filter((name) => !defined.has(name)), []);
});

test('the help mockups paint a theme-aware surface', () => {
  const at = html.indexOf('\n  .help-mock {');
  assert.ok(at >= 0, '.help-mock rule');
  const rule = html.slice(at, html.indexOf('}', at));
  assert.match(rule, /background: var\(--(?:bg-2|card-bg|card-bg-2)\)/);
});

const readTemplate = (src, marker) => {
  const at = src.indexOf(marker);
  assert.ok(at >= 0, `template ${marker}`);
  // The marker ends with the opening backtick; its own length already includes it.
  const start = at + marker.length - 1;
  assert.equal(src[start], '`', `template start ${marker}`);
  const end = src.indexOf('`', start + 1);
  assert.ok(end > start, `unterminated template ${marker}`);
  return src.slice(start + 1, end);
};
const HELP_HTML = { uk: readTemplate(script, 'uk: `'), ru: readTemplate(script, 'ru: `') };

test('the uk and ru help pages carry the same mockups as the English one', () => {
  const markup = html.slice(0, scriptStart);
  const enHelp = markup.slice(markup.indexOf('id="helpTab"'), markup.indexOf('<section id="quizSection"'));
  const mockClasses = (src) => [...src.matchAll(/class="((?:help-mock|hm-)[^"]*)"/g)].map((m) => m[1]);
  const expected = mockClasses(enHelp);
  assert.ok(expected.length > 40, `English help mockups (${expected.length} class values)`);
  assert.equal(expected.filter((c) => c.startsWith('help-mock')).length, 8);
  assert.deepEqual(mockClasses(HELP_HTML.uk), expected);
  assert.deepEqual(mockClasses(HELP_HTML.ru), expected);
});

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall tests passed');
