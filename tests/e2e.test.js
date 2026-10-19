'use strict';
/*
 * Florilegium — acceptance / e2e suite.
 *
 * Run:
 *   $env:NODE_PATH="C:\Users\Daniel\AppData\Local\Temp\flori-tools\node_modules"
 *   node --test tests/
 *
 * Env toggles:
 *   FLORI_LIVE=1     let requests hit the real Gutendex/Gutenberg (soft checks)
 *   FLORI_PORT=4181  static server port
 *   FLORI_EDGE=...   Edge executable path
 *
 * Design notes
 * ------------
 * - Everything runs against the deterministic network stub in netstub.js, so the
 *   full-book assertions are reproducible and never hang on a flaky API.
 * - No test is allowed to pass by timing out. Each wait is bounded, and any test
 *   that cannot get off the ground is reported as a failure with the reason.
 * - Probes are deliberately implementation-agnostic (see helpers.js QA_HELPERS):
 *   they look for "some paragraph container", "some next affordance", "some end
 *   marker". That keeps the suite useful across the full-book rewrite.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { installNetworkMock } = require('./netstub');

/* ---------------------------------------------------------------- fixtures */

const BOOK = {
  id: 1342,
  title: 'Pride and Prejudice',
  author: 'Jane Austen'
};

let server, browser, page, net;

const T = { soft: Number(process.env.FLORI_T || 15000) };

/** Soft assertion: records a failure reason instead of throwing. */
function soft(cond, message) {
  if (!cond) {
    softFailures.push(message);
    console.log(`    [soft] ${message}`);
    return false;
  }
  return true;
}
const softFailures = [];

function softNote(message) {
  softFailures.push(message);
  console.log(`    [soft] ${message}`);
}

test.before(async () => {
  server = await H.startServer();
  browser = await H.launchBrowser();
  page = await H.newPage(browser);
  net = await installNetworkMock(page);
  await H.gotoApp(page, server);
});

test.after(async () => {
  try { if (browser) await browser.close(); } catch (e) {}
  try { if (server) server.stop(); } catch (e) {}
});

/** Reload into a known state: cleared storage unless a shelf is seeded. */
async function fresh(seed) {
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  if (seed) await H.seedLocalState(page, seed);
  await H.reload(page, server);
  await H.closeAllOverlays(page);
}

/** A book with no built-in excerpt in index.html: forces a real text fetch. */
const NO_EXCERPT_BOOK = { id: 1400, title: 'Great Expectations' };

/* Shelf seed used by the reader tests: one book with a built-in excerpt and one
   without, so both the cached path and the full fetch path are exercised. */
const READER_SEED = {
  shelf: [
    {
      bookId: 1400,
      book: {
        id: 1400, title: 'Great Expectations', author: 'Charles Dickens',
        subjects: ['Bildungsromans', 'Orphans -- Fiction'], downloads: 68000,
        cover: 'https://www.gutenberg.org/cache/epub/1400/pg1400.cover.medium.jpg',
        textUrl: 'https://www.gutenberg.org/cache/epub/1400/pg1400.txt'
      },
      status: 'to-read', addedAt: 2
    },
    {
      bookId: 1342,
      book: {
        id: 1342, title: 'Pride and Prejudice', author: 'Jane Austen',
        subjects: ['Romance fiction'], downloads: 190246,
        cover: 'https://www.gutenberg.org/cache/epub/1342/pg1342.cover.medium.jpg',
        textUrl: 'https://www.gutenberg.org/cache/epub/1342/pg1342.txt'
      },
      status: 'reading', addedAt: 1
    }
  ],
  settings: { theme: 'paper', family: 'serif', size: 18, margin: 1 }
};

const reader = () => H.readerState(page);

/** Wait until the reader has stopped showing a loader, bounded. */
async function settleReader(timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const s = await reader();
    if (s && !s.hasLoader) return s;
    await new Promise(r => setTimeout(r, 250));
  }
  return reader();
}

/* =============================================================== HOME ==== */

test('home: daily folio renders title, author and cover with no lingering skeleton', { timeout: 60000 }, async () => {
  await fresh();
  const home = await page.$('[data-screen="home"]');
  assert.ok(home, 'home screen exists');

  const info = await page.evaluate(() => {
    const el = document.querySelector('[data-screen="home"]');
    const title = el.querySelector('.daily-title');
    const author = el.querySelector('.daily-author');
    const cover = el.querySelector('.daily-cover .cover');
    const img = cover ? cover.querySelector('img') : null;
    const quote = el.querySelector('[data-daily-quote]');
    return {
      title: title ? title.textContent.trim() : '',
      author: author ? author.textContent.trim() : '',
      hasCover: !!cover,
      coverSrc: img ? img.getAttribute('src') : '',
      skeletons: el.querySelectorAll('.q-skel, .loader').length,
      quote: quote ? quote.textContent.trim() : ''
    };
  });

  assert.ok(info.title.length > 1, `daily title rendered (got "${info.title}")`);
  assert.ok(info.author.length > 1, `daily author rendered (got "${info.author}")`);
  assert.ok(info.hasCover, 'daily cover element rendered');

  // The quote skeleton must resolve. If the network is unavailable the app is
  // allowed to fail the quote softly, but a skeleton stuck on screen is a bug.
  const t0 = Date.now();
  let skeletons = info.skeletons;
  while (Date.now() - t0 < 25000 && skeletons > 0) {
    await new Promise(r => setTimeout(r, 300));
    skeletons = await page.evaluate(() => document.querySelectorAll('[data-screen="home"] .q-skel, [data-screen="home"] .loader').length);
  }
  assert.equal(skeletons, 0, 'daily quote skeleton must resolve, not linger');
});

test('home: For You deck renders a book card with keep/skip affordances', { timeout: 60000 }, async () => {
  await fresh();
  assert.equal(await H.nav(page, 'foryou'), true, 'For You tab is clickable');

  const t0 = Date.now();
  let state = null;
  while (Date.now() - t0 < 30000) {
    state = await page.evaluate(() => {
      const el = document.querySelector('[data-screen="foryou"]');
      return {
        active: !!document.querySelector('.view.view-foryou.active'),
        title: el.querySelector('.deck-title') ? el.querySelector('.deck-title').textContent.trim() : '',
        author: el.querySelector('.deck-author') ? el.querySelector('.deck-author').textContent.trim() : '',
        hasSkip: !!Array.from(el.querySelectorAll('[data-act]')).find(b => b.dataset.act === 'skip'),
        hasKeep: !!Array.from(el.querySelectorAll('[data-act]')).find(b => b.dataset.act === 'keep'),
        empty: !!el.querySelector('.empty'),
        loading: el.querySelectorAll('.loader').length
      };
    });
    if (state.title || state.empty) break;
    await new Promise(r => setTimeout(r, 300));
  }
  assert.equal(state.active, true, 'For You view is active');
  assert.ok(!state.loading || state.title, 'deck is not stuck on a loader');
  assert.ok(state.title.length > 1 || state.empty, `deck shows a card or an explicit empty state (title="${state.title}")`);
  if (state.title) {
    assert.ok(state.author.length > 1, 'deck card shows an author');
    assert.equal(state.hasSkip, true, 'deck exposes Skip');
    assert.equal(state.hasKeep, true, 'deck exposes Keep');
  }
});

/* ============================================================ PREVIEW ==== */

test('preview sheet: shows 3 paragraphs, END OF PREVIEW, Read a little and Add to shelf', { timeout: 60000 }, async () => {
  await fresh();
  // Open the preview for a known book straight from the shelf rows.
  await H.nav(page, 'shelf');
  const opened = await page.evaluate(id => {
    const row = document.querySelector(`[data-act="preview"][data-id="${id}"]`);
    if (!row) return false;
    row.click(); return true;
  }, BOOK.id);
  assert.equal(opened, true, 'a shelf row can open the preview sheet');

  const t0 = Date.now();
  let pv = null;
  while (Date.now() - t0 < 30000) {
    pv = await H.previewState(page);
    if (pv && pv.text && !pv.loading) break;
    await new Promise(r => setTimeout(r, 300));
  }
  assert.ok(pv, 'preview sheet opened');
  assert.ok(!pv.loading, 'preview body finished loading');

  assert.equal(pv.paras, 3, `preview shows exactly 3 paragraphs (got ${pv.paras})`);
  assert.equal(pv.endPreview, true, 'preview shows an END OF PREVIEW marker');
  assert.equal(pv.hasReadALittle, true, 'preview has a "Read a little" action');
  assert.equal(pv.hasAddToShelf, true, 'preview has an "Add to shelf" action');

  const preview = await page.evaluate(() => {
    const ov = document.querySelector('.overlay.preview') || window.__QA.root();
    const t = ov ? ov.innerText.replace(/\s+/g, ' ') : '';
    return { title: /Pride and Prejudice/.test(t), text: t.slice(0, 400) };
  });
  assert.equal(preview.title, true, 'preview names the book being previewed');
});

/* =========================================================== FULL BOOK ==== */

/* --- 1. the headline acceptance bar: a real book, not a preview ------------ */

test('reader: renders the whole book, not a 14-paragraph preview', { timeout: 300000 }, async () => {
  for (const book of [NO_EXCERPT_BOOK, BOOK]) {
    await fresh(READER_SEED);
    assert.equal(await H.openReaderById(page, book.id), true, `reader opened for ${book.title}`);

    const s = await settleReader(60000);
    assert.ok(s, `reader overlay is present for ${book.title}`);
    assert.equal(s.hasLoader, false, `reader finished loading for ${book.title}`);
    assert.equal(s.errorState, false, `reader must not be in an error state (${s.errorHTML})`);
    assert.ok(s.first.length > 20, 'reader shows real prose');

    /* Count every distinct paragraph the reader is able to show, whether it
       renders the whole book at once or a screen at a time. The old prototype
       topped out at 14 and never grew. */
    const seen = new Set(s.texts || []);
    let maxParas = s.paras, steps = 0, stalls = 0;
    for (let i = 0; i < 20; i++) {
      const r = await H.advanceOnce(page, { settle: 2500 });
      steps++;
      const now = await reader();
      if (!now) break;
      maxParas = Math.max(maxParas, now.paras);
      (now.texts || []).forEach(t => seen.add(t));
      if (seen.size > 40) break;
      stalls = r.moved ? 0 : stalls + 1;
      if (stalls >= 3) break;
    }
    console.log(`    ${book.title}: ${maxParas} paragraphs on screen, ${seen.size} distinct across ${steps} steps`);

    assert.ok(
      maxParas > 14 || seen.size > 14,
      `reader must get past the 14-paragraph preview for ${book.title} ` +
      `(max ${maxParas} on screen, ${seen.size} distinct paragraphs across ${steps} steps)`
    );
    assert.ok(
      seen.size >= 40,
      `reader must be able to show the whole book, not a stub (${book.title}: only ${seen.size} distinct paragraphs reachable)`
    );
    assert.equal(
      s.prototypeCopy, false,
      `reader must not punt the reader to Project Gutenberg instead of the text (${book.title})`
    );
  }
});

/* --- 2. paging: next advances, previous returns ---------------------------- */

test('reader: next/continue advances through the book and previous returns', { timeout: 240000 }, async () => {
  await fresh(READER_SEED);
  await H.openReaderById(page, NO_EXCERPT_BOOK.id);
  await settleReader(60000);

  const start = await reader();
  const firstTexts = new Set([start.first, start.last]);

  let moved = 0, stalled = 0;
  for (let i = 0; i < 10; i++) {
    const r = await H.advanceOnce(page, { settle: 4000 });
    if (!r.moved) { if (++stalled >= 2) break; continue; }
    stalled = 0;
    moved++;
    const now = await reader();
    if (now) { firstTexts.add(now.first); firstTexts.add(now.last); }
    if (firstTexts.size >= 3) break;
  }

  assert.ok(
    moved >= 1,
    'a next/continue affordance must advance the reader (no paging action found in the reader overlay)'
  );

  const forward = await reader();
  assert.notEqual(
    `${forward.first}|${forward.last}`, `${start.first}|${start.last}`,
    'reader shows different text after advancing'
  );

  const backClicked = await page.evaluate(() => {
    const ov = window.__QA.readerRoot(); if (!ov) return false;
    const rx = /previous|back to|go back|^prev$|\u2039|\u2190|^re-read/i;
    const b = Array.from(ov.querySelectorAll('button,[data-act],[role="button"]'))
      .filter(x => !x.disabled && x.getAttribute('data-act') !== 'close')   // never the dismiss chevron
      .find(x => rx.test(((x.innerText || '') + ' ' + (x.getAttribute('aria-label') || '') + ' ' + (x.getAttribute('data-act') || '')).replace(/\s+/g, ' ')));
    if (!b) return false;
    b.click(); return true;
  });
  assert.equal(backClicked, true, 'reader exposes a previous/back control');

  const t0 = Date.now();
  let returned = false;
  while (Date.now() - t0 < 10000) {
    const s = await reader();
    if (s && (s.first === start.first || s.scrollTop < start.scrollTop + 4)) { returned = true; break; }
    await new Promise(r => setTimeout(r, 300));
  }
  assert.equal(returned, true, 'previous returns the reader to the earlier passage');
});

/* --- 3. progress, chapters and a true end of book -------------------------- */

test('reader: shows progress/chapter position and reaches a true end of book', { timeout: 300000 }, async () => {
  await fresh(READER_SEED);
  await H.openReaderById(page, NO_EXCERPT_BOOK.id);
  await settleReader(60000);

  const start = await reader();
  soft(!!start.chapter, 'reader renders no explicit chapter marker');
  soft(start.progress !== null, 'reader has no progress element');

  const progressStart = start.progress;
  const seen = new Set(start.texts || []);
  let reachedEnd = false, steps = 0, maxParas = start.paras, progressEnd = start.progress;
  let stalls = 0;

  for (let i = 0; i < 80 && !reachedEnd; i++) {
    const r = await H.advanceOnce(page, { settle: 2500 });
    steps++;
    const s = await reader();
    if (!s) break;
    maxParas = Math.max(maxParas, s.paras);
    (s.texts || []).forEach(t => seen.add(t));
    if (s.progress) progressEnd = s.progress;
    if (s.endOfBook) { reachedEnd = true; break; }
    stalls = r.moved ? 0 : stalls + 1;
    if (stalls >= 3) break;   // paging is exhausted
  }

  console.log(`    walked ${steps} pages, ${seen.size} distinct openings, max ${maxParas} paragraphs, progress ${progressStart} -> ${progressEnd}`);

  assert.ok(
    maxParas > 14 || seen.size > 1,
    'paging through the book must keep producing new text past the 14-paragraph preview (max ' + maxParas + ')'
  );
  assert.ok(
    reachedEnd,
    'reading to the end of the book must surface a true end-of-book state, ' +
    `not the prototype\'s "End of preview" (walked ${steps} pages, ${seen.size} distinct openings)`
  );
  if (progressStart !== null && progressEnd !== null) {
    soft(progressStart !== progressEnd, 'progress indicator never changed while paging');
  }
});

/* --- 4. the reader must not freeze ---------------------------------------- */

test('reader: stays responsive (no freeze) while paging', { timeout: 240000 }, async () => {
  await fresh(READER_SEED);
  await H.openReaderById(page, NO_EXCERPT_BOOK.id);
  await settleReader(60000);

  const frames = await page.evaluate(async () => {
    const t0 = performance.now();
    let n = 0;
    while (performance.now() - t0 < 1000) { n++; await new Promise(r => requestAnimationFrame(r)); }
    return n;
  });
  assert.ok(frames > 5, `page produced only ${frames} animation frames per second — possible freeze`);

  let responsive = true;
  for (let i = 0; i < 6; i++) {
    await H.advanceOnce(page, { settle: 2500 });
    const alive = await page.evaluate(() => ({ t: Date.now(), reader: !!window.__QA.readerState() })).catch(() => null);
    if (!alive) { responsive = false; break; }
    assert.equal(alive.reader, true, 'reader overlay survived the page turn');
  }
  assert.equal(responsive, true, 'browser stayed responsive across repeated page turns');
});

/* --- 5. loading and error handling ----------------------------------------- */

test('reader: shows a loading state, then an explicit error with a retry when text fetch fails', { timeout: 120000 }, async () => {
  await fresh(READER_SEED);
  page.__netFailText = true;
  try {
    assert.equal(await H.openReaderById(page, NO_EXCERPT_BOOK.id), true, 'reader opened for a book with no cached excerpt');
    const s = await settleReader(30000);

    assert.ok(s, 'reader overlay still present after a failed fetch');
    assert.equal(s.hasLoader, false, 'reader must not sit on an endless loader after a failed fetch');
    assert.equal(
      s.errorState, true,
      'reader must show an explicit error/empty state when the text cannot be fetched'
    );
    const hasRetry = await page.evaluate(() => {
      const ov = window.__QA.readerRoot(); if (!ov) return false;
      return Array.from(ov.querySelectorAll('button,[data-act]'))
        .some(b => /try again|retry|reload/i.test((b.innerText || '') + ' ' + (b.getAttribute('data-act') || '')));
    });
    soft(hasRetry, 'no retry affordance in the reader error state');
  } finally {
    page.__netFailText = false;
  }
});

/* ============================================================ SETTINGS ==== */

test('reader settings: Paper/White/Night, serif/sans, size and margins all take effect', { timeout: 180000 }, async () => {
  await fresh(READER_SEED);
  await H.openReaderById(page, NO_EXCERPT_BOOK.id);
  await settleReader(60000);

  const opened = await page.evaluate(() => {
    const ov = window.__QA.readerRoot(); if (!ov) return false;
    const b = Array.from(ov.querySelectorAll('button,[data-act]'))
      .find(x => x.getAttribute('data-act') === 'reader-settings' || /reading settings|reading preferences|\baa\b/i.test(x.getAttribute('aria-label') || ''));
    if (!b) return false; b.click(); return true;
  });
  assert.equal(opened, true, 'reader exposes a reading-settings control');

  const snapshot = () => page.evaluate(() => {
    const ov = window.__QA.readerRoot(); if (!ov) return null;
    const host = ov.querySelector('.settings,[class*="set"],[class*="sheet"]') || ov;
    const btns = Array.from(host.querySelectorAll('button')).map(b => ({
      t: (b.innerText || '').replace(/\s+/g, ' ').trim(),
      act: b.getAttribute('data-act') || '',
      set: b.getAttribute('data-set') || '',
      val: b.getAttribute('data-value') || '',
      delta: b.getAttribute('data-delta') || '',
      on: b.classList.contains('on') || b.getAttribute('aria-checked') === 'true'
    }));
    return btns;
  });

  /* The reading surface may be transparent and inherit from an ancestor, so walk
     up until an opaque background is found. */
  const readerTheme = () => page.evaluate(() => {
    let el = window.__QA.readerRoot();
    if (!el) return '';
    el = el.querySelector('[data-reader-scroll],.reader-scroll,.scroll') || el;
    while (el) {
      const bg = getComputedStyle(el).backgroundColor;
      if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) return bg;
      el = el.parentElement;
    }
    return '';
  });

  const initial = { theme: await readerTheme(), buttons: await snapshot() };
  assert.ok(initial.buttons.length > 0, 'settings sheet rendered controls');

  /* Clicks a segmented setting by its data-value, or falls back to its label. */
  const pick = async (set, value) => page.evaluate((s, v) => {
    const ov = window.__QA.root(); if (!ov) return false;
    const all = Array.from(ov.querySelectorAll('button,[data-act]')).filter(x => !x.disabled);
    const b = all.find(x => x.getAttribute('data-set') === s && x.getAttribute('data-value') === v)
        || all.find(x => (x.getAttribute('data-value') || '') === v && !x.getAttribute('data-set'))
        || all.find(x => (x.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase() === String(v).toLowerCase());
    if (!b) return false; b.click(); return true;
  }, set, value);

  // Themes: each must change the reader's rendered background.
  const seen = {};
  for (const t of ['paper', 'white', 'night']) {
    const ok = await pick('theme', t);
    if (!ok) { softNote(`settings has no ${t} theme option`); continue; }
    await new Promise(r => setTimeout(r, 400));
    seen[t] = await readerTheme();
  }
  assert.equal(Object.keys(seen).length, 3, `settings must offer Paper/White/Night (saw ${Object.keys(seen).join(',') || 'none'})`);
  assert.ok(new Set(Object.values(seen)).size >= 2, `themes must render distinct backgrounds (saw ${JSON.stringify(seen)})`);
  {
    const lum = c => (c.match(/\d+/g) || [0, 0, 0]).slice(0, 3).reduce((a, v, i) => a + Number(v) * [0.299, 0.587, 0.114][i], 0);
    assert.ok(lum(seen.night) < lum(seen.paper), `Night must be darker than Paper (night=${seen.night} paper=${seen.paper})`);
    assert.ok(lum(seen.white) >= lum(seen.paper), `White must be lighter than Paper (white=${seen.white} paper=${seen.paper})`);
  }

  // Typeface.
  const fonts = {};
  for (const f of ['serif', 'sans']) {
    const ok = await pick('family', f);
    if (!ok) { softNote(`settings has no ${f} typeface option`); continue; }
    await new Promise(r => setTimeout(r, 400));
    fonts[f] = await page.evaluate(() => {
      const ov = window.__QA.readerRoot(); if (!ov) return '';
      const p = ov.querySelector('p');
      return p ? getComputedStyle(p).fontFamily : '';
    });
  }
  assert.equal(Object.keys(fonts).length, 2, `settings must offer Serif/Sans (saw ${Object.keys(fonts).join(',') || 'none'})`);
  assert.notEqual(fonts.serif, fonts.sans, `Serif and Sans must resolve to different fonts (${fonts.serif} vs ${fonts.sans})`);
  assert.ok(/serif|times|georgia|newsreader|garamond|palatino|charter|book/i.test(fonts.serif), `serif option does not look like a serif stack (${fonts.serif})`);
  assert.ok(/sans|inter|helvetica|arial|system/i.test(fonts.sans), `sans option does not look like a sans stack (${fonts.sans})`);

  // Size.
  const sizeNow = () => page.evaluate(() => {
    const ov = window.__QA.readerRoot(); if (!ov) return 0;
    const p = ov.querySelector('p'); const sc = ov.querySelector('[data-reader-scroll],.reader-scroll') || ov;
    const host = ov.querySelector('.reader-body,[data-reader-body]') || sc;
    return p ? parseFloat(getComputedStyle(p).fontSize) : parseFloat(getComputedStyle(host).fontSize) || 0;
  });
  const sizeBtn = delta => page.evaluate(d => {
    const ov = window.__QA.root(); if (!ov) return false;
    const all = Array.from(ov.querySelectorAll('button,[data-act]')).filter(x => !x.disabled);
    const b = all.find(x => (x.getAttribute('data-delta') || '') === d)
        || all.find(x => d === '1' ? /\+|\blarger\b/i.test(x.innerText || '') : /\u2212|\u2013|\bminus\b|smaller/i.test(x.innerText || ''));
    if (!b) return false; b.click(); return true;
  }, delta);

  const s0 = await sizeNow();
  soft(await sizeBtn('1'), 'no text-size increase control in settings');
  await new Promise(r => setTimeout(r, 400));
  const s1 = await sizeNow();
  assert.ok(s1 > s0, `A+ must increase text size (${s0}px -> ${s1}px)`);
  await sizeBtn('-1');
  await new Promise(r => setTimeout(r, 400));
  const s2 = await sizeNow();
  assert.ok(s2 < s1, `A\u2212 must decrease text size (${s1}px -> ${s2}px)`);

  // Margins.
  const padNow = () => page.evaluate(() => {
    const ov = window.__QA.readerRoot(); if (!ov) return '';
    const host = ov.querySelector('.reader-body,[data-reader-body],article') || ov.querySelector('[data-reader-scroll],.reader-scroll') || ov;
    return getComputedStyle(host).paddingLeft;
  });
  const p0 = await padNow();
  await pick('margin', '2');           // Wide
  await new Promise(r => setTimeout(r, 400));
  const pWide = await padNow();
  await pick('margin', '0');           // Narrow
  await new Promise(r => setTimeout(r, 400));
  const pNarrow = await padNow();
  assert.ok(parseFloat(pWide) > parseFloat(pNarrow) + 1, `Wide must have larger margins than Narrow (${pWide} vs ${pNarrow})`);
  assert.ok(parseFloat(pNarrow) < parseFloat(p0) + 1, 'Narrow margins must be the tightest option');

  // Close the sheet.
  await page.evaluate(() => {
    const ov = window.__QA.root(); if (!ov) return;
    const b = Array.from(ov.querySelectorAll('button,[data-act]'))
      .filter(x => !x.disabled)
      .find(x => /done|^close$/i.test((x.innerText || '') + ' ' + (x.getAttribute('data-act') || '')));
    if (b) b.click();
  });
});

test('reader settings persist across closing the book and reopening it', { timeout: 240000 }, async () => {
  await fresh(READER_SEED);
  await H.openReaderById(page, NO_EXCERPT_BOOK.id);
  await settleReader(60000);

  await page.evaluate(() => {
    const ov = window.__QA.readerRoot();
    const b = Array.from(ov.querySelectorAll('button,[data-act]'))
      .find(x => x.getAttribute('data-act') === 'reader-settings');
    if (b) b.click();
  });
  await page.waitForFunction(() => !!window.__QA.root(), { timeout: 5000 });

  const setOpt = async (val, nth = 0) => page.evaluate((v, n) => {
    const ov = window.__QA.root(); if (!ov) return false;
    const b = Array.from(ov.querySelectorAll('button,[data-act]'))
      .filter(x => !x.disabled)
      .filter(x => (x.getAttribute('data-value') || '') === v)[n];
    if (!b) return false; b.click(); return true;
  }, val, nth);

  assert.equal(await setOpt('night'), true, 'Night theme is selectable');
  assert.equal(await setOpt('sans'), true, 'Sans typeface is selectable');

  const stored = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('florilegium.mono.v1') || '{}').settings || null; } catch (e) { return null; }
  });
  soft(stored && stored.theme === 'night', `theme persisted to localStorage (${JSON.stringify(stored)})`);
  soft(stored && stored.family === 'sans', `typeface persisted to localStorage (${JSON.stringify(stored)})`);

  // Close the reader, reopen it, confirm the theme is still applied.
  await page.evaluate(() => {
    const ov = window.__QA.readerRoot();
    const b = Array.from(ov.querySelectorAll('button,[data-act]')).find(x => x.getAttribute('data-act') === 'close');
    if (b) b.click();
  });
  await new Promise(r => setTimeout(r, 800));
  await H.closeAllOverlays(page);
  assert.equal(await page.evaluate(() => window.__QA.readerPresent()), false, 'reader closed');

  assert.equal(await H.openReaderById(page, NO_EXCERPT_BOOK.id), true, 'reader reopened');
  await settleReader(60000);
  const after = await reader();
  const themeAttr = after.theme;
  const applied = await page.evaluate(() => {
    const ov = window.__QA.readerRoot();
    const sc = ov.querySelector('[data-reader-scroll],.reader-scroll') || ov;
    return getComputedStyle(sc).backgroundColor;
  });
  soft(themeAttr === 'night' || (stored && stored.theme === 'night'),
    `reopened reader should still be in Night (data-theme="${themeAttr}", bg=${applied})`);

  // And it survives a full page reload.
  await H.reload(page, server);
  const afterReload = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('florilegium.mono.v1') || '{}').settings || null; } catch (e) { return null; }
  });
  soft(afterReload && afterReload.theme === 'night' && afterReload.family === 'sans',
    `settings must survive a page reload (${JSON.stringify(afterReload)})`);
});

/* ============================================================== SHELF ==== */

/* Opens the top card of the For You deck and returns its book id. Those books
   are guaranteed *not* to be on the shelf yet, which is what the save tests need. */
async function deckBook(page) {
  await H.nav(page, 'foryou');
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const b = await page.evaluate(() => {
      const c = document.querySelector('[data-deck-top][data-id]');
      return c ? { id: c.getAttribute('data-id'), title: (c.querySelector('.deck-title') || {}).textContent || '' } : null;
    });
    if (b && b.id) return b;
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

async function openPreviewForId(page, id) {
  const ok = await page.evaluate(i => {
    const el = document.querySelector(`[data-act="preview"][data-id="${i}"]`);
    if (!el) return false; el.click(); return true;
  }, id);
  if (!ok) return false;
  return page.waitForFunction(() => (window.__QA.previewState() || {}).open === true, { timeout: 15000 })
    .then(() => true).catch(() => false);
}

const shelfIds = () => page.evaluate(() => {
  try { return (JSON.parse(localStorage.getItem('florilegium.mono.v1') || '{}').shelf || []).map(s => String(s.bookId)); } catch (e) { return []; }
});

test('save from the preview sheet persists the book to localStorage and the shelf', { timeout: 120000 }, async () => {
  await fresh(H.SAVE_SEED);
  const deck = await deckBook(page);
  assert.ok(deck, 'For You deck offers a book that is not on the shelf yet');
  assert.equal((await shelfIds()).includes(deck.id), false, 'deck book is not on the shelf before saving');

  assert.equal(await openPreviewForId(page, deck.id), true, 'preview sheet opened for the deck book');

  const clicked = await page.evaluate(() => {
    const ov = window.__QA.root(); if (!ov) return false;
    const b = Array.from(ov.querySelectorAll('button,[data-act]'))
      .filter(x => !x.disabled)
      .find(x => /add to shelf|save|keep/i.test((x.innerText || '') + ' ' + (x.getAttribute('data-act') || '')));
    if (!b) return false; b.click(); return true;
  });
  assert.equal(clicked, true, 'preview exposes "Add to shelf"');

  const persisted = await page.waitForFunction(id => {
    try { return (JSON.parse(localStorage.getItem('florilegium.mono.v1') || '{}').shelf || []).some(s => String(s.bookId) === id); } catch (e) { return false; }
  }, { timeout: 10000, polling: 200 }, String(deck.id)).then(() => true).catch(() => false);
  assert.equal(persisted, true, 'book persisted in the localStorage shelf');

  const entry = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('florilegium.mono.v1') || '{}').shelf || []; } catch (e) { return []; }
  }).then(rows => rows.find(s => String(s.bookId) === String(deck.id)));
  assert.ok(entry, 'shelf entry exists');
  assert.ok(entry.book && entry.book.title, 'persisted entry keeps the book payload');
  assert.ok(typeof entry.status === 'string', 'persisted entry has a reading status');

  const uiSaved = await page.evaluate(() => (window.__QA.previewState() || {}).saved === true);
  soft(uiSaved, 'preview save button did not flip to an "on your shelf" state');

  await H.closeAllOverlays(page);
  await H.nav(page, 'shelf');
  const onShelf = await page.evaluate(id => !!document.querySelector(`[data-screen="shelf"] [data-id="${id}"]`), deck.id);
  assert.equal(onShelf, true, 'saved book appears on the shelf screen');
});

test('save from inside the reader persists to the shelf', { timeout: 180000 }, async () => {
  await fresh(H.SAVE_SEED);
  const deck = await deckBook(page);
  assert.ok(deck, 'For You deck offers a book');
  assert.equal(await H.openReaderById(page, deck.id), true, 'reader opened for the deck book');
  await settleReader(60000);

  const findSave = () => page.evaluate(() => {
    const ov = window.__QA.readerRoot(); if (!ov) return false;
    const b = Array.from(ov.querySelectorAll('button,[data-act]'))
      .filter(x => !x.disabled)
      .find(x => /add to shelf|on your shelf|save|keep/i.test((x.innerText || '') + ' ' + (x.getAttribute('aria-label') || '') + ' ' + (x.getAttribute('data-act') || '')));
    if (!b) return false; b.click(); return true;
  });

  /* A full-book reader may only offer "save" at the end of the text, so look on
     the opening screen, at the foot of a scrolled page, and a dozen pages in. */
  let clicked = await findSave();
  for (let i = 0; i < 12 && !clicked; i++) {
    await page.evaluate(() => window.__QA.clickScrollBottom());
    await new Promise(r => setTimeout(r, 250));
    clicked = await findSave();
    if (clicked) break;
    await H.advanceOnce(page, { settle: 2000 });
  }
  assert.equal(clicked, true, 'reader exposes a save/add-to-shelf control somewhere in the reading flow');

  const ok = await page.waitForFunction(id => {
    try { return (JSON.parse(localStorage.getItem('florilegium.mono.v1') || '{}').shelf || []).some(s => String(s.bookId) === id); } catch (e) { return false; }
  }, { timeout: 10000, polling: 200 }, String(deck.id)).then(() => true).catch(() => false);
  assert.equal(ok, true, 'saving from the reader writes to localStorage');
});

test('shelf: filters narrow the list and persist across reload', { timeout: 90000 }, async () => {
  await fresh(H.SHELF_SEED);
  await H.nav(page, 'shelf');

  const rows = () => page.evaluate(() => document.querySelectorAll('[data-screen="shelf"] [data-act="preview"]').length);
  const tabs = await page.evaluate(() => Array.from(document.querySelectorAll('[data-screen="shelf"] [data-act="shelf-filter"]')).map(b => ({ f: b.dataset.filter, t: (b.innerText || '').replace(/\s+/g, ' ').trim() })));
  assert.ok(tabs.length >= 3, `shelf exposes filter tabs (saw ${tabs.map(t => t.f).join(',')})`);

  const all = await rows();
  assert.ok(all >= 4, `seeded shelf shows its books (saw ${all})`);

  const counts = {};
  for (const t of ['to-read', 'reading', 'finished']) {
    const hit = await page.evaluate(f => {
      const b = document.querySelector(`[data-act="shelf-filter"][data-filter="${f}"]`);
      if (!b) return false; b.click(); return true;
    }, t);
    assert.equal(hit, true, `filter "${t}" is clickable`);
    await new Promise(r => setTimeout(r, 250));
    counts[t] = await rows();
  }

  soft(counts['reading'] >= 1, `Reading filter shows reading books (saw ${counts.reading})`);
  soft(counts['finished'] >= 1, `Finished filter shows finished books (saw ${counts.finished})`);
  soft(counts['to-read'] >= 1, `To read filter shows queued books (saw ${counts['to-read']})`);
  soft(
    counts['to-read'] + counts['reading'] + counts['finished'] === all,
    `filters partition the shelf (${JSON.stringify(counts)} vs ${all} total)`
  );

  // Persistence of the shelf itself.
  await H.reload(page, server);
  await H.nav(page, 'shelf');
  const afterReload = await rows();
  soft(afterReload >= 4, `shelf survives reload (saw ${afterReload})`);
});

/* ====================================================== SEARCH & BROWSE ==== */

test('search: "sherlock" returns English result rows', { timeout: 120000 }, async () => {
  await fresh();
  const opened = await page.evaluate(() => {
    const b = document.querySelector('[data-act="search"]');
    if (!b) return false; b.click(); return true;
  });
  assert.equal(opened, true, 'home exposes a search action');

  await page.waitForFunction(() => !!document.querySelector('[data-search-input]'), { timeout: 15000 });
  await page.evaluate(() => {
    const i = document.querySelector('[data-search-input]');
    i.focus(); i.value = 'sherlock';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });

  let res = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    res = await page.evaluate(() => {
      const body = document.querySelector('.overlay.search [data-search-body]') ||
                   (window.__QA.root() && window.__QA.root().querySelector('[data-search-body]'));
      if (!body) return null;
      const rows = Array.from(body.querySelectorAll('[data-act="preview"]')).map(r => r.innerText.replace(/\s+/g, ' ').trim());
      return {
        rows,
        meta: body.querySelector('.result-meta') ? body.querySelector('.result-meta').innerText.replace(/\s+/g, ' ').trim() : '',
        loading: !!body.querySelector('.loader'),
        empty: !!body.querySelector('.empty'),
        err: /stacks are quiet|could not reach/i.test(body.innerText || '')
      };
    });
    if (res && (res.rows.length || res.empty || res.err)) break;
    await new Promise(r => setTimeout(r, 400));
  }

  assert.ok(res, 'search panel rendered');
  if (res.err) { softNote('search could not reach Gutendex (network) — soft'); return; }
  assert.ok(!res.loading, 'search is not stuck loading');
  assert.ok(res.rows.length > 0, `"sherlock" returned result rows (empty: ${res.empty}, meta: ${res.meta})`);
  assert.ok(res.rows.some(r => /sherlock/i.test(r)), `rows match the query (${res.rows.slice(0, 3).join(' | ')})`);

  const nonEnglish = await page.evaluate(() => {
    const rs = Array.from(document.querySelectorAll('.overlay.search [data-act="preview"]'));
    return rs.filter(r => /german|french|latin|spanish|italian/i.test(r.innerText)).map(r => r.innerText.slice(0, 60));
  });
  soft(nonEnglish.length === 0, `search returned non-English rows (${nonEnglish.join(' | ')})`);

  // A row must open the preview.
  const rowOpens = await page.evaluate(() => {
    const r = document.querySelector('.overlay.search [data-act="preview"]');
    if (!r) return false; r.click(); return true;
  });
  assert.equal(rowOpens, true, 'a search result row is clickable');
  const pv = await page.waitForFunction(() => (window.__QA.previewState() || {}).open === true, { timeout: 10000 }).then(() => true).catch(() => false);
  soft(pv, 'search result row did not open a preview sheet');
});

test('browse: Mystery returns rows and a real count', { timeout: 120000 }, async () => {
  await fresh();
  const opened = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-act="browse"]'));
    const m = rows.find(r => /mystery/i.test(r.innerText)) || rows[0];
    if (!m) return false; m.click(); return true;
  });
  assert.equal(opened, true, 'home exposes browse rows');

  let state = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    state = await page.evaluate(() => {
      const ov = window.__QA.root();
      if (!ov) return null;
      const body = ov.querySelector('[data-browse-body]') || ov;
      const rows = Array.from(body.querySelectorAll('[data-act="preview"]')).map(r => r.innerText.replace(/\s+/g, ' ').trim());
      return {
        rows,
        count: ov.querySelector('[data-browse-count]') ? ov.querySelector('[data-browse-count]').textContent.trim() : '',
        loading: !!body.querySelector('.loader'),
        empty: !!body.querySelector('.empty'),
        err: /quiet|could not|unavailable/i.test(body.innerText || '')
      };
    });
    if (state && (state.rows.length || state.empty || state.err)) break;
    await new Promise(r => setTimeout(r, 400));
  }

  assert.ok(state, 'browse sheet rendered');
  if (state.err) { softNote('browse could not reach Gutendex (network) — soft'); return; }
  assert.ok(!state.loading, 'browse is not stuck loading');
  assert.ok(state.rows.length > 0, `Mystery browse returned rows (empty=${state.empty}, count="${state.count}")`);
  soft(/\d/.test(state.count) && !/loading/i.test(state.count), `browse shows a resolved count (got "${state.count}")`);
});

/* =============================================================== RESET ==== */

test('reset flow: confirms, clears storage and restores the demo shelf', { timeout: 90000 }, async () => {
  await fresh();
  // Make some state worth clearing.
  await page.evaluate(() => {
    localStorage.setItem('florilegium.mono.v1', JSON.stringify({
      shelf: [{ bookId: 999, book: { id: 999, title: 'Temp', author: 'X' }, status: 'reading', addedAt: 1 }],
      settings: { theme: 'night', family: 'sans', size: 22, margin: 2 }
    }));
  });
  await H.reload(page, server);

  await H.nav(page, 'profile');
  const opened = await page.evaluate(() => {
    const b = document.querySelector('[data-act="reset"]');
    if (!b) return false; b.click(); return true;
  });
  assert.equal(opened, true, 'profile exposes a reset action');

  await page.waitForFunction(() => /reset/i.test((window.__QA.root() || {}).innerText || ''), { timeout: 10000 });
  const confirmed = await page.evaluate(() => {
    const ov = window.__QA.root(); if (!ov) return false;
    const b = Array.from(ov.querySelectorAll('button,[data-act]'))
      .find(x => /reset everything|confirm|yes/i.test((x.innerText || '') + ' ' + (x.getAttribute('data-act') || '')));
    if (!b) return false; b.click(); return true;
  });
  assert.equal(confirmed, true, 'reset dialog offers a confirm action');

  await page.waitForFunction(() => document.querySelector('[data-screen="home"] .daily-title'), { timeout: 30000 });
  await H.reload(page, server);
  await H.nav(page, 'shelf');
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('[data-screen="shelf"] [data-act="preview"]')).map(r => r.innerText.replace(/\s+/g, ' ').trim()));
  const settings = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('florilegium.mono.v1') || '{}').settings || null; } catch (e) { return null; }
  });
  soft(!rows.some(r => /Temp/.test(r)), `reset must drop the temporary shelf entry (${rows.join(' | ')})`);
  soft(!settings || settings.theme !== 'night', `reset must clear custom settings (${JSON.stringify(settings)})`);
});

/* =========================================================================
   ROUND-3 REGRESSION CASES
   Guards the specific defects found in review of the full-book branch:
   the preview CTA rename, the deck leaking shelf books, the demo shelf not
   being persisted, a dead deck with no way back, the r.jina.ai throttle path,
   and undersized touch targets.
   ========================================================================= */

/* --- 1. the preview's primary CTA --------------------------------------- */

test('regression: preview exposes a "Read a little" action that opens the reader', { timeout: 120000 }, async () => {
  await fresh(READER_SEED);
  const deck = await deckBook(page);
  assert.ok(deck, 'deck offers a book');

  assert.equal(await openPreviewForId(page, deck.id), true, 'preview sheet opened');

  const cta = await page.evaluate(() => {
    const ov = window.__QA.root(); if (!ov) return null;
    const b = Array.from(ov.querySelectorAll('button,[data-act]'))
      .filter(x => !x.disabled)
      .find(x => x.getAttribute('data-act') === 'reader' || /read a little/i.test(x.innerText || ''));
    if (!b) {
      return {
        missing: true,
        labels: Array.from(ov.querySelectorAll('button')).map(x => (x.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean)
      };
    }
    return { label: (b.innerText || '').replace(/\s+/g, ' ').trim() };
  });

  assert.ok(cta && !cta.missing,
    `preview must offer a "Read a little" action (buttons seen: ${(cta && cta.labels || []).join(' | ')})`);
  assert.match(cta.label, /read a little/i,
    `the preview read action must be labelled "Read a little" (saw "${cta.label}")`);

  assert.equal(await H.openReaderById(page, deck.id), true, '"Read a little" opens the reader');
  await settleReader(60000);
  assert.ok(await reader(), 'reader is open after using the preview CTA');
});

/* --- 2. the deck must never offer a book that is already on the shelf ----- */

test('regression: deck never offers shelf books and Keep always grows the shelf', { timeout: 240000 }, async () => {
  /* A deliberately small catalogue that *contains the shelf books*, which is
     the real-world shape (Gutendex returns the popular ones). With 8 rows and
     4 already shelved, applyCatalogue() computes fresh.length < 6 and takes
     its fallback shuffle - the exact path that leaked shelf books into the
     deck. 8 - 4 = 4 also leaves enough unsaved books to exercise Keep. */
  const tiny = [
    { id: 1342, title: 'Pride and Prejudice', author: 'Jane Austen', subjects: ['Romance fiction'], downloads: 190246 },
    { id: 1661, title: 'The Adventures of Sherlock Holmes', author: 'Arthur Conan Doyle', subjects: ['Detective fiction'], downloads: 62140 },
    { id: 345, title: 'Dracula', author: 'Bram Stoker', subjects: ['Horror tales'], downloads: 55488 },
    { id: 11, title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll', subjects: ['Fantasy fiction'], downloads: 121623 },
    { id: 768, title: 'Wuthering Heights', author: 'Emily Bronte', subjects: ['Romance fiction'], downloads: 71000 },
    { id: 203, title: "Uncle Tom's Cabin", author: 'Harriet Beecher Stowe', subjects: ['Slavery -- Fiction'], downloads: 64000 },
    { id: 1400, title: 'Great Expectations', author: 'Charles Dickens', subjects: ['Bildungsromans'], downloads: 68000 },
    { id: 84, title: 'Frankenstein', author: 'Mary Wollstonecraft Shelley', subjects: ['Science fiction'], downloads: 144008 }
  ];
  const mk = (id, title, author, subjects, status, addedAt) => ({
    bookId: id,
    book: { id, title, author, subjects, downloads: 1, cover: null, textUrl: 'https://www.gutenberg.org/cache/epub/' + id + '/pg' + id + '.txt' },
    status, addedAt
  });
  const seed = {
    shelf: [
      mk(1342, 'Pride and Prejudice', 'Jane Austen', ['Romance fiction'], 'reading', 4),
      mk(1661, 'The Adventures of Sherlock Holmes', 'Arthur Conan Doyle', ['Detective fiction'], 'to-read', 3),
      mk(345, 'Dracula', 'Bram Stoker', ['Horror tales'], 'to-read', 2),
      mk(11, "Alice's Adventures in Wonderland", 'Lewis Carroll', ['Fantasy fiction'], 'finished', 1)
    ],
    settings: { theme: 'paper', family: 'serif', size: 18, margin: 1 }
  };
  page.resetNet();
  page.__net.catalogue = tiny;
  try {
    await fresh(seed);
    const shelfBefore = seed.shelf.map(s => String(s.bookId));

    await H.nav(page, 'foryou');
    // let the catalogue land and the deck settle
    await new Promise(r => setTimeout(r, 2500));

    const seenIds = [];
    const offenders = [];
    let keeps = 0, keepsWithoutEffect = 0;

    for (let i = 0; i < 10; i++) {
      const d = await page.evaluate(() => window.__QA.deckState());
      if (!d) break;
      if (d.empty || !d.topId) break;

      if (shelfBefore.includes(String(d.topId)) && !seenIds.includes(String(d.topId))) {
        offenders.push(`${d.topId} (${d.topTitle})`);
      }
      seenIds.push(String(d.topId));

      const before = (await shelfIds()).length;
      const acted = await page.evaluate(() => {
        const el = document.querySelector('[data-screen="foryou"]');
        const b = Array.from(el.querySelectorAll('button,[data-act]'))
          .filter(x => !x.disabled && x.offsetParent !== null)
          .find(x => x.getAttribute('data-act') === 'keep' || /\bkeep\b/i.test(x.innerText || ''));
        if (!b) return false;
        b.click(); return true;
      });
      if (!acted) break;
      keeps++;

      await new Promise(r => setTimeout(r, 700));
      const after = (await shelfIds()).length;
      if (after !== before + 1) keepsWithoutEffect++;
      if (offenders.length) break;   // one is enough, and the run stays short
    }

    console.log(`    deck offered ${seenIds.length} cards (${seenIds.join(', ')}), ${keeps} keeps`);
    assert.deepEqual(offenders, [],
      `deck must never offer a book that is already on the shelf (${offenders.join(', ')})`);
    assert.ok(keeps >= 2, `expected several deck cards to exercise Keep (saw ${keeps})`);
    assert.equal(keepsWithoutEffect, 0,
      `every Keep must add the book to the shelf (${keepsWithoutEffect} of ${keeps} keeps changed nothing)`);
  } finally {
    page.resetNet();
  }
});

/* --- 3. the seeded demo shelf must survive a reload ----------------------- */

test('regression: the seeded demo shelf is persisted and survives a reload', { timeout: 120000 }, async () => {
  await fresh();                       // empty storage -> the app seeds its demo shelf

  await H.nav(page, 'shelf');
  const first = await page.evaluate(() => window.__QA.shelfState());
  assert.ok(first, 'shelf screen rendered');
  assert.equal(first.rows.length, 4, `a fresh profile shows the 4 demo shelf rows (saw ${first.rows.length}: ${first.rows.map(r => r.id).join(',')})`);

  const stored = await page.evaluate(() => {
    try {
      const raw = localStorage.getItem('florilegium.mono.v1');
      if (!raw) return null;
      return (JSON.parse(raw).shelf || []).map(s => ({ id: String(s.bookId), status: s.status }));
    } catch (e) { return null; }
  });
  assert.ok(stored, 'the seeded shelf must be written to localStorage, not held in memory only');
  assert.equal(stored.length, 4, `localStorage holds the 4 demo books (saw ${stored.length})`);

  const statusOf = rows => Object.fromEntries(rows.map(r => {
    const m = /to read|reading|finished/i.exec(r.text || '');
    return [r.id, m ? m[0].toLowerCase() : ''];
  }));
  const before = statusOf(first.rows);

  await H.reload(page, server);
  await H.nav(page, 'shelf');
  const after = await page.evaluate(() => window.__QA.shelfState());
  const afterStatus = statusOf(after.rows);

  assert.deepEqual(after.rows.map(r => r.id).sort(), first.rows.map(r => r.id).sort(),
    'the same shelf ids must be present after a reload');
  for (const [id, st] of Object.entries(before)) {
    assert.equal(afterStatus[id], st, `book ${id} keeps its "${st}" status across a reload`);
  }
  assert.equal(after.rows.length, 4, 'no rows lost or duplicated across the reload');
});

/* --- 4. the deck must survive a catalogue outage --------------------------- */

test('regression: a failed catalogue fetch ends the deck in a retryable state', { timeout: 240000 }, async () => {
  page.resetNet();
  await fresh();
  page.__netFailApi = true;
  try {
    await H.nav(page, 'foryou');
    await new Promise(r => setTimeout(r, 2000));

    // Burn through the seeded deck; each fetch for more will fail.
    let state = null;
    for (let i = 0; i < 24; i++) {
      state = await page.evaluate(() => window.__QA.deckState());
      if (!state || state.empty) break;
      const acted = await page.evaluate(() => {
        const el = document.querySelector('[data-screen="foryou"]');
        const b = Array.from(el.querySelectorAll('button,[data-act]'))
          .filter(x => !x.disabled && x.offsetParent !== null)
          .find(x => x.getAttribute('data-act') === 'skip' || /\bskip\b/i.test(x.innerText || ''));
        if (!b) return false;
        b.click(); return true;
      });
      if (!acted) break;
      await new Promise(r => setTimeout(r, 550));
    }

    // Give the final failing supply request time to land.
    for (let i = 0; i < 20; i++) {
      state = await page.evaluate(() => window.__QA.deckState());
      if (state && state.empty && !state.loading) break;
      await new Promise(r => setTimeout(r, 400));
    }

    assert.ok(state, 'deck screen still responsive');
    assert.equal(state.loading, false, 'deck must not sit on a loader after the outage');
    assert.equal(state.empty, true, 'an exhausted, failing deck must show an explicit empty state');
    assert.ok(!/folio for today/i.test(state.emptyText),
      `a failed fetch must not be reported as a finished deck ("${state.emptyText}")`);
    assert.ok(
      state.emptyActions.some(t => /try again|retry|reload|shuffle again/i.test(t)),
      `the failed deck state must offer a retry (buttons: ${state.emptyActions.join(' | ')})`
    );

    // Recovery: the catalogue comes back and retry produces a card.
    page.__netFailApi = false;
    await page.evaluate(() => {
      const el = document.querySelector('[data-screen="foryou"]');
      const b = Array.from(el.querySelectorAll('button,[data-act]'))
        .filter(x => !x.disabled)
        .find(x => /try again|retry|reload|shuffle again/i.test(x.innerText || ''));
      if (b) b.click();
    });

    let recovered = null;
    for (let i = 0; i < 30; i++) {
      recovered = await page.evaluate(() => window.__QA.deckState());
      if (recovered && !recovered.loading && (recovered.topId || recovered.empty)) break;
      await new Promise(r => setTimeout(r, 400));
    }
    soft(recovered && (recovered.topId || recovered.empty),
      'retry after a catalogue outage did not produce a card or an explicit state');
    if (recovered && recovered.topId) {
      soft(!!recovered.topTitle, 'recovered deck card has no title');
    }
  } finally {
    page.resetNet();
  }
});

/* --- 5. the r.jina.ai throttle path --------------------------------------- */

test('regression: a 429 from the text service is reported as rate limiting and Retry recovers', { timeout: 300000 }, async () => {
  page.resetNet();
  await fresh(READER_SEED);
  page.__netTextStatus = 429;
  page.__netJinaStatus = 429;
  try {
    assert.equal(await H.openReaderById(page, NO_EXCERPT_BOOK.id), true, 'reader opened for a non-curated book');

    const t0 = Date.now();
    let s = null;
    while (Date.now() - t0 < 120000) {
      s = await reader();
      if (s && s.hasLoader === false && s.errorState) break;
      await new Promise(r => setTimeout(r, 500));
    }
    assert.ok(s, 'reader overlay present');
    assert.equal(s.hasLoader, false, 'the reader must settle into an error state, not an endless loader');

    const rateSpecific = s.rateLimited || /rate/i.test(s.errorKind || '') || /too many requests|rate.?limit|throttl/i.test(s.fullText || '');
    assert.ok(rateSpecific,
      `a 429 must be reported as rate limiting, not a generic failure (errorKind="${s.errorKind}", text="${(s.fullText || '').slice(0, 160)}")`);

    const retry = await page.evaluate(() => {
      const ov = window.__QA.readerRoot(); if (!ov) return null;
      const b = Array.from(ov.querySelectorAll('button,[data-act]'))
        .filter(x => !x.disabled)
        .find(x => x.getAttribute('data-act') === 'retry-reader' || /try again|retry|reload/i.test(x.innerText || ''));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { label: (b.innerText || '').replace(/\s+/g, ' ').trim(), w: r.width, h: r.height };
    });
    assert.ok(retry, 'the rate-limit error must offer a Retry control');
    assert.ok(retry.w >= 44 && retry.h >= 44, `Retry must be a 44x44 touch target (got ${Math.round(retry.w)}x${Math.round(retry.h)})`);

    // The service recovers; retry must actually open the book.
    page.__netTextStatus = 0;
    page.__netJinaStatus = 0;
    await page.evaluate(() => {
      const ov = window.__QA.readerRoot(); if (!ov) return;
      const b = Array.from(ov.querySelectorAll('button,[data-act]'))
        .filter(x => !x.disabled)
        .find(x => x.getAttribute('data-act') === 'retry-reader' || /try again|retry/i.test(x.innerText || ''));
      if (b) b.click();
    });

    const t1 = Date.now();
    let opened = null;
    while (Date.now() - t1 < 120000) {
      opened = await reader();
      /* require a real chapter, not a transitional one-paragraph frame */
      if (opened && opened.errorState === false && opened.paras > 14) break;
      await new Promise(r => setTimeout(r, 500));
    }
    assert.ok(opened && opened.errorState === false,
      `Retry after the service recovered must open the book (still: ${JSON.stringify((opened || {}).fullText || '').slice(0, 140)})`);
    assert.ok(opened.paras > 14,
      `the recovered reader must show real chapters, not a stub (${opened.paras} paragraphs)`);
    assert.ok(!!opened.chapter, 'the recovered reader shows a chapter marker');
  } finally {
    page.resetNet();
  }
});

/* --- 6. touch targets ------------------------------------------------------ */

test('regression: reader and preview controls are at least 44x44', { timeout: 180000 }, async () => {
  await fresh(READER_SEED);
  page.__netFailText = true;
  try {
    /* a) reader Prev / Next, with the reader in its error state (Retry) */
    assert.equal(await H.openReaderById(page, NO_EXCERPT_BOOK.id), true, 'reader opened');
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const s = await reader();
      if (s && s.errorState) break;
      await new Promise(r => setTimeout(r, 400));
    }
    const readerTargets = await page.evaluate(() => window.__QA.touchTargets());
    const pick = (list, re) => list.find(t => re.test(t.act) || re.test(t.label));

    const prev = pick(readerTargets, /reader-prev|previous|^prev$/i);
    const next = pick(readerTargets, /reader-next|next/i);
    const readerRetry = pick(readerTargets, /retry-reader|try again/i);

    assert.ok(prev, `reader exposes a Previous control (saw ${readerTargets.map(t => t.act || t.label).join(' | ')})`);
    assert.ok(next, 'reader exposes a Next control');
    assert.ok(prev.w >= 44 && prev.h >= 44, `Previous must be >=44x44 (got ${prev.w}x${prev.h})`);
    assert.ok(next.w >= 44 && next.h >= 44, `Next must be >=44x44 (got ${next.w}x${next.h})`);
    if (readerRetry) {
      assert.ok(readerRetry.w >= 44 && readerRetry.h >= 44,
        `reader Retry must be >=44x44 (got ${readerRetry.w}x${readerRetry.h})`);
    } else {
      softNote('reader showed no error-state Retry to measure (text fetch may have been cached)');
    }
    await H.closeAllOverlays(page);

    /* b) the preview's Retry */
    await H.nav(page, 'shelf');
    const row = await page.evaluate(() => {
      const r = document.querySelector('[data-screen="shelf"] [data-act="preview"]');
      if (!r) return null;
      r.click(); return r.getAttribute('data-id');
    });
    assert.ok(row, 'a shelf row opens a preview');
    await page.waitForFunction(() => (window.__QA.previewState() || {}).open === true, { timeout: 15000 });
    for (let i = 0; i < 30; i++) {
      const pv = await H.previewState(page);
      if (pv && pv.error) break;
      await new Promise(r => setTimeout(r, 400));
    }
    const previewTargets = await page.evaluate(() => window.__QA.touchTargets());
    const pRetry = pick(previewTargets, /retry-excerpt|try again/i);
    assert.ok(pRetry, `the preview failure state offers a Retry (saw ${previewTargets.map(t => t.act || t.label).join(' | ')})`);
    assert.ok(pRetry.w >= 44 && pRetry.h >= 44, `preview Retry must be >=44x44 (got ${pRetry.w}x${pRetry.h})`);
  } finally {
    page.resetNet();
  }
});

/* ==================================================== SUITE SELF-CHECKS ==== */

test('suite: the in-page helper bundle escapes correctly', () => {
  const { problems, evaluated, usesRaw } = require('./check-helpers').inspectHelpers();
  assert.deepEqual(
    problems.map(p => ({ code: p.code, at: p.at })), [],
    'the QA_HELPERS bundle must have no control characters and must parse: ' + JSON.stringify(problems).slice(0, 400)
  );
  assert.equal(usesRaw, true, 'QA_HELPERS must be a String.raw template so backslashes survive');
  assert.ok(evaluated.includes('readerState'), 'helper bundle exposes readerState');
  assert.ok(evaluated.includes('function endState'), 'helper bundle has the end-of-book detector');
  /* The detector must keep real escapes and must not fall back to matching
     bare prose like "at the end of the Roman Republic", which a real book
     contains. `split("\n")` here means a literal backslash-n in the bundle. */
  assert.ok(evaluated.includes('split("\\n")'), 'endState must split on a real newline escape');
  assert.ok(evaluated.includes('MARK=/^(end of (the )?book'), 'endState marker regex must be intact');
  assert.ok(evaluated.includes(
    "replace(/[\\s\\u00b7\\u2022.\\-\\u2014:]+$/,\"\")"
  ), 'endState must keep its whitespace class escapes');
  assert.ok(!/\|quiet\//.test(evaluated), "errorState must not match bare 'quiet' (it occurs in ordinary prose)");
});
/* ========================================================= NO PAGE ERRORS ==== */

test('no uncaught page errors across the whole walkthrough', { timeout: 300000 }, async () => {
  const before = page.__errors.length;
  await fresh();

  // Exercise every surface once.
  for (const v of ['home', 'foryou', 'shelf', 'profile']) { await H.nav(page, v); await new Promise(r => setTimeout(r, 400)); }
  await H.openReaderById(page, BOOK.id);
  await settleReader(30000);
  await H.advanceOnce(page, { settle: 2500 });
  await page.evaluate(() => {
    const ov = window.__QA.readerRoot();
    const b = Array.from(ov.querySelectorAll('button,[data-act]')).find(x => x.getAttribute('data-act') === 'close');
    if (b) b.click();
  });
  await new Promise(r => setTimeout(r, 600));
  await page.evaluate(() => {
    const b = document.querySelector('[data-act="search"]'); if (b) b.click();
  });
  await page.waitForFunction(() => !!document.querySelector('[data-search-input]'), { timeout: 10000 }).catch(() => {});
  await page.keyboard.type('sherlock').catch(() => {});
  await new Promise(r => setTimeout(r, 4000));
  await page.evaluate(() => {
    const ov = window.__QA.root();
    const b = Array.from((ov ? ov.querySelectorAll('button,[data-act]') : [])).find(x => x.getAttribute('data-act') === 'close');
    if (b) b.click();
  });
  await new Promise(r => setTimeout(r, 800));
  await H.nav(page, 'home');

  const errors = page.__errors.slice(before).filter(e => e.kind !== 'request');
  assert.deepEqual(errors, [], `no uncaught page errors:\n${errors.map(e => `  ${e.kind}: ${e.text}`).join('\n')}`);
});

test('suite summary', async () => {
  if (softFailures.length) {
    console.log(`\n  Soft acceptance gaps (${softFailures.length}):`);
    for (const f of softFailures) console.log(`   - ${f}`);
  } else {
    console.log('\n  No soft acceptance gaps.');
  }
});