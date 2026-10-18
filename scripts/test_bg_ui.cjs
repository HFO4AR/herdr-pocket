// Background work (bg.js): an idle Claude whose background shells still run reads 后台运行中 (with
// 执行中, never 已完成) and the watcher holds it; a Codex terminal is shown but never holds; the row
// gets a 「后台 N」 chip beside the sub-agent chip; the 「后台任务」 sheet lists running first; a task
// opens a read-only output viewer (bgOutput, one read per open/refresh) that keeps to the end;
// the chat's footer rail and status line say so; light/dark, 320 px, demo. Nothing is sent.
// Offline: native SSH is a strict fake and `remote` the list fixture plus background reports.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const {install}=require('./lists_fixture.cjs');

(async()=>{
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const folder=path.join(root,'ui-artifacts');fs.mkdirSync(folder,{recursive:true});
const errors=[];
async function boot(width,height,opts){
 const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:2,hasTouch:true,colorScheme:opts.dark?'dark':'light'});
 const page=await context.newPage();
 page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
 await page.addInitScript(()=>{window.nativeCalls=[];window.watchArgs=[];
  window.PocketNative={request(id,op,raw){nativeCalls.push(op);if(!['devices','demo','disconnect','protect','watchState','settings','cacheGet','cachePut'].includes(op))throw Error('Forbidden native call in offline UI test: '+op);
   if(op==='watchState')watchArgs.push(JSON.parse(raw));
   setTimeout(()=>nativeResult(id,{ok:true,data:op==='devices'?{devices:[]}:op==='cacheGet'?{value:null}:{}}),0);}};});
 await page.goto(require('./ui_bundle.cjs').url(html));
 if(opts.dark)await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
 await page.getByRole('button',{name:'体验聊天演示',exact:true}).click();
 await page.getByText('离线演示 · 示例数据，不连接电脑',{exact:true}).waitFor();
 return page;}
async function fresh(width=390,height=844,opts={}){
 const page=await boot(width,height,opts);
 await install(page,opts);
 // r2: idle Claude, a build and a monitor running, two finished. r4: idle Codex, one terminal. r3: a ch pane.
 await page.evaluate(()=>{
  const now=Date.now()/1000;
  const task=(id,kind,title,command,state,ago,extra={})=>({id,kind,title,command,started:now-ago,state,running:state==='running',output:true,...extra});
  fx.bg={r2:{total:4,running:2,hold:2,stamp:'a',items:[
    task('bfin','shell','构建 Android 包','./gradlew assembleDebug','completed',3000,{exit:0,ended:now-2700}),
    task('bbuild','shell','跑完整测试','python3 -m unittest discover -s tests -v','running',200),
    task('blint','shell','检查代码风格','npm run lint','failed',4000,{exit:1,ended:now-3950}),
    task('bmon','monitor','等 CI 结果','until gh run view --exit-status; do sleep 30; done','running',900,{timeout:1800,events:2})]},
   r4:{total:1,running:1,hold:0,stamp:'c',items:[task('41001','terminal','npm run dev -- --port 5173','npm run dev -- --port 5173','running',600)]}};
  fx.remoteBg={total:1,running:1,hold:1,stamp:'r',items:[task('bfar','shell','远端：跑固件构建','python3 scripts/firmware.py build','running',120)]};
  fx.out={bbuild:{state:'running',source:'file',text:Array.from({length:400},(_,i)=>'test_case_'+i+' ... ok').join('\n')+'\nRan 400 tests\n',size:9000,truncated:false,mtime:now-3},
   bmon:{state:'running',source:'events',text:'[09:41] CI 排队中\n[09:44] CI 运行中：3/7 步',truncated:false},
   blint:{state:'failed',source:'file',text:'src/app.js:12:5  error  缺少分号\n✖ 1 个问题\n',size:60,truncated:false,mtime:now-3950}};
  fx.agents[3].history_ref.record.thread='t3';
  const base=remote,none={total:0,running:0,hold:0,items:[],stamp:'0'};
  remote=async(op,args={})=>{
   if(op==='bgOutput'){fx.calls.push({op,args});await new Promise(r=>setTimeout(r,30));const o=fx.out[args.task];if(!o)throw Error('这段对话里没有这个后台任务');return {task:args.task,...o};}
   const r=await base(op,args);
   if(op==='glance')for(const it of args.items||[]){const id=String(it.record_id);
    if(it.remote)r.previews[it.key]={kids_only:true,kids:{total:0,running:0,items:[]},bg:it.bg?fx.remoteBg:undefined};
    else if(it.bg)r.previews[it.key]={...(r.previews[it.key]||{missing:true}),bg:fx.bg[id]?(it.bg_stamp===fx.bg[id].stamp?{same:true,running:fx.bg[id].running,hold:fx.bg[id].hold}:fx.bg[id]):none};}
   if(op==='history'&&fx.bg[args.record_id])r.bg=JSON.parse(JSON.stringify(fx.bg[args.record_id]));
   return r;};
  setTab('live');});
 await page.locator('.agent-row').first().waitFor();
 return page;}
// Polls every 100 ms (rAF polling stalls in a busy headless page).
const until=(page,fn)=>page.waitForFunction(fn,null,{polling:100});
const calls=(page,op)=>page.evaluate(op=>fx.calls.filter(c=>c.op===op).map(c=>c.args),op);
const noInput=async page=>{for(const op of ['prompt','key','answer','closePane','exitAgent','paneRun','paneText','paneKey'])assert.equal((await calls(page,op)).length,0,op+' must not be called');};
const overflow=page=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
const rowOf=(page,title)=>page.locator('.agent-row',{has:page.locator('.card-title',{hasText:title})});
const groupOf=(page,title)=>rowOf(page,title).evaluate(n=>{let c=n.closest('.list-card');while(c&&!c.classList.contains('group-label'))c=c.previousElementSibling;return c?c.firstChild.textContent:'';});
const finish=page=>page.evaluate(()=>{const r=fx.bg.r2;r.items.forEach(x=>{if(x.running){x.running=false;x.state='completed';x.exit=0;}});r.running=0;r.hold=0;r.stamp='done';});
const chipOf=(page,n)=>page.getByRole('button',{name:'后台任务 '+n+' 个运行中，点开查看',exact:true});

// 1. List: held vs shown, one chip group per row, the watcher asks for it, ch panes too.
{const page=await fresh();
 await until(page,()=>stateLabel(S.agents[2])==='后台运行中 · 2');
 assert.equal(await groupOf(page,'整理串口日志解析'),'执行中');
 assert.equal(await rowOf(page,'整理串口日志解析').locator('.row-state').count(),0,'never 已完成 while background shells run');
 // Codex: a dev server keeps running but Codex does not wake for it — 空闲, with the chip.
 await until(page,()=>bgRunning(S.agents[4])===1);
 assert.equal(await groupOf(page,'补齐 Host 回归测试'),'空闲');
 const strip=page.locator('.kids-strip',{has:chipOf(page,1)});
 await strip.first().waitFor();
 // The ch pane: asked through the remote read, with bg.
 await until(page,()=>bgHold(S.agents[3])===1);
 const asked=(await calls(page,'glance')).flatMap(x=>x.items);
 assert.ok(asked.filter(x=>!x.remote).every(x=>x.bg===true),'local items ask for background work');
 assert.ok(asked.some(x=>x.remote&&x.bg),'ch pane asked too');
 const watch=await page.evaluate(()=>watchArgs.at(-1));
 assert.equal(watch.states['w3:p3/id2'],'kids','the watcher holds it');
 assert.equal(watch.states['w1:p5/id4'],'idle','a Codex terminal never holds');
 const row2=page.locator('.kids-strip[data-kids="default/id2"]');
 await row2.locator('.bg-chip').waitFor();
 const h=await page.$$eval('.bg-chip',ns=>ns.map(n=>n.getBoundingClientRect().height));
 assert.ok(Math.min(...h)>=44,'touch targets: '+h);
 assert.ok(await overflow(page)<=0,'live overflows');
 await page.screenshot({path:path.join(folder,'bg-live-390.png')});
 // Sheet: running first, then finished; failed shows its exit code.
 await row2.locator('.bg-chip').click();
 await page.locator('#bg-sheet .bg-lead',{hasText:'2 个还在跑，跑完 Agent 会接着处理'}).waitFor();
 assert.deepEqual(await page.locator('#bg-sheet .bg-row .bg-title').allTextContents(),['跑完整测试','等 CI 结果','构建 Android 包','检查代码风格']);
 assert.deepEqual(await page.locator('#bg-sheet .bg-head > span:first-child').allTextContents(),['运行中','已结束']);
 const subs=await page.locator('#bg-sheet .bg-sub').allTextContents();
 assert.ok(subs[0].startsWith('后台命令 · 运行中 · '),subs[0]);assert.ok(subs[1].startsWith('监视器 · 运行中'),subs[1]);
 assert.ok(subs[3].includes('失败 · 退出码 1'),subs[3]);assert.ok(!subs[2].includes('退出码'),'exit 0 is not worth saying: '+subs[2]);
 assert.equal(await page.getByRole('button',{name:/停止|结束|kill/i}).count(),0,'read-only: no stop button');
 assert.ok(await overflow(page)<=0,'sheet overflows');
 await page.screenshot({path:path.join(folder,'bg-sheet-390.png')});
 // Viewer: one read on open, monospace, at the end; refresh reads again; back returns to the sheet.
 await page.getByRole('button',{name:/^跑完整测试，后台命令/}).click();
 await page.locator('#bg-view .bg-pre',{hasText:'Ran 400 tests'}).waitFor();
 let reads=await calls(page,'bgOutput');
 assert.equal(reads.length,1);assert.deepEqual({...reads[0]},{provider:'claude',thread:'t2',record_id:'r2',cwd:'/mnt/E/project/ch-cli',task:'bbuild'});
 await until(page,()=>{const c=document.querySelector('#bg-view .bg-out');return c&&c.scrollHeight>c.clientHeight&&c.scrollHeight-c.scrollTop-c.clientHeight<4;});
 assert.match(await page.$eval('#bg-view .bg-pre',n=>getComputedStyle(n).fontFamily),/mono/i);
 await page.locator('#bg-view .fv-status .badge',{hasText:'运行中'}).waitFor();
 await page.screenshot({path:path.join(folder,'bg-view-390.png')});
 await page.getByRole('button',{name:'刷新',exact:true}).click();
 await until(page,()=>fx.calls.filter(c=>c.op==='bgOutput').length>=2);
 await page.getByRole('button',{name:'复制',exact:true}).click();await page.getByText('已复制',{exact:true}).waitFor();
 await page.getByRole('button',{name:'返回后台任务',exact:true}).click();
 await page.locator('#bg-sheet .bg-row').first().waitFor();
 // Errors stay in the viewer.
 await page.evaluate(()=>{delete fx.out.blint;});
 await page.getByRole('button',{name:/^检查代码风格，/}).click();
 await page.locator('#bg-view .fv-error',{hasText:'这段对话里没有这个后台任务'}).waitFor();
 await page.evaluate(()=>closeSheet());
 // Everything finishes: 做完了, back to 空闲, the chip goes away.
 await finish(page);await page.evaluate(()=>glanceRefresh());
 await page.getByText('「整理串口日志解析」做完了',{exact:true}).waitFor();
 assert.equal(await groupOf(page,'整理串口日志解析'),'空闲');
 await page.locator('.kids-strip[data-kids="default/id2"]').waitFor({state:'detached'});
 await until(page,()=>watchArgs.at(-1).states['w3:p3/id2']==='idle');
 await noInput(page);
 await page.context().close();}

// 2. Chat: the status line and the footer rail; the sheet opens from the rail; history keeps it current.
{const page=await fresh();
 await until(page,()=>bgHold(S.agents[2])===2);
 await rowOf(page,'整理串口日志解析').click();
 await page.locator('#chat-meta .meta-state',{hasText:'后台运行中 · 2'}).waitFor();
 const lead=page.locator('#foot-rail .foot-lead.t-bg');await lead.waitFor();
 assert.equal(await lead.locator('strong').textContent(),'后台运行中 · 2');
 assert.equal(await lead.locator('.foot-detail').textContent(),'跑完整测试');
 assert.equal(await page.locator('#foot-rail .t-done').count(),0,'no 做完了 while it will wake again');
 assert.ok(await overflow(page)<=0,'chat overflows');
 await page.screenshot({path:path.join(folder,'bg-chat-390.png')});
 await lead.click();
 await page.locator('#bg-sheet .bg-row').first().waitFor();
 // One finishes; the next history poll repaints the open sheet.
 await page.evaluate(()=>{const r=fx.bg.r2;const b=r.items.find(x=>x.id==='bbuild');b.running=false;b.state='completed';b.exit=0;r.running=1;r.hold=1;r.stamp='one';fetchHistory();});
 await page.locator('#bg-sheet .bg-lead',{hasText:'1 个还在跑'}).waitFor();
 await page.evaluate(()=>closeSheet());
 await page.locator('#foot-rail .foot-lead.t-bg strong',{hasText:'后台运行中 · 1'}).waitFor();
 await finish(page);await page.evaluate(()=>fetchHistory());
 await page.locator('#foot-rail .t-bg').waitFor({state:'detached'});
 await page.locator('#chat-meta .meta-state',{hasText:'空闲'}).waitFor();
 await noInput(page);
 await page.context().close();}

// 3. Small and dark: no overflow at 320; chip, sheet and viewer read in both themes.
for(const [w,h,dark] of [[320,640,false],[390,844,true],[320,640,true]]){
 const page=await fresh(w,h,{dark});
 const chip=page.locator('.kids-strip[data-kids="default/id2"] .bg-chip');await chip.waitFor();
 assert.ok(await overflow(page)<=0,'overflow at '+w);
 const wide=await page.evaluate(()=>[...document.querySelectorAll('.kids-strip *')].filter(n=>n.getBoundingClientRect().right>innerWidth+1).map(n=>n.className));
 assert.deepEqual(wide,[]);
 await chip.scrollIntoViewIfNeeded();await page.waitForTimeout(250);
 await page.screenshot({path:path.join(folder,'bg-live-'+w+(dark?'-dark':'')+'.png')});
 await chip.click();await page.locator('#bg-sheet .bg-row').first().waitFor();await page.waitForTimeout(350);
 const off=await page.evaluate(()=>[...document.querySelectorAll('#bg-sheet *')].filter(n=>n.getBoundingClientRect().right>innerWidth+1).map(n=>n.className));
 assert.deepEqual(off,[],'sheet fits at '+w);
 await page.screenshot({path:path.join(folder,'bg-sheet-'+w+(dark?'-dark':'')+'.png')});
 await page.getByRole('button',{name:/^等 CI 结果，监视器/}).click();
 await page.locator('#bg-view .bg-pre',{hasText:'CI 运行中'}).waitFor();
 await page.locator('#bg-view .fv-status',{hasText:'监视器最近的事件'}).waitFor();await page.waitForTimeout(300);
 assert.ok(await overflow(page)<=0,'viewer overflow at '+w);
 await page.screenshot({path:path.join(folder,'bg-view-'+w+(dark?'-dark':'')+'.png')});
 await page.context().close();}

// 4. Demo: Claude's demo chat shows its background work while it works (a chip, not the lead).
{const page=await boot(390,844,{});
 await page.getByText('对话的阅读体验',{exact:false}).first().waitFor().catch(()=>{});
 const a=await page.evaluate(()=>S.agents.findIndex(x=>x.agent==='claude'&&x.agent_status==='working'));
 assert.ok(a>=0,'demo has a working Claude');
 await page.evaluate(i=>openAgent(S.agents[i]),a);
 const chip=page.locator('#foot-rail .foot-chip.t-bg');await chip.waitFor();
 assert.equal((await chip.textContent()).trim(),'后台 2');
 await chip.click();
 await page.getByRole('button',{name:/^跑完整测试，后台命令/}).click();
 await page.locator('#bg-view .bg-pre',{hasText:'test_case_60 ... ok'}).waitFor();
 await page.screenshot({path:path.join(folder,'bg-demo-view.png')});
 await page.context().close();}

await browser.close();
assert.deepEqual(errors,[]);
console.log('PASS: background work holds Claude (not Codex), chip beside sub-agents, sheet running-first, read-only viewer, chat rail, 320/dark, demo');
})().catch(e=>{console.error(e);process.exit(1);});
