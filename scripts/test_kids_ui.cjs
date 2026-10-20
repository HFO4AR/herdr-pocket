// Sub-agents (kids.js): a parent that Herdr calls idle while its sub-agents run shows as
// 子 Agent 运行中 (grouped with 执行中, never 已完成), the row's chip expands its sub-agents and opens
// one read-only, the chat's 切换 Agent sheet lists them running-first and updates while open, the
// background watcher gets the same state, and the tablet two-pane layout keeps working.
// Offline: native SSH is a strict fake and `remote` the list fixture plus sub-agent reports.
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
 await install(page,opts);
 // Sub-agent reports: agent 2 (idle, local) has two running of three; agent 3 (a ch pane) one running.
 await page.evaluate(()=>{
  const now=Date.now()/1000;
  const kid=(id,title,running,ago)=>({id,thread:id+'-thread',provider:'claude',parent:'t2',title,role:'general-purpose',cwd:'/home/me/IterxAI/stm32_host',modified:now-ago,running,state:running?'running':'done'});
  fx.kids={r2:{total:3,running:2,stamp:'a',items:[kid('k3','整理日志格式',false,900),kid('k1','补接口回归用例',true,20),kid('k2','检查暗色模式对比度',true,50)]}};
  fx.remoteKids={r3:{total:1,running:1,stamp:'b',items:[{...kid('remote:abc:k9','远端：跑完整测试',true,30),remote:{session:'x'}}]}};
  const ch=fx.agents[3].history_ref;ch.record.thread='t3';
  const base=remote,none={total:0,running:0,items:[]};
  remote=async(op,args={})=>{const r=await base(op,args);
   if(op==='glance')for(const it of args.items||[]){const id=String(it.record_id);
    if(it.remote)r.previews[it.key]={kids_only:true,kids:fx.remoteKids[id]||none};
    else if(it.kids)r.previews[it.key]={...(r.previews[it.key]||{missing:true}),kids:fx.kids[id]||none};}
   if(op==='history'){const id=args.record_id;if(fx.kids[id])r.kids=JSON.parse(JSON.stringify(fx.kids[id]));
    const k=Object.values(fx.kids).flatMap(x=>x.items).find(x=>x.id===id);if(k){r.kid={running:k.running};r.record=k;}}
   return r;};
  setTab('live');});
 await page.locator('.agent-row').first().waitFor();
 return page;}
const calls=(page,op)=>page.evaluate(op=>fx.calls.filter(c=>c.op===op).map(c=>c.args),op);
const noInput=async page=>{for(const op of ['prompt','key','answer','closePane','exitAgent','paneRun','paneText','paneKey'])assert.equal((await calls(page,op)).length,0,op+' must not be called');};
const overflow=page=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
const rowOf=(page,title)=>page.locator('.agent-row',{has:page.locator('.card-title',{hasText:title})});
const groupOf=(page,title)=>rowOf(page,title).evaluate(n=>{let c=n.closest('.list-card');while(c&&!c.classList.contains('group-label'))c=c.previousElementSibling;return c?c.firstChild.textContent:'';});
const finish=page=>page.evaluate(()=>{const r=fx.kids.r2;r.items.forEach(x=>{x.running=false;x.state='done';});r.running=0;r.stamp='done';});

// 1. State: idle parents with running sub-agents are working, the chip says how many, the ch pane too.
{const page=await fresh();
 await page.getByRole('button',{name:'子 Agent 3 · 2 运行中，展开',exact:true}).waitFor();
 assert.equal(await groupOf(page,'整理串口日志解析'),'执行中');
 assert.equal(await rowOf(page,'整理串口日志解析').locator('.row-state').count(),0,'never 已完成 while sub-agents run');
 assert.ok(await rowOf(page,'整理串口日志解析').locator('.avatar .status-dot.work').count(),'amber dot');
 assert.equal(await page.evaluate(()=>stateLabel(S.agents[2])),'子 Agent 运行中 · 2');
 // The ch pane is asked separately (remote helper), with its record and remote context.
 await page.getByRole('button',{name:'子 Agent 1 · 1 运行中，展开',exact:true}).waitFor();
 assert.equal(await groupOf(page,'CAM 预处理参数对齐'),'执行中');
 const asked=(await calls(page,'glance')).flatMap(x=>x.items);
 assert.ok(asked.some(x=>x.remote&&x.record_id==='r3'&&x.thread==='t3'&&x.kids),'ch pane asked for its sub-agents');
 assert.ok(asked.filter(x=>!x.remote).every(x=>x.kids===true),'local items ask for sub-agents too');
 const glances=await calls(page,'glance');assert.ok(glances.every(g=>g.items.every(x=>!!x.remote)||g.items.every(x=>!x.remote)),'remote and local never share a request');
 // The background watcher gets the same state plus what to check before saying 做完了.
 const watch=await page.evaluate(()=>watchArgs.at(-1));
 assert.equal(watch.states['w3:p3/id2'],'kids');
 assert.deepEqual(Object.keys(watch.kids['w3:p3/id2']).sort(),['cwd','kids','provider','record_id','thread']);
 assert.equal(watch.kids['w4:p4/id3'].remote.session,'x');
 assert.ok(await overflow(page)<=0,'live overflows');
 await page.screenshot({path:path.join(folder,'kids-live-390.png')});
 // Expand: running first, then the finished one, each opens read-only; back returns to the list.
 await page.getByRole('button',{name:'子 Agent 3 · 2 运行中，展开',exact:true}).click();
 const names=await page.locator('.kids-strip.open .kid-row').evaluateAll(ns=>ns.map(n=>n.getAttribute('aria-label')));
 assert.deepEqual(names,['补接口回归用例，运行中，打开只读记录','检查暗色模式对比度，运行中，打开只读记录','整理日志格式，已结束，打开只读记录']);
 const tall=await page.$$eval('.kids-strip.open .kid-row, .kids-chip',ns=>ns.map(n=>n.getBoundingClientRect().height));
 assert.ok(Math.min(...tall)>=44,'touch targets: '+tall);
 assert.ok(await overflow(page)<=0,'expanded overflows');
 await page.screenshot({path:path.join(folder,'kids-expanded-390.png')});
 await page.getByRole('button',{name:'补接口回归用例，运行中，打开只读记录',exact:true}).click();
 await page.locator('#chat-meta',{hasText:'子 Agent · 运行中 · Claude · 历史只读'}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'消息输入框',exact:true}).count(),0,'read-only');
 assert.equal((await calls(page,'history')).at(-1).record_id,'k1');
 await page.getByRole('button',{name:'返回列表',exact:true}).click();
 await page.getByRole('button',{name:'子 Agent 3 · 2 运行中，收起',exact:true}).waitFor();
 // Sub-agents finish: back to 空闲, unread, a 做完了 toast; the chip stays (3 sub-agents, none running).
 await finish(page);await page.evaluate(()=>glanceRefresh());
 await page.getByText('「整理串口日志解析」做完了',{exact:true}).waitFor();
 await page.getByRole('button',{name:'子 Agent 3，收起',exact:true}).waitFor();
 assert.equal(await groupOf(page,'整理串口日志解析'),'空闲');
 assert.ok(await rowOf(page,'整理串口日志解析').evaluate(n=>n.classList.contains('unread')));
 assert.equal(await page.evaluate(()=>watchArgs.at(-1).states['w3:p3/id2']),'idle');
 await noInput(page);
 await page.context().close();}

// 2. Chat: header state, the 切换 Agent sheet running-first and live while open.
{const page=await fresh();
 await page.getByRole('button',{name:'子 Agent 3 · 2 运行中，展开',exact:true}).waitFor();
 await rowOf(page,'整理串口日志解析').click();
 await page.locator('#chat-meta .meta-state',{hasText:'子 Agent 运行中 · 2'}).waitFor();
 assert.equal(await page.$eval('#chat-dot',n=>n.className),'status-dot work');
 assert.equal(await page.$eval('#child-count',n=>n.textContent+'/'+n.className),'2/icon-count kids-on');
 await page.getByRole('button',{name:'切换 Agent',exact:true}).click();
 await page.locator('.kids-sheet-head',{hasText:'这段对话的子 Agent · 3'}).waitFor();
 await page.locator('.kids-sheet-head .badge',{hasText:'2 个运行中'}).waitFor();
 const order=await page.locator('#kids-sheet .kid-row .kid-title').allTextContents();
 assert.deepEqual(order,['补接口回归用例','检查暗色模式对比度','整理日志格式']);
 // The agent list in the sheet says the same as the list.
 assert.ok(await page.locator('.agent-pick .badge',{hasText:'子 Agent · 2'}).count());
 await page.screenshot({path:path.join(folder,'kids-sheet-390.png')});
 // One finishes; the next history poll updates the open sheet in place.
 await page.evaluate(()=>{const r=fx.kids.r2;r.items[1].running=false;r.items[1].state='done';r.running=1;r.stamp='one';fetchHistory();});
 await page.locator('.kids-sheet-head .badge',{hasText:'1 个运行中'}).waitFor();
 assert.deepEqual(await page.locator('#kids-sheet .kid-row.running .kid-title').allTextContents(),['检查暗色模式对比度']);
 assert.equal(await page.locator('#chat-meta .meta-state').textContent().then(t=>t.startsWith('子 Agent 运行中 · 1')),true);
 // All done: no 做完了 flash/toast while viewing, the header says 空闲.
 await finish(page);await page.evaluate(()=>fetchHistory());
 await page.locator('.kids-sheet-head .badge').waitFor({state:'detached'});
 await page.locator('#chat-meta .meta-state',{hasText:'空闲'}).waitFor();
 await page.locator('#kids-sheet .kid-row').first().click();
 await page.locator('#chat-meta',{hasText:'子 Agent · Claude · 历史只读'}).waitFor();
 await page.getByRole('button',{name:'返回列表',exact:true}).click();
 await page.locator('#chat-meta .meta-state',{hasText:'空闲'}).waitFor();
 await noInput(page);
 await page.context().close();}

// 3. Small and dark: no overflow at 320, the chip and list read well in dark.
for(const [w,h,dark] of [[320,640,false],[390,844,true],[320,640,true]]){
 const page=await fresh(w,h,{dark});
 await page.getByRole('button',{name:'子 Agent 3 · 2 运行中，展开',exact:true}).click();
 await page.locator('.kids-strip.open .kid-row').first().waitFor();
 assert.ok(await overflow(page)<=0,'overflow at '+w);
 const wide=await page.evaluate(()=>[...document.querySelectorAll('.kids-strip *')].filter(n=>n.getBoundingClientRect().right>innerWidth+1).map(n=>n.className));
 assert.deepEqual(wide,[]);
 await rowOf(page,'整理串口日志解析').scrollIntoViewIfNeeded();await page.waitForTimeout(250);
 await page.screenshot({path:path.join(folder,'kids-'+w+(dark?'-dark':'')+'.png')});
 await page.context().close();}

// 4. Tablet: two panes keep the strip in the list while a chat is open; finishing repaints the list.
{const page=await fresh(1024,768);
 await page.getByRole('button',{name:'子 Agent 3 · 2 运行中，展开',exact:true}).waitFor();
 assert.ok(await page.locator('.wide-frame').count(),'two panes');
 await rowOf(page,'整理串口日志解析').click();
 await page.locator('.wide-detail #chat-meta .meta-state',{hasText:'子 Agent 运行中 · 2'}).waitFor();
 assert.ok(await page.locator('.wide-list .kids-strip').count(),'list keeps the strip');
 await finish(page);await page.evaluate(()=>fetchHistory());
 await page.locator('.wide-detail #chat-meta .meta-state',{hasText:'空闲'}).waitFor();
 await page.waitForFunction(()=>{const r=[...document.querySelectorAll('.wide-list .agent-row')].find(n=>n.textContent.includes('整理串口日志解析'));let c=r?.closest('.list-card');while(c&&!c.classList.contains('group-label'))c=c.previousElementSibling;return c?.firstChild.textContent==='空闲';});
 assert.ok(await overflow(page)<=0,'tablet overflows');
 await page.screenshot({path:path.join(folder,'kids-tablet.png')});
 await noInput(page);
 await page.context().close();}

// 5. A parent blocked inside a foreground Agent call reads "working" in Herdr, and the bridge's
// kids report says waiting: the phone treats it as held by its sub-agents, so a message goes to the
// parent pane at once (Claude queues it) without Esc. A parent working on its own still queues.
{const page=await fresh();
 await page.getByRole('button',{name:'子 Agent 3 · 2 运行中，展开',exact:true}).waitFor();
 await page.evaluate(()=>{
  fx.agents=fx.agents.map((a,i)=>i===2?{...a,agent_status:'working'}:a);
  fx.kids.r2.waiting=true;
  const base=remote;
  remote=async(op,args={})=>{if(op==='prompt'){fx.calls.push({op,args});return{sent:true,receipt:args.id};}return base(op,args);};
 });
 await page.evaluate(async()=>{S.statusBusy=false;await refreshStatus();await glanceRefresh();});
 await page.waitForFunction(()=>agentState(S.agents[2])==='kids');
 assert.equal(await page.evaluate(()=>stateLabel(S.agents[2])),'子 Agent 运行中 · 2');
 assert.equal(await groupOf(page,'整理串口日志解析'),'执行中');
 await rowOf(page,'整理串口日志解析').click();
 await page.locator('#chat-meta .meta-state',{hasText:'子 Agent 运行中 · 2'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'发送消息',exact:true}).getAttribute('title'),'发送','not a queue button');
 await page.getByRole('textbox',{name:'消息输入框',exact:true}).fill('等子 Agent 时直接发');
 await page.getByRole('button',{name:'发送消息',exact:true}).click();
 const sent=await page.evaluate(async()=>{for(let i=0;i<80&&!fx.calls.some(c=>c.op==='prompt');i++)await new Promise(r=>setTimeout(r,50));return fx.calls.filter(c=>c.op==='prompt');});
 assert.equal(sent.length,1,'sent once');
 assert.equal(sent[0].args.target,'w3:p3','the parent pane');
 assert.equal(sent[0].args.identity,'id2','the parent agent');
 assert.equal(sent[0].args.text,'等子 Agent 时直接发');
 assert.equal(await page.locator('.message.queued').count(),0,'not queued');
 assert.equal((await calls(page,'key')).length,0,'no Esc');
 // Nothing says waiting any more: a working parent queues the next message as before.
 await page.evaluate(async()=>{fx.kids.r2.waiting=false;await glanceRefresh();});
 await page.waitForFunction(()=>agentState(S.chat.agent)==='working');
 await page.getByRole('textbox',{name:'消息输入框',exact:true}).fill('它自己也在干活');
 await page.getByRole('button',{name:'发送消息',exact:true}).click();
 await page.locator('.message.queued').filter({hasText:'它自己也在干活'}).getByText('排队中 · 等它停下再发',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>fx.calls.filter(c=>c.op==='prompt').length),1,'no prompt while it works');
 // An automatic status refresh that repaints the list must keep the reading position and must
 // not replay the entrance animation (that was the quick jump to the top / flicker).
 await page.getByRole('button',{name:'返回列表',exact:true}).click();
 await page.evaluate(()=>{document.querySelector('.main').scrollTop=500;});
 const before=await page.evaluate(()=>document.querySelector('.main').scrollTop);
 assert(before>0,'list scrolled');
 await page.evaluate(async()=>{fx.agents=fx.agents.map((a,i)=>i===4?{...a,agent_status:a.agent_status==='idle'?'done':'idle'}:a);S.statusBusy=false;await refreshStatus();});
 const after=await page.evaluate(()=>document.querySelector('.main').scrollTop);
 assert(Math.abs(after-before)<2,'scroll kept on refresh: '+before+' → '+after);
 assert.equal(await page.evaluate(()=>document.querySelector('.main').classList.contains('pane-enter')),false,'no entrance replay');
 await page.context().close();}

await browser.close();
assert.deepEqual(errors,[]);
console.log('PASS: sub-agents keep parents working, chip expands and opens read-only, chat sheet live, watcher state, tablet, waiting parent takes a message');
})().catch(e=>{console.error(e);process.exit(1);});
