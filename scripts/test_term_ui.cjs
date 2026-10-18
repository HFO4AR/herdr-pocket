// Terminal look and phone ergonomics: SSH (xterm) and Herdr pane views, the chat 「终端」 tab and
// the confirm screen, in light and dark at 390 and 320 px, with the soft keyboard up (adjustResize
// shrinks the viewport). Offline demo only: native is a strict fake and the demo never sends input.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');

(async()=>{
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const folder=path.join(root,'ui-artifacts');fs.mkdirSync(folder,{recursive:true});
const errors=[];
async function fresh(width,height,theme){
 const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:2,hasTouch:true});
 const page=await context.newPage();
 page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
 await page.addInitScript(()=>{window.PocketNative={request(id,op,raw){
  if(!['devices','demo','disconnect','protect','watchState','settings','cacheGet','cachePut'].includes(op))throw Error('Forbidden native call in offline UI test: '+op);
  setTimeout(()=>nativeResult(id,{ok:true,data:op==='devices'?{devices:[]}:op==='cacheGet'?{value:null}:{}}),0);}};});
 await page.goto(require('./ui_bundle.cjs').url(html));
 await page.getByRole('button',{name:'体验聊天演示',exact:true}).click();
 await page.getByText('离线演示 · 示例数据，不连接电脑',{exact:true}).first().waitFor();
 await page.evaluate(t=>window.applyTheme(t),theme);
 return page;}
const token=(page,name)=>page.evaluate(n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim(),name);
const rgb=hex=>{const h=hex.replace('#','');return 'rgb('+[0,2,4].map(i=>parseInt(h.slice(i,i+2),16)).join(', ')+')';};
const overflow=page=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
async function keyTargets(page){
 const boxes=await page.getByRole('toolbar',{name:'终端按键'}).getByRole('button').evaluateAll(ns=>ns.map(n=>{const r=n.getBoundingClientRect();return [n.getAttribute('aria-label')||n.textContent,r.width,r.height];}));
 assert.ok(boxes.length>=10,'key bar has the common keys');
 for(const [name,w,h] of boxes)assert.ok(w>=44&&h>=44,'key '+name+' is '+w+'x'+h);
 for(const name of ['执行','发送后回车'])
  {const b=await page.getByRole(name==='执行'?'button':'checkbox',{name,exact:true}).evaluate(n=>{const r=(n.closest('label')||n).getBoundingClientRect();return [r.width,r.height];});assert.ok(b[0]>=44&&b[1]>=44,name+' target '+b);}}
// The soft keyboard: the activity resizes, so the page gets a shorter viewport.
async function keyboard(page,width,height,tag){
 const input=page.getByRole('textbox',{name:'终端输入',exact:true});await input.focus();
 const h=Math.round(height*0.55);await page.setViewportSize({width,height:h});await page.waitForTimeout(250);
 const r=await input.boundingBox();assert.ok(r.y+r.height<=h,'input visible above the keyboard ('+tag+')');
 const run=await page.getByRole('button',{name:'执行',exact:true}).boundingBox();assert.ok(run.y+run.height<=h,'执行 visible ('+tag+')');
 const screen=await page.locator('#term-surface').boundingBox();assert.ok(screen.height>=110,'screen keeps room with the keyboard up ('+tag+'): '+screen.height);
 const keys=await page.getByRole('toolbar',{name:'终端按键'}).boundingBox();assert.ok(keys.y>=screen.y+screen.height-1&&keys.y+keys.height<=r.y+1,'keys between screen and input');
 assert.ok(await overflow(page)<=0,'no sideways scroll ('+tag+')');
 assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'终端输入','focus stays in the input');
 await page.screenshot({path:path.join(folder,'term-'+tag+'-keyboard.png')});
 await page.setViewportSize({width,height});await page.waitForTimeout(150);}

for(const theme of ['light','dark'])for(const [width,height] of [[390,844],[320,640]]){
 const tag=theme+'-'+width;const page=await fresh(width,height,theme);
 // 1. SSH: xterm colours come from the tokens; keys are thumb-sized; the keyboard never hides the input.
 await page.locator('.bottom-nav').getByRole('button',{name:'终端',exact:true}).click();
 await page.getByRole('button',{name:'打开 SSH 终端',exact:true}).click();
 await page.locator('.xterm-screen').waitFor();
 const bg=await token(page,'--terminal');
 assert.equal(await page.evaluate(()=>T.shell.term.options.theme.background),bg,'xterm background = --terminal ('+tag+')');
 assert.equal(await page.evaluate(()=>T.shell.term.options.theme.cursor),await token(page,'--accent-raw'));
 assert.equal(await page.locator('#term-surface').evaluate(n=>getComputedStyle(n).backgroundColor),rgb(bg));
 assert.match(await page.evaluate(()=>T.shell.term.options.fontFamily),/Mono/);
 assert.equal(await page.locator('#term-state').textContent(),'演示');
 await keyTargets(page);
 assert.equal(await page.getByRole('button',{name:'直接键盘',exact:true}).count(),1);
 await page.evaluate(()=>{for(let i=0;i<120;i++)T.shell.term.write('\x1b[36m~/proj\x1b[0m $ echo line '+i+'\r\n');});
 await page.waitForTimeout(120);
 // Reading back: the jump button appears, and takes you to the latest line.
 assert.equal(await page.locator('#term-jump').isHidden(),true,'at the bottom: no jump button');
 await page.evaluate(()=>T.shell.term.scrollLines(-30));await page.locator('#term-jump').waitFor();
 await page.screenshot({path:path.join(folder,'term-'+tag+'-ssh.png')});
 await page.getByRole('button',{name:'跳到最新输出',exact:true}).click();
 assert.equal(await page.evaluate(()=>{const b=T.shell.term.buffer.active;return b.viewportY===b.baseY;}),true,'back at the latest line');
 assert.equal(await page.locator('#term-jump').isHidden(),true);
 // A one-finger drag scrolls the history (xterm alone ignores touch).
 {const box=await page.locator('.pty-host').boundingBox();const cdp=await page.context().newCDPSession(page);const x=box.x+box.width/2;let y=box.y+60;
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
  for(let i=0;i<10;i++){y+=14;await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y}]});}
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(100);
  assert.ok(await page.evaluate(()=>{const b=T.shell.term.buffer.active;return b.viewportY<b.baseY;}),'touch drag scrolls back');
  await page.getByRole('button',{name:'跳到最新输出',exact:true}).click();}
 // Theme switches repaint the live shell.
 const other=theme==='light'?'dark':'light';await page.evaluate(t=>window.applyTheme(t),other);
 assert.equal(await page.evaluate(()=>T.shell.term.options.theme.background),await token(page,'--terminal'),'xterm follows the theme');
 assert.equal(await page.evaluate(()=>T.shell.term.options.theme.foreground),await token(page,'--terminal-ink'));
 await page.evaluate(t=>window.applyTheme(t),theme);
 assert.equal(await page.evaluate(()=>T.shell.term.options.theme.background),bg);
 // Soft-keyboard Enter runs the line (demo: nothing is sent).
 await keyboard(page,width,height,tag+'-ssh');
 const input=page.getByRole('textbox',{name:'终端输入',exact:true});await input.fill('ls -la');await input.press('Enter');
 await page.getByText('终端演示：未发送',{exact:true}).waitFor();
 assert.equal(await input.inputValue(),'ls -la','demo keeps the line');
 await page.getByRole('button',{name:'Esc',exact:true}).click();
 assert.equal(await page.evaluate(()=>T.shell.sequence),0,'demo sends nothing');
 // Ended: a clear state and one way forward.
 await page.evaluate(()=>{T.shell.ended=true;terminalStatus(T.shell,'SSH shell 已结束，可以重新打开。');});
 assert.equal(await page.locator('#term-state').textContent(),'已结束');
 await page.getByRole('status').getByRole('button',{name:'重新打开',exact:true}).click();
 await page.locator('.xterm-screen').waitFor();assert.equal(await page.evaluate(()=>T.shell.ended),false,'a fresh shell');
 assert.equal(await page.locator('#term-state').textContent(),'演示');
 assert.ok(await overflow(page)<=0);

 // 2. Herdr pane: opens at the latest line, follows output while you are there, larger text on A+.
 await page.getByRole('button',{name:'返回终端列表',exact:true}).click();
 await page.getByRole('button',{name:/开发终端/}).click();
 await page.evaluate(()=>{T.view.text=Array.from({length:150},(_,i)=>'$ step '+i).join('\n')+'\n\n\n';renderTerminal();});
 await page.waitForTimeout(100);
 const atBottom=()=>page.$eval('#pane-screen',n=>n.scrollHeight-n.scrollTop-n.clientHeight<4);
 assert.ok(await atBottom(),'pane opens at the latest line');
 assert.equal(await page.$eval('#pane-screen',n=>n.textContent.endsWith('$ step 149')),true,'trailing blank lines trimmed');
 assert.equal(await page.locator('#pane-screen').evaluate(n=>getComputedStyle(n).backgroundColor),'rgba(0, 0, 0, 0)','pane text sits on the card');
 await keyTargets(page);
 assert.equal(await page.getByRole('button',{name:'Ctrl',exact:true}).count(),0,'Ctrl latch is SSH only');
 await page.$eval('#pane-screen',n=>{n.scrollTop=0;n.dispatchEvent(new Event('scroll'));});await page.locator('#term-jump').waitFor();
 await page.getByRole('button',{name:'跳到最新输出',exact:true}).click();await page.waitForTimeout(500);assert.ok(await atBottom());
 const fs0=await page.$eval('#pane-screen',n=>parseFloat(getComputedStyle(n).fontSize));
 await page.getByRole('button',{name:'终端选项',exact:true}).click();await page.getByRole('button',{name:'字号大一点',exact:true}).click();
 await page.getByRole('button',{name:'关闭',exact:true}).click();
 assert.ok(await page.$eval('#pane-screen',n=>parseFloat(getComputedStyle(n).fontSize))>fs0,'A+ grows the text');
 await page.getByRole('button',{name:'终端选项',exact:true}).click();await page.getByRole('button',{name:'字号小一点',exact:true}).click();
 await page.getByRole('button',{name:/^选择文字/}).click();
 assert.equal(await page.locator('.term-select').evaluate(n=>getComputedStyle(n).userSelect),'text');
 await page.getByRole('button',{name:'关闭',exact:true}).click();
 await keyboard(page,width,height,tag+'-pane');
 await page.getByRole('button',{name:'返回终端列表',exact:true}).click();

 // 3. Chat 「终端」 tab: a terminal card filling the view, monospace, latest lines in view.
 await page.locator('.bottom-nav').getByRole('button',{name:'会话',exact:true}).click();
 await page.getByRole('button',{name:/把移动端做成真正的聊天工具/}).click();
 await page.getByRole('button',{name:'终端',exact:true}).click();
 await page.getByText('离线演示，不是真实终端。',{exact:false}).waitFor();
 const card=page.locator('.term-card');
 assert.equal(await card.evaluate(n=>getComputedStyle(n).backgroundColor),rgb(bg));
 assert.match(await page.locator('#terminal-output').evaluate(n=>getComputedStyle(n).fontFamily),/Mono/);
 assert.equal(await page.getByRole('button',{name:'刷新终端',exact:true}).count(),1);
 const cb=await card.boundingBox(),body=await page.locator('#chat-scroll').boundingBox();
 assert.ok(cb.width>=body.width-40,'card spans the view');assert.ok(cb.y+cb.height<=body.y+body.height+1,'card fits the view');
 await page.evaluate(()=>{document.getElementById('terminal-output').textContent=Array.from({length:120},(_,i)=>'out '+i).join('\n');});
 await page.waitForTimeout(80);
 assert.ok(await page.$eval('#terminal-output',n=>n.scrollHeight-n.scrollTop-n.clientHeight<4),'latest lines in view');
 await page.screenshot({path:path.join(folder,'term-'+tag+'-chat.png')});
 assert.ok(await overflow(page)<=0);
 await page.getByRole('button',{name:'返回列表',exact:true}).click();

 // 4. Confirm screen: the same terminal look (presentation only).
 await page.getByRole('button',{name:/清理构建缓存/}).click();
 await page.evaluate(async()=>{await fetchTerminal(true);S.chat.qaRaw=true;renderComposer();});
 const scr=page.locator('#confirm-screen');await scr.waitFor();
 assert.equal(await scr.evaluate(n=>getComputedStyle(n).backgroundColor),rgb(bg));
 assert.match(await scr.evaluate(n=>getComputedStyle(n).fontFamily),/Mono/);
 assert.ok(await scr.evaluate(n=>n.scrollHeight-n.scrollTop-n.clientHeight<4),'confirm screen shows the last lines');
 await page.screenshot({path:path.join(folder,'term-'+tag+'-confirm.png')});
 assert.ok(await overflow(page)<=0);
 await page.context().close();
 console.log('PASS: '+tag+': SSH theme/keys/keyboard/jump/touch/ended, pane, chat 终端 card, confirm screen');}

assert.deepEqual(errors,[]);
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
