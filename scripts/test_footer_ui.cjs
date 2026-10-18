// The chat footer as one panel (foot.js): one rail line + at most one block + the composer, in every
// state (idle, working, queued, waiting on an approval, slash list, keyboard open) and size (320×640,
// 390×844, landscape 844×390, tablet 1024×768), light and dark. Checks: what leads, the composer (or
// 「写消息」 where the card takes its place) is on screen, 44 px touch targets, the footer never covers
// the header, the conversation keeps room, no sideways overflow, theme tokens, reduced motion.
// Demo mode, offline: native calls are a strict fake and nothing is sent.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const folder=path.join(root,'ui-artifacts');fs.mkdirSync(folder,{recursive:true});
const SIZES=[['320',320,640,true],['390',390,844,false],['land',844,390,true],['tab',1024,768,false]];
(async()=>{
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const errors=[];
async function fresh(w,h,dark,reduce=false){
 const ctx=await browser.newContext({viewport:{width:w,height:h},deviceScaleFactor:1,hasTouch:true,colorScheme:dark?'dark':'light',reducedMotion:reduce?'reduce':'no-preference'});
 const page=await ctx.newPage();page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
 await page.addInitScript(()=>{window.PocketNative={request(id,op){if(!['devices','demo','disconnect','protect','watchState','settings','cacheGet','cachePut','haptic','cacheInfo'].includes(op))throw Error('Forbidden native call: '+op);setTimeout(()=>nativeResult(id,{ok:true,data:op==='devices'?{devices:[]}:{}}),0);}};});
 await page.goto(require('./ui_bundle.cjs').url(html));
 if(dark)await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
 await page.getByRole('button',{name:'体验聊天演示',exact:true}).click();
 return page;}
const open=async(page,title)=>{await page.locator('.agent-row',{hasText:title}).first().click();await page.locator('#composer .composer').waitFor({state:'attached'});
 await page.waitForFunction(()=>document.getElementById('composer')?.dataset.primary);};
// Phones go back to the list; the tablet keeps the list beside the chat.
const back=async page=>{const b=page.getByRole('button',{name:'返回列表',exact:true});if(await b.isVisible())await b.click();};
const primary=page=>page.evaluate(()=>document.getElementById('composer').dataset.primary);
const settle=page=>page.waitForFunction(()=>!document.getAnimations().some(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity));
const input=page=>page.getByRole('textbox',{name:'消息输入框',exact:true});
// Everything that must hold in every state.
async function layout(page,label,minConv){
 await settle(page);
 const r=await page.evaluate(()=>{
  const box=n=>n.getBoundingClientRect(),f=document.getElementById('composer'),head=document.getElementById('chat-head'),conv=document.getElementById('chat-scroll');
  const vis=n=>{const b=box(n);return getComputedStyle(n).display!=='none'&&getComputedStyle(n).visibility!=='hidden'&&b.width>0&&b.height>0&&!n.closest('.hidden,[hidden]');};
  const t=f.querySelector('.composer textarea'),w=[...f.querySelectorAll('.foot-write')].find(vis);
  const reach=n=>{if(!n||!vis(n))return false;const b=box(n);return b.top>=0&&b.bottom<=innerHeight+0.5;};
  // Touch targets: a 44 px band through the middle of every visible footer button must hit it (own box or ::after).
  const small=[];for(const b of f.querySelectorAll('button')){if(!vis(b)||b.disabled&&b.closest('.hidden'))continue;const r=box(b);if(r.bottom<0||r.top>innerHeight)continue;
   const sc=b.closest('.qa-body,.slash-pop');if(sc){const s=box(sc);if(r.top<s.top||r.bottom>s.bottom)continue;}
   const x=r.left+Math.min(r.width/2,12),mid=r.top+r.height/2;if(r.height>=43.5)continue;
   const hit=y=>{const n=document.elementFromPoint(x,y);return n===b||b.contains(n);};
   if(!hit(mid-21.5)||!hit(mid+21.5))small.push((b.getAttribute('aria-label')||b.textContent).trim()+' '+Math.round(r.height));}
  const hb=box(head),fb=box(f),cb=box(conv);
  return {input:reach(t),write:reach(w),small,overlap:fb.top<hb.bottom-0.5,conv:Math.round(Math.min(cb.bottom,innerHeight)-Math.max(cb.top,hb.bottom)),
   overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,bottom:Math.round(fb.bottom-innerHeight)};});
 assert.ok(r.input||r.write,label+': composer or 写消息 on screen');
 assert.deepEqual(r.small,[],label+': touch targets');
 assert.equal(r.overlap,false,label+': footer below the header');
 assert.ok(r.conv>=minConv,label+': conversation keeps room '+r.conv+' < '+minConv);
 assert.equal(r.overflow,0,label+': no sideways overflow');
 assert.ok(r.bottom<=0.5,label+': footer inside the screen '+r.bottom);
 return r;}
const footH=page=>page.evaluate(()=>Math.round(document.getElementById('composer').getBoundingClientRect().height));

for(const [name,w,h,dark] of SIZES){
 const short=h<=560,tag=name+(dark?' dark':' light');
 let page=await fresh(w,h,dark);
 // ── Idle: the mode line leads; nothing else above the input. ─────────────────
 await open(page,'把移动端做成真正的聊天工具');
 await page.waitForFunction(()=>document.querySelector('#mode-bar .mode-chip:not(.m-quiet)'));
 assert.equal(await primary(page),'mode');
 assert.ok(await page.locator('#mode-bar').isVisible());
 assert.equal(await page.locator('#foot-rail .foot-lead, #foot-rail .foot-chip').count(),0,'idle: no chips');
 await layout(page,tag+' idle',short?120:300);const idle=await footH(page);
 // ── Slash list: the block; the mode line steps aside, the composer stays. ────
 await input(page).fill('/');await page.locator('#slash-pop').waitFor();
 assert.equal(await primary(page),'slash');assert.equal(await page.locator('#mode-bar').isVisible(),false);
 assert.equal(await page.locator('#foot-rail').isVisible(),false,'mode alone never earns a line under the slash list');
 await layout(page,tag+' slash',short?40:150);
 await input(page).fill('');await page.waitForFunction(()=>!document.getElementById('slash-pop'));
 assert.equal(await primary(page),'mode');
 // ── Keyboard open (focused input, shorter viewport): one line plus the input. ─
 await input(page).focus();await page.setViewportSize({width:w,height:Math.round(h*.55)});await page.waitForTimeout(150);
 await layout(page,tag+' keyboard idle',short?30:120);
 await page.setViewportSize({width:w,height:h});await input(page).blur();
 await back(page);

 // ── Working: one line, 「执行中」 + 中断, the mode as a chip; no taller than idle. ──
 await open(page,'检查接口与回归测试');
 await page.locator('#foot-rail .foot-lead.t-work').getByText('执行中').waitFor();
 assert.equal(await primary(page),'work');
 assert.equal(await page.locator('#mode-bar').isVisible(),false);
 await page.locator('#foot-rail .foot-chip.mode-chip').waitFor();
 assert.ok(Math.abs(await footH(page)-idle)<=2,'working footer as tall as idle: '+(await footH(page))+' vs '+idle);
 await layout(page,tag+' working',short?120:300);
 await page.locator('#foot-rail').getByRole('button',{name:'中断',exact:true}).click();
 await page.getByRole('dialog',{name:'中断 Agent？'}).getByRole('button',{name:'取消',exact:true}).click();
 // The mode chip opens the details, where 「切换模式」 lives.
 await page.locator('#foot-rail .foot-chip.mode-chip').click();
 const ms=page.getByRole('dialog',{name:'Agent 模式'});await ms.waitFor();assert.ok(await ms.getByRole('button',{name:'切换模式'}).isVisible());
 await ms.getByRole('button',{name:'知道了',exact:true}).click();await ms.waitFor({state:'detached'});
 // Keyboard open while it works: still one line.
 await input(page).focus();await page.setViewportSize({width:w,height:Math.round(h*.55)});await page.waitForTimeout(150);
 await layout(page,tag+' keyboard working',short?30:120);
 await page.setViewportSize({width:w,height:h});await input(page).blur();

 // ── Queued: the queue leads, 「执行中」 and the mode collapse into chips. ───────
 for(const t of ['顺便把文档也更新一下','再跑一遍测试']){await input(page).fill(t);await page.getByRole('button',{name:'发送消息',exact:true}).click();}
 await page.locator('#foot-rail .foot-lead.t-queue').getByText('排队 2 条').waitFor();
 assert.equal(await primary(page),'queue');
 const chips=await page.locator('#foot-rail .foot-chip').allTextContents();
 assert.ok(chips.length===2&&chips[0].startsWith('执行中'),'chips: '+chips.join('|'));
 assert.ok(Math.abs(await footH(page)-idle)<=2,'queued footer as tall as idle');
 await page.evaluate(()=>document.getElementById('toast').classList.remove('show'));
 await layout(page,tag+' queued',short?120:300);
 await page.screenshot({path:path.join(folder,'footer-'+name+'-queued.png')});
 // 「执行中」 chip: brings the working line (and 中断) forward; the queue becomes a chip.
 await page.locator('#foot-rail .foot-chip.t-work').click();
 await page.locator('#foot-rail .foot-lead.t-work').waitFor();
 assert.ok(await page.locator('#foot-rail').getByRole('button',{name:'中断',exact:true}).isVisible());
 assert.ok(await page.locator('#foot-rail .foot-chip.t-queue').isVisible());
 // The queue chip shows the waiting messages in the conversation.
 await page.locator('#foot-rail .foot-chip.t-queue').click();
 await page.waitForFunction(()=>{const q=document.querySelector('#chat-scroll .queue'),s=document.getElementById('chat-scroll');if(!q)return false;const a=q.getBoundingClientRect(),b=s.getBoundingClientRect();return a.bottom>b.top&&a.top<b.bottom;});
 await back(page);

 // ── Waiting on an approval: the card leads, mode hidden (and disabled). ──────
 await open(page,'清理构建缓存');
 const card=page.locator('#live-state .qa-card');await card.waitFor();
 assert.equal(await primary(page),'ask');
 assert.equal(await page.locator('#mode-bar').isVisible(),false);
 assert.ok(await page.locator('#mode-bar .mode-switch').isDisabled());
 await settle(page);
 const r=await layout(page,tag+' approval',short?60:100);
 // The answer bar stays on screen: the options scroll inside the card.
 const submit=await card.getByRole('button',{name:'确认这个选择',exact:true}).boundingBox();assert.ok(submit&&submit.y+submit.height<=h+0.5,'submit bar on screen');
 assert.ok(await card.getByRole('button',{name:'关闭',exact:true}).isVisible());
 if(short){
  assert.equal(r.input,false,'short screen: the card takes the input\'s place');
  await page.screenshot({path:path.join(folder,'footer-'+name+'-approval.png')});
  await card.getByRole('button',{name:'写消息',exact:true}).click();
 }else{
  assert.equal(r.input,true,'tall screen: card and input together');
  assert.equal(await card.getByRole('button',{name:'写消息',exact:true}).isVisible(),false);
  await page.screenshot({path:path.join(folder,'footer-'+name+'-approval.png')});
  // Focusing the input on a touch screen (the keyboard is coming) folds the card.
  await input(page).tap();}
 // Writing: the card folds into the rail, the input is there and focused; 展开 brings the card back.
 await page.locator('#foot-rail .foot-lead.t-ask').waitFor();
 assert.equal(await card.isVisible(),false);
 await page.waitForFunction(()=>document.activeElement===document.querySelector('#composer textarea'));
 await page.setViewportSize({width:w,height:Math.round(h*.55)});await page.waitForTimeout(150);
 await layout(page,tag+' keyboard approval',short?30:100);
 assert.equal(await page.locator('#foot-rail .foot-lead.t-ask').isVisible(),true,'the folded question stays in reach while typing');
 await page.setViewportSize({width:w,height:h});
 await page.locator('#foot-rail').getByRole('button',{name:'展开问题',exact:true}).click();
 await card.waitFor();assert.equal(await primary(page),'ask');
 // Theme tokens on the rail and card head.
 const tone=await page.evaluate(()=>{const s=getComputedStyle(document.documentElement);return {soft:s.getPropertyValue('--danger-soft').trim(),head:getComputedStyle(document.querySelector('.qa-card .qa-head')).backgroundColor};});
 assert.ok(tone.soft&&tone.head,'tokens resolve');
 await page.context().close();
 console.log('PASS: '+tag+': idle, slash, keyboard, working, queued, approval (footer '+idle+' px)');}

// ── Theme tokens: the working line uses --warn-soft in both themes. ─────────────
for(const dark of [false,true]){const page=await fresh(390,844,dark);await open(page,'检查接口与回归测试');
 const c=await page.evaluate(()=>{const n=document.createElement('div');n.style.background='var(--warn-soft)';document.body.append(n);const want=getComputedStyle(n).backgroundColor;n.remove();
  return {want,got:getComputedStyle(document.querySelector('#foot-rail .foot-lead.t-work')).backgroundColor};});
 assert.equal(c.got,c.want,(dark?'dark':'light')+' working line token');await page.context().close();}
console.log('PASS: rail colours come from the theme tokens (light and dark)');

// ── Motion: a light swap when what leads changes; none with reduced motion. ───
for(const reduce of [false,true]){const page=await fresh(390,844,false,reduce);await open(page,'检查接口与回归测试');
 await page.locator('#foot-rail .foot-lead.t-work').waitFor();await page.waitForTimeout(300);
 await input(page).fill('排一条');await page.getByRole('button',{name:'发送消息',exact:true}).click();
 await page.locator('#foot-rail .foot-lead.t-queue').waitFor();
 const swap=await page.evaluate(()=>document.getElementById('foot-rail').classList.contains('foot-swap'));
 assert.equal(swap,!reduce,reduce?'no swap animation with reduced motion':'swap animation when the queue takes the lead');
 // Repaints of the same state never replay it.
 if(!reduce){await page.waitForTimeout(400);const n=await page.evaluate(()=>{const r=document.getElementById('foot-rail');r.classList.remove('foot-swap');renderComposer();footRefresh();return r.classList.contains('foot-swap');});assert.equal(n,false,'no replay on repaint');}
 await page.context().close();}
console.log('PASS: state swaps animate once, reduced motion respected');

await browser.close();
assert.deepEqual(errors,[]);
console.log('footer UI: all passed');
})().catch(e=>{console.error(e);process.exit(1);});
