// Terminal key system (termkeys.js): the key table shared with the bridge, sticky Ctrl / Alt /
// Shift (one-shot, double-tap lock), per-computer custom order, the disabled state for combinations
// that cannot be sent, hardware-keyboard modifiers, the direct keyboard on pane snapshots, and the
// bar in portrait, landscape and on a tablet. Offline demo only; native is a strict fake.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const TABLE=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/term_keys.json'),'utf8')).keys;

(async()=>{
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const folder=path.join(root,'ui-artifacts');fs.mkdirSync(folder,{recursive:true});
const errors=[];
async function fresh(width,height,theme='light'){
 const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:2,hasTouch:true});
 const page=await context.newPage();
 page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
 await page.addInitScript(()=>{window.PocketNative={request(id,op){
  if(!['devices','demo','disconnect','protect','watchState','settings','cacheGet','cachePut'].includes(op))throw Error('Forbidden native call in offline UI test: '+op);
  setTimeout(()=>nativeResult(id,{ok:true,data:op==='devices'?{devices:[]}:op==='cacheGet'?{value:null}:{}}),0);}};});
 await page.goto(require('./ui_bundle.cjs').url(html));
 await page.getByRole('button',{name:'体验聊天演示',exact:true}).click();
 await page.getByText('离线演示 · 示例数据，不连接电脑',{exact:true}).first().waitFor();
 await page.evaluate(t=>window.applyTheme(t),theme);
 return page;}
async function openShell(page){
 await page.locator('.bottom-nav').getByRole('button',{name:'终端',exact:true}).click();
 await page.getByRole('button',{name:'打开 SSH 终端',exact:true}).click();
 await page.locator('.xterm-screen').waitFor();
 await page.getByRole('toolbar',{name:'终端按键'}).waitFor();}
const overflow=page=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
const keyBoxes=page=>page.getByRole('toolbar',{name:'终端按键'}).getByRole('button').evaluateAll(ns=>ns.map(n=>{const r=n.getBoundingClientRect();return [n.getAttribute('aria-label')||n.textContent,r.width,r.height];}));

const page=await fresh(390,844,'light');
await openShell(page);

// ── 1. The phone's table is byte-for-byte the bridge's table (tests/fixtures/term_keys.json) ──
const table=await page.evaluate(rows=>{
 const bad=[];const push=(r,what,got,want)=>bad.push({key:r.key,what,got,want});
 for(const r of rows){
  let b,a,h,t;try{b=tkBytes(r.key);a=tkBytes(r.key,true);h=tkHerdrArgs(r.key);t=tkTmuxArgs(r.key);}
  catch(e){push(r,'throw',String(e),'');continue;}
  if(b!==r.bytes)push(r,'bytes',b,r.bytes);
  if(a!==r.app)push(r,'app',a,r.app);
  if(JSON.stringify(h)!==JSON.stringify(r.herdr))push(r,'herdr',h,r.herdr);
  if(JSON.stringify(t)!==JSON.stringify(r.tmux))push(r,'tmux',t,r.tmux);
 }
 return {n:rows.length,count:bad.length,bad:bad.slice(0,4)};},TABLE);
assert.ok(table.n>=400,'table has the full key set: '+table.n);
assert.equal(table.count,0,'termkeys.js and the bridge table agree: '+JSON.stringify(table.bad));
console.log('PASS: '+table.n+' key names match the bridge (xterm bytes, app cursor, Herdr and tmux arguments)');

// ── 2. The full key set, combos, symbols, and 44 px targets on every page ──
const keys=await page.$$eval('.tk-pager .key[data-key]',ns=>ns.map(n=>n.dataset.key));
for(const k of ['esc','tab','enter','backspace','up','down','left','right','home','end','insert','delete','pageup','pagedown',
 'f1','f5','f12','ctrl+c','ctrl+d','ctrl+z','ctrl+l','ctrl+r','ctrl+a','ctrl+e','ctrl+u','ctrl+k','ctrl+w','ctrl+b',
 ...'|~/-_:;`\\[]{}<>=&*!$'.split('')])assert.ok(keys.includes(k),'key bar has '+k);
assert.ok(keys.filter(k=>/^f\d+$/.test(k)).length===12,'F1–F12');
for(const [name,w,h] of await keyBoxes(page))assert.ok(w>=44&&h>=44,'key '+name+' is '+w+'x'+h);
const pages=await page.locator('.tk-page').count();
assert.ok(pages>=2,'the bar swipes sideways: '+pages+' pages');
assert.equal(await page.locator('.tk-dots i').count(),pages,'one dot per page');
assert.ok(await overflow(page)<=0,'no sideways page scroll');

// ── 3. Sticky modifiers: one-shot, double-tap lock, visible state ──
const mod=name=>page.getByRole('button',{name,exact:true});
assert.equal(await page.evaluate(()=>T.view.mods.ctrl),0);
await mod('Ctrl').click();
assert.equal(await page.evaluate(()=>T.view.mods.ctrl),1,'one tap latches for one key');
assert.equal(await mod('Ctrl').getAttribute('aria-pressed'),'true','latch is exposed');
assert.ok(await mod('Ctrl').evaluate(n=>n.classList.contains('on')),'latch is visible');
// A double tap within 400 ms locks it.
await page.evaluate(()=>{tkModTap(T.view,'shift');tkModTap(T.view,'shift');});
assert.equal(await page.evaluate(()=>T.view.mods.shift),2,'double tap locks');
assert.ok(await mod('Shift').evaluate(n=>n.classList.contains('locked')),'lock is visible');
assert.equal(await mod('Shift').getAttribute('aria-pressed'),'true');
await page.evaluate(()=>tkModTap(T.view,'shift'));
assert.equal(await page.evaluate(()=>T.view.mods.shift),0,'a tap on a locked modifier releases it');
// Modifiers combine, and a bar key consumes only the one-shot ones.
assert.equal(await page.evaluate(()=>tkWith('up',{ctrl:true,alt:true,shift:true})),'ctrl+alt+shift+up');
await page.evaluate(()=>{T.view.mods={ctrl:1,alt:1,shift:0};tkPaintMods(T.view);});
assert.equal(await page.evaluate(()=>tkWith('left',T.view.mods)),'ctrl+alt+left');
await page.getByRole('toolbar',{name:'终端按键'}).getByRole('button',{name:'Esc',exact:true}).click();
assert.equal(await page.evaluate(()=>T.view.mods.ctrl),0,'one-shot Ctrl drops after a key');
assert.equal(await page.evaluate(()=>T.view.mods.alt),0,'one-shot Alt drops after a key');
assert.equal(await page.evaluate(()=>T.view.sequence),0,'demo sends nothing');
// Locked modifiers stay after a key.
await page.evaluate(()=>{tkModTap(T.view,'ctrl');tkModTap(T.view,'ctrl');tkPress(T.view,'esc');});
assert.equal(await page.evaluate(()=>T.view.mods.ctrl),2,'a locked modifier stays');
await page.evaluate(()=>{T.view.mods={ctrl:0,alt:0,shift:0};tkPaintMods(T.view);});
console.log('PASS: Ctrl/Alt/Shift latch, lock, stay visible and combine');

// ── 4. Unsupported combinations are greyed out with the reason, never sent wrong ──
for(const k of ['ctrl+1','ctrl+|','ctrl++']){
 assert.ok(await page.evaluate(k=>tkWhy('xterm',k),k),'xterm refuses '+k);
 assert.ok(await page.evaluate(k=>tkWhy('tmux',k),k),'tmux refuses '+k);
 assert.ok(await page.evaluate(k=>tkWhy('herdr',k),k),'Herdr refuses '+k);
}
assert.equal(await page.evaluate(()=>tkWhy('tmux','shift+enter')),'','tmux takes modified Enter as bytes');
assert.equal(await page.evaluate(()=>tkHerdrArgs('ctrl+tab').join('|')),'send-text|\x1b[27;5;9~','Herdr gets Ctrl+Tab as bytes');
await page.evaluate(()=>{T.view.mods={ctrl:2,alt:2,shift:2};tkPaintKeys(T.view);});
const off=await page.locator('.tk-pager .key[data-key="|"]');
assert.ok(await off.evaluate(n=>n.classList.contains('off')),'Ctrl+Alt+Shift+| is greyed out');
assert.equal(await off.getAttribute('aria-disabled'),'true');
assert.match(await off.getAttribute('title'),/没有对应的按键码/,'the reason is the tooltip');
await page.evaluate(()=>{T.view.mods={ctrl:0,alt:0,shift:0};tkPaintKeys(T.view);});
assert.equal(await page.locator('.tk-pager .key.off').count(),0,'nothing else is disabled');
console.log('PASS: impossible combinations are disabled with a reason');

// ── 5. Hardware keyboard: real modifiers become the right key names ──
const hw=await page.evaluate(()=>{
 const ev=(k,m)=>new KeyboardEvent('keydown',{key:k,...m});
 return [tkFromEvent(ev('ArrowLeft',{ctrlKey:true,shiftKey:true}),{}),
  tkFromEvent(ev('ArrowUp',{altKey:true}),{}),tkFromEvent(ev('Tab',{shiftKey:true}),{}),
  tkFromEvent(ev('F5',{}),{}),tkFromEvent(ev('Escape',{}),{}),tkFromEvent(ev('a',{ctrlKey:true}),{}),
  tkFromEvent(ev('a',{}),{}),tkFromEvent(ev('A',{shiftKey:true}),{})];});
assert.deepEqual(hw,['ctrl+shift+left','alt+up','shift+tab','f5','esc','ctrl+a',null,null]);
console.log('PASS: hardware modifiers map to ctrl/shift/alt key names');

// ── 6. 自定义按键: hide and reorder, saved per computer ──
await page.evaluate(()=>{window.__puts=[];window.cachePut=(k,v)=>window.__puts.push([k,v]);});
await page.locator('.tk-edit').click();
await page.getByRole('checkbox',{name:'显示 F1',exact:true}).uncheck();
assert.equal(await page.evaluate(()=>TK.hidden.has('f1')),true,'f1 hidden');
assert.ok(await page.evaluate(()=>window.__puts.some(([k,v])=>k==='term:keys'&&v.hidden.includes('f1'))),'saved');
await page.evaluate(()=>{[...document.querySelectorAll('.tk-edit-row button')].find(b=>b.getAttribute('aria-label')==='往后移 Esc').click();});
assert.ok(await page.evaluate(()=>TK.order.indexOf('esc')>0),'Esc moved back');
assert.ok(await page.evaluate(()=>window.__puts.some(([k,v])=>k==='term:keys'&&v.order.indexOf('esc')>0)),'order saved');
await page.evaluate(()=>{tkApplyPrefs({order:['f12','esc','f1'],hidden:['f1']});});
assert.deepEqual(await page.evaluate(()=>TK.order.slice(0,3)),['f12','esc','f1'],'a saved order is applied');
assert.equal(await page.evaluate(()=>TK.order.length),await page.evaluate(()=>TK_DEFAULT.length),'new keys are appended');
assert.equal(await page.evaluate(()=>tkVisible().some(k=>k[0]==='f1')),false,'hidden keys are left out');
await page.getByRole('button',{name:'恢复默认',exact:true}).click();
assert.deepEqual(await page.evaluate(()=>TK.order),await page.evaluate(()=>TK_DEFAULT),'reset');
assert.equal(await page.evaluate(()=>TK.hidden.size),0);
await page.getByRole('button',{name:'完成',exact:true}).click();
assert.equal(await page.locator('.tk-edit-list').count(),0,'sheet closed');
console.log('PASS: custom key order and hidden keys are saved');

// ── 7. Direct keyboard on a pane snapshot: bar modifiers and hardware keys send pane keys ──
await page.getByRole('button',{name:'返回终端列表',exact:true}).click();
await page.getByRole('button',{name:/开发终端/}).click();
await page.locator('#pane-screen').waitFor();
await page.evaluate(()=>{window.__sent=[];window.sendPane=async(entry,op,args)=>{window.__sent.push([op,args]);entry.fast=performance.now();return true;};});
await page.evaluate(()=>{const c=document.querySelector('.tk-catch');c.focus({preventScroll:true});
 c.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));});
await page.waitForTimeout(60);
assert.deepEqual(await page.evaluate(()=>window.__sent.at(-1)),['paneKey',{key:'ctrl+shift+left'}],'Ctrl+Shift+Left from a hardware keyboard');
assert.ok(await page.locator('#term-surface').evaluate(n=>n.classList.contains('catching')),'direct keyboard is on');
assert.ok(await page.locator('#term-kbd').evaluate(n=>n.classList.contains('on')));
// A latched Ctrl plus one typed character is that control key.
await page.evaluate(()=>{T.view.mods.ctrl=1;const c=document.querySelector('.tk-catch');
 c.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertText',data:'c',bubbles:true,cancelable:true}));});
await page.waitForTimeout(60);
assert.deepEqual(await page.evaluate(()=>window.__sent.at(-1)),['paneKey',{key:'ctrl+c'}],'latched Ctrl + c');
// IME text goes in as text, in one piece.
await page.evaluate(()=>{T.view.mods={ctrl:0,alt:0,shift:0};const c=document.querySelector('.tk-catch');
 c.dispatchEvent(new CompositionEvent('compositionend',{data:'你好',bubbles:true}));});
await page.waitForTimeout(60);
assert.deepEqual(await page.evaluate(()=>window.__sent.at(-1)),['paneText',{text:'你好'}],'IME commit');
await page.screenshot({path:path.join(folder,'term2-keys-light-390.png')});
console.log('PASS: pane direct keyboard sends the mapped keys and IME text');

// ── 8. Dark, landscape and tablet ──
await page.evaluate(()=>window.applyTheme('dark'));await page.waitForTimeout(120);
await page.screenshot({path:path.join(folder,'term2-keys-dark-390.png')});
await page.evaluate(()=>window.applyTheme('light'));
await page.getByRole('button',{name:'返回终端列表',exact:true}).click();
await page.getByRole('button',{name:/^(打开|返回) SSH 终端$/}).click();
await page.locator('.xterm-screen').waitFor();
// Landscape phone: one row, still 44 px, nothing scrolls sideways, pager has pages.
await page.setViewportSize({width:844,height:390});await page.waitForTimeout(250);
assert.equal(await page.locator('.tk-bar.two-rows').count(),0,'one row in landscape');
for(const [name,w,h] of await keyBoxes(page))assert.ok(w>=44&&h>=44,'landscape key '+name+' is '+w+'x'+h);
assert.ok(await overflow(page)<=0,'landscape fits');
assert.ok(await page.locator('.tk-dots i').count()>=2,'pager pages in landscape');
await page.screenshot({path:path.join(folder,'term2-keys-landscape-844x390.png')});
await page.context().close();
// Tablet: two rows and the 自定义按键 button.
const tab=await fresh(1024,768,'light');await openShell(tab);
assert.equal(await tab.locator('.tk-bar.two-rows').count(),1,'two rows on a tablet');
assert.equal(await tab.locator('.tk-edit').isVisible(),true,'自定义按键 is reachable without the menu');
for(const [name,w,h] of await keyBoxes(tab))assert.ok(w>=44&&h>=44,'tablet key '+name+' is '+w+'x'+h);
assert.ok(await overflow(tab)<=0,'tablet fits');
await tab.screenshot({path:path.join(folder,'term2-keys-tablet-1024x768.png')});
await tab.context().close();

// ── 9. PTY reads: a wake delivered during the read must not be lost (the old code waited 3 s) ──
const race=await fresh(390,844,'light');
const reads=await race.evaluate(async()=>{
 window.__reads=0;
 window.rpc=async(op)=>{
  if(op==='cacheGet')return {value:null};
  if(op==='shellRead'){const n=++window.__reads;
   // The pane changed between the native read and this page's continuation: wake now.
   if(n===1){window.ptyWake('race-id');return {data:'',next:0,ended:false,armed:true};}
   if(n===2)return {data:btoa('\x1b[32mOK\x1b[0m\r\n'),next:9,ended:false,armed:true};
   return {data:'',next:9,ended:true,armed:false};}
  return {};};
 const entry=ptyEntry({kind:'ssh',id:'race-id',title:'race',demo:false});
 document.body.append(entry.host);entry.host.style.cssText='width:300px;height:200px';
 T.view=entry;S.active=true;ptyLoop(entry);
 await new Promise(r=>setTimeout(r,250));
 const n=window.__reads;T.view=null;entry.ended=true;entry.term.dispose();entry.host.remove();
 return n;});
assert.ok(reads>=2,'a wake during the read is not lost: '+reads+' reads in 250 ms');
console.log('PASS: a wake during a PTY read is not lost');
await race.context().close();

assert.deepEqual(errors,[]);
await browser.close();
console.log('ALL TERMINAL KEY UI CHECKS PASSED');
})().catch(e=>{console.error(e);process.exit(1);});
