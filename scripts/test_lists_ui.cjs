// The list screens: 会话 (groups, freshness, search, project chips, swipe actions, pull to refresh,
// Herdr session switcher), 历史 (chips with counts, debounced search, endless scroll, swipe to hide),
// 终端 (SSH vs Herdr panes, running command, key bar, Ctrl latch, font size, copy) and the 新建
// sheet's recent directories. Offline: native SSH is a strict fake and `remote` a recorded fixture.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const {install}=require('./lists_fixture.cjs');

(async()=>{
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const folder=path.join(root,'ui-artifacts');fs.mkdirSync(folder,{recursive:true});
const errors=[];
async function fresh(width=390,height=844,opts={}){
 const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:2,hasTouch:true});
 const page=await context.newPage();
 page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
 await page.addInitScript(()=>{const store=new Map();window.nativeCalls=[];
  window.PocketNative={request(id,op,raw){nativeCalls.push(op);if(!['devices','demo','disconnect','protect','watchState','settings','cacheGet','cachePut'].includes(op))throw Error('Forbidden native call in offline UI test: '+op);
   const a=JSON.parse(raw||'{}');let data={};if(op==='devices')data={devices:[]};if(op==='cacheGet')data={value:store.get(a.device+'\n'+a.key)||null};if(op==='cachePut')store.set(a.device+'\n'+a.key,a.value);
   setTimeout(()=>nativeResult(id,{ok:true,data}),0);}};});
 await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
 await page.getByRole('button',{name:'体验聊天演示',exact:true}).click();
 await page.getByText('离线演示 · 示例数据，不连接电脑',{exact:true}).waitFor();
 if(opts.demo)return page;
 await install(page,opts);await page.evaluate(()=>setTab('live'));if(opts.agents!==0)await page.locator('.agent-row').first().waitFor();
 return page;}
const calls=(page,op)=>page.evaluate(op=>fx.calls.filter(c=>c.op===op).map(c=>c.args),op);
const noInput=async page=>{for(const op of ['prompt','key','closePane','exitAgent','paneRun','paneText'])assert.equal((await calls(page,op)).length,0,op+' must not be called');};
async function swipe(page,locator){
 await locator.evaluate(row=>{row.scrollIntoView({block:'center'});const r=row.getBoundingClientRect();const ev=(t,x)=>row.dispatchEvent(new PointerEvent(t,{bubbles:true,pointerType:'touch',clientX:x,clientY:r.top+20,pointerId:7,isPrimary:true}));
  ev('pointerdown',r.right-20);for(let i=1;i<=8;i++)ev('pointermove',r.right-20-i*25);ev('pointerup',r.right-220);});
 await page.waitForTimeout(300);}
async function pull(page){
 await page.evaluate(()=>{const m=document.querySelector('.main');m.scrollTop=0;const t=(type,y)=>{const touch=new Touch({identifier:1,target:m,clientX:100,clientY:y});m.dispatchEvent(new TouchEvent(type,{bubbles:true,touches:type==='touchend'?[]:[touch],changedTouches:[touch]}));};
  t('touchstart',200);for(let y=210;y<=360;y+=15)t('touchmove',y);t('touchend',360);});}
const overflow=page=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);

// 1. 会话: groups with counts, freshness, search over 8 agents, project chips.
{const page=await fresh();
 const labels=await page.$$eval('.group-label',n=>n.map(x=>x.textContent));
 assert.deepEqual(labels,['等你确认2','执行中4','空闲16']);
 await page.getByText('22 个在线',{exact:true}).waitFor();
 await page.getByText('刚刚更新',{exact:true}).waitFor();
 assert.equal(await page.locator('.agent-row').count(),22);
 // ch panes are marked as remote; the meta line names the project, not the provider again.
 assert.equal(await page.locator('.agent-row .remote-tag').count(),3);
 await page.getByRole('button',{name:'stm32_host',exact:true}).click();
 assert.equal(await page.locator('.agent-row').count(),4);
 assert.equal(await page.getByRole('button',{name:'stm32_host',exact:true}).getAttribute('aria-pressed'),'true');
 await page.getByRole('searchbox',{name:'搜索标题、项目或 Agent'}).fill('OTA');
 assert.equal(await page.locator('.agent-row').count(),1);
 await page.getByRole('searchbox').fill('没有这个');
 await page.getByText('没有匹配的 Agent',{exact:true}).waitFor();
 await page.getByRole('button',{name:'清除筛选',exact:true}).click();
 assert.equal(await page.locator('.agent-row').count(),22);
 assert.ok(await overflow(page)<=0,'live overflows');
 await page.screenshot({path:path.join(folder,'lists-live-390.png')});
 // Freshness ticks without a re-render (status polls held: with agents working the list polls every 2.5 s).
 await page.evaluate(()=>{S.statusSupported=false;const n=document.querySelector('[data-fmt="upd"]');n.dataset.since=Date.now()-42000;});
 await page.getByText('42 秒前更新',{exact:true}).waitFor({timeout:3000});
 await page.evaluate(()=>{S.statusSupported=true;});
 await noInput(page);
 await page.context().close();console.log('PASS: 会话 groups, counts, freshness, search, project chips and clear');}

// 2. Swipe a row: 关闭 / 更多 appear (hidden from assistive tech until then); the tap does not open the chat.
{const page=await fresh();
 assert.equal(await page.getByRole('button',{name:'关闭',exact:true}).count(),0,'swipe actions stay out of the a11y tree while closed');
 const row=page.locator('.agent-row').nth(6);
 await swipe(page,row);
 assert.equal(await page.locator('.swipe.open').count(),1);
 assert.equal(await page.evaluate(()=>!!S.chat),false,'a swipe never opens the chat');
 await page.locator('.swipe.open').getByRole('button',{name:'关闭',exact:true}).click();
 const sheet=page.getByRole('dialog',{name:'关闭会话'});await sheet.waitFor();
 await sheet.getByRole('button',{name:'取消',exact:true}).click();
 assert.equal(await page.locator('.swipe.open').count(),0);
 // Swiping another row closes the first; tapping an open row only closes it.
 await swipe(page,page.locator('.agent-row').nth(7));await swipe(page,page.locator('.agent-row').nth(8));
 assert.equal(await page.locator('.swipe.open').count(),1);
 await page.waitForTimeout(500);
 await page.locator('.swipe.open .agent-row').click({force:true});
 assert.equal(await page.locator('.swipe.open').count(),0);
 assert.equal(await page.evaluate(()=>!!S.chat),false);
 await page.getByText('左滑或长按一行：关闭会话、更多操作',{exact:true}).waitFor();
 await noInput(page);
 await page.context().close();console.log('PASS: swipe reveals 关闭 / 更多, one open row, never opens or closes anything by itself');}

// 3. Pull to refresh and the Herdr session switcher.
{const page=await fresh(390,844,{sessions:[{name:'default',running:true},{name:'work',running:true}]});
 const before=(await calls(page,'agents')).length;
 await pull(page);
 await page.waitForFunction(n=>fx.calls.filter(c=>c.op==='agents').length>n,before);
 await page.getByRole('button',{name:'切换 Herdr 会话 · 当前 default',exact:true}).click();
 const sheet=page.getByRole('dialog',{name:'切换 Herdr 会话'});
 assert.equal(await sheet.locator('[aria-current="true"]').count(),1);
 await sheet.getByText('当前 · 22 个 Agent',{exact:true}).waitFor();
 await sheet.getByRole('button',{name:/^work/}).click();
 await page.waitForFunction(()=>fx.calls.some(c=>c.op==='agents'&&c.args.session==='work'));
 await page.getByRole('button',{name:'切换 Herdr 会话 · 当前 work',exact:true}).waitFor();
 await page.context().close();console.log('PASS: pull to refresh re-reads agents; session switcher marks current and switches');}

// 4. Empty list: a clear next step.
{const page=await fresh(390,844,{agents:0});
 await page.evaluate(()=>{fx.agents=[];S.agents=[];loadLive();});
 await page.getByText('暂时没有会话',{exact:true}).waitFor();
 assert.equal(await page.locator('.empty').getByRole('button',{name:'新建会话',exact:true}).count(),1);
 await page.context().close();console.log('PASS: empty 会话 offers 新建会话');}

// 5. 历史: chips with counts, endless scroll, debounced search, swipe to hide.
{const page=await fresh();
 await page.evaluate(()=>setTab('history'));
 await page.locator('.history-row').first().waitFor();
 assert.equal(await page.locator('.history-row').count(),100);
 assert.equal(await page.locator('#history-filters .pill').first().textContent(),'全部240');
 assert.match(await page.getByRole('button',{name:'Codex',exact:true}).textContent(),/^Codex\d+\+$/);
 assert.equal(await page.locator('.day-label').first().textContent(),'今天');
 // Endless scroll: reaching the end loads the next page by itself.
 await page.evaluate(()=>{const m=document.querySelector('.main');m.scrollTop=m.scrollHeight;});
 await page.waitForFunction(()=>document.querySelectorAll('.history-row').length===200);
 assert.deepEqual((await calls(page,'catalog')).map(c=>c.offset),[0,100]);
 await page.evaluate(()=>{const m=document.querySelector('.main');m.scrollTop=m.scrollHeight;});
 await page.waitForFunction(()=>document.querySelectorAll('.history-row').length===240);
 await page.getByText('到底了 · 共 240 条',{exact:true}).waitFor();
 assert.equal(await page.locator('#history-filters .pill').nth(1).textContent(),'Codex80');
 // Debounced search: one read for the final text.
 const box=page.getByRole('searchbox',{name:'搜索项目、标题或会话 ID'});
 const n0=(await calls(page,'catalog')).length;
 for(const t of ['I','IM','IMU']){await box.fill(t);await page.waitForTimeout(60);}
 await page.getByText(/「IMU」找到 \d+ 条/).waitFor();
 const searches=(await calls(page,'catalog')).slice(n0);
 assert.deepEqual(searches.map(c=>c.query),['IMU']);
 await page.screenshot({path:path.join(folder,'lists-history-search-390.png')});
 await page.getByRole('button',{name:'清除搜索',exact:true}).click();
 await page.waitForFunction(()=>S.catalogQuery===''&&!S.catalogLoading);
 // Swipe → 移除 hides through the bridge list (never deletes).
 await swipe(page,page.locator('.history-row').first());
 await page.locator('.swipe.open').getByRole('button',{name:'移除',exact:true}).click();
 await page.getByText('已从列表移除，在「已隐藏」里能找回',{exact:true}).waitFor();
 assert.deepEqual((await calls(page,'hidden')).filter(c=>c.add).map(c=>c.add),[['h0']]);
 await page.getByRole('button',{name:'已隐藏 · 1',exact:true}).waitFor();
 assert.ok(await overflow(page)<=0,'history overflows');
 await noInput(page);
 await page.context().close();console.log('PASS: 历史 chips with counts, endless scroll, debounced search, swipe to hide');}

// 6. 终端: SSH vs Herdr panes, running command, key bar, font size, copy.
{const page=await fresh();
 await page.evaluate(()=>setTab('terminals'));
 await page.getByRole('button',{name:'打开 SSH 终端',exact:true}).waitFor();
 await page.locator('.term-row').nth(1).waitFor();
 const titles=await page.$$eval('.term-row:not(.ssh-row) .card-title',n=>n.map(x=>x.textContent));
 assert.deepEqual(titles,['python3 apps/host_app/server.py','空闲 shell','./gradlew assembleDebug','htop','npm run dev']);
 assert.deepEqual(await page.$$eval('.ws-label',n=>n.map(x=>x.textContent)),['工作区 · stm32_host','工作区 · herdr-pocket','工作区 · ~','工作区 · site']);
 await page.screenshot({path:path.join(folder,'lists-terminals-390.png')});
 await page.getByRole('button',{name:/npm run dev/}).click();
 await page.getByText('Herdr 窗格 · site · w4:p24',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Ctrl',exact:true}).count(),0,'Ctrl latch is SSH only');
 for(const k of ['Esc','Tab','上','下','左','右','Enter','Ctrl+C','Ctrl+D','退格'])assert.equal(await page.getByRole('toolbar',{name:'终端按键'}).getByRole('button',{name:k,exact:true}).count(),1,k);
 await page.getByText(/VITE v5/).waitFor();
 await page.getByRole('button',{name:'复制屏幕内容',exact:true}).click();
 await page.getByText('已复制',{exact:true}).waitFor();
 const size=()=>page.$eval('#pane-screen',n=>parseFloat(getComputedStyle(n).fontSize));
 const s0=await size();
 await page.getByRole('button',{name:'终端选项',exact:true}).click();
 await page.getByRole('button',{name:'字号大一点',exact:true}).click();
 assert.ok(await size()>s0,'font grows');
 await page.getByText('字号 · 15',{exact:true}).waitFor();
 await page.getByRole('button',{name:'关闭',exact:true}).click();
 for(const [w,h] of [[320,640],[844,390]]){await page.setViewportSize({width:w,height:h});const b=await page.getByRole('button',{name:'执行',exact:true}).boundingBox();assert(b.y+b.height<=h,'terminal composer clipped at '+w);assert.ok(await overflow(page)<=0);}
 await noInput(page);
 await page.context().close();console.log('PASS: 终端 list shows commands by workspace; pane key bar, copy and font size');}

// 7. SSH (demo): the Ctrl latch turns the next letter into Ctrl+letter and releases; nothing is sent in demo.
{const page=await fresh(390,844,{demo:true});
 await page.locator('.bottom-nav').getByRole('button',{name:'终端',exact:true}).click();
 await page.getByRole('button',{name:'打开 SSH 终端',exact:true}).click();
 await page.locator('.xterm-screen').waitFor();
 const ctrl=page.getByRole('button',{name:'Ctrl',exact:true});
 await ctrl.click();assert.equal(await ctrl.getAttribute('aria-pressed'),'true');
 await page.evaluate(()=>{window.sent=[];const orig=sendShell;sendShell=(e,d)=>{sent.push(d);return orig(e,d);};T.shell.term.input('c');});
 assert.deepEqual(await page.evaluate(()=>sent),['\x03']);
 assert.equal(await ctrl.getAttribute('aria-pressed'),'false');
 assert.equal(await page.evaluate(()=>T.shell.sequence),0,'demo sends nothing');
 await page.getByRole('button',{name:'返回终端列表',exact:true}).click();
 await page.getByRole('button',{name:'返回 SSH 终端',exact:true}).waitFor();
 await page.context().close();console.log('PASS: SSH Ctrl latch, demo isolation, 返回 SSH 终端');}

// 8. 新建: the directory used last time comes first next time (per computer, encrypted cache).
{const page=await fresh();
 await page.getByRole('button',{name:'新建会话',exact:true}).click();
 let sheet=page.getByRole('dialog',{name:'新建会话'});
 await sheet.getByRole('radio',{name:/^stm32_host\s?~/}).waitFor();
 assert.equal(await sheet.getByRole('radio',{name:/^stm32_host\s?~/}).getAttribute('aria-checked'),'true');
 await sheet.getByRole('button',{name:'更多目录 · 2'}).click();
 await sheet.getByRole('radio',{name:/^site\s?~\/site/}).click();
 await sheet.getByRole('radio',{name:'Claude',exact:true}).click();
 await sheet.getByRole('button',{name:'开始新建',exact:true}).click();
 assert.deepEqual((await calls(page,'create')).map(c=>[c.kind,c.cwd]),[['claude','/home/me/site']]);
 await page.waitForTimeout(1500);await page.evaluate(()=>{closeSheet();setTab('live');});await page.locator('.agent-row').first().waitFor();
 await page.getByRole('button',{name:'新建会话',exact:true}).click();
 sheet=page.getByRole('dialog',{name:'新建会话'});
 await sheet.getByRole('radio',{name:/^site\s?~\/site · 上次用的/}).waitFor();
 assert.equal(await sheet.getByRole('radio',{name:/^site\s?~/}).getAttribute('aria-checked'),'true');
 assert.equal(await sheet.getByRole('radio',{name:'Claude',exact:true}).getAttribute('aria-checked'),'true');
 assert.equal((await sheet.locator('.new-dir .menu-label').first().textContent()),'site');
 await page.screenshot({path:path.join(folder,'lists-new-recent-390.png')});
 await page.context().close();console.log('PASS: 新建 remembers the last directory and kind for this computer');}

// 9. No horizontal overflow at 320 in light and dark on all three lists.
for(const theme of ['light','dark']){const page=await fresh(320,640);await page.evaluate(t=>{document.documentElement.dataset.theme=t;},theme);
 for(const tab of ['live','history','terminals']){await page.evaluate(t=>setTab(t),tab);await page.waitForTimeout(300);assert.ok(await overflow(page)<=0,tab+' overflows at 320 '+theme);
  const wide=await page.evaluate(()=>[...document.querySelectorAll('.main *')].filter(n=>n.getBoundingClientRect().right>innerWidth+1&&!n.closest('.chips')&&!n.closest('.swipe-acts')).map(n=>n.className).slice(0,3));assert.deepEqual(wide,[],tab+' content wider than 320 '+theme);}
 await page.screenshot({path:path.join(folder,'lists-terminals-320-'+theme+'.png')});
 await page.context().close();}
console.log('PASS: lists fit 320 in light and dark');

assert.deepEqual(errors,[]);
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
