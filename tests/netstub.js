'use strict';
/*
 * Deterministic network stub for the Florilegium acceptance suite.
 *
 * The app talks to three external origins:
 *   - gutendex.com          catalogue / search / topic
 *   - www.gutenberg.org     plain-text editions + cover images
 *   - r.jina.ai             text-extraction fallback
 *
 * In CI (and on a flaky laptop) those are slow or absent, and an acceptance
 * suite that hangs on them is worse than useless. So every test runs against
 * these stubs, which reproduce the real response shapes closely enough that
 * cleanBlocks()/normBook() exercise their real code paths.
 *
 * Set FLORI_LIVE=1 to let requests through to the real network instead; the
 * network-dependent tests then become soft checks.
 */

const MOCK_CATALOGUE = [
  { id: 1342, title: 'Pride and Prejudice', author: 'Jane Austen', subjects: ['Romance fiction', 'England -- Fiction'], downloads: 190246 },
  { id: 1661, title: 'The Adventures of Sherlock Holmes', author: 'Arthur Conan Doyle', subjects: ['Detective fiction', 'Short stories'], downloads: 62140 },
  { id: 345, title: 'Dracula', author: 'Bram Stoker', subjects: ['Horror tales', 'Gothic fiction'], downloads: 55488 },
  { id: 11, title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll', subjects: ['Fantasy fiction', "Children's fiction"], downloads: 121623 },
  { id: 2701, title: 'Moby Dick; Or, The Whale', author: 'Herman Melville', subjects: ['Adventure stories', 'Sea stories'], downloads: 165720 },
  { id: 84, title: 'Frankenstein; Or, The Modern Prometheus', author: 'Mary Wollstonecraft Shelley', subjects: ['Science fiction', 'Gothic fiction'], downloads: 144008 },
  { id: 43, title: 'The Strange Case of Dr. Jekyll and Mr. Hyde', author: 'Robert Louis Stevenson', subjects: ['Horror tales', 'Gothic fiction'], downloads: 61240 },
  { id: 5200, title: 'Metamorphosis', author: 'Franz Kafka', subjects: ['Fiction', 'Absurdist fiction'], downloads: 40120 },
  /* Deliberately no built-in excerpt in index.html for these, so a full-book
     reader is forced to fetch and render the actual text. */
  { id: 768, title: 'Wuthering Heights', author: 'Emily Bronte', subjects: ['Romance fiction', 'Gothic fiction'], downloads: 71000 },
  { id: 1400, title: 'Great Expectations', author: 'Charles Dickens', subjects: ['Bildungsromans', 'Orphans -- Fiction'], downloads: 68000 },
  { id: 203, title: "Uncle Tom's Cabin", author: 'Harriet Beecher Stowe', subjects: ['Slavery -- Fiction', 'Antislavery'], downloads: 64000 }
];

const COVER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

const GUTENBERG_FILE_URL = 'https://www.gutenberg.org/cache/epub/1342/pg1342.txt';
const GUTENBERG_IMAGE_URL = 'https://www.gutenberg.org/cache/epub/1342/pg1342.cover.medium.jpg';

/* ---------------------------------------------------------------- text body */

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const OPENING = [
  'It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.',
  'However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families.',
  'Call me Ishmael. Some years ago, never mind how long precisely, having little or no money in my purse.',
  'To Sherlock Holmes she is always the woman. I have seldom heard him mention her under any other name.',
  'You will rejoice to hear that no disaster has accompanied the commencement of an enterprise which you have regarded with such evil forebodings.'
];

function buildText({ chapters = 6, perChapter = 24, seed = 'florilegium' } = {}) {
  const out = [
    'The Project Gutenberg eBook of Acceptance Fixture',
    '',
    'This ebook is for the use of anyone anywhere at no cost and with almost',
    'no restrictions whatsoever. You may copy, give away or re-use it.',
    '',
    '*** START OF THE PROJECT GUTENBERG EBOOK ACCEPTANCE FIXTURE ***',
    '',
    'TITLE: Acceptance Fixture',
    'URL Source: https://www.gutenberg.org/cache/epub/1342/pg1342.txt',
    'Published Time: 2026-01-01',
    'Markdown Content:',
    ''
  ];
  let n = 0;
  for (let c = 0; c < chapters; c++) {
    out.push(`CHAPTER ${ROMAN[c % ROMAN.length]}.`, '');
    for (let p = 0; p < perChapter; p++) {
      n++;
      const opener = (n === 1) ? OPENING[0] : '';
      out.push(`${opener} ${sentenceFor(seed, c, p, n)}`.trim());
      out.push('');
    }
  }
  out.push('*** END OF THE PROJECT GUTENBERG EBOOK ACCEPTANCE FIXTURE ***', '');
  return out.join('\n');
}

const CITIES = ['Longbourn', 'Netherfield', 'Pemberley', 'Rosings', 'Hunsford', 'Meryton', 'Longbournshire', 'Barton'];
const VERBS = ['considered', 'declined', 'assured', 'observed', 'remembered', 'expected', 'doubted', 'acknowledged'];
const NOUNS = ['the assembled company', 'a quiet morning', 'the parlour', 'the carriage', 'an old letter', 'the assembled household'];
const OBJECTS = ['her composure', 'the arrangement', 'his patience', 'the weather', 'the invitation', 'her opinion'];

function sentenceFor(seed, c, p, n) {
  const h = hash(`${seed}:${c}:${p}:${n}`);
  const city = CITIES[h % CITIES.length];
  const verb = VERBS[(h >> 3) % VERBS.length];
  const noun = NOUNS[(h >> 5) % NOUNS.length];
  const obj = OBJECTS[(h >> 7) % OBJECTS.length];
  const who = p % 2 ? 'Elizabeth' : 'Mr. Bennet';
  return `${who} ${verb} ${noun} as they spoke of ${obj} at ${city}, and the hour being late, the household withdrew to the west parlour without further ceremony.`;
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}

/* ------------------------------------------------------------------ routing */

function gutendexBody(url, catalogue) {
  const rows0 = (catalogue && catalogue.length) ? catalogue : MOCK_CATALOGUE;
  const q = new URL(url);
  const search = (q.searchParams.get('search') || '').toLowerCase();
  const topic = (q.searchParams.get('topic') || '').toLowerCase();
  const page = Number(q.searchParams.get('page') || '1');

  let rows = rows0.slice();
  if (search) {
    rows = rows.filter(b => (b.title + ' ' + b.author + ' ' + b.subjects.join(' ')).toLowerCase().includes(search));
  }
  if (topic) {
    rows = rows.filter(b => b.subjects.join(' ').toLowerCase().includes(topic.replace(/\s+/g, ' ').trim()) || b.title.toLowerCase().includes(topic));
    if (!rows.length) rows = MOCK_CATALOGUE.filter(b => b.subjects.join(' ').toLowerCase().includes('fiction'));
  }
  const total = rows.length;
  const slice = rows.slice(0, 32);

  const results = slice.map(b => ({
    id: b.id,
    title: b.title,
    authors: [{ name: b.author, birth_date: null, death_date: null }],
    subjects: b.subjects,
    bookshelves: [],
    languages: ['en'],
    download_count: b.downloads,
    formats: {
      'image/jpeg': `https://www.gutenberg.org/cache/epub/${b.id}/pg${b.id}.cover.medium.jpg`,
      'text/plain; charset=utf-8': `https://www.gutenberg.org/cache/epub/${b.id}/pg${b.id}.txt`,
      'text/html': `https://www.gutenberg.org/cache/epub/${b.id}/pg${b.id}.images.html`
    }
  }));

  return JSON.stringify({ count: total, next: page > 1 ? null : null, previous: null, results });
}

/*
 * page.setRequestInterception(true) + respond from here.
 *
 * Runtime switches, flipped by tests between cases:
 *   page.__netFailText    truthy  -> text origins answer 500 (plain network error)
 *   page.__netTextStatus  number   -> gutenberg text status (429 fakes throttling)
 *   page.__netJinaStatus  number   -> r.jina.ai status
 *   page.__netFailApi     truthy  -> Gutendex answers 503 (deck/recs failure)
 *   page.__net.catalogue  array    -> swap in a smaller catalogue
 *
 * FLORI_LIVE=1 turns the stub off and lets Edge hit the real network.
 */
async function installNetworkMock(page, opts = {}) {
  const live = process.env.FLORI_LIVE === '1';
  const text = buildText(opts.textOpts);
  const log = { live, textRequests: 0, apiRequests: 0, jinaRequests: 0, covers: 0, aborted: 0 };
  page.__net = log;

  page.__netFailText = false;
  page.__netTextStatus = 0;
  page.__netJinaStatus = 0;
  page.__netFailApi = false;
  page.__net.catalogue = null;
  /** Puts every knob back to its default. Call from a finally block. */
  page.resetNet = () => {
    page.__netFailText = false;
    page.__netTextStatus = 0;
    page.__netJinaStatus = 0;
    page.__netFailApi = false;
    page.__net.catalogue = null;
  };

  if (live) {
    page.__netLive = true;
    return log;
  }

  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = req.url();
    const host = (() => { try { return new URL(url).hostname; } catch (e) { return ''; } })();
    const respond = (status, contentType, body) => {
      if (status === 599) log.aborted++;
      req.respond({
        status,
        contentType,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': 'GET,OPTIONS',
          'cache-control': 'no-store'
        },
        body
      }).catch(() => {});
    };

    try {
      if (host === 'gutendex.com') {
        log.apiRequests++;
        if (page.__netFailApi) return respond(503, 'application/json', '{"detail":"service unavailable"}');
        return respond(200, 'application/json', gutendexBody(url, page.__net.catalogue));
      }
      if (host === 'r.jina.ai') {
        log.jinaRequests++;
        const st = page.__netJinaStatus || (page.__netFailText ? 500 : 200);
        return respond(st, 'text/plain; charset=utf-8', text);
      }
      if (/gutenberg\.org$/.test(host)) {
        if (/\.(txt|html?|0\.txt)$/i.test(url)) {
          log.textRequests++;
          const st = page.__netTextStatus || (page.__netFailText ? 500 : 200);
          return respond(st, 'text/plain; charset=utf-8', text);
        }
        log.covers++;
        return respond(200, 'image/png', COVER_PNG);
      }
      if (host === '127.0.0.1' || host === 'localhost') return req.continue().catch(() => {});
      if (/fonts\.(googleapis|gstatic)\.com$/.test(host)) { log.aborted++; return respond(200, 'text/css', '/* stub */'); }
      if (/^https?:/.test(url)) { log.aborted++; return respond(200, 'text/plain', ''); }
      return req.continue().catch(() => {});
    } catch (e) {
      try { req.abort(); } catch (e2) {}
    }
  });
  return log;
}

module.exports = { installNetworkMock, buildText, MOCK_CATALOGUE, COVER_PNG, GUTENBERG_FILE_URL, GUTENBERG_IMAGE_URL };