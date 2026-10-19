/**
 * Full-book reading test — Florilegium
 *
 * Serves this worktree on 127.0.0.1:4180 (python -m http.server) and drives
 * Microsoft Edge at 390x844 with puppeteer-core.
 *
 * Run from the repo root:
 *   $env:NODE_PATH='C:\Users\Daniel\AppData\Local\Temp\flori-tools\node_modules'
 *   node tests/full-book.test.js
 */
'use strict';
const {spawn}=require('child_process');
const path=require('path');
const puppeteer=require('puppeteer-core');

const ROOT=path.resolve(__dirname,'..');
const BASE='http://127.0.0.1:4180/index.html';
const EDGE=process.env.EDGE_PATH||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT=4180;

const wait=ms=>new Promise(r=>setTimeout(r,ms));
function pass(msg){console.log('  PASS  '+msg);}
function info(msg){console.log('        '+msg);}
function assert(cond,msg){if(!cond)throw new Error('ASSERT FAILED: '+msg);pass(msg);}

async function serverUp(){
  try{const r=await fetch(BASE);return r.ok;}catch(e){return false;}
}
async function waitServer(ms=15000){
  const end=Date.now()+ms;
  while(Date.now()<end){if(await serverUp())return true;await wait(250);}
  return false;
}
async function waitReader(page,{timeout=120000,not='loading'}={}){
  await page.waitForFunction(n=>{
    const el=document.querySelector('.overlay.reader');
    return !!(el&&el.dataset.readerMode&&el.dataset.readerMode!==n);
  },{timeout,polling:200},not);
}
const readerState=page=>page.evaluate(()=>{
  const el=document.querySelector('.overlay.reader');
  if(!el)return null;
  return {
    mode:el.dataset.readerMode,
    total:Number(el.dataset.readerTotal||0),
    index:Number(el.dataset.readerIndex||0),
    label:(el.querySelector('[data-rlabel]')||{}).textContent||'',
    theme:el.dataset.theme,
    paras:el.querySelectorAll('[data-reader-body] p').length,
    first:(el.querySelector('[data-reader-body] p')||{}).textContent||'',
    nextDisabled:!!(el.querySelector('[data-act="reader-next"]')||{}).disabled,
    prevDisabled:!!(el.querySelector('[data-act="reader-prev"]')||{}).disabled,
    barWidth:(el.querySelector('[data-rprog]')||{}).style.width||'0%',
    endVisible:!!el.querySelector('[data-reader-end]'),
    endText:(el.querySelector('[data-reader-end]')||{}).textContent||'',
    errorKind:el.dataset.readerError||'',
    fontSize:getComputedStyle(el.querySelector('[data-reader-body]')).fontSize
  };
});
/* Hard DOM-isolation probe: only the current section may be in the DOM, never
   the whole book. Compared against the live section and the full block count. */
const domIsolation=page=>page.evaluate(()=>{
  const el=document.querySelector('.overlay.reader');
  if(!el||!el._reader)return null;
  const st=el._reader;
  const sec=(st.sections&&st.sections[st.index])||{paras:[]};
  return {
    rendered:el.querySelectorAll('[data-reader-body] p').length,
    section:(sec.paras||[]).length,
    total:(st.blocks||[]).length
  };
});

(async()=>{
  let server=null,browser=null;
  const pageErrors=[],consoleErrors=[];
  let heat=0;
  try{
    if(!(await serverUp())){
      info('starting python -m http.server '+PORT);
      server=spawn('python',['-m','http.server',String(PORT),'--bind','127.0.0.1'],{cwd:ROOT,stdio:'ignore',windowsHide:true});
      server.on('error',e=>info('server error: '+e.message));
      if(!(await waitServer()))throw new Error('local server did not start on '+PORT);
    }else{
      info('reusing server already listening on '+PORT);
    }
    info('serving '+ROOT);

    browser=await puppeteer.launch({
      executablePath:EDGE,
      headless:true,
      args:['--no-sandbox','--disable-dev-shm-usage','--hide-scrollbars']
    });
    const page=await browser.newPage();
    await page.setViewport({width:390,height:844,deviceScaleFactor:1});
    page.on('pageerror',e=>pageErrors.push(String(e&&e.message||e)));
    page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});

    await page.goto(BASE,{waitUntil:'domcontentloaded'});
    /* clean slate so persisted positions cannot affect the run */
    await page.evaluate(()=>{try{localStorage.clear();}catch(e){}});
    await page.reload({waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>document.querySelectorAll('[data-tabbar] .tab').length===4,{timeout:20000});
    await wait(600);

    /* ---------------------------------------------------------------
       1. Preview stays a teaser: 3 paragraphs + END OF PREVIEW
    --------------------------------------------------------------- */
    console.log('\n[1] preview');
    await page.evaluate(()=>openPreview(bookById(1342)));
    await page.waitForFunction(()=>document.querySelectorAll('.overlay.preview [data-excerpt] p').length>0,{timeout:20000});
    const preview=await page.evaluate(()=>{
      const el=document.querySelector('.overlay.preview');
      return {
        paras:el.querySelectorAll('[data-excerpt] p').length,
        end:(el.querySelector('.preview-end .kicker')||{}).textContent||'',
        readerLabel:(el.querySelector('[data-act="reader"]')||{}).textContent||'',
        hasReaderBtn:!!el.querySelector('[data-act="reader"]')
      };
    });
    assert(preview.paras===3,'preview shows exactly 3 paragraphs (got '+preview.paras+')');
    assert(/end of preview/i.test(preview.end),'preview shows END OF PREVIEW (got "'+preview.end+'")');
    assert(preview.hasReaderBtn,'preview offers a reading action');
    assert(/read a little/i.test(preview.readerLabel),'preview CTA reads "Read a little" (got "'+preview.readerLabel.trim()+'")');

    /* chapterless books paginate in ~22-paragraph pages (pure logic check) */
    const pageMode=await page.evaluate(()=>{
      const sentence='The rain fell steadily over the empty streets, and the lamps burned low against the long grey evening. ';
      const blocks=[];
      for(let i=0;i<50;i++)blocks.push(sentence+'Passage '+i+'.');
      const m=readerModel(blocks);
      return {mode:m.mode,sizes:m.sections.map(s=>s.paras.length)};
    });
    assert(pageMode.mode==='page','a book without chapter headings falls back to page mode');
    assert(pageMode.sizes.length===3&&pageMode.sizes[0]===22&&pageMode.sizes[2]===6,
      'chapterless text is split into ~22-paragraph pages (got '+pageMode.sizes.join('/')+')');

    /* failed deck supply exposes a retry instead of a dead end */
    const deckState=await page.evaluate(()=>{
      const d=store.deck;
      const saved={books:d.books,index:d.index,error:d.error,loading:d.loading,fetching:d.fetching};
      d.books=[];d.index=0;d.error=true;d.loading=false;d.fetching=false;
      renderForYou();
      const el=document.querySelector('[data-screen="foryou"]');
      const out={retry:!!el.querySelector('[data-act="reload-deck"]'),text:el.textContent};
      Object.assign(d,saved);renderForYou();
      return out;
    });
    assert(deckState.retry&&/could not reach gutendex/i.test(deckState.text),'failed deck supply shows a Try again affordance');

    /* the swipe click-suppression latch must not survive a bailed decideDeck */
    const latch=await page.evaluate(()=>{
      const d=store.deck,wasBusy=!!d.busy;
      suppressClick=true;d.busy=true;decideDeck('keep');
      const after=suppressClick;d.busy=wasBusy;
      return after;
    });
    assert(latch===false,'suppressClick is cleared when decideDeck bails');

    /* close preview */
    await page.click('.overlay.preview .sheet-head [data-act="close"]');
    await page.waitForFunction(()=>!document.querySelector('.overlay.preview'),{timeout:5000});

    /* ---------------------------------------------------------------
       2. Save from the preview, then open the full book
    --------------------------------------------------------------- */
    console.log('\n[2] save + open Moby Dick');
    await page.evaluate(()=>openPreview(bookById(2701)));
    await page.waitForSelector('.overlay.preview [data-preview-actions]');
    await page.click('.overlay.preview [data-preview-actions] [data-act="save"]');
    await page.waitForFunction(()=>{
      try{
        const d=JSON.parse(localStorage.getItem('florilegium.mono.v1')||'{}');
        return (d.shelf||[]).some(e=>e.bookId===2701);
      }catch(e){return false;}
    },{timeout:5000});
    assert(await page.evaluate(()=>!!document.querySelector('[data-toast].on')),'save shows the confirmation toast');
    assert(await page.evaluate(()=>{
      try{
        const d=JSON.parse(localStorage.getItem('florilegium.mono.v1')||'{}');
        return (d.shelf||[]).some(e=>e.bookId===2701);
      }catch(e){return false;}
    }),'saved book is persisted in localStorage');

    await page.click('.overlay.preview [data-act="reader"]');
    await waitReader(page);
    let st=await readerState(page);
    info('state: '+JSON.stringify({mode:st.mode,total:st.total,index:st.index,label:st.label,paras:st.paras}));
    assert(st.mode==='chapter','long book is split into chapters (mode='+st.mode+')');
    assert(st.total>14,'reader exposes the whole book ('+st.total+' sections)');
    assert(st.paras>14,'first chapter renders more than 14 paragraphs ('+st.paras+')');
    assert(/^Chapter 1 of \d+$/.test(st.label),'progress reads "'+st.label+'"');
    assert(st.prevDisabled,'Previous is disabled on the first chapter');
    const navBoxes=await page.evaluate(()=>['reader-prev','reader-next'].map(a=>{
      const r=document.querySelector('.overlay.reader [data-act="'+a+'"]').getBoundingClientRect();
      return {w:r.width,h:r.height};
    }));
    assert(navBoxes.every(b=>b.w>=44&&b.h>=44),'reader Prev/Next targets are at least 44x44');
    const isoFirst=await domIsolation(page);
    info('dom first section: '+JSON.stringify(isoFirst));
    assert(isoFirst&&isoFirst.rendered<=60,'DOM isolation on load: current section renders <=60 paragraphs (got '+(isoFirst&&isoFirst.rendered)+')');
    assert(isoFirst&&isoFirst.rendered<=isoFirst.section,'DOM isolation on load: never renders beyond the current section ('+isoFirst.rendered+' of '+isoFirst.section+')');
    assert(isoFirst&&isoFirst.rendered<isoFirst.total,'DOM isolation on load: never renders the whole book ('+isoFirst.rendered+' of '+isoFirst.total+' blocks)');
    const firstText=st.first,firstBar=parseFloat(st.barWidth)||0;

    /* ---------------------------------------------------------------
       3. Next / Previous change content and progress
    --------------------------------------------------------------- */
    console.log('\n[3] navigation + progress');
    await page.click('.overlay.reader [data-act="reader-next"]');
    await page.waitForFunction(()=>{
      const el=document.querySelector('.overlay.reader');
      return el&&el.dataset.readerIndex==='1';
    },{timeout:5000});
    st=await readerState(page);
    assert(/^Chapter 2 of \d+$/.test(st.label),'Next advances to "'+st.label+'"');
    assert(st.first!==firstText,'Next changes the rendered text');
    assert(!st.prevDisabled,'Previous is enabled on chapter 2');
    assert((parseFloat(st.barWidth)||0)>firstBar,'progress bar advances with the chapter');
    const isoSecond=await domIsolation(page);
    info('dom second section: '+JSON.stringify(isoSecond));
    assert(isoSecond&&isoSecond.rendered<=60,'DOM isolation after navigation: chapter 2 renders <=60 paragraphs (got '+(isoSecond&&isoSecond.rendered)+')');
    assert(isoSecond&&isoSecond.rendered<=isoSecond.section&&isoSecond.rendered<isoSecond.total,
      'DOM isolation after navigation: only the current section is in the DOM ('+isoSecond.rendered+' of '+isoSecond.total+' blocks)');

    await page.click('.overlay.reader [data-act="reader-prev"]');
    await page.waitForFunction(()=>{
      const el=document.querySelector('.overlay.reader');
      return el&&el.dataset.readerIndex==='0';
    },{timeout:5000});
    st=await readerState(page);
    assert(st.index===0&&/^Chapter 1 /.test(st.label),'Previous returns to chapter 1');
    assert(st.first===firstText,'Previous restores chapter 1 text');

    /* ---------------------------------------------------------------
       4. Reading settings still apply inside the reader
    --------------------------------------------------------------- */
    console.log('\n[4] reader settings');
    const fontBefore=st.fontSize;
    await page.click('.overlay.reader [data-act="reader-settings"]');
    await page.waitForSelector('.overlay.sheet-overlay.open [data-act="set"][data-value="night"]');
    await wait(500); /* let the bottom sheet finish sliding in */
    await page.click('.overlay.sheet-overlay [data-act="set"][data-value="night"]');
    await page.waitForFunction(()=>document.querySelector('.overlay.reader').dataset.theme==='night',{timeout:3000});
    assert(true,'Night theme applies to the reader');
    await wait(200);
    await page.click('.overlay.sheet-overlay [data-act="size"][data-delta="1"]');
    await page.waitForFunction(before=>parseFloat(getComputedStyle(document.querySelector('.overlay.reader [data-reader-body]')).fontSize)>before,{timeout:5000},parseFloat(fontBefore));
    const fontAfter=await page.evaluate(()=>getComputedStyle(document.querySelector('.overlay.reader [data-reader-body]')).fontSize);
    assert(parseFloat(fontAfter)>parseFloat(fontBefore),'text size increases ('+fontBefore+' -> '+fontAfter+')');
    await page.click('.overlay.sheet-overlay .settings [data-act="close"].btn-primary');
    await page.waitForFunction(()=>!document.querySelector('.overlay.sheet-overlay'),{timeout:5000});

    /* ---------------------------------------------------------------
       5. True end-of-book state + Gutenberg credit
    --------------------------------------------------------------- */
    console.log('\n[5] end of book');
    st=await readerState(page);
    const total=st.total;
    await page.evaluate(()=>{
      const el=document.querySelector('.overlay.reader');
      el._reader.index=el._reader.total-1;
      paintReader(el);
    });
    await wait(200);
    st=await readerState(page);
    assert(st.index===total-1,'reader reaches the final section (index '+(total-1)+')');
    assert(st.endVisible,'end-of-book card is shown');
    assert(/end of book/i.test(st.endText),'end card says End of book');
    assert(/project gutenberg/i.test(st.endText),'end card credits Project Gutenberg');
    assert(st.nextDisabled,'Next is disabled at the end of the book');

    /* ---------------------------------------------------------------
       6. Position persists across a reload
    --------------------------------------------------------------- */
    console.log('\n[6] reading position persists');
    const stored=await page.evaluate(()=>{
      try{return JSON.parse(localStorage.getItem('florilegium.reader.v1')||'{}');}catch(e){return {};}
    });
    assert(stored&&stored[2701]&&stored[2701].index===total-1,
      'position is stored under its own key (index '+(total-1)+')');

    await page.reload({waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>document.querySelectorAll('[data-tabbar] .tab').length===4,{timeout:20000});
    await wait(500);
    await page.evaluate(()=>openReader(bookById(2701)));
    await waitReader(page);
    st=await readerState(page);
    assert(st.index===total-1,'reopening restores the saved chapter ('+st.index+')');
    assert(st.endVisible,'reopened reader still lands on the end card');

    /* ---------------------------------------------------------------
       6b. An intra-chapter scroll fraction survives close/reopen
    --------------------------------------------------------------- */
    console.log('\n[6b] intra-chapter scroll fraction persists');
    await page.evaluate(()=>{
      const el=document.querySelector('.overlay.reader');
      el._reader.index=0;el._reader.frac=0;paintReader(el);
    });
    await wait(200);
    const scrollInfo=await page.evaluate(()=>{
      const el=document.querySelector('.overlay.reader');
      const sc=el.querySelector('[data-reader-scroll]');
      const max=sc.scrollHeight-sc.clientHeight;
      sc.scrollTop=Math.round(max*0.5);
      return {max,top:sc.scrollTop};
    });
    assert(scrollInfo.max>100,'chapter 1 is long enough to scroll ('+scrollInfo.max+'px)');
    await wait(600); /* let the throttled save land */
    const fracStored=await page.evaluate(()=>{
      try{return JSON.parse(localStorage.getItem('florilegium.reader.v1')||'{}')[2701];}catch(e){return null;}
    });
    assert(fracStored&&fracStored.index===0&&fracStored.frac>0.25&&fracStored.frac<0.75,
      'scroll fraction is persisted (index '+(fracStored&&fracStored.index)+', frac '+(fracStored&&fracStored.frac)+')');
    await page.evaluate(()=>{while(overlayStack.length)popOverlay();});
    await page.waitForFunction(()=>!document.querySelector('.overlay'),{timeout:5000});
    await page.evaluate(()=>openReader(bookById(2701)));
    await waitReader(page);
    const restored=await page.evaluate(()=>{
      const el=document.querySelector('.overlay.reader');
      const sc=el.querySelector('[data-reader-scroll]');
      const max=sc.scrollHeight-sc.clientHeight;
      return {index:el._reader.index,scrollFrac:max>4?sc.scrollTop/max:0};
    });
    info('restored scroll: '+JSON.stringify(restored));
    assert(restored.index===0,'small move survives close/reopen in the same chapter ('+restored.index+')');
    assert(restored.scrollFrac>0.25&&restored.scrollFrac<0.75,'small move survives close/reopen: fraction restored ('+restored.scrollFrac.toFixed(3)+')');

    /* close every overlay before the next scenario */
    await page.evaluate(()=>{while(overlayStack.length)popOverlay();});
    await page.waitForFunction(()=>!document.querySelector('.overlay'),{timeout:5000});

    /* ---------------------------------------------------------------
       7. Failure paths: 429 rate limit, retry, non-curated preview retry
    --------------------------------------------------------------- */
    console.log('\n[7] failure + retry');
    let netMode='off'; /* off | rate | abort */
    await page.setRequestInterception(true);
    page.on('request',req=>{
      const u=req.url(),hit=u.includes('r.jina.ai')||u.includes('gutenberg.org');
      if(netMode!=='off'&&hit){
        if(netMode==='rate')return req.respond({
          status:429,
          headers:{'access-control-allow-origin':'*'},
          contentType:'text/plain',
          body:'rate limited'
        });
        return req.abort();
      }
      return req.continue();
    });

    /* 7a: a 429 from Jina must surface the distinct rate-limit message */
    await page.evaluate(()=>openPreview(bookById(1342)));
    await page.waitForFunction(()=>document.querySelectorAll('.overlay.preview [data-excerpt] p').length===3,{timeout:20000});
    netMode='rate';
    await page.click('.overlay.preview [data-act="reader"]');
    await page.waitForFunction(()=>{
      const el=document.querySelector('.overlay.reader');
      return !!(el&&el.dataset.readerMode==='error');
    },{timeout:90000});
    st=await readerState(page);
    assert(st.mode==='error','429 shows an inline reader error');
    assert(st.errorKind==='rate','429 is surfaced as a rate-limit error (kind='+st.errorKind+')');
    assert(/rate limited/i.test(st.label),'rate-limit label reads "'+st.label+'"');
    const retryBox=await page.evaluate(()=>{
      const r=document.querySelector('.overlay.reader [data-act="retry-reader"]').getBoundingClientRect();
      return {w:r.width,h:r.height};
    });
    assert(retryBox.w>=44&&retryBox.h>=44,'reader Retry target is at least 44x44');
    assert(await page.evaluate(()=>document.querySelectorAll('.overlay.preview [data-excerpt] p').length===3),'preview underneath stays usable with 3 paragraphs');

    netMode='off';
    await page.click('.overlay.reader [data-act="retry-reader"]');
    await waitReader(page,{timeout:120000});
    st=await readerState(page);
    assert((st.mode==='chapter'||st.mode==='page')&&st.paras>0,'retry after 429 loads the full book ('+st.mode+', '+st.paras+' paragraphs)');

    await page.evaluate(()=>{while(overlayStack.length)popOverlay();});
    await page.waitForFunction(()=>!document.querySelector('.overlay'),{timeout:5000});

    /* 7b: an empty preview result must not be cached — Retry refetches */
    console.log('\n[7b] non-curated preview retry');
    await page.evaluate(()=>{
      if(!bookById(1400))store.books.push({
        id:1400,title:'Great Expectations',author:'Charles Dickens',
        subjects:['Fiction'],downloads:1,cover:null,
        textUrl:'https://www.gutenberg.org/cache/epub/1400/pg1400.txt'
      });
    });
    netMode='abort';
    await page.evaluate(()=>openPreview(bookById(1400)));
    await page.waitForFunction(()=>!!document.querySelector('.overlay.preview [data-act="retry-excerpt"]'),{timeout:90000});
    const failedPreview=await page.evaluate(()=>{
      const box=document.querySelector('.overlay.preview [data-excerpt]');
      const r=document.querySelector('.overlay.preview [data-act="retry-excerpt"]').getBoundingClientRect();
      return {text:box.textContent,retry:{w:r.width,h:r.height}};
    });
    assert(/could not be fetched/i.test(failedPreview.text),'failed non-curated preview shows the inline error');
    assert(failedPreview.retry.w>=44&&failedPreview.retry.h>=44,'preview Retry target is at least 44x44');
    netMode='off';
    await page.click('.overlay.preview [data-act="retry-excerpt"]');
    await page.waitForFunction(()=>document.querySelectorAll('.overlay.preview [data-excerpt] p').length===3,{timeout:120000});
    assert(true,'preview Retry refetches after an empty result (3 paragraphs)');
    await page.evaluate(()=>{while(overlayStack.length)popOverlay();});
    await page.waitForFunction(()=>!document.querySelector('.overlay'),{timeout:5000});

    /* ---------------------------------------------------------------
       7c. Catalogue pools never offer books already on the shelf
    --------------------------------------------------------------- */
    console.log('\n[7c] deck/recommendation pools exclude the shelf');
    const poolCheck=await page.evaluate(()=>{
      const mk=(id,title)=>({id,title,author:'A',cover:'c',subjects:['Fiction'],languages:['en'],downloads:1});
      const shelfBook=store.shelf[0].book;
      const shelfIds=store.shelf.map(s=>s.bookId);
      const savedDeck=store.deck.books.slice();
      /* main path: plenty of eligible books */
      store.books=[shelfBook,...[900001,900002,900003,900004,900005,900006].map(n=>mk(n,'Book '+n))];
      store.deck.books=[];store.deck.index=0;
      applyCatalogue(store.books.slice());
      const deckMain=store.deck.books.map(b=>b.id),recMain=store.recommended.map(b=>b.id);
      /* fallback path: fewer than six eligible books */
      store.books=[shelfBook,mk(910001,'One'),mk(910002,'Two')];
      store.deck.books=[];store.deck.index=0;
      applyCatalogue(store.books.slice());
      const deckFall=store.deck.books.map(b=>b.id),recFall=store.recommended.map(b=>b.id);
      store.deck.books=savedDeck;
      return {shelfIds,deckMain,recMain,deckFall,recFall};
    });
    const leaked=[...poolCheck.deckMain,...poolCheck.recMain,...poolCheck.deckFall,...poolCheck.recFall].filter(id=>poolCheck.shelfIds.includes(id));
    assert(leaked.length===0,'catalogue pools exclude shelf books in the main and fallback paths');

    /* ---------------------------------------------------------------
       7d. Surface smoke: daily quote / shelf / search / browse
    --------------------------------------------------------------- */
    console.log('\n[7d] surface smoke');
    await page.evaluate(()=>{store.pick=FALLBACK_BOOKS.find(b=>b.id&&EXCERPTS[b.id]);renderHome();});
    await page.waitForFunction(()=>{
      const q=document.querySelector('[data-daily-quote]');
      return !!(q&&q.textContent.indexOf('\u201c')>=0&&q.textContent.length>8);
    },{timeout:5000}).catch(()=>{});
    const quoteSmoke=await page.evaluate(()=>{
      const q=document.querySelector('[data-daily-quote]');
      return (q&&q.textContent||'').trim();
    });
    assert(quoteSmoke.indexOf('\u201c')>=0&&quoteSmoke.length>8,'daily quote paints from the curated excerpt (got "'+quoteSmoke.slice(0,44)+'")');

    const shelfSmoke=await page.evaluate(()=>{
      setView('shelf');
      const el=document.querySelector('[data-screen="shelf"]');
      return {rows:el.querySelectorAll('[data-act="preview"]').length,total:store.shelf.length,title:(el.querySelector('.screen-title')||{}).textContent||''};
    });
    assert(shelfSmoke.total>0&&shelfSmoke.rows===shelfSmoke.total,'shelf lists every saved book ('+shelfSmoke.rows+' of '+shelfSmoke.total+')');
    assert(/your shelf/i.test(shelfSmoke.title),'shelf screen renders its heading ("'+shelfSmoke.title.trim()+'")');

    /* browse + search run against a stubbed catalogue so the smoke is deterministic */
    await page.evaluate(()=>{
      window.__floriFetch=window.fetch;
      window.fetch=async(u,o)=>{
        const url=String((u&&u.url)||u);
        if(url.includes('gutendex.com/books')){
          return {ok:true,status:200,json:async()=>({count:1,results:[{id:990001,title:'The Smoke Test',authors:[{name:'Doe, Jane'}],subjects:['Fiction'],download_count:12,languages:['en'],formats:{'image/jpeg':'http://127.0.0.1:4180/none.jpg','text/plain; charset=utf-8':'http://127.0.0.1:4180/none.txt'}}]})};
        }
        return window.__floriFetch(u,o);
      };
    });
    try{
      await page.evaluate(()=>openBrowse('Fiction','fiction'));
      await page.waitForFunction(()=>{
        const el=document.querySelector('.overlay.browse');
        return !!(el&&el.querySelector('[data-browse-body] .row'));
      },{timeout:8000});
      const browseSmoke=await page.evaluate(()=>{
        const el=document.querySelector('.overlay.browse');
        return {rows:el.querySelectorAll('[data-browse-body] .row').length,title:(el.querySelector('.browse-title')||{}).textContent||''};
      });
      assert(browseSmoke.rows>=1&&/fiction/i.test(browseSmoke.title),'browse renders category results ('+browseSmoke.rows+' rows, "'+browseSmoke.title+'")');
      await page.evaluate(()=>{while(overlayStack.length)popOverlay();});

      await page.evaluate(()=>openSearch());
      await page.evaluate(()=>{
        const el=document.querySelector('.overlay.search');
        const input=el.querySelector('[data-search-input]');
        input.value='smoke';
        input.dispatchEvent(new Event('input',{bubbles:true}));
      });
      await page.waitForFunction(()=>{
        const el=document.querySelector('.overlay.search');
        return !!(el&&el.querySelector('.result-meta'));
      },{timeout:8000});
      const searchSmoke=await page.evaluate(()=>{
        const el=document.querySelector('.overlay.search');
        return {rows:el.querySelectorAll('[data-search-body] .row').length,meta:(el.querySelector('.result-meta')||{}).textContent||''};
      });
      assert(searchSmoke.rows>=1,'search renders results from the catalogue ('+searchSmoke.rows+' rows)');
    }finally{
      await page.evaluate(()=>{
        if(window.__floriFetch){window.fetch=window.__floriFetch;delete window.__floriFetch;}
        while(overlayStack.length)popOverlay();
      });
    }
    await page.waitForFunction(()=>!document.querySelector('.overlay'),{timeout:5000});

    /* textCache LRU: keep ~6 recent full books, evict oldest-first */
    const lru=await page.evaluate(()=>{
      const savedMap=new Map(textCache),savedOpen=openTextId;
      openTextId=null;textCache.clear();
      for(let i=1;i<=12;i++){textCache.set(100000+i,['x']);trimTextCache();}
      const size=textCache.size,keys=Array.from(textCache.keys());
      textCache.clear();savedMap.forEach((v,k)=>textCache.set(k,v));openTextId=savedOpen;
      return {size,newest:keys[keys.length-1],oldest:keys[0]};
    });
    info('textCache LRU: '+JSON.stringify(lru));
    assert(lru.size===6,'textCache LRU keeps exactly 6 full books ('+lru.size+')');
    assert(lru.newest===100012&&lru.oldest===100007,'textCache LRU evicts oldest-first, keeps newest ('+lru.oldest+'..'+lru.newest+')');

    /* legacy reader positions (bare number, or object without frac) still load */
    const legacy=await page.evaluate(()=>{
      const all=readPositions(),saved=all[2701];
      all[2701]=3;localStorage.setItem(READER_LS,JSON.stringify(all));
      const bare=savedPos(2701);
      all[2701]={index:5,at:1};localStorage.setItem(READER_LS,JSON.stringify(all));
      const noFrac=savedPos(2701);
      all[2701]=saved;localStorage.setItem(READER_LS,JSON.stringify(all));
      return {bare,noFrac};
    });
    assert(legacy.bare.index===3&&legacy.bare.frac===0,'legacy number-only position still loads (index '+legacy.bare.index+')');
    assert(legacy.noFrac.index===5&&legacy.noFrac.frac===0,'legacy position without a fraction defaults frac to 0 (index '+legacy.noFrac.index+')');

    /* ---------------------------------------------------------------
       8. No uncaught page errors
    --------------------------------------------------------------- */
    console.log('\n[8] errors');
    /* External best-effort fetches (Gutendex catalogue, Jina text proxy,
       Gutenberg cover images) can emit CORS/network noise that the app
       already handles; those are not app errors. Uncaught JS errors are
       still asserted below. */
    const externalNoise=/Failed to load resource|net::ERR|ERR_FAILED|favicon|blocked by CORS policy|Access to fetch at/i;
    const unexpected=consoleErrors.filter(t=>!externalNoise.test(t));
    info('page errors: '+pageErrors.length+', console errors: '+consoleErrors.length+' ('+unexpected.length+' unexpected)');
    if(consoleErrors.length)consoleErrors.slice(0,5).forEach(t=>info('console: '+t.slice(0,160)));
    assert(pageErrors.length===0,'no uncaught page errors');
    assert(unexpected.length===0,'no unexpected console errors');

    console.log('\nALL TESTS PASSED');
    heat=0;
  }catch(err){
    console.error('\nTEST FAILED: '+(err&&err.stack||err));
    if(pageErrors.length){console.error('page errors:');pageErrors.forEach(e=>console.error('  - '+e));}
    if(consoleErrors.length){console.error('console errors:');consoleErrors.slice(0,10).forEach(e=>console.error('  - '+e));}
    heat=1;
  }finally{
    try{if(browser)await browser.close();}catch(e){}
    try{if(server)server.kill();}catch(e){}
    process.exit(heat);
  }
})();
