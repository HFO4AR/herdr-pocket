// Design QA across modules (demo mode, offline): the chat footer does not stack bars on small screens,
// compact controls keep a 44 px touch target, one word per concept (窗格), and nothing overflows.
const {chromium}=require('playwright');
const path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
(async()=>{
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const errors=[];
for(const [w,h,dark] of [[390,844,false],[320,640,true]]){
 const ctx=await browser.newContext({viewport:{width:w,height:h},deviceScaleFactor:1,hasTouch:true,colorScheme:dark?'dark':'light'});
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.PocketNative={request(id,op){if(!['devices','demo','disconnect','protect','watchState','settings','cacheGet','cachePut','haptic','cacheInfo'].includes(op))throw Error('Forbidden native call: '+op);setTimeout(()=>nativeResult(id,{ok:true,data:op==='devices'?{devices:[]}:{}}),0);}};});
 await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
 if(dark)await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
 await page.getByRole('button',{name:'体验聊天演示',exact:true}).click();
 const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
 const barShown=()=>page.evaluate(()=>{const b=document.getElementById('mode-bar');return !!b&&getComputedStyle(b).display!=='none';});

 // Idle chat: the mode bar is one slim line; the slash list replaces it while open.
 await page.locator('.agent-row',{hasText:'把移动端做成真正的聊天工具'}).click();
 await page.waitForFunction(()=>document.querySelector('#mode-bar .mode-chip:not(.m-quiet)'));
 assert.ok(await barShown(),'mode bar visible on an idle chat');
 const sw=await page.locator('#mode-bar .mode-switch').boundingBox();assert.ok(sw.height>=44,'switch keeps 44 px');
 const input=page.getByRole('textbox',{name:'消息输入框'});
 await input.fill('/');await page.locator('#slash-pop').waitFor();
 await page.waitForFunction(()=>getComputedStyle(document.getElementById('mode-bar')).display==='none');
 await input.fill('');await page.waitForFunction(()=>!document.getElementById('slash-pop'));
 assert.ok(await barShown(),'mode bar back after the slash list closes');
 assert.equal(await overflow(),0);
 await page.getByRole('button',{name:'返回列表'}).click();

 // Waiting for the person: the question card owns the footer; no disabled mode bar above it.
 await page.locator('.agent-row',{hasText:'清理构建缓存'}).click();
 await page.locator('#composer .qa-card, #composer .confirm-panel').first().waitFor();
 assert.equal(await barShown(),false,'mode bar steps aside for the question card');
 assert.equal(await page.locator('#mode-bar .mode-switch').isDisabled(),true,'still disabled underneath');
 const conv=await page.locator('#chat-scroll').boundingBox();assert.ok(conv.height>=(h<700?120:300),'conversation keeps room: '+conv.height);
 assert.equal(await overflow(),0);
 await page.getByRole('button',{name:'返回列表'}).click();

 // Compact chips keep a 44 px touch target (hit area above/below the visible pill).
 await page.getByRole('button',{name:'历史',exact:true}).click();
 const pill=page.locator('.chips .pill').first();await pill.waitFor();
 await page.waitForFunction(()=>!S.catalogLoading&&!document.getAnimations().some(a=>a.playState==='running'));
 const hit=await pill.evaluate(n=>{const r=n.getBoundingClientRect(),x=r.left+r.width/2;const top=document.elementFromPoint(x,r.top-3),bottom=document.elementFromPoint(x,r.bottom+3);return {h:r.height,top:top===n||n.contains(top),bottom:bottom===n||n.contains(bottom)};});
 assert.ok(hit.h<44&&hit.top&&hit.bottom,'pill hit area reaches 44 px '+JSON.stringify(hit));
 // Demo history reads newest first: each day label appears once.
 await page.locator('#history-list .day-label').first().waitFor();await page.waitForFunction(()=>!S.catalogLoading&&S.records.length===4);
 const days=await page.locator('#history-list .section-label, #history-list .day-label').allTextContents();
 assert.equal(new Set(days).size,days.length,'day groups not repeated: '+days.join(','));

 // One word for Herdr panes everywhere: 窗格.
 await page.getByRole('button',{name:'终端',exact:true}).click();
 await page.getByText('电脑上的 Herdr 窗格').waitFor();
 assert.equal(await page.evaluate(()=>document.body.innerText.includes('分屏')),false);
 assert.equal(await overflow(),0);
 await ctx.close();}
assert.deepEqual(errors,[]);
console.log('PASS: footer bars step aside, touch targets, one term per concept, no overflow (light 390, dark 320)');
await browser.close();})().catch(e=>{console.error(e);process.exit(1);});
