'use strict';
/*
 * Florilegium — post-deploy gate for the public URL.
 *
 *   $env:NODE_PATH="C:\Users\Daniel\AppData\Local\Temp\flori-tools\node_modules"
 *   node tests/live-verify.js
 *   $env:FLORI_URL="https://danieldamilola.github.io/florilegium/"; node tests/live-verify.js
 *
 * Unlike the stubbed suite this drives the real deployment: real Gutendex, real
 * Project Gutenberg, real r.jina.ai. Network is slow, so waits are generous and
 * individually bounded. The full-book requirement is NOT softened — a deployed
 * build that still shows previews fails here.
 *
 * Exit code 0 = every check passed, 1 = a check failed, 2 = could not run.
 *
 * Env:
 *   FLORI_URL           default https://danieldamilola.github.io/florilegium/
 *   FLORI_EDGE          Edge executable
 *   FLORI_OPEN_TIMEOUT  ms to first paint            (default 120000)
 *   FLORI_READ_TIMEOUT  ms for one book to open     (default 150000)
 *   FLORI_PAGE_TIMEOUT  ms for one page turn        (default 45000)
 *   FLORI_MAX_PAGES     max page turns to walk      (default 80)
 *   FLORI_MAX_BOOKS     deck books to try before failing (default 3)
 *   FLORI_HEADFUL       1 = show the browser window
 */

const H = require('./helpers');

const URL_UNDER_TEST = (process.env.FLORI_URL || 'https://danieldamilola.github.io/florilegium/').replace(/\/*$/, '/');
const OPEN_TIMEOUT = Number(process.env.FLORI_OPEN_TIMEOUT || 120000);
const READ_TIMEOUT = Number(process.env.FLORI_READ_TIMEOUT || 150000);
const PAGE_TIMEOUT = Number(process.env.FLORI_PAGE_TIMEOUT || 45000);
const MAX_PAGES = Number(process.env.FLORI_MAX_PAGES || 80);
const MAX_BOOKS = Number(process.env.FLORI_MAX_BOOKS || 3);

const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || '', ms: Date.now() - t0 });
    console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    results.push({ name, ok: false, detail: msg, ms: Date.now() - t0 });
    console.log(`  FAIL  ${name}\n          ${msg.split('\n')[0]}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** Poll a predicate with a hard deadline. Never throws on timeout. */
async function until(fn, ms, every = 500) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  return last || null;
}

/* ------------------------------------------------------------------ probes */

const deckCard = page => page.evaluate(() => {
  const c = document.querySelector('[data-deck-top][data-id]');
  if (!c) return null;
  return { id: c.getAttribute('data-id'), title: ((c.querySelector('.deck-title') || {}).textContent || '').trim() };
});

/**
 * Clicks the first control in the top overlay matching `src`.
 * Returns {ok, label, diag} — a miss is always explainable, never a bare null.
 */
async function clickInOverlay(page, src) {
  return page.evaluate(s => {
    const ov = (window.__QA && window.__QA.root) ? window.__QA.root() : null;
    const btns = ov ? Array.from(ov.querySelectorAll('button,[data-act]')) : [];
    const dump = btns.map(b => (b.getAttribute('data-act') || '-') + '|' +
      (b.innerText || '').trim() + '|' + (b.disabled ? 'off' : 'on'));
    if (!ov) return { ok: false, label: '', diag: { root: null, buttons: [] } };
    const rx = new RegExp(s, 'i');
    const b = btns.filter(x => !x.disabled).find(x => rx.test(
      (x.innerText || '') + ' ' + (x.getAttribute('aria-label') || '') + ' ' + (x.getAttribute('data-act') || '')));
    if (!b) return { ok: false, label: '', diag: { root: ov.className, buttons: dump } };
    b.click();
    const label = [(b.innerText || '').trim(), b.getAttribute('aria-label') || '', b.getAttribute('data-act') || '']
      .filter(Boolean).join(' / ');
    return { ok: true, label: label || 'clicked', diag: null };
  }, src).catch(e => ({ ok: false, label: '', diag: { error: String((e && e.message) || e) } }));
}

const overlayMiss = r => 'no matching control ' + JSON.stringify(r.diag).slice(0, 400);

/** Shelf size, preferring what the app persisted (the shelf screen is only
    rendered when that tab is active, so the DOM is not always populated). */
async function shelfCount(page) {
  const stored = await page.evaluate(() => {
    try { return (JSON.parse(localStorage.getItem('florilegium.mono.v1') || '{}').shelf || []).length; } catch (e) { return 0; }
  }).catch(() => 0);
  if (stored) return stored;
  return page.evaluate(() => {
    const el = document.querySelector('[data-screen="shelf"]');
    return el ? el.querySelectorAll('[data-act="preview"][data-id]').length : 0;
  }).catch(() => 0);
}

/** Opens the top For You card's preview sheet. */
async function openDeckPreview(page) {
  await H.nav(page, 'foryou');
  const card = await until(() => deckCard(page), 60000);
  if (!card) return null;
  const ok = await page.evaluate(id => {
    const el = document.querySelector(`[data-deck-top][data-id="${id}"]`);
    if (!el) return false;
    el.click(); return true;
  }, card.id);
  if (!ok) return null;
  const pv = await until(async () => {
    const p = await H.previewState(page);
    return p && p.open && !p.loading ? p : null;
  }, 90000);
  return { card, pv };
}

const skipDeckCard = page => page.evaluate(() => {
  const s = document.querySelector('[data-act="skip"]');
  if (s) { s.click(); return true; }
  return false;
});

/* ------------------------------------------------------------------- main */

(async () => {
  console.log(`\nFlorilegium live verification`);
  console.log(`  URL      ${URL_UNDER_TEST}`);
  console.log(`  viewport 390x844  ·  ${H.EDGE}\n`);

  const browser = await H.launchBrowser({ headless: process.env.FLORI_HEADFUL !== '1' });
  const page = await H.newPage(browser);

  /* ---------------------------------------------------------------- boot */

  await check('home: the deployed app loads and renders the daily folio', async () => {
    let navError = null;
    try {
      await page.goto(URL_UNDER_TEST, { waitUntil: 'domcontentloaded', timeout: OPEN_TIMEOUT });
    } catch (e) { navError = e; }
    assert(!navError, `navigation failed: ${navError && navError.message}`);
    assert(/^https?:/i.test(page.url()), `not a real http(s) URL: ${page.url()}`);

    const title = await until(() => page.evaluate(() => {
      const t = document.querySelector('.daily-title');
      return t && t.textContent.trim().length > 1 ? t.textContent.trim() : null;
    }), OPEN_TIMEOUT);
    assert(title, `no daily title within ${OPEN_TIMEOUT}ms (is the site deployed and reachable?)`);

    const info = await page.evaluate(() => {
      const el = document.querySelector('[data-screen="home"]');
      return {
        author: ((el.querySelector('.daily-author') || {}).textContent || '').trim(),
        cover: !!el.querySelector('.daily-cover .cover')
      };
    });
    assert(info.author.length > 1, 'no author on the daily folio');
    assert(info.cover, 'no cover on the daily folio');
    return `"${title}" by ${info.author}`;
  });

  await check('home: the daily quote skeleton resolves', async () => {
    const q = await until(() => page.evaluate(() => {
      const el = document.querySelector('[data-daily-quote]');
      if (!el) return null;
      if (el.querySelectorAll('.q-skel, .loader').length === 0) return (el.textContent || '').trim() || '(empty)';
      return null;
    }), 45000);
    assert(q !== null, 'the daily quote skeleton never cleared within 45s');
    return q.length > 57 ? q.slice(0, 57) + '…' : q;
  });

  /* ------------------------------------------------------------- preview */

  let firstPreview = null;
  await check('preview: the For You deck offers a book with a usable preview sheet', async () => {
    const opened = await openDeckPreview(page);
    assert(opened && opened.card, 'no deck card / preview within 60s');
    firstPreview = opened;
    const pv = opened.pv;
    assert(pv, 'the preview sheet never finished loading');
    assert(!pv.error, 'the preview could not fetch the opening pages on the live site');
    /* Capped at 3. Books with fewer than 3 built-in paragraphs legitimately show
       fewer, so the cap is the assertion, not an exact count. */
    assert(pv.paras >= 1, `the preview showed no paragraphs at all (${pv.paras})`);
    assert(pv.paras <= 3, `the preview leaked past its 3-paragraph cap (${pv.paras})`);
    assert(pv.endPreview, 'no END OF PREVIEW marker in the preview');
    assert(pv.hasReadALittle, 'no "Read a little" action in the preview');
    assert(pv.hasAddToShelf, 'no add-to-shelf action in the preview');
    return `${opened.card.title} (id ${opened.card.id}): ${pv.paras} paragraph(s) + END OF PREVIEW`;
  });

  /* --------------------------------------------------------- full book */

  const walked = { pages: 0, distinct: 0, books: [] };

  await check('reader: the preview CTA opens the reader and loads the full text', async () => {
    const hit = await clickInOverlay(page, 'read a little|start reading|^read$|data-act="reader"');
    assert(hit.ok, 'the preview exposes no read action: ' + overlayMiss(hit));
    const open = await until(async () => !!(await H.readerState(page)), 60000);
    assert(open, 'the reader did not open');

    /* A Gutenberg edition can be junk (front matter only, OCR noise). Try a few
       deck books before concluding the reader cannot show a whole book. */
    const failures = [];
    for (let book = 0; book < MAX_BOOKS; book++) {
      const s = await until(async () => {
        const st = await H.readerState(page);
        if (!st) return null;
        if (st.errorState && !st.hasLoader) return st;
        return st.paras > 14 ? st : null;
      }, READ_TIMEOUT);
      if (s && s.paras > 14 && !s.errorState) {
        assert(!s.prototypeCopy, 'the reader still says the full text is only available on Project Gutenberg');
        walked.books.push(firstPreview.card.title);
        return `${s.paras} paragraphs from "${firstPreview.card.title}"`;
      }
      failures.push(`${firstPreview.card.title}: ${(s && (s.fullText || '').slice(0, 60)) || 'no content'}`);
      await H.closeAllOverlays(page);
      const skipped = await skipDeckCard(page);
      await sleep(1200);
      const next = await openDeckPreview(page);
      if (!next || !next.pv) break;
      firstPreview = next;
      const go = await clickInOverlay(page, 'read a little|start reading|^read$|data-act="reader"');
      if (!go.ok) break;
      await until(async () => !!(await H.readerState(page)), 60000);
      if (!skipped) break;
    }
    throw new Error(`no deck book yielded a full text within ${READ_TIMEOUT}ms each — ${failures.join(' | ')}`);
  });

  await check('reader: accumulates >=40 distinct paragraphs across page turns', async () => {
    const seen = new Set();
    let stalls = 0;
    for (let i = 0; i < MAX_PAGES && seen.size < 40; i++) {
      const before = await H.readerState(page);
      (before ? (before.texts || []) : []).forEach(t => seen.add(t));
      if (seen.size >= 40) break;
      const r = await H.advanceOnce(page, { settle: Math.min(PAGE_TIMEOUT, 12000) });
      walked.pages++;
      const now = await H.readerState(page);
      (now ? (now.texts || []) : []).forEach(t => seen.add(t));
      if (now && now.endOfBook) break;
      stalls = r.moved ? 0 : stalls + 1;
      if (stalls >= 3) break;
    }
    walked.distinct = seen.size;
    assert(seen.size >= 40,
      `only ${seen.size} distinct paragraphs reachable in ${walked.pages} page turns — the deployed reader is still a preview`);
    return `${seen.size} distinct paragraphs over ${walked.pages} page turn(s)`;
  });

  await check('reader: Next advances and Previous is available', async () => {
    const start = await H.readerState(page);
    const r = await H.advanceOnce(page, { settle: Math.min(PAGE_TIMEOUT, 12000) });
    const after = await H.readerState(page);
    assert(r.moved, 'no next/continue affordance advanced the reader');
    assert(after && `${after.first}|${after.textLen}` !== `${start.first}|${start.textLen}`,
      'the reader showed identical text after advancing');

    const back = await clickInOverlay(page, 'previous|back to|go back|^prev$');
    assert(back.ok, 'no previous/back control in the reader: ' + overlayMiss(back));
    return `advanced to "${((after && (after.chapter || after.first)) || '').slice(0, 40)}", back control "${back.label}"`;
  });

  await check('reader: reaches a true end-of-book marker', async () => {
    let s = await H.readerState(page);
    if (s && s.endOfBook) return String(s.endOfBook).slice(0, 70);
    let stalls = 0;
    for (let i = 0; i < MAX_PAGES; i++) {
      const r = await H.advanceOnce(page, { settle: Math.min(PAGE_TIMEOUT, 12000) });
      walked.pages++;
      s = await H.readerState(page);
      if (s && s.endOfBook) return String(s.endOfBook).slice(0, 70);
      stalls = r.moved ? 0 : stalls + 1;
      if (stalls >= 3) break;
    }
    throw new Error(`no end-of-book marker after ${walked.pages} page turns — the reader never finishes the book`);
  });

  /* ------------------------------------------------- save from the reader */

  await check('reader: a save control adds the book to the shelf', async () => {
    const before = await shelfCount(page);
    let hit = await clickInOverlay(page, 'add to shelf|save|keep');
    for (let i = 0; i < 6 && !hit.ok; i++) {
      await H.advanceOnce(page, { settle: 6000 });
      hit = await clickInOverlay(page, 'add to shelf|save|keep');
    }
    assert(hit.ok, 'no save/add-to-shelf control anywhere in the reading flow: ' + overlayMiss(hit));
    const grew = await until(async () => (await shelfCount(page)) > before, 15000);
    assert(grew, `shelf did not grow after saving from the reader (was ${before}) — the control may already read "On your shelf"`);
    return `shelf ${before} -> ${await shelfCount(page)} via "${hit.label}"`;
  });

  /* -------------------------------------------------- save from a preview */

  await check('preview: "Add to shelf" persists an unsaved book', async () => {
    /* Reset storage so the target book is genuinely not on the shelf yet. */
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: OPEN_TIMEOUT });
    await until(() => page.evaluate(() => !!document.querySelector('.daily-title')), OPEN_TIMEOUT);

    const before = await shelfCount(page);
    let target = null, tries = 0;
    /* Only proceed with a card the preview itself reports as unsaved: a fresh
       profile can be handed a deck card that is already shelved. */
    while (tries < 6) {
      const opened = await openDeckPreview(page);
      if (!opened || !opened.pv) break;
      if (!opened.pv.saved) { target = opened; break; }
      await H.closeAllOverlays(page);
      await skipDeckCard(page);
      await sleep(1000);
      tries++;
    }
    assert(target, `could not find an unsaved deck card after ${tries} tries`);
    const hit = await clickInOverlay(page, 'add to shelf|save|keep');
    assert(hit.ok, 'no add-to-shelf control in the preview: ' + overlayMiss(hit));
    const grew = await until(async () => (await shelfCount(page)) > before, 15000);
    assert(grew, `shelf did not grow after saving from the preview (was ${before})`);
    return `shelf ${before} -> ${await shelfCount(page)} via "${hit.label}" (${target.card.title})`;
  });

  /* ----------------------------------------------------------- hygiene */

  await check('no uncaught page errors during the whole journey', async () => {
    const errs = (page.__errors || []).filter(e => e.kind !== 'request' && String(e.text || '').trim());
    assert(errs.length === 0, `uncaught errors: ${JSON.stringify(errs).slice(0, 500)}`);
    const benign = (page.__errors || []).length;
    return benign ? `0 uncaught (${benign} benign network failure(s) ignored)` : '0 uncaught';
  });

  await browser.close();

  /* ----------------------------------------------------------- summary */

  const failed = results.filter(r => !r.ok);
  const total = results.length;
  console.log(`\n${'-'.repeat(64)}`);
  console.log(`  ${URL_UNDER_TEST}`);
  console.log(`  ${total - failed.length}/${total} checks passed` +
    (failed.length ? `, ${failed.length} FAILED` : '') +
    `  ·  ${(results.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(1)}s` +
    (walked.pages ? `  ·  walked ${walked.pages} page turns` : ''));
  if (failed.length) {
    console.log('\n  Failing checks:');
    for (const f of failed) console.log(`   - ${f.name}\n       ${f.detail.split('\n')[0]}`);
  }
  console.log(`\n  ${failed.length ? 'RESULT: FAIL' : 'RESULT: PASS'}\n`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => {
  console.error(`\n  live verification could not run: ${(e && e.stack) || e}\n`);
  process.exit(2);
});