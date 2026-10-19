'use strict';
/*
 * Florilegium acceptance-test helpers.
 *
 * Owns: static file server (python -m http.server), Edge via puppeteer-core,
 * a 390x844 mobile page, page-error collection and a set of resilient
 * DOM-probing utilities used by tests/e2e.test.js.
 *
 * Environment:
 *   NODE_PATH must point at a folder containing puppeteer-core, e.g.
 *     $env:NODE_PATH="C:\Users\Daniel\AppData\Local\Temp\flori-tools\node_modules"
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.FLORI_PORT || 4181);
const EDGE = process.env.FLORI_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const START_TIMEOUT = Number(process.env.FLORI_SERVER_TIMEOUT || 30000);

/* ------------------------------------------------------------------ server */

function probePort(port) {
  return new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = ok => { if (done) return; done = true; try { sock.destroy(); } catch (e) {} resolve(ok); };
    sock.setTimeout(1500);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
  });
}

async function waitForPort(port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await probePort(port)) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

async function freePortFrom(start, tries = 40) {
  for (let p = start; p < start + tries; p++) {
    if (!(await probePort(p))) return p;
  }
  throw new Error(`no free port in ${start}..${start + tries - 1}`);
}

function sha256(buf) {
  return require('crypto').createHash('sha256').update(buf).digest('hex');
}

/*
 * Starts a static server for ROOT/index.html on its own free port.
 *
 * It deliberately does NOT reuse a busy port. An earlier version did, and a
 * leaked server from an aborted run served a *stale copy* of the app, so the
 * whole suite silently validated the wrong build. The served bytes are now
 * fingerprinted against the working copy and a mismatch is a hard error.
 */
async function startServer() {
  const port = await freePortFrom(PORT);
  const py = process.env.FLORI_PYTHON || 'python';
  const child = spawn(py, ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true
  });
  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    try { child.kill(); } catch (e) {}
  };
  child.on('error', () => {});
  process.once('exit', kill);
  process.once('SIGINT', () => { kill(); process.exit(130); });

  const up = await waitForPort(port, START_TIMEOUT);
  if (!up) {
    kill();
    throw new Error(`static server did not come up on 127.0.0.1:${port} (${py} -m http.server)`);
  }

  const want = sha256(fs.readFileSync(path.join(ROOT, 'index.html')));
  const got = sha256(Buffer.from(await (await fetch(`http://127.0.0.1:${port}/index.html`)).arrayBuffer()));
  if (want !== got) {
    kill();
    throw new Error(
      `static server on 127.0.0.1:${port} is not serving ${path.join(ROOT, 'index.html')} ` +
      `(served sha256 ${got.slice(0, 12)}, expected ${want.slice(0, 12)}). ` +
      `Refusing to run the suite against an unknown build.`
    );
  }

  return { port, root: ROOT, stop: kill };
}

/* --------------------------------------------------------- in-page helpers */
/*
 * Injected on every document (including after reload) so tests can probe the
 * app without depending on one specific internal implementation. Everything
 * degrades gracefully: if the markup changes, the probes still find *something*
 * so assertions fail with a readable message instead of throwing.
 */
const QA_HELPERS = String.raw`window.__QA = (function(){
  function root(){
    var ovs = Array.prototype.slice.call(document.querySelectorAll('[data-overlays] > *'));
    return ovs.filter(function(o){ return o.classList.contains('open') || o.offsetParent !== null; })
             .filter(function(o){ return o.offsetParent !== null; }).pop()
        || ovs.find(function(o){ return /reader/i.test(o.className||''); })
        || ovs[ovs.length-1] || null;
  }
  function readerRoot(){
    var ovs = Array.prototype.slice.call(document.querySelectorAll('[data-overlays] > *'));
    var byClass = ovs.find(function(o){ return /(^|\s|\-)reader(\s|-|$)/i.test(o.className||''); });
    if (byClass) return byClass;
    var byBtn = ovs.find(function(o){ return !!o.querySelector('[data-act="reader-settings"],[aria-label="Reading settings"],[aria-label*="etting"]'); });
    if (byBtn) return byBtn;
    var NOT_READER = /\b(preview|search|browse|sheet)\b/i;
    var visible = ovs.filter(function(o){ return o.offsetParent !== null; });
    var candidates = visible.filter(function(o){ return !NOT_READER.test(o.className||''); });
    return (candidates[ candidates.length-1 ] || visible[visible.length-1] || ovs[ovs.length-1] || null);
  }
  function scrollHost(ov){
    return ov.querySelector('[data-reader-scroll],.reader-scroll,.reader-text,.scroll,[class*="reader"] [class*="scroll"]') || ov;
  }
  function bodyHost(ov){
    return ov.querySelector('[data-reader-body],.reader-body,[data-reader-content],article') || ov;
  }
  function parasOf(host){ return Array.prototype.slice.call(host.querySelectorAll('p')).filter(function(p){ return (p.textContent||'').trim().length>0; }); }

  function sig(s){ if(!s) return 'none'; return [s.paras, s.textLen, s.scrollTop, (s.first||'').slice(0,70), (s.last||'').slice(0,70)].join('|'); }

  /* Terminal-state detector: returns {ok, evidence}.
     Only standalone marker lines, unambiguous end sentences, or an explicit
     terminal block whose own copy agrees. Ordinary prose must never count -
     a real book contained "at the end of the Roman Republic". */
  function endState(ov){
    var body=bodyHost(ov);
    var text=body.innerText||body.textContent||"";
    var MARK=/^(end of (the )?book|the end|finis|fin|\u00a7\s*end of (the )?book|the end of (this|the) (book|edition|text))$/i;
    var lines=String(text).split("\n").map(function(l){return l.trim();}).filter(Boolean);
    for(var i=0;i<lines.length;i++){
      var clean=lines[i].replace(/[\s\u00b7\u2022.\-\u2014:]+$/,"");
      if(MARK.test(clean)) return {ok:true, evidence:lines.slice(i,Math.min(lines.length,i+2)).join(" ").slice(0,90)};
    }
    var sent=/(you have reached the end|that is the end of|reached the end of (this|the) (book|edition|text)|there is nothing (more )?to read)/i.exec(text);
    if(sent) return {ok:true, evidence:sent[0]};
    var term=body.querySelector("[data-reader-end],[data-end-of-book],[data-reader-complete]");
    if(term){
      var t=(term.innerText||term.textContent||"").trim();
      var s2=/(you have reached the end|that is the end|end of (the )?book|the end)/i.exec(t);
      if(s2) return {ok:true, evidence:t.replace(/\s+/g," ").slice(0,90)};
    }
    return {ok:false, evidence:""};
  }
  function readerState(){
    var ov = readerRoot(); if(!ov) return null;
    var body = bodyHost(ov), sc = scrollHost(ov), ps = parasOf(body);
    var text = body.innerText || body.textContent || '';
    var pbar = ov.querySelector('[data-rprog],[data-progress],[class*="progress"] > *');
    var chap = ov.querySelector('[data-chapter],[class*="chapter"],[class*="chapt"]');
    var p0 = ps[0] ? getComputedStyle(ps[0]) : null;
    var bcs = getComputedStyle(body), scs = getComputedStyle(sc);
    return {
      open:true,
      paras:ps.length,
      texts: ps.slice(0,80).map(function(p){ return (p.textContent||'').trim().slice(0,120); }),
      textLen:text.length,
      first:(ps[0]||{}).textContent||'',
      last:(ps.length?ps[ps.length-1].textContent:''),
      scrollTop:sc.scrollTop||0, scrollHeight:sc.scrollHeight||0, clientHeight:sc.clientHeight||0,
      atBottom:((sc.scrollHeight||0)-(sc.clientHeight||0)-(sc.scrollTop||0)) <= 4,
      theme:ov.getAttribute('data-theme')||'',
      progress: pbar ? (pbar.style.width || (pbar.getBoundingClientRect().width+'px')) : null,
      chapter: chap ? ((chap.innerText||'').trim()) : '',
      header: (ov.innerText||'').split('\n').filter(Boolean).slice(0,6).join(' | '),
      buttons: Array.prototype.slice.call(ov.querySelectorAll('button,[data-act],[role="button"]')).map(function(b){
        return { t:((b.innerText||'')+' '+(b.getAttribute('aria-label')||'')).replace(/\s+/g,' ').trim(),
                 act:b.getAttribute('data-act')||'', aria:b.getAttribute('aria-label')||'',
                 val:b.getAttribute('data-value')||'', dis:!!b.disabled };
      }),
      loading: ov.querySelectorAll('.loader,.q-skel').length > 0,
      hasLoader: !!ov.querySelector('.loader'),
      /* NB: match specific error copy only. A bare "quiet" also occurs in
         ordinary prose ("a quiet morning") and produced false positives. */
      errorState: /could not be fetched|pages are quiet|stacks are quiet|failed to load|could not be loaded|did not open/i.test(text),
      errorKind: ov.getAttribute('data-reader-error')||'',
      fullText: text.replace(/\s+/g,' ').slice(0, 700),
      rateLimited: /too many requests|rate.?limit|throttl|slow down|busy right now/i.test(text),
      prototypeCopy: /This prototype shows the opening pages|full text is free at Project Gutenberg/i.test(text),
      /* End-of-book detection must not fire on ordinary prose: a live book
         contained "at the end of the Roman Republic" and tripped an older
         /the end/ pattern three chapters into a 45-chapter novel. Only accept
         standalone marker lines, an explicit terminal block whose own text
         agrees, or an unambiguous end sentence. */
      endOfBook: (function(){
        var e=endState(ov);
        return e.ok ? e.evidence : false;
      })(),
      errorHTML: /could not be fetched|pages are quiet|Try again/i.test(text) ? text.replace(/\s+/g,' ').slice(0,240) : '',
      fontFamily: p0 ? p0.fontFamily : bcs.fontFamily,
      fontSize: p0 ? p0.fontSize : bcs.fontSize,
      padLeft: bcs.paddingLeft,
      lineHeight: p0 ? p0.lineHeight : bcs.lineHeight,
      bg: scs.backgroundColor,
      vars: (function(){ var cs=getComputedStyle(ov); return { size:cs.getPropertyValue('--reader-size').trim(),
                  pad:cs.getPropertyValue('--reader-pad').trim(),
                  font:cs.getPropertyValue('--reader-font').trim() }; })()
    };
  }

  function previewState(){
    var ovs = Array.prototype.slice.call(document.querySelectorAll('[data-overlays] > *'));
    var ov = ovs.filter(function(o){ return o.offsetParent!==null; }).pop();
    if(!ov) return null;
    var box = ov.querySelector('[data-excerpt],.preview-text,[class*="excerpt"],[class*="preview"] [class*="text"]');
    var ps = box ? parasOf(box) : [];
    var btns = Array.prototype.slice.call(ov.querySelectorAll('button')).map(function(b){ return (b.innerText||'').replace(/\s+/g,' ').trim(); });
    return {
      open:true,
      paras:ps.length,
      first:(ps[0]||{}).textContent||'',
      text:(ov.innerText||'').replace(/\s+/g,' '),
      endPreview:/end of preview/i.test(ov.innerText||''),
      hasReadALittle:btns.some(function(t){ return /read a little/i.test(t); }),
      hasAddToShelf:btns.some(function(t){ return /add to shelf|on your shelf/i.test(t); }),
      saved:btns.some(function(t){ return /on your shelf/i.test(t); }),
      loading:!!ov.querySelector('.loader'),
      error:/could not be fetched/i.test(ov.innerText||'')
    };
  }

  function clickIn(rootSel, src, nth){
    var r = document.querySelector(rootSel);
    var scope = r || document;
    var rx = new RegExp(src, 'i');
    var cands = Array.prototype.slice.call(scope.querySelectorAll('button,[data-act],[role="button"],a'))
      .filter(function(e){ return !e.disabled && e.offsetParent !== null; });
    var hit = cands.filter(function(e){
      var t = ((e.innerText||'')+' '+(e.getAttribute('aria-label')||'')+' '+(e.getAttribute('data-act')||'')).replace(/\s+/g,' ');
      return rx.test(t);
    })[nth||0];
    if(!hit) return null;
    hit.click();
    return ((hit.innerText||'').trim()||hit.getAttribute('data-act')||'clicked');
  }

  function clickScrollBottom(){
    var ov = readerRoot(); if(!ov) return false;
    var sc = scrollHost(ov);
    sc.scrollTop = sc.scrollHeight;
    sc.dispatchEvent(new Event('scroll',{bubbles:true}));
    return true;
  }

  function frames(ms){
    return new Promise(function(res){
      var n=0, t0=performance.now();
      (function tick(){ n++; if(performance.now()-t0 < ms) requestAnimationFrame(tick); else res(n); })();
    });
  }

  function readerPresent(){
    var ovs = Array.prototype.slice.call(document.querySelectorAll('[data-overlays] > *'));
    return ovs.some(function(o){
      return /(^|\s|\-)reader(\s|-|$)/i.test(o.className||'')
        || !!o.querySelector('[data-act="reader-settings"],[aria-label="Reading settings"]');
    });
  }

  /* Measured geometry of the controls a thumb has to hit. */
  function touchTargets(){
    var out=[];
    var scope = readerRoot() || root() || document;
    Array.prototype.slice.call(scope.querySelectorAll('[data-act],[role="button"],button,a')).forEach(function(el){
      if(el.getClientRects().length===0) return;
      var r=el.getBoundingClientRect();
      if(!r.width && !r.height) return;
      out.push({
        act: el.getAttribute('data-act')||'',
        label: ((el.innerText||'')+' '+(el.getAttribute('aria-label')||'')).replace(/\s+/g,' ').trim().slice(0,40),
        w: Math.round(r.width*10)/10, h: Math.round(r.height*10)/10
      });
    });
    return out;
  }

  /* For You deck: the visible card plus every card id the deck still holds. */
  function deckState(){
    var el = document.querySelector('[data-screen="foryou"]');
    if(!el) return null;
    var top = el.querySelector('[data-deck-top][data-id]');
    var empty = el.querySelector('.empty');
    return {
      active: !!document.querySelector('.view.view-foryou.active'),
      topId: top ? top.getAttribute('data-id') : null,
      topTitle: top ? ((top.querySelector('.deck-title')||{}).textContent||'') : '',
      loading: !!el.querySelector('.loader'),
      empty: !!empty,
      emptyText: empty ? empty.innerText.replace(/\s+/g,' ').trim() : '',
      emptyActions: empty ? Array.prototype.slice.call(empty.querySelectorAll('button,[data-act]')).map(function(b){ return (b.innerText||'').trim(); }) : [],
      rows: Array.prototype.slice.call(el.querySelectorAll('[data-act="preview"][data-id]')).map(function(r){ return r.getAttribute('data-id'); }),
      note: (el.querySelector('.deck-note')||{}).textContent||''
    };
  }

  /* Shelf contents as the UI reports them, not as storage does. */
  function shelfState(){
    var el = document.querySelector('[data-screen="shelf"]');
    if(!el) return null;
    return {
      count: ((el.querySelector('.count-large')||{}).textContent||''),
      rows: Array.prototype.slice.call(el.querySelectorAll('[data-act="preview"][data-id]')).map(function(r){
        return { id: r.getAttribute('data-id'), text: r.innerText.replace(/\s+/g,' ').trim() };
      }),
      tabs: Array.prototype.slice.call(el.querySelectorAll('[data-act="shelf-filter"]')).map(function(b){
        return { f: b.getAttribute('data-filter'), text: (b.innerText||'').replace(/\s+/g,' ').trim() };
      })
    };
  }

  return { root:root, readerRoot:readerRoot, scrollHost:scrollHost, bodyHost:bodyHost,
           parasOf:parasOf, sig:sig, readerState:readerState, previewState:previewState,
           readerPresent:readerPresent, touchTargets:touchTargets, deckState:deckState, shelfState:shelfState,
           clickIn:clickIn, clickScrollBottom:clickScrollBottom, frames:frames };
})();`;

/* --------------------------------------------------------------- page setup */

/* Page-level noise that is not an app defect. */
const IGNORED_ERROR = /Failed to load resource|net::ERR|NS_ERROR|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_INTERNET_DISCONNECTED|ERR_CERT|status of 4\d\d|status of 5\d\d|The server responded/i;

function isRealError(text) {
  if (!text) return false;
  return !IGNORED_ERROR.test(text);
}

async function launchBrowser(overrides = {}) {
  const puppeteer = require('puppeteer-core');
  return puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--disable-features=Translate,MediaRouter'
    ],
    defaultViewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    protocolTimeout: 300000,
    ...overrides
  });
}

async function newPage(browser) {
  const page = await browser.newPage();
  page.setDefaultTimeout(Number(process.env.FLORI_WAIT || 30000));
  page.setDefaultNavigationTimeout(60000);
  await page.evaluateOnNewDocument(QA_HELPERS);
  const errors = [];
  page.on('pageerror', e => errors.push({ kind: 'pageerror', text: String(e && e.message || e) }));
  page.on('console', m => {
    if (m.type() === 'error' && isRealError(m.text())) errors.push({ kind: 'console', text: m.text() });
  });
  page.on('requestfailed', r => {
    const t = r.failure() && r.failure().errorText || '';
    if (isRealError(t)) errors.push({ kind: 'request', text: `${t} ${r.url()}` });
  });
  page.__errors = errors;
  return page;
}

async function gotoApp(page, server) {
  await page.goto(`http://127.0.0.1:${server.port}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__QA && document.querySelector('[data-screen="home"] .daily-title'), { timeout: 30000 });
}

async function reload(page, server) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__QA && document.querySelector('[data-screen="home"] .daily-title'), { timeout: 30000 });
}

async function seedLocalState(page, state) {
  await page.evaluate(s => {
    try { localStorage.setItem('florilegium.mono.v1', JSON.stringify(s)); } catch (e) {}
  }, state);
}

const SHELF_SEED = {
  shelf: [
    { bookId: 1342, book: { id: 1342, title: 'Pride and Prejudice', author: 'Jane Austen', subjects: ['Romance'], downloads: 190246, cover: 'https://www.gutenberg.org/cache/epub/1342/pg1342.cover.medium.jpg', textUrl: 'https://www.gutenberg.org/files/1342/1342-0.txt' }, status: 'reading', addedAt: 4000 },
    { bookId: 1661, book: { id: 1661, title: 'The Adventures of Sherlock Holmes', author: 'Arthur Conan Doyle', subjects: ['Detective fiction'], downloads: 62140, cover: 'https://www.gutenberg.org/cache/epub/1661/pg1661.cover.medium.jpg', textUrl: 'https://www.gutenberg.org/files/1661/1661-0.txt' }, status: 'to-read', addedAt: 3000 },
    { bookId: 345, book: { id: 345, title: 'Dracula', author: 'Bram Stoker', subjects: ['Horror'], downloads: 55488, cover: 'https://www.gutenberg.org/cache/epub/345/pg345.cover.medium.jpg', textUrl: 'https://www.gutenberg.org/files/345/3450.txt' }, status: 'to-read', addedAt: 2000 },
    { bookId: 11, book: { id: 11, title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll', subjects: ['Fantasy'], downloads: 121623, cover: 'https://www.gutenberg.org/cache/epub/11/pg11.cover.medium.jpg', textUrl: 'https://www.gutenberg.org/files/11/11-0.txt' }, status: 'finished', addedAt: 1000 }
  ],
  settings: { theme: 'paper', family: 'serif', size: 18, margin: 1 }
};

/* ------------------------------------------------------------- interactions */

const nav = (page, view) =>
  page.evaluate(v => {
    const b = document.querySelector(`.tab[data-view="${v}"]`);
    if (!b) return false;
    b.click(); return true;
  }, view);

const clickIn = (page, rootSel, src, nth = 0) =>
  page.evaluate((r, s, n) => window.__QA.clickIn(r, s, n), rootSel, src, nth);

const readerState = page => page.evaluate(() => window.__QA.readerState());
const previewState = page => page.evaluate(() => window.__QA.previewState());

/*
 * Opens the reader for a given book id, deterministically.
 * Preferred path: shelf row -> preview sheet -> "Read a little".
 * Falls back to any [data-act="reader"] control carrying the id.
 */
async function openReaderById(page, id) {
  const viaCta = await page.evaluate(i => {
    const b = document.querySelector(`[data-act="reader"][data-id="${i}"]`);
    if (!b) return false;
    b.click(); return true;
  }, id);
  if (viaCta) {
    const ok = await page.waitForFunction(() => !!window.__QA.readerState(), { timeout: 20000 }).then(() => true).catch(() => false);
    if (ok) return true;
  }

  // Via the shelf: row -> preview -> Read a little.
  const rowOpened = await page.evaluate(i => {
    const scope = document.querySelector('.view.view-shelf.active') || document;
    const r = scope.querySelector(`[data-act="preview"][data-id="${i}"]`);
    if (!r) return false;
    r.click(); return true;
  }, id);
  if (!rowOpened) return false;
  const previewUp = await page.waitForFunction(() => (window.__QA.previewState() || {}).open === true, { timeout: 15000 })
    .then(() => true).catch(() => false);
  if (!previewUp) return false;

  const started = await page.evaluate(() => {
    const ov = window.__QA.root(); if (!ov) return false;
    const b = Array.from(ov.querySelectorAll('button,[data-act]'))
      .filter(x => !x.disabled)
      .find(x => /read a little|start reading|^read\b/i.test(x.innerText || ''));
    if (!b) return false; b.click(); return true;
  });
  if (!started) return false;
  return page.waitForFunction(() => !!window.__QA.readerState(), { timeout: 30000 }).then(() => true).catch(() => false);
}

/** Closes every open overlay (Escape is the app's universal dismiss). */
async function closeAllOverlays(page) {
  for (let i = 0; i < 6; i++) {
    const has = await page.evaluate(() => {
      const ovs = Array.from(document.querySelectorAll('[data-overlays] > *'));
      return ovs.some(o => o.offsetParent !== null);
    });
    if (!has) break;
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 450));
  }
}

/*
 * One "turn the page" action. Tries, in order:
 *   1. a next/continue affordance inside the reader
 *   2. keyboard paging
 *   3. scrolling the reading surface to the end
 * Returns { moved, how, before, after }.
 */
async function advanceOnce(page, { settle = 2500 } = {}) {
  const before = await page.evaluate(() => window.__QA.readerState());
  if (!before) return { moved: false, how: 'no-reader', before: null, after: null };

  const sig = s => `${s.paras}|${s.textLen}|${s.scrollTop}|${(s.first || '').slice(0, 70)}|${(s.last || '').slice(0, 70)}`;

  let how = null;
  const label = await page.evaluate(() => {
    const ov = window.__QA.readerRoot(); if (!ov) return null;
    const rx = /next|continue|read more|more pages|forward|turn page|^more$|\u203a|\u2192|page down|下/i;
    const bs = Array.from(ov.querySelectorAll('button,[data-act],[role="button"]'))
      .filter(b => !b.disabled && b.offsetParent !== null && b.getAttribute('data-act') !== 'close');
    const el = bs.find(b => rx.test(((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-act') || '')).replace(/\s+/g, ' ')));
    if (!el) return null;
    el.click();
    return (el.innerText || '').trim() || el.getAttribute('data-act') || el.getAttribute('aria-label') || 'button';
  });
  if (label) how = `button(${label})`;

  if (!how) {
    await page.keyboard.press('ArrowRight');
    await new Promise(r => setTimeout(r, 100));
    await page.keyboard.press('PageDown');
    how = 'keyboard';
  }

  let moved = false;
  const deadline = Date.now() + settle;
  while (Date.now() < deadline) {
    const now = await page.evaluate(() => window.__QA.readerState());
    if (now && sig(now) !== sig(before)) { moved = true; break; }
    if (!how) {
      await page.evaluate(() => window.__QA.clickScrollBottom());
      how = 'scroll';
    }
    await new Promise(r => setTimeout(r, 180));
  }
  const after = await page.evaluate(() => window.__QA.readerState());
  return { moved, how, before, after };
}

/* A shelf whose books deliberately do NOT exist in FALLBACK_BOOKS or in the
   mocked Gutendex catalogue. Used by the save tests so that whatever the For You
   deck offers is guaranteed not to be on the shelf yet (the real app's deck can
   contain shelf books when the catalogue is small). */
const SAVE_SEED = {
  shelf: [
    { bookId: 900001, book: { id: 900001, title: 'Shelf Fixture One', author: 'A. Tester', subjects: ['Fiction'], downloads: 1000, cover: null, textUrl: 'https://www.gutenberg.org/cache/epub/900001/pg900001.txt' }, status: 'reading', addedAt: 2 },
    { bookId: 900002, book: { id: 900002, title: 'Shelf Fixture Two', author: 'B. Tester', subjects: ['Fiction'], downloads: 2000, cover: null, textUrl: 'https://www.gutenberg.org/cache/epub/900002/pg900002.txt' }, status: 'to-read', addedAt: 1 }
  ],
  settings: { theme: 'paper', family: 'serif', size: 18, margin: 1 }
};

module.exports = {
  ROOT, PORT, EDGE,
  startServer, launchBrowser, newPage, gotoApp, reload,
  seedLocalState, SHELF_SEED, SAVE_SEED,
  nav, clickIn, readerState, previewState, openReaderById, closeAllOverlays, advanceOnce,
  isRealError
};