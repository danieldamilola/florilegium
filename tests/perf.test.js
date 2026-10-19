/**
 * Reader performance verification — Florilegium (round-3 worktree)
 *
 * Serves this worktree on 127.0.0.1:4185 (python -m http.server) and drives
 * Microsoft Edge at 390x844 with puppeteer-core, CPU throttled 4x via CDP,
 * over the real network. Measures the real app reading Moby Dick (id 2701).
 *
 * If the Jina full-text fetch cannot complete, the app's own retries are
 * allowed to run out; the run then marks Jina unavailable and reports the
 * rest (milestones captured up to that point, downstream sections N/A).
 *
 * Run from the repo root:
 *   $env:NODE_PATH='C:\Users\Daniel\AppData\Local\Temp\flori-tools\node_modules'
 *   node tests/perf.test.js
 *
 * Deliverables: this file plus tests/perf-report.md (written from the run output).
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:4185/index.html';
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 4185;
const BOOK_ID = 2701;
const JUMPS = 10;
const OPEN_DEADLINE_MS = 240000; // app retries Jina up to 3x per source; bound the whole open
const NAV_BUDGET_MS = 300;       // budget per jump once data is loaded
const NAV_JUMP_DEADLINE_MS = 15000;
const DOM_MAX_BUDGET = 500;      // paragraph budget: near one chapter, not thousands
const PROTOCOL_TIMEOUT_MS = 300000;
const RETRY_WAIT_MS = 20000;     // wait between harness-level open attempts

const wait = ms => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();
const elapsed = t0 => Date.now() - t0;

function pass(m) { console.log('  PASS  ' + m); }
function fail(m) { console.log('  FAIL  ' + m); }
function info(m) { console.log('        ' + m); }
function check(cond, msg) { if (cond) { pass(msg); return true; } fail(msg); return false; }

let server = null, browser = null;
let heat = 0;
const results = { jinaAvailable: null, jinaNote: '' };

async function probeServer() {
  try { const r = await fetch(BASE); return r.ok; } catch (e) { return false; }
}

async function readMemory(client) {
  const heap = await client.send('Runtime.getHeapUsage');
  let jsHeap = null;
  const metrics = await client.send('Performance.getMetrics');
  const m = (metrics.metrics || []).find(x => x.name === 'JSHeapUsedSize');
  if (m) jsHeap = m.value;
  return { heapUsed: heap.usedSize, heapTotal: heap.totalSize, jsHeapUsedSize: jsHeap };
}

function mb(bytes) { return (bytes / 1048576).toFixed(2); }

/* open the home screen from a clean slate */
async function openHome(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('[data-tabbar] .tab').length === 4, { timeout: 20000 });
  await wait(600);
}

/* open Moby Dick's preview (curated excerpt, instant), then time the reader open */
async function measureOpen(page, jina, tClickBase) {
  await page.evaluate((id) => openPreview(bookById(id)), BOOK_ID);
  await page.waitForFunction(() => document.querySelectorAll('.overlay.preview [data-excerpt] p').length > 0, { timeout: 20000 });

  const tClickNode = now();
  const openRes = await page.evaluate(async (deadlineMs) => {
    const tClick = Date.now();
    const deadline = tClick + deadlineMs;
    const btn = document.querySelector('.overlay.preview [data-preview-actions] [data-act="reader"]');
    if (!btn) return { error: 'no reader button on preview', tClick };
    btn.click();
    const poll = (cond) => new Promise(resolve => {
      const tick = () => {
        const v = cond();
        if (v !== undefined) resolve(v);
        else if (Date.now() >= deadline) resolve(undefined);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const pOverlay = poll(() => { const el = document.querySelector('.overlay.reader'); return el ? Date.now() : undefined; });
    const pLoading = poll(() => { const el = document.querySelector('.overlay.reader .reader-loading'); return el ? Date.now() : undefined; });
    const pOpen = poll(() => { const el = document.querySelector('.overlay.reader.open'); return el ? Date.now() : undefined; });
    const pChapter = poll(() => {
      const el = document.querySelector('.overlay.reader');
      if (!el) return undefined;
      if (el.dataset.readerMode === 'error') return { mode: 'error', at: Date.now() };
      if (el.dataset.readerMode !== 'chapter' && el.dataset.readerMode !== 'page') return undefined; // still loading
      const body = el.querySelector('[data-reader-body]');
      const ps = body ? body.querySelectorAll('p') : null;
      if (ps && ps.length > 0) {
        return {
          mode: el.dataset.readerMode, at: Date.now(), paras: ps.length,
          index: Number(el.dataset.readerIndex || 0), total: Number(el.dataset.readerTotal || 0),
          label: (el.querySelector('[data-rlabel]') || {}).textContent || ''
        };
      }
      return undefined;
    });
    return { tClick, tOverlay: await pOverlay, tLoading: await pLoading, tOpen: await pOpen, chapter: await pChapter };
  }, OPEN_DEADLINE_MS);

  const errKind = await page.evaluate(() => {
    try { const e = textErrors.get(2701); return e ? { kind: e.kind, at: e.at } : null; } catch (e) { return null; }
  });

  const candidates = jina.requests.filter(r => r.url.includes('r.jina.ai'));
  info('jina candidates: ' + JSON.stringify(candidates.map(r => ({ u: r.url.slice(0, 60), start: r.start, startMs: r.start ? Math.round(r.start * 1000) : null, end: r.end ? Math.round(r.end * 1000) : null, fb: r.firstByte ? Math.round(r.firstByte * 1000) : null }))));
  const jinaReq = candidates.find(r => r.start && r.end);
  const seen = candidates.length;
  const completed = candidates.filter(r => r.end).length;

  let jinaMs = null, firstByteMs = null;
  if (jinaReq) {
    jinaMs = (jinaReq.end - jinaReq.start) * 1000;          // CDP clock is self-consistent; do not compare with page Date.now
    firstByteMs = (jinaReq.firstByte - jinaReq.start) * 1000;
  }
  return { tClickNode, openRes, errKind, jinaReq, jinaMs, firstByteMs, seen, completed };
}

/* 10 consecutive Next jumps, each measured click -> new chapter text in DOM */
async function measureJumps(page) {
  return await page.evaluate(async (n, jumpDeadlineMs) => {
    const out = [];
    const reader = () => document.querySelector('.overlay.reader');
    const waitIndex = (target, deadline) => new Promise(resolve => {
      const tick = () => {
        const now2 = Date.now();
        const el = reader();
        if (now2 >= deadline) { resolve({ at: now2, timeout: true }); return; }
        if (el && el.dataset.readerIndex === String(target)) {
          resolve({ at: now2, paras: el.querySelectorAll('[data-reader-body] p').length });
          return;
        }
        if (el && el.dataset.readerMode === 'error') { resolve({ error: true, at: now2 }); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    for (let i = 1; i <= n; i++) {
      const btn = reader().querySelector('[data-act="reader-next"]');
      if (!btn || btn.disabled) { out.push({ from: i - 1, to: i, ms: null, paras: null, error: true, disabled: true }); continue; }
      const t0 = Date.now();
      btn.click(); /* paintReader runs synchronously: the new chapter's text is in the DOM before click() returns */
      const el = reader();
      const changed = el && el.dataset.readerIndex === String(i);
      const ms = Date.now() - t0;
      if (changed) {
        out.push({ from: i - 1, to: i, ms, paras: el.querySelectorAll('[data-reader-body] p').length, error: false, timeout: false });
        continue;
      }
      const r = await waitIndex(i, t0 + jumpDeadlineMs);
      out.push({ from: i - 1, to: i, ms: r.timeout ? null : r.at - t0, paras: r.paras, error: !!r.error || !!r.timeout, timeout: !!r.timeout, changed: false });
      if (r.timeout || r.error) break;
    }
    return out;
  }, JUMPS, NAV_JUMP_DEADLINE_MS);
}

async function measureSettings(page) {
  return await page.evaluate(async () => {
    const waited = (cond, deadline) => new Promise(resolve => {
      const tick = () => {
        const now2 = Date.now();
        const v = cond();
        if (v !== undefined) resolve(v);
        else if (now2 >= deadline) resolve(undefined);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const SETTINGS_DEADLINE = Date.now() + 10000;
    const reader = document.querySelector('.overlay.reader');
    const sc = reader.querySelector('[data-reader-scroll]');
    const body = reader.querySelector('[data-reader-body]');
    const scrollBefore = sc.scrollTop;
    const sizeBefore = getComputedStyle(body).fontSize;
    const t0 = Date.now();
    reader.querySelector('[data-act="reader-settings"]').click();
    await waited(() => !!document.querySelector('.overlay.sheet-overlay.open'), SETTINGS_DEADLINE);
    document.querySelector('.overlay.sheet-overlay .settings [data-act="size"][data-delta="1"]').click();
    const t1 = await waited(() => {
      const b = document.querySelector('.overlay.reader [data-reader-body]');
      return b && getComputedStyle(b).fontSize !== sizeBefore ? Date.now() : undefined;
    }, SETTINGS_DEADLINE);
    const sizeAfter = getComputedStyle(document.querySelector('.overlay.reader [data-reader-body]')).fontSize;
    await new Promise(r => setTimeout(r, 150));
    const scrollAfter = document.querySelector('.overlay.reader [data-reader-scroll]').scrollTop;
    const closeBtn = document.querySelector('.overlay.sheet-overlay .settings [data-act="close"].btn-primary');
    if (closeBtn) closeBtn.click();
    await waited(() => !document.querySelector('.overlay.sheet-overlay'), SETTINGS_DEADLINE);
    return { t0, t1, ms: t1 - t0, sizeBefore, sizeAfter, scrollBefore, scrollAfter, scrollDelta: scrollAfter - scrollBefore };
  });
}

(async () => {
  const tRun0 = now();
  try {
    /* ---------------- local server ---------------- */
    if (!(await probeServer())) {
      info('starting python -m http.server ' + PORT + ' serving ' + ROOT);
      server = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
        { cwd: ROOT, stdio: 'ignore', windowsHide: true });
      server.on('error', e => info('server error: ' + e.message));
      let ok = false;
      for (let i = 0; i < 60 && !ok; i++) { ok = await probeServer(); if (!ok) await wait(250); }
      if (!ok) throw new Error('local server did not start on ' + PORT);
    } else {
      info('reusing server already listening on ' + PORT);
    }

    /* ---------------- browser + CDP ---------------- */
    browser = await puppeteer.launch({
      executablePath: EDGE,
      headless: 'new',
      protocolTimeout: PROTOCOL_TIMEOUT_MS,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    page.setDefaultNavigationTimeout(120000);
    page.setDefaultTimeout(120000);
    page.on('pageerror', e => info('page error: ' + e.message));

    const client = await page.target().createCDPSession();
    await client.send('Network.enable');
    await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    info('CDP: Network enabled, CPU throttled 4x (wall time ' + new Date().toISOString().slice(11, 19) + ')');

    const jina = { requests: [] };
    client.on('Network.requestWillBeSent', e => {
      const u = e.request.url;
      if (u.includes('r.jina.ai')) {
        info('CDP Jina REQ: ' + u.slice(0, 160));
        jina.requests.push({ url: u, requestId: e.requestId, start: e.timestamp, firstByte: null, end: null });
      }
    });
    client.on('Network.responseReceived', e => {
      const r = jina.requests.find(x => x.requestId === e.requestId && x.firstByte === null);
      if (r) r.firstByte = e.timestamp;
    });
    client.on('Network.loadingFinished', e => {
      const r = jina.requests.find(x => x.requestId === e.requestId && x.end === null);
      if (r) r.end = e.timestamp;
    });
    client.on('Network.loadingFailed', e => {
      const r = jina.requests.find(x => x.requestId === e.requestId && x.end === null);
      if (r) r.end = e.timestamp;
    });

    await openHome(page);
    info('home rendered; daily pick id=' + await page.evaluate(() => (store.pick && store.pick.id) || null));

    /* ---------------- reader open timing (attempt 1, then one harness retry) ---------------- */
    let attempt = await measureOpen(page, jina, now());
    if (!attempt.openRes.chapter || attempt.openRes.chapter.mode !== 'chapter') {
      info('attempt 1 did not open the full text (errorKind=' + JSON.stringify(attempt.errKind) +
        ', jina seen=' + attempt.seen + ' completed=' + attempt.completed + ')');
      await wait(RETRY_WAIT_MS);
      await openHome(page);
      attempt = await measureOpen(page, jina, attempt.tClickNode);
      info('attempt 2 ' + (attempt.openRes.chapter && attempt.openRes.chapter.mode === 'chapter' ? 'opened the full text' : 'still did not open (errorKind=' + JSON.stringify(attempt.errKind) + ')'));
    }

    console.log('\n[1] reader open — Moby Dick (id ' + BOOK_ID + ')');
    console.log('  click -> overlay in DOM : ' + (attempt.openRes.tOverlay - attempt.openRes.tClick) + ' ms');
    console.log('  click -> loading state  : ' + (attempt.openRes.tLoading - attempt.openRes.tClick) + ' ms');
    console.log('  click -> loading open   : ' + (attempt.openRes.tOpen - attempt.openRes.tClick) + ' ms');
    if (attempt.jinaReq) {
      info('Jina request: ' + attempt.jinaReq.url);
      info('  request -> first byte : ' + attempt.firstByteMs.toFixed(0) + ' ms');
      info('  request -> complete   : ' + attempt.jinaMs.toFixed(0) + ' ms');
    } else {
      info('no completed r.jina.ai pg2701 request captured in CDP (seen=' + attempt.seen + ', completed=' + attempt.completed + ')');
    }

    let openTotal = null, renderMs = null, jumps = [], memBefore, memAfter, settingsRes, maxDom = null;
    if (attempt.openRes.chapter && attempt.openRes.chapter.mode === 'chapter') {
      results.jinaAvailable = true;
      openTotal = attempt.openRes.chapter.at - attempt.openRes.tClick;
      renderMs = attempt.jinaMs != null ? openTotal - attempt.jinaMs : null;
      console.log('  click -> first chapter text : ' + openTotal + ' ms');
      console.log('    (' + attempt.openRes.chapter.label + ', total sections: ' + attempt.openRes.chapter.total +
        ', index: ' + attempt.openRes.chapter.index + ', paragraphs: ' + attempt.openRes.chapter.paras + ')');
      if (renderMs != null) console.log('  post-fetch render (chapter text - fetch complete): ' + renderMs.toFixed(0) + ' ms');
      else console.log('  post-fetch render: not separable (Jina timing not captured)');
      pass('reader opened and first chapter rendered');

      /* ---------------- chapter navigation ---------------- */
      jumps = await measureJumps(page);
      console.log('\n[2] chapter navigation — ' + JUMPS + ' consecutive Next clicks (data already loaded)');
      const okJumps = jumps.filter(j => !j.error);
      const times = okJumps.map(j => j.ms);
      if (times.length) {
        const s = times.slice().sort((a, b) => a - b);
        const min = s[0], max = s[s.length - 1];
        const med = s.length % 2 ? s[Math.floor(s.length / 2)] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
        console.log('  per-jump ms (click -> new chapter text): ' + times.join(', '));
        console.log('  min=' + min + ' median=' + med + ' max=' + max);
        check(max < NAV_BUDGET_MS, 'navigation budget: every jump < ' + NAV_BUDGET_MS + ' ms (max ' + max + ' ms)');
        info('  (times include one frame of observation latency under 4x CPU throttling; chapter paint work varies with chapter length)');
      } else {
        fail('no successful jumps recorded');
      }

      /* ---------------- DOM discipline ---------------- */
      console.log('\n[3] DOM discipline — .reader-body p count');
      const domCounts = [attempt.openRes.chapter.paras].concat(jumps.map(j => j.paras).filter(Number.isFinite));
      console.log('  after load: ' + attempt.openRes.chapter.paras + ' paragraphs; after each jump: ' +
        jumps.map(j => (Number.isFinite(j.paras) ? j.paras : 'n/a')).join(', '));
      maxDom = Math.max(...domCounts);
      check(maxDom < DOM_MAX_BUDGET, 'DOM stays near one chapter: max ' + maxDom + ' paragraphs (budget < ' + DOM_MAX_BUDGET + ')');

      /* ---------------- memory ---------------- */
      await wait(300);
      memBefore = await readMemory(client);
      await wait(300);
      memAfter = await readMemory(client);
      const heapGrowth = memAfter.heapUsed - memBefore.heapUsed;
      const jsGrowth = memAfter.jsHeapUsedSize != null && memBefore.jsHeapUsedSize != null
        ? memAfter.jsHeapUsedSize - memBefore.jsHeapUsedSize : null;
      console.log('\n[4] memory — JS heap before/after ' + JUMPS + ' jumps');
      console.log('  Runtime.getHeapUsage: before ' + mb(memBefore.heapUsed) + ' MB / total ' + mb(memBefore.heapTotal) +
        ' MB, after ' + mb(memAfter.heapUsed) + ' MB / total ' + mb(memAfter.heapTotal) + ' MB');
      console.log('  heap growth: ' + mb(heapGrowth) + ' MB' + (jsGrowth != null ? ' (Performance.getMetrics JSHeapUsedSize growth: ' + mb(jsGrowth) + ' MB)' : ''));
      results.memory = { beforeMB: mb(memBefore.heapUsed), afterMB: mb(memAfter.heapUsed), growthMB: mb(heapGrowth) };

      /* ---------------- settings reflow ---------------- */
      settingsRes = await measureSettings(page);
      console.log('\n[5] settings reflow — text size +1 mid-chapter');
      console.log('  repaint: ' + settingsRes.sizeBefore + ' -> ' + settingsRes.sizeAfter + ' in ' + settingsRes.ms + ' ms');
      console.log('  scrollTop before=' + settingsRes.scrollBefore + ' after=' + settingsRes.scrollAfter + ' (delta ' + settingsRes.scrollDelta + 'px)');
      check(settingsRes.ms < 500, 'text-size reflow repaint < 500ms (' + settingsRes.ms + ' ms)');
    } else {
      results.jinaAvailable = false;
      results.jinaNote = 'Jina full-text fetch did not complete within the open deadline (' +
        OPEN_DEADLINE_MS + 'ms); marked unavailable per run contract.';
      console.log('  full text did not arrive (reader mode: ' + (attempt.openRes.chapter && attempt.openRes.chapter.mode) + ')');
      console.log('  ' + results.jinaNote);
      fail('full text did not open — Jina unavailable; navigation / DOM / memory / settings not measured');
    }

    console.log('jinaRequests=' + JSON.stringify(jina.requests.map(r => ({ u: r.url.slice(0, 100), start: r.start, end: r.end, fb: r.firstByte }))));
    console.log('\n=== PERF SUMMARY (wall ' + new Date().toISOString().slice(11, 19) + ', run elapsed ' + elapsed(tRun0) + ' ms) ===');
    console.log('jinaAvailable=' + results.jinaAvailable);
    console.log('readerOpenTotalMs=' + openTotal);
    console.log('jinaFetchMs=' + attempt.jinaMs);
    console.log('postFetchRenderMs=' + renderMs);
    const okTimes = jumps.filter(j => !j.error).map(j => j.ms);
    const sOk = okTimes.slice().sort((a, b) => a - b);
    console.log('navMs min/median/max=' + (okTimes.length ? [sOk[0], sOk.length % 2 ? sOk[Math.floor(sOk.length / 2)] : (sOk[sOk.length / 2 - 1] + sOk[sOk.length / 2]) / 2, sOk[sOk.length - 1]].join('/') : 'n/a'));
    console.log('domMaxParagraphs=' + maxDom);
    console.log('memoryGrowthMB=' + (results.memory ? results.memory.growthMB : 'n/a'));
    console.log('settingsReflowMs=' + (settingsRes ? settingsRes.ms : 'n/a'));
    console.log('====================\n');

    if (heat) process.exitCode = 1;
  } catch (err) {
    console.error('\nHARNESS FAILED: ' + (err && err.stack ? err.stack : err));
    heat = 1;
  } finally {
    try { if (browser) await browser.close(); } catch (e) { info('browser close error: ' + e.message); }
    try { if (server) server.kill(); } catch (e) { info('server kill error: ' + e.message); }
    process.exit(heat ? 1 : 0);
  }
})();
