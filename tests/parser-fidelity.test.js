/**
 * Parser fidelity test — Florilegium
 *
 * Measures how the app's real full-text pipeline handles real Gutenberg
 * books. The parser under test is NOT reimplemented: cleanBlocks, HEAD_RE,
 * isHeading, headingIndices, cleanTitle, chaptersOf, isProse, proseParas and
 * readerModel are extracted verbatim
 * out of index.html at runtime, so the numbers below describe the rules the
 * app actually ships.
 *
 * For each book it reports: raw byte size, block count after cleanBlocks,
 * chapter mode vs page mode, section count, the first section titles, and a
 * short quality note. Books where detection collapses (fewer than three
 * chunks, garbage titles, or one giant chapter) are flagged.
 *
 * No browser is needed. Full text is fetched from Jina Reader (the same
 * proxy the app uses) with ~2s between requests, and cached on disk so a
 * rerun is instant:
 *   %TEMP%\opencode\flori-parser-cache\pg<id>.txt   (override: FLORI_CACHE_DIR)
 *
 * Run from the repo root:
 *   node tests/parser-fidelity.test.js
 *
 * Options:
 *   --no-report    measure and print only; do not rewrite
 *                  tests/parser-fidelity-report.md
 *   --only=84,11   restrict to a subset of Gutenberg ids
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'index.html');
const REPORT = path.join(__dirname, 'parser-fidelity-report.md');

const BOOKS = [
  { id: '2701', title: 'Moby Dick', author: 'Herman Melville' },
  { id: '1342', title: 'Pride and Prejudice', author: 'Jane Austen' },
  { id: '84', title: 'Frankenstein', author: 'Mary Wollstonecraft Shelley' },
  { id: '345', title: 'Dracula', author: 'Bram Stoker' },
  { id: '11', title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll' },
  { id: '1661', title: 'The Adventures of Sherlock Holmes', author: 'Arthur Conan Doyle' }
];

/* Curated observations, written after inspecting the generated measurements.
   The report is fully regenerated from these + the live numbers on every run. */
const NOTES = {
  '2701': 'All 135 chapters detected with correct titles, numerals complete. The 135-line TOC is neutralised deliberately: its entries form one long consecutive heading run, which headingIndices skips as a table of contents. The first 231 blocks are unreachable in chapter mode: skipping the TOC is desirable, but the genuine Etymology and Extracts prose is lost with it. The flagged "garbage" titles are legitimate Moby Dick chapter titles (heuristic false positives).',
  '1342': 'All 61 chapters detected (Chapter I. … Chapter LXI., Roman numerals), numerals complete. This edition has no TOC; the 30 skipped front-matter blocks are Saintsbury\'s preface plus a page-numbered index of quotations — mostly desirable to skip. Source capitalisation is inconsistent ("Chapter I." then "CHAPTER II.") and reproduced verbatim — cosmetic only.',
  '84': '4 letters + 24 chapters = 28 sections, exactly the source structure. The reader counter calls the letters "Chapter 1–4", so the UI label drifts from the printed chapter numbers (cosmetic).',
  '345': 'All 27 chapters (I–XXVII) detected, numerals complete. In-body epistolary captions ("Letter from Miss Mina Murray to Miss Lucy Westenra.", "Letter, Mina Harker to Lucy Westenra.") are demoted to prose by the from/to rule, so they no longer split chapters V/IX/X or delete the real headings beside them. Titles are strip-cleaned, so no markdown underscore artefacts remain. The 141 diary date blocks stay as ordinary prose (correct).',
  '11': 'All 12 chapters detected with full titles. Clean pass — closest miss in the corpus.',
  '1661': '12 numbered story headings ("I. A SCANDAL IN BOHEMIA" … "XII. THE ADVENTURE OF THE COPPER BEECHES") are recognised in chapter mode with their real titles. cleanBlocks now keeps numbered headings regardless of the 42-char floor, and the numbered-heading rule (short, mostly-uppercase title, no internal list separators) admits them while rejecting the 405-char single-line contents block.'
};

/* Rule changes applied in this revision (parser rules in index.html). */
const CHANGES = [
  '**Numbered story headings recognised.** `isHeading` accepts `#. TITLE` (Roman or Arabic numeral plus `.`/`)` and a short, mostly-uppercase title), which recovers all 12 Sherlock headings (`I. A SCANDAL IN BOHEMIA`). A length cap (title 3–80 chars), a ≥0.6 uppercase-letter ratio and a `;`-free title reject the 405-char one-line contents block and Moby Dick\'s in-prose list (`I. THE FOLIO WHALE; II. …`).',
  '**Short headings kept in `cleanBlocks`.** The 42-char floor now defers to `isHeading`, so Sherlock\'s 22–41-char headings survive to `readerModel` instead of being deleted.',
  '**Adjacency filter replaced by run-collapsing.** `headingIndices` groups consecutive heading blocks: a run of ≥4 is a table of contents/index and starts nothing, a shorter run keeps only its first block. Moby Dick\'s 135-line contents is still skipped, and Dracula\'s real chapters survive a neighbouring caption.',
  '**Epistolary captions demoted.** A `Letter` block naming from/to in its first 120 chars (`Letter from …`, `Letter, X to Y.`) is no longer a heading, while Frankenstein\'s `Letter 1`/`Letter 2` stay sections.',
  '**Titles strip-cleaned.** `cleanTitle` removes markdown `_`/`*` anywhere in a section title and trims trailing punctuation, so no `…Mina Murray_.` artefacts remain.',
  '**Still outstanding (not changed).** The pre-first-heading lead is still dropped in chapter mode, so Moby Dick\'s Etymology/Extracts prose and P&P\'s preface remain unreachable; and the reader counter still numbers Frankenstein\'s letters as "Chapter 1–4" (cosmetic).'
];

const CACHE = process.env.FLORI_CACHE_DIR
  || path.join(os.tmpdir(), 'opencode', 'flori-parser-cache');
const GAP_MS = 2100;          /* stay under Jina's ~20 req/min */
const RETRY_WAIT_MS = 9000;   /* generous: a 429 often clears in seconds */
const FETCH_TIMEOUT_MS = 120000;

const wait = ms => new Promise(r => setTimeout(r, ms));
const info = msg => console.log('        ' + msg);
function pass(msg) { console.log('  PASS  ' + msg); }
function assert(cond, msg) { if (!cond) throw new Error('ASSERT FAILED: ' + msg); pass(msg); }

/* ------------------------------------------------------------------ */
/* 1. Extract the app's actual parser from index.html                  */
/* ------------------------------------------------------------------ */
function extractParser() {
  const src = fs.readFileSync(HTML, 'utf8');
  const cut = (a, b) => {
    const i = src.indexOf(a);
    if (i < 0) throw new Error('anchor not found in index.html: ' + a);
    const j = src.indexOf(b, i + a.length);
    if (j < 0) throw new Error('anchor not found in index.html: ' + b);
    return src.slice(i, j);
  };
  const body =
    cut('function cleanBlocks(raw){', 'const HEAD_RE=') +
    cut('const HEAD_RE=', 'const sleep=') +
    cut('function readerModel(blocks){', 'function readerLabel(st){');
  // eslint-disable-next-line no-new-func
  return new Function(
    body + '\nreturn {cleanBlocks,HEAD_RE,chaptersOf,isProse,proseParas,readerModel,isHeading,headingIndices,cleanTitle};'
  )();
}

function sanity(api) {
  const { cleanBlocks, isProse, proseParas, readerModel } = api;
  /* boilerplate stripping */
  const raw = [
    '*** START OF THE PROJECT GUTENBERG EBOOK DEMO ***',
    '',
    'Title: Demo',
    'URL Source: https://www.gutenberg.org/cache/epub/1/demo.txt',
    '',
    'www.gutenberg.org is supported by readers like you.',
    '',
    'CHAPTER I. Loomings.',
    '',
    'Call me Ishmael, and remember the long grey afternoon we spent upon the open sea together with the whaling crew.'
  ].join('\n');
  const b = cleanBlocks(raw);
  assert(b.length === 2, 'cleanBlocks keeps only heading + one prose block (got ' + b.length + ')');
  assert(/^CHAPTER I/.test(b[0]), 'cleanBlocks preserves the chapter heading');

  /* chapter detection */
  const sentence = 'The rain fell steadily over the empty streets, and the lamps burned low against the long grey evening. ';
  const withChapters = [];
  for (let c = 1; c <= 4; c++) { withChapters.push('Chapter ' + c + '. Heading'); for (let i = 0; i < 5; i++) withChapters.push(sentence + 'c' + c + 'p' + i + '.'); }
  const ch = readerModel(withChapters);
  assert(ch.mode === 'chapter' && ch.sections.length === 4,
    'three or more isolated headings give chapter mode (' + ch.mode + ', ' + ch.sections.length + ' sections)');

  /* page fallback */
  const noChapters = []; for (let i = 0; i < 50; i++) noChapters.push(sentence + 'p' + i + '.');
  const pg = readerModel(noChapters);
  assert(pg.mode === 'page' && pg.sections.length === 3 && pg.sections[0].paras.length === 22,
    'chapterless text falls back to 22-paragraph pages (got ' + pg.mode + ', ' + pg.sections.map(s => s.paras.length).join('/'));

  /* excerpt helpers still behave */
  assert(isProse(sentence) === true, 'isProse accepts ordinary prose');
  assert(proseParas(withChapters, 2).length === 2, 'proseParas returns the requested excerpt count');

  /* heading predicate + consecutive-run collapsing (the parser rules that
     fix Sherlock/Dracula/Moby Dick) are locked in here */
  if (api.isHeading) {
    assert(api.isHeading('I. A SCANDAL IN BOHEMIA') === true,
      'numbered story heading is recognised');
    assert(api.isHeading('Letter from Mina Murray to Lucy Westenra.') === false,
      'epistolary caption "Letter from ... to ..." is not a heading');
    assert(api.isHeading('Letter, Lucy Westenra to Mina Murray_.') === false,
      'comma-form letter caption is not a heading');
    assert(api.isHeading('Letter 1') === true, 'bare "Letter 1" heading is recognised');
  }
  if (api.headingIndices) {
    const toc = ['CHAPTER 1', 'CHAPTER 2', 'CHAPTER 3', 'CHAPTER 4'];
    const run = api.headingIndices(toc);
    assert(run.length === 0, 'a run of four consecutive headings is treated as contents (got ' + run.length + ')');
    const near = api.headingIndices(['CHAPTER V', sentence + 'a.', 'CHAPTER X', 'CHAPTER XI', sentence + 'b.']);
    assert(near.length === 2 && near[0] === 0 && near[1] === 2,
      'a two-heading run keeps only its first block, isolated headings survive (got ' + JSON.stringify(near) + ')');
  }
}

/* ------------------------------------------------------------------ */
/* 2. Fetch (cached, paced, one retry)                                 */
/* ------------------------------------------------------------------ */
async function fetchText(id) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, 'pg' + id + '.txt');
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    return { text: fs.readFileSync(file, 'utf8'), bytes: fs.statSync(file).size, fromCache: true, ms: 0 };
  }
  const url = 'https://r.jina.ai/http://www.gutenberg.org/cache/epub/' + id + '/pg' + id + '.txt';
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      const bytes = Buffer.byteLength(text);
      if (bytes < 2000) throw new Error('implausibly short body (' + bytes + ' bytes)');
      fs.writeFileSync(file, text);
      return { text, bytes, fromCache: false, ms: Date.now() - t0 };
    } catch (e) {
      last = e;
      info('fetch ' + id + ' attempt ' + attempt + ' failed: ' + (e && e.message || e));
      if (attempt < 2) await wait(RETRY_WAIT_MS);
    }
  }
  return { error: String(last && last.message || last) };
}

/* ------------------------------------------------------------------ */
/* 3. Analysis                                                         */
/* ------------------------------------------------------------------ */
const DIARY_RE = /^[_*(]*\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

const ROMAN_TABLE = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
function toRoman(n) { let out = ''; for (const [v, s] of ROMAN_TABLE) while (n >= v) { out += s; n -= v; } return out || String(n); }

function suspectTitle(t) {
  const words = t.split(/\s+/).length;
  if (t.length > 90) return 'over 90 characters';
  if (words > 10) return 'more than 10 words';
  if (/[,;]$/.test(t)) return 'ends with , or ; like prose';
  if (/[.!?]$/.test(t) && words > 6 &&
      !/^(chapter|part|book|act|letter)\s+([0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\.?\s*$/i.test(t) &&
      !/^(chapter|part|book|act|letter)\s+[0-9ivxlcdm]+\.?\s+\S+/i.test(t)) return 'reads like a sentence';
  return null;
}

function analyze(text, api) {
  const blocks = api.cleanBlocks(text);
  const model = api.readerModel(blocks);

  /* instrumentation that mirrors readerModel's own heading loop; uses the
     app's isHeading/headingIndices when present so the report tracks the
     rules that actually shipped */
  const isHeading = api.isHeading
    ? api.isHeading
    : (b => api.HEAD_RE.test(b) && b.length < 140);
  const marks = [];
  blocks.forEach((b, i) => { if (isHeading(b)) marks.push(i); });
  const isolated = api.headingIndices
    ? api.headingIndices(blocks)
    : (() => {
        const set = new Set(marks);
        return marks.filter(i => !set.has(i - 1) && !set.has(i + 1));
      })();
  const droppedAdjacent = marks.length - isolated.length;

  const titles = model.sections.map(s => s.title).filter(Boolean);
  const suspect = titles.map(t => ({ title: t, why: suspectTitle(t) })).filter(x => x.why);
  const parasPerSection = model.sections.map(s => s.paras.length);
  const totalParas = parasPerSection.reduce((a, b) => a + b, 0);
  const maxParas = parasPerSection.length ? Math.max(...parasPerSection) : 0;
  const sorted = parasPerSection.slice().sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;

  const proseCount = blocks.filter(p => api.isProse(p)).length;
  const diaryEntries = blocks.filter(b => DIARY_RE.test(b)).length;
  const leakBlocks = blocks.filter(b => /project gutenberg|gutenberg\.org/i.test(b)).length;

  /* objective fidelity metric: do the printed chapter numerals survive? */
  const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  const romanValue = s => { let v = 0; for (let i = 0; i < s.length; i++) { const a = ROMAN[s[i]], b = ROMAN[s[i + 1]]; v += b > a ? -a : a; } return v; };
  const numRe = /^(?:chapter|part|book)\s+([0-9]+|[IVXLC]+)\b/i;
  const nums = [];
  titles.forEach(t => { const m = numRe.exec(t); if (m) nums.push(/^[IVXLC]+$/.test(m[1]) ? romanValue(m[1].toUpperCase()) : parseInt(m[1], 10)); });
  let chapterNums = null;
  if (nums.length >= 3) {
    const uniq = [...new Set(nums)].sort((a, b) => a - b);
    const max = uniq[uniq.length - 1];
    const missing = []; for (let n = 1; n <= max; n++) if (!uniq.includes(n)) missing.push(n);
    chapterNums = { distinct: uniq.length, max, missing };
  }
  /* chapter mode silently ignores everything before the first heading */
  const leading = (model.mode === 'chapter' && isolated.length) ? isolated[0] : 0;

  const flags = [];
  if (model.sections.length < 3) flags.push('COLLAPSE: only ' + model.sections.length + ' chunk(s)');
  if (model.mode === 'chapter' && suspect.length > model.sections.length / 3)
    flags.push('garbage titles (' + suspect.length + '/' + titles.length + ')');
  if (model.mode === 'chapter' && totalParas && maxParas / totalParas > 0.4 && model.sections.length >= 3)
    flags.push('one giant chapter (' + maxParas + '/' + totalParas + ' paras)');
  if (model.mode === 'page' && blocks.length > 400)
    flags.push('page-mode fallback for a full-length book');
  if (chapterNums && chapterNums.missing.length)
    flags.push('printed chapter numerals missing: ' + chapterNums.missing.map(toRoman).join(', '));

  return {
    blocks: blocks.length,
    chars: blocks.reduce((a, b) => a + b.length, 0),
    mode: model.mode,
    sections: model.sections.length,
    firstTitles: model.sections.slice(0, 3).map(s => s.title || '(untitled)'),
    allTitles: titles,
    suspectTitles: suspect,
    marks: marks.length,
    isolated: isolated.length,
    droppedAdjacent,
    paras: { total: totalParas, min: parasPerSection.length ? Math.min(...parasPerSection) : 0, median, max: maxParas },
    proseCount,
    diaryEntries,
    leakBlocks,
    chapterNums,
    leading,
    hasStart: /\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG/i.test(text),
    hasEnd: /\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/i.test(text),
    flags
  };
}

/* ------------------------------------------------------------------ */
/* 4. Report rendering                                                 */
/* ------------------------------------------------------------------ */
const esc = s => String(s).replace(/\|/g, '\\|');
const short = (s, n = 58) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
const kb = b => (b / 1024).toFixed(0) + ' KB';
const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : 'n/a';

function renderReport(results) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const L = [];
  L.push('# Full-text parser & chapter-detection fidelity');
  L.push('');
  L.push('Generated by `tests/parser-fidelity.test.js` on ' + now + '. Regenerate with:');
  L.push('');
  L.push('```');
  L.push('node tests/parser-fidelity.test.js');
  L.push('```');
  L.push('');
  L.push('The parser under test is extracted verbatim from `index.html` at runtime');
  L.push('(`cleanBlocks`, `HEAD_RE`, `isHeading`, `headingIndices`, `cleanTitle`, `chaptersOf`,');
  L.push('`isProse`, `proseParas`, `readerModel`),');
  L.push('so these numbers measure the rules the app actually ships. Text comes from');
  L.push('`https://r.jina.ai/http://www.gutenberg.org/cache/epub/<id>/pg<id>.txt` — the same');
  L.push('Jina Reader proxy the app uses — cached on disk between runs.');
  L.push('');
  L.push('## Results');
  L.push('');
  L.push('| Book | ID | Size | Blocks | Mode | Sections | First 3 section titles | Quality note |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const titles = r.metrics
      ? r.metrics.firstTitles.map(t => esc(short(t, 40))).join('<br>')
      : '—';
    L.push('| ' + esc(r.title) + ' | ' + r.id + ' | ' +
      (r.metrics ? kb(r.bytes) : '—') + ' | ' + (r.metrics ? r.metrics.blocks : '—') + ' | ' +
      (r.metrics ? r.metrics.mode : 'unavailable') + ' | ' + (r.metrics ? r.metrics.sections : '—') + ' | ' +
      titles + ' | ' + esc(NOTES[r.id] || '') + ' |');
  }
  L.push('');
  L.push('## Per-book detail');
  L.push('');
  for (const r of results) {
    L.push('### ' + r.id + ' — ' + esc(r.title) + ' (' + esc(r.author) + ')');
    L.push('');
    if (!r.metrics) {
      L.push('Unavailable: fetch failed after one retry (`' + esc(r.error) + '`).');
      L.push('');
      continue;
    }
    const m = r.metrics;
    L.push('- fetch: ' + (r.fromCache ? 'cache hit' : 'downloaded in ' + (r.ms / 1000).toFixed(1) + 's') +
      ', ' + kb(r.bytes) + ' raw; START marker ' + (m.hasStart ? 'found' : 'MISSING') +
      ', END marker ' + (m.hasEnd ? 'found' : 'MISSING (possible truncation — license tail stays in the text)'));
    L.push('- cleanBlocks: ' + m.blocks + ' blocks (' + m.chars.toLocaleString('en-US') + ' chars, ' +
      pct(m.chars, r.bytes) + ' of the raw download); ' + m.proseCount + ' blocks pass isProse; ' +
      m.leakBlocks + ' blocks still mention Gutenberg');
    L.push('- headings: ' + m.marks + ' heading block(s); ' + m.isolated +
      ' start a section' + (m.droppedAdjacent ? ' (' + m.droppedAdjacent + ' collapsed as contents/adjacent headings)' : '') +
      (m.allTitles.length ? '; suspected garbage titles: ' + m.suspectTitles.length : ''));
    if (m.chapterNums) {
      L.push('- printed chapter numerals: ' + m.chapterNums.distinct + ' distinct, running to ' +
        m.chapterNums.max + (m.chapterNums.missing.length
          ? '; **missing: ' + m.chapterNums.missing.map(toRoman).join(', ') + '**'
          : ' (complete, no gaps)'));
    }
    if (m.leading) L.push('- chapter mode ignores the first ' + m.leading + ' block(s) before the first heading (front matter is unreachable)');
    if (m.suspectTitles.length) {
      m.suspectTitles.slice(0, 3).forEach(s => L.push('  - suspect title `' + esc(short(s.title, 90)) + '` (' + s.why + ')'));
    }
    L.push('- readerModel: mode=' + m.mode + ', ' + m.sections + ' sections; paras/section min/median/max = ' +
      m.paras.min + '/' + m.paras.median + '/' + m.paras.max + '; largest section holds ' + pct(m.paras.max, m.paras.total) + ' of paragraphs');
    if (m.diaryEntries) L.push('- diary-style date blocks: ' + m.diaryEntries);
    L.push('- flags: ' + (m.flags.length ? m.flags.join('; ') : 'none'));
    L.push('');
  }
  L.push('## Collapse flags');
  L.push('');
  const collapsed = results.filter(r => r.metrics && r.metrics.flags.length);
  if (!collapsed.length) {
    L.push('None — every fetched book produced at least three chunks with usable titles.');
  } else {
    for (const r of collapsed) L.push('- **' + r.id + ' ' + esc(r.title) + '**: ' + r.metrics.flags.join('; '));
  }
  L.push('');
  L.push('## Rule changes applied in this revision');
  L.push('');
  L.push('These rules are live in `index.html`. Impact across this corpus: the 42-char floor');
  L.push('plus the narrow heading whitelist used to collapse whole collections (Sherlock:');
  L.push('0/12 headings); the adjacency filter plus the `letter` keyword corrupted epistolary');
  L.push('novels (Dracula: 24/27 chapters, 14 phantom sections). Both are fixed below; the');
  L.push('pre-first-heading lead is deliberately left alone.');
  L.push('');
  CHANGES.forEach(x => L.push('- ' + x));
  L.push('');
  L.push('## Method');
  L.push('');
  L.push('- Parser extracted from `index.html` via source anchors (`function cleanBlocks(raw){` … `const sleep=`,');
  L.push('  `function readerModel(blocks){` … `function readerLabel(st){`), so any edit to those functions');
  L.push('  is measured automatically on the next run.');
  L.push('- Full text fetched with Node `fetch` (no CORS), ~2.1s between requests, one retry per book,');
  L.push('  120s abort so a hung request cannot stall the run. Responses cached in `' + CACHE.replace(/\\/g, '/') + '`.');
  L.push('- "Suspect title" is a heuristic (length > 90 chars, > 10 words, or prose-like ending) applied to');
  L.push('  the section titles `readerModel` would render in the chapter header.');
  L.push('- Collapse criteria: fewer than 3 sections, garbage titles in more than a third of sections,');
  L.push('  one section holding more than 40% of all paragraphs, page-mode fallback on a 400+ block book,');
  L.push('  or printed chapter numerals (parsed from titles) with gaps.');
  return L.join('\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* 5. Main                                                             */
/* ------------------------------------------------------------------ */
(async () => {
  let heat = 0;
  try {
    console.log('[0] extracting parser from index.html');
    const api = extractParser();
    sanity(api);
    info('parser: ' + Object.keys(api).join(', '));

    let books = BOOKS;
    const onlyArg = process.argv.find(a => a.startsWith('--only='));
    if (onlyArg) {
      const ids = onlyArg.slice(7).split(',');
      books = BOOKS.filter(b => ids.includes(b.id));
    }

    const results = [];
    for (const book of books) {
      console.log('\n[' + book.id + '] ' + book.title);
      const f = await fetchText(book.id);
      if (f.error) {
        info('fetch failed: ' + f.error);
        results.push({ ...book, error: f.error });
      } else {
        info('bytes=' + f.bytes + (f.fromCache ? ' (cache)' : ' in ' + (f.ms / 1000).toFixed(1) + 's'));
        const m = analyze(f.text, api);
        info('blocks=' + m.blocks + ' mode=' + m.mode + ' sections=' + m.sections +
          ' titles=' + JSON.stringify(m.firstTitles) + (m.flags.length ? ' FLAGS: ' + m.flags.join('; ') : ''));
        results.push({ ...book, bytes: f.bytes, fromCache: f.fromCache, ms: f.ms, metrics: m });
      }
      await wait(GAP_MS);
    }

    const ok = results.filter(r => r.metrics);
    const bad = results.filter(r => !r.metrics);
    console.log('\nsummary: ' + ok.length + '/' + results.length + ' books analysed' +
      (bad.length ? ', unavailable: ' + bad.map(r => r.id).join(',') : ''));
    for (const r of ok) {
      console.log('  ' + r.id.padEnd(5) + r.metrics.mode.padEnd(8) +
        String(r.metrics.sections).padStart(4) + ' sections  ' +
        (r.metrics.flags.length ? 'FLAG ' + r.metrics.flags.join('; ') : 'ok'));
    }

    if (!process.argv.includes('--no-report')) {
      fs.writeFileSync(REPORT, renderReport(results), 'utf8');
      console.log('\nreport written: ' + path.relative(ROOT, REPORT));
    }

    /* infrastructure must have worked; quality is reported, not asserted,
       except: a truncated/failed run must not silently look like success */
    assert(api.cleanBlocks && api.readerModel, 'parser extracted from index.html');
    assert(ok.length > 0, 'at least one book analysed');
    assert(bad.length === 0 || process.env.FLORI_ALLOW_UNAVAILABLE === '1',
      'every book fetched (set FLORI_ALLOW_UNAVAILABLE=1 to tolerate misses)');
    console.log('\nPARSER FIDELITY RUN COMPLETE');
  } catch (err) {
    console.error('\nTEST FAILED: ' + (err && err.stack || err));
    heat = 1;
  } finally {
    process.exit(heat);
  }
})();
