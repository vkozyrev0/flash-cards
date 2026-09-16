#!/usr/bin/env node
// Extracts pure helpers from language-cards.html and asserts the audit-fix behaviors.
import { readFileSync } from 'node:fs';
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
];
const namesConst = ['cardIsStudied', 'cardIsDue', 'cardIsNew'];
const srsLine = script.match(/const SRS_INTERVALS = \[[^\]]+\];/);
assert.ok(srsLine, 'SRS_INTERVALS');

const prelude = [
  'let LEXICON = { by: { uk: new Map(), ru: new Map(), en: new Map(), fi: new Map() }, size: 0 };',
  srsLine[0],
  ...namesConst.map((n) => extractDecl(script, 'const', n)),
  ...namesFn.map((n) => extractDecl(script, 'function', n)),
].join('\n');

const fn = new Function(`${prelude}
  return {
    trimText, norm, isValidFor, cleanMt, looksUntranslated, splitAddInput,
    applySrs, SRS_INTERVALS, cardIsStudied, cardIsDue, cardIsNew,
    indexLexicon, lookupLexicon, lexiconHitsCard, normalizeCard,
    shuffle, pickSessionCards, normalizeDeletedIds,
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
  assert.match(script, /fetch\('\.\/ukr-cards-categorized\.json'\)/);
  assert.match(script, /fetch\('\.\/lexicon\.json'\)/);
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

test('service worker is v3 and lists lexicon + bundle', () => {
  assert.match(sw, /ukr-cards-v3/);
  assert.match(sw, /lexicon\.json/);
  assert.match(sw, /ukr-cards-categorized\.json/);
  assert.match(sw, /network-first|isAppShell/);
});

test('known-bad corpus rows were patched', () => {
  assert.equal(bundle.cards['ґудзик'].fi, 'nappi');
  assert.equal(bundle.cards['щодо'].en, 'regarding');
  assert.equal(bundle.cards['заохочення'].en, 'encouragement');
});

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall tests passed');
