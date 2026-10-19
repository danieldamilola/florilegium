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
    fontSize:getComputedStyle(el.querySelector('[data-reader-body]')).fontSize
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
        hasReaderBtn:!!el.querySelector('[data-act="reader"]')
      };
    });
    assert(preview.paras===3,'preview shows exactly 3 paragraphs (got '+preview.paras+')');
    assert(/end of preview/i.test(preview.end),'preview shows END OF PREVIEW (got "'+preview.end+'")');
    assert(preview.hasReaderBtn,'preview offers a Start reading action');

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

    /* close every overlay before the next scenario */
    await page.evaluate(()=>{while(overlayStack.length)popOverlay();});
    await page.waitForFunction(()=>!document.querySelector('.overlay'),{timeout:5000});

    /* ---------------------------------------------------------------
       7. Failure path: inline reader error + retry; preview stays usable
    --------------------------------------------------------------- */
    console.log('\n[7] failure + retry');
    let blocking=true;
    await page.setRequestInterception(true);
    page.on('request',req=>{
      const u=req.url();
      if(blocking&&(u.includes('r.jina.ai')||u.includes('gutenberg.org')))return req.abort();
      return req.continue();
    });

    await page.evaluate(()=>openPreview(bookById(1342)));
    await page.waitForFunction(()=>document.querySelectorAll('.overlay.preview [data-excerpt] p').length===3,{timeout:20000});
    await page.click('.overlay.preview [data-act="reader"]');
    await page.waitForFunction(()=>{
      const el=document.querySelector('.overlay.reader');
      return !!(el&&el.dataset.readerMode==='error');
    },{timeout:45000});
    st=await readerState(page);
    assert(st.mode==='error','failed fetch shows an inline reader error');
    assert(await page.evaluate(()=>!!document.querySelector('.overlay.reader [data-act="retry-reader"]')),'error offers a Retry action');
    assert(await page.evaluate(()=>document.querySelectorAll('.overlay.preview [data-excerpt] p').length===3),'preview underneath stays usable with 3 paragraphs');

    blocking=false;
    await page.click('.overlay.reader [data-act="retry-reader"]');
    await waitReader(page,{timeout:120000});
    st=await readerState(page);
    assert((st.mode==='chapter'||st.mode==='page')&&st.paras>0,'retry loads the full book ('+st.mode+', '+st.paras+' paragraphs)');

    /* ---------------------------------------------------------------
       8. No uncaught page errors
    --------------------------------------------------------------- */
    console.log('\n[8] errors');
    const unexpected=consoleErrors.filter(t=>!/Failed to load resource|net::ERR|favicon/i.test(t));
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
