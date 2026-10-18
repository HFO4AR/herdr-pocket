// Agent questions reach the phone fast, and can be closed without answering.
//  · Latency (fake clock, measured op delays): from the moment Herdr reports the new state until
//    the question card is on screen — Codex async (idle + transcript call) and a blocked menu.
//  · 暂不回答 (Codex async): nothing is sent, the card folds into the history row and a bar above
//    the input, a normal message is fine, and the question can still be answered later.
//  · 关闭 (blocked TUI menus): 先收起 only hides it; Esc goes out only after a confirmation that
//    says what Esc means on that dialog, and only if the same dialog is still on screen.
//  · The 会话 list puts an idle Codex with an unanswered question with the ones waiting for you.
// Offline: native SSH is a strict fake and `remote` a recorded fixture. Menus come from the real
// bridge parser. UI_ROOT=<dir> LATENCY_ONLY=1 measures another tree (used for before/after numbers).
const {chromium}=require('playwright');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const uiRoot=process.env.UI_ROOT||root,latencyOnly=!!process.env.LATENCY_ONLY;
const RULE='─'.repeat(64);
const SCREENS={
 claude:[RULE,'←  ☐ 日志位置  ✔ Submit  →','','运行日志放在哪里？','','❯ 1. 写到项目目录（推荐）','     放在 logs/ 下。','  2. 写到系统临时目录','  3. Type something.',RULE,'  4. Chat about this','','Enter to select · Tab/Arrow keys to navigate · Esc to cancel'].join('\n'),
 claude2:[RULE,'←  ☐ 日志位置  ✔ Submit  →','','日志要保留几天？','','❯ 1. 7 天','  2. 30 天','  3. Type something.',RULE,'  4. Chat about this','','Enter to select · Tab/Arrow keys to navigate · Esc to cancel'].join('\n'),
 bash:['● 我先清掉旧的构建结果。','',RULE,' Bash command','','   rm -rf dist .cache','',' Do you want to proceed?',' ❯ 1. Yes','   2. Yes, and don\'t ask again for rm commands','   3. No, and tell Claude what to do differently (esc)','',' Esc to cancel · Tab to amend · ctrl+e to explain'].join('\n'),
 codexq:['  Question 1/1','  消息顺序','  Agent 正在工作时，新发的消息怎么处理？','','  › 1. 按顺序等待 (Recommended)  进入队列，这一轮结束后再发。','    2. 立即追加                  直接交给正在运行的 Agent。','    3. None of the above         Optionally, add details in notes (tab).','','  tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt'].join('\n'),
};
const menus=JSON.parse(execFileSync('python3',['-c',`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('b',sys.argv[1]);b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
print(json.dumps({k:b.parse_menu(v,'codex' if k.startswith('codex') else 'claude') for k,v in json.loads(sys.argv[2]).items()},ensure_ascii=False))`,path.join(root,'bridge/pocket_bridge.py'),JSON.stringify(SCREENS)],{encoding:'utf8'}));
for(const [k,m] of Object.entries(menus))assert(m&&m.cursor,'bridge parsed '+k);
// Measured on the host (bridge over a local SSH hop): status ~0.1 s, history ~0.3 s, screen read ~0.5 s.
const LAT={status:100,agents:150,sessions:80,history:300,read:470,glance:100};

(async()=>{
const html=require('./ui_bundle.cjs')(uiRoot);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const folder=path.join(root,'ui-artifacts');fs.mkdirSync(folder,{recursive:true});
const errors=[];
async function fresh({width=390,height=844,dark=false,clock=false}={}){
 const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:2,colorScheme:dark?'dark':'light'});
 const page=await context.newPage();page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
 if(clock)await page.clock.install({time:new Date('2026-10-15T10:00:00Z')});
 await page.addInitScript(()=>{window.nativeCalls=[];window.cacheStore=new Map();
  window.PocketNative={request(id,op,raw){nativeCalls.push(op);if(!['devices','demo','disconnect','protect','watchState','settings','cacheGet','cachePut'].includes(op))throw Error('Forbidden native call in offline UI test: '+op);
   const a=JSON.parse(raw||'{}');let data=op==='devices'?{devices:[]}:{};
   if(op==='cachePut')cacheStore.set(a.key,a.value);if(op==='cacheGet')data={value:cacheStore.get(a.key)||null};
   setTimeout(()=>nativeResult(id,{ok:true,data}),0);}};});
 await page.goto(require('./ui_bundle.cjs').url(html));
 if(dark)await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
 await page.getByRole('button',{name:'体验聊天演示',exact:true}).click();
 await page.getByText('离线演示 · 示例数据，不连接电脑',{exact:true}).waitFor();
 await page.evaluate(({menus,screens,LAT,ASYNC})=>{
  const t=n=>new Date(Date.UTC(2026,9,15,9,n)).toISOString();
  window.msg=(n,kind,text,extra={})=>({id:n+':0',kind,text,title:'',call_id:'',timestamp:t(n%60),...extra});
  window.fx={calls:[],screen:'claude',lat:LAT,menus,screens,agents:[],previews:{},ASYNC};
  // Messages may carry `after` (fake-clock ms): they show up in history from then on.
  remote=async(op,args={})=>{fx.calls.push({op,args,at:Date.now()});await new Promise(r=>setTimeout(r,fx.lat[op]??30));
   const status=a=>typeof a.statusAt==='function'?a.statusAt():a.agent_status;
   const live=()=>fx.agents.map(a=>({...a,agent_status:status(a)}));
   if(op==='sessions')return{sessions:[{name:'fixture',running:true}]};
   if(op==='agents'||op==='status')return{agents:live()};
   if(op==='history'){const a=fx.agents.find(x=>x.history_ref.record.id===args.record_id);return{record:a.history_ref.record,messages:structuredClone((a.messages||[]).filter(m=>!m.after||Date.now()>=m.after).map(({after,...m})=>m)),children:[],before:0,has_more:false};}
   if(op==='read'){const a=live().find(x=>x.pane_id===args.target);const scr=a.screen||fx.screen;return{text:screens[scr],agent_status:a.agent_status,...(a.agent_status==='blocked'?{menu:menus[scr]}:{})};}
   if(op==='glance')return{previews:fx.previews};
   if(['prompt','key','answer'].includes(op))return{sent:true,receipt:args.id};
   return {};};
  window.agent=(id,provider,status,extra={})=>({pane_id:'w1:'+id,identity:'id-'+id,agent:provider,agent_status:status,cwd:'/home/demo/site',terminal_title:'任务 '+id,agent_session:{value:'t-'+id},
   history_ref:{status:'matched',record_id:'rec-'+id,thread:'t-'+id,record:{id:'rec-'+id,thread:'t-'+id,provider,title:'任务 '+id,cwd:'/home/demo/site',modified:Date.now()/1000}},...extra});
  S.demo=false;S.session='fixture';S.device={id:'dev-fixture',name:'工作站',user:'demo',host:'w',port:22};
 },{menus,screens:SCREENS,LAT,ASYNC});
 return page;}
const calls=(page,op)=>page.evaluate(op=>fx.calls.filter(c=>c.op===op).map(c=>c.args),op);
const ASYNC=JSON.stringify({questions:[{title:'今天先做哪件？',options:['修测试','写文档','整理日志']}]},null,2);

// ─── 1. Latency ─────────────────────────────────────────────────────────────
// For each phase of the poll beat, the agent changes state at T (Herdr reports it from then on);
// the clock steps 50 ms at a time until the card is on screen.
async function latency(kind){
 const page=await fresh({clock:true});const out=[];
 for(let phase=0;phase<2500;phase+=250){
  const r=await page.evaluate(({kind,phase})=>{const T=Date.now()+4000+phase;
   const a=kind==='async'?agent('cx','codex','working',{statusAt:()=>Date.now()>=T?'idle':'working',
     messages:[msg(1,'user','用选择题问我。'),msg(2,'tool',fx.ASYNC,{title:'request_user_input_async',call_id:'call_lat'+phase,after:T-3000}),msg(3,'result','{"accepted":true}',{title:'执行结果',call_id:'call_lat'+phase,after:T-2900}),msg(4,'assistant','问题已发出。',{phase:'final_answer',after:T-400})]})
    :agent('cl'+phase,'claude','working',{statusAt:()=>Date.now()>=T?'blocked':'working',screen:'claude',messages:[msg(1,'user','整理日志')]});
   a.identity+=phase;fx.agents=[a];S.agents=[{...a,agent_status:'working'}];S.since=new Map();S.statusBusy=false;S.polling=false;S.reading=null;openAgent(S.agents[0]);return T;},{kind,phase});
  const sel=kind==='async'?'.qa-log.waiting .qa-card':'#live-state .qa-card';let shown=null;
  for(let i=0;i<500&&shown===null;i++){await page.clock.runFor(50);const now=await page.evaluate(sel=>document.querySelector(sel)?Date.now():0,sel);if(now&&now>=r)shown=now-r;}
  out.push(shown);}
 await page.context().close();return out;}
await (async()=>{
 const fmt=v=>v===null?'never (>25 s)':(v/1000).toFixed(2)+' s';
 const sum=xs=>{const ok=xs.filter(x=>x!==null);return {max:xs.includes(null)?null:Math.max(...ok),avg:ok.length?ok.reduce((a,b)=>a+b,0)/ok.length:null,miss:xs.filter(x=>x===null).length};};
 const run=async kind=>{const xs=await latency(kind);const s=sum(xs);console.log(`LATENCY ${kind}: avg ${fmt(s.avg)} · worst ${fmt(s.max)} · missed ${s.miss}/${xs.length} · per phase ${xs.map(fmt).join(', ')}`);return s;};
 const a=await run('async'),b=await run('menu');
 if(!latencyOnly){assert.equal(a.miss,0,'async card always appears');assert(a.max<=2200,'Codex async card within 2.2 s of the stop: '+a.max);
  assert.equal(b.miss,0,'menu card always appears');assert(b.max<=2600,'menu card within 2.6 s of blocked: '+b.max);}
})();
if(latencyOnly){assert.deepEqual(errors,[]);await browser.close();return;}
console.log('PASS: question cards appear soon after the agent stops or blocks, at every poll phase');

// ─── 2. Codex async: 暂不回答, reopen, a normal message, answer later ──────────
{const page=await fresh();
 await page.evaluate(ASYNC=>{fx.ASYNC=ASYNC;const a=agent('cx','codex','idle',{messages:[msg(1,'user','用选择题问我。'),msg(2,'tool',ASYNC,{title:'request_user_input_async',call_id:'call_a'}),msg(3,'result','{"accepted":true}',{title:'执行结果',call_id:'call_a'}),msg(4,'assistant','问题已发出，选一个。',{phase:'final_answer'})]});
  fx.agents=[a];S.agents=[a];openAgent(a);},ASYNC);
 const card=page.locator('.qa-log.waiting .qa-card');await card.waitFor();
 const close=card.getByRole('button',{name:'暂不回答',exact:true});await close.waitFor();
 await page.screenshot({path:path.join(folder,'ask-async-card.png')});
 // Choosing first, then closing: still nothing is sent.
 await card.getByRole('radio',{name:'写文档',exact:true}).click();await close.click();
 await page.getByText('先不答，问题留着，随时可以点开回答',{exact:true}).waitFor();
 assert.equal(await page.locator('.qa-log .qa-card').count(),0,'card folded');
 for(const op of ['prompt','key','answer'])assert.equal((await calls(page,op)).length,0,op+' must not be sent on 暂不回答');
 const row=page.locator('.qa-log.waiting');await row.getByText(/还没回答/).waitFor();
 const bar=page.locator('#live-state .qa-mini');await bar.getByText('Codex 有个问题还没回答',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>document.querySelector('#composer textarea').disabled),false);
 await page.screenshot({path:path.join(folder,'ask-async-aside.png')});
 // Remembered in the device cache: the card does not pop up again after a restart.
 await page.waitForFunction(()=>cacheStore.get('qa-aside')?.ids?.includes('async:call_a'),null,{timeout:5000});
 // Polls keep it folded.
 await page.evaluate(()=>fetchHistory());await page.waitForTimeout(500);assert.equal(await page.locator('.qa-log .qa-card').count(),0);
 // Reopen from the bar; the earlier choice is still there.
 await bar.getByRole('button',{name:'展开问题',exact:true}).click();await card.waitFor();
 assert.equal(await card.getByRole('radio',{name:'写文档',exact:true}).getAttribute('aria-checked'),'true');
 assert.equal(await page.locator('#live-state .qa-mini').count(),0);
 // Fold again and reopen from the history row.
 await card.getByRole('button',{name:'暂不回答',exact:true}).click();await row.getByRole('button',{name:'点开回答',exact:true}).click();await card.waitFor();
 await card.getByRole('button',{name:'暂不回答',exact:true}).click();
 // A normal message while the question waits goes straight out (the agent is idle).
 await page.getByRole('textbox',{name:'消息输入框'}).fill('先不选，帮我看下日志');await page.getByRole('button',{name:'发送消息'}).click();
 await page.waitForFunction(()=>fx.calls.some(c=>c.op==='prompt'));
 assert.equal((await calls(page,'prompt'))[0].text,'先不选，帮我看下日志');
 // It reaches the transcript: the question is no longer waiting, but can still be answered.
 await page.evaluate(()=>{fx.agents[0].messages.push(msg(5,'user','先不选，帮我看下日志'),msg(6,'assistant','日志看过了。',{phase:'final_answer'}));fx.agents[0].agent_status='idle';S.chat.agent={...S.chat.agent,agent_status:'idle'};return fetchHistory();});
 const replied=page.locator('.qa-log.replied');await replied.getByText(/没在这里回答 · 你接着发了消息/).waitFor();
 assert.equal(await page.locator('#live-state .qa-mini').count(),0,'no bar once you moved on');
 await replied.getByRole('button',{name:'现在回答',exact:true}).click();
 const late=replied.locator('.qa-card');await late.waitFor();assert.match(await late.locator('.qa-head').textContent(),/之前问你的/);
 await late.getByRole('radio',{name:'整理日志',exact:true}).click();await late.getByRole('button',{name:'发送回答',exact:true}).click();
 await page.waitForFunction(()=>fx.calls.filter(c=>c.op==='prompt').length===2);
 const reply=(await calls(page,'prompt'))[1].text;
 assert.deepEqual(JSON.parse(reply.split('\n')[1]),[{answer:'整理日志',question:'今天先做哪件？',questionItemId:'["request_user_input_async","call_a",0]'}]);
 // The reply naming this call marks it answered; a reply to another call does not.
 assert.deepEqual(await page.evaluate(reply=>{const m=S.messages.find(x=>x.call_id==='call_a'),p=qaParse(m);
  const other=reply.replace('call_a','call_zz');return [qaOutcome(m,p,[m,{kind:'user',text:reply}]).state,qaOutcome(m,p,[m,{kind:'user',text:other}]).state,qaOutcome(m,p,[m]).state];},reply),['answered','replied','waiting']);
 for(const op of ['key','answer'])assert.equal((await calls(page,op)).length,0);
 await page.context().close();
 console.log('PASS: Codex async 暂不回答 sends nothing, folds into the row and a bar, reopens, survives a normal message, answers later');}

// ─── 3. Blocked menus: 先收起 hides only; Esc after a confirmation, only on the same dialog ──
{const page=await fresh();
 await page.evaluate(()=>{const a=agent('cl','claude','blocked',{screen:'claude',messages:[msg(1,'user','整理日志'),msg(2,'tool',JSON.stringify({questions:[{question:'运行日志放在哪里？',header:'日志位置',options:[{label:'写到项目目录（推荐）',description:'放在 logs/ 下。'},{label:'写到系统临时目录',description:''}]}]}),{title:'AskUserQuestion',call_id:'toolu_1'})]});
  fx.agents=[a];S.agents=[a];S.since.set(agentKey(a),{status:'blocked',at:Date.now()-1000});openAgent(a);});
 const card=page.locator('#live-state .qa-card');await card.waitFor();
 await card.getByRole('button',{name:'关闭',exact:true}).click();
 const sheet=page.getByRole('dialog',{name:'先不回答？'});await sheet.waitFor();
 await sheet.getByText(/收起只在手机上先不显示，不会替你选任何一项/).waitFor();
 await page.screenshot({path:path.join(folder,'ask-close-sheet.png')});
 await sheet.getByRole('button',{name:/^先收起/}).click();
 const mini=page.locator('#live-state .qa-mini');await mini.getByText('Claude 在等你回答 · 已收起',{exact:true}).waitFor();
 assert.equal(await card.count(),0);
 await page.locator('.qa-log.waiting').getByText(/等你回答 · 已收起/).waitFor();
 // Polling the same wait keeps it folded; nothing went to the pane.
 await page.evaluate(()=>fetchTerminal(true));await page.waitForTimeout(700);assert.equal(await card.count(),0);
 for(const op of ['key','answer','prompt'])assert.equal((await calls(page,op)).length,0,op+' must not be sent on 先收起');
 await page.screenshot({path:path.join(folder,'ask-menu-aside.png')});
 // Queued while folded: 立即发送 asks before pressing Esc.
 await page.getByRole('textbox',{name:'消息输入框'}).fill('先回答我另一个问题');await page.getByRole('button',{name:'发送消息'}).click();
 await mini.getByText(/排队的消息在你回答后才发/).waitFor();
 await page.locator('.queue').getByRole('button',{name:'立即发送',exact:true}).click();
 const now=page.getByRole('dialog',{name:'先取消它在等的问题？'});await now.waitFor();
 await now.getByText(/Claude 会收到「没有回答」/).waitFor();await now.getByRole('button',{name:'取消',exact:true}).click();
 assert.equal((await calls(page,'key')).length,0,'立即发送 on a question needs a yes');
 // 展开 brings the card back.
 await mini.getByRole('button',{name:'展开问题',exact:true}).click();await card.waitFor();
 // Esc: the explanation, 取消 sends nothing, 按 Esc sends exactly one Esc after re-reading the screen.
 await card.getByRole('button',{name:'关闭',exact:true}).click();
 await page.getByRole('dialog',{name:'先不回答？'}).getByRole('button',{name:/取消这个问题（按 Esc）/}).click();
 const confirm=page.getByRole('dialog',{name:'按 Esc 取消？'});await confirm.waitFor();
 assert.match(await confirm.textContent(),/Claude 会收到「没有回答」，这一轮停下，等你发新消息/);
 await confirm.getByRole('button',{name:'取消',exact:true}).click();assert.equal((await calls(page,'key')).length,0);
 // The dialog changed in between: no Esc.
 await card.getByRole('button',{name:'关闭',exact:true}).click();
 await page.getByRole('dialog',{name:'先不回答？'}).getByRole('button',{name:/取消这个问题（按 Esc）/}).click();
 await page.evaluate(()=>{fx.agents[0].screen='claude2';});
 await page.getByRole('dialog',{name:'按 Esc 取消？'}).getByRole('button',{name:'按 Esc',exact:true}).click();
 await page.getByText('问题已经变了，没有按 Esc',{exact:true}).waitFor();assert.equal((await calls(page,'key')).length,0);
 await card.getByRole('radio',{name:'7 天'}).waitFor();
 await card.getByRole('button',{name:'关闭',exact:true}).click();
 await page.getByRole('dialog',{name:'先不回答？'}).getByRole('button',{name:/取消这个问题（按 Esc）/}).click();
 await page.getByRole('dialog',{name:'按 Esc 取消？'}).getByRole('button',{name:'按 Esc',exact:true}).click();
 await page.getByText('已按 Esc，问题取消了',{exact:true}).waitFor();
 const keys=await calls(page,'key');assert.deepEqual(keys.map(k=>[k.key,k.target,k.identity]),[['esc','w1:cl','id-cl']]);
 assert.equal((await calls(page,'answer')).length,0,'closing never answers');
 // A new wait (blocked again later) starts unfolded.
 await page.evaluate(async()=>{fx.agents[0].agent_status='working';S.statusBusy=false;await refreshStatus();});
 await page.evaluate(async()=>{fx.agents[0].agent_status='blocked';fx.agents[0].screen='claude';S.statusBusy=false;await refreshStatus();});
 await card.waitFor();
 await page.context().close();
 console.log('PASS: menus close without answering: 先收起 is local, Esc needs a confirmation and the same dialog, 立即发送 asks first');}

// What Esc means, per dialog, from the screen's own hint.
{const page=await fresh();
 const texts=await page.evaluate(()=>[qaEscText(fx.menus.bash,{agent:'claude'}),qaEscText(fx.menus.codexq,{agent:'codex'}),qaEscText({...fx.menus.bash,esc:null},{agent:'codex'}),qaEscText(fx.menus.claude,{agent:'claude'})]);
 assert.equal(texts[0],'等于选「No, and tell Claude what to do differently」：这一步不会执行，Claude 停下来等你说怎么做。');
 assert.equal(texts[1],'会中断 Codex 这一轮：问题连同它正在做的事一起停下，然后等你发新消息。');
 assert.equal(texts[2],'等于拒绝：这一步不会执行，Codex 停下来等你说怎么做。');
 assert.equal(texts[3],'Claude 会收到「没有回答」，这一轮停下，等你发新消息。');
 await page.context().close();
 console.log('PASS: Esc is explained per dialog (Claude question/permission, Codex approval/question)');}

// ─── 4. The 会话 list: an idle Codex with an unanswered question waits for you ──
for(const [w,h,dark] of [[390,844,false],[390,844,true],[320,640,false],[320,640,true]]){
 const page=await fresh({width:w,height:h,dark});
 await page.evaluate(()=>{fx.agents=[agent('cx','codex','idle'),agent('wk','codex','working'),agent('id','claude','idle')];
  fx.previews={['fixture/id-cx']:{ask:{text:'今天先做哪件？',count:1,call_id:'call_l',at:new Date().toISOString()},reply:{text:'问题已发出。',current:true},stamp:'1:1'},
   ['fixture/id-wk']:{activity:{kind:'tool',verb:'run',text:'npm test',open:true},stamp:'1:2'},['fixture/id-id']:{reply:{text:'做完了。',current:true},stamp:'1:3'}};setTab('live');});
 const row=page.locator('.agent-row',{has:page.locator('.card-title',{hasText:'任务 cx'})});
 await row.locator('.glance.g-ask').waitFor();
 assert.equal(await row.locator('.glance').evaluate(n=>[...n.querySelectorAll('.gt')].map(x=>x.textContent).join('|')),'问：|今天先做哪件？');
 assert.equal(await row.locator('.row-state').textContent(),'在问你');
 assert.deepEqual(await page.$$eval('.group-label > span:first-child',n=>n.map(x=>x.textContent)),['等你处理','执行中','空闲']);
 assert.equal(await page.locator('.nav-badge').textContent(),'1');
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow at '+w);
 await page.screenshot({path:path.join(folder,`ask-list-${dark?'dark':'light'}-${w}.png`)});
 if(w===390&&!dark){
  // Put aside: back with the idle ones, preview stays but not in red.
  await page.evaluate(()=>{qaSetAside('async:call_l',true);render();});
  assert.deepEqual(await page.$$eval('.group-label > span:first-child',n=>n.map(x=>x.textContent)),['执行中','空闲']);
  assert.equal(await row.locator('.glance.g-ask').count(),0);assert.equal(await row.locator('.glance').count(),1);}
 await page.context().close();}
console.log('PASS: list groups an idle Codex question with what waits for you, light/dark, 390/320');

// ─── 5. Screenshots: card and folded states, light/dark, 390/320 ─────────────
for(const [w,h,dark] of [[390,844,true],[320,640,false],[320,640,true]]){
 const page=await fresh({width:w,height:h,dark});const tag=(dark?'dark':'light')+'-'+w;
 await page.evaluate(ASYNC=>{const a=agent('cx','codex','idle',{messages:[msg(1,'user','用选择题问我。'),msg(2,'tool',ASYNC,{title:'request_user_input_async',call_id:'call_s'}),msg(3,'result','{"accepted":true}',{title:'执行结果',call_id:'call_s'})]});fx.agents=[a];S.agents=[a];openAgent(a);},ASYNC);
 const card=page.locator('.qa-log.waiting .qa-card');await card.waitFor();
 const b=await card.locator('.qa-actions').boundingBox();assert(b.x+b.width<=w,'actions fit at '+w);
 await page.screenshot({path:path.join(folder,`ask-async-${tag}.png`)});
 await card.getByRole('button',{name:'暂不回答',exact:true}).click();await page.locator('#live-state .qa-mini').waitFor();
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow at '+w);
 await page.screenshot({path:path.join(folder,`ask-async-aside-${tag}.png`)});
 await page.evaluate(()=>{const a=agent('cl','claude','blocked',{screen:'bash',messages:[msg(1,'user','清理一下')]});fx.agents=[a];S.agents=[a];openAgent(a);});
 const menu=page.locator('#live-state .qa-card');await menu.waitFor();
 await page.screenshot({path:path.join(folder,`ask-menu-${tag}.png`)});
 await menu.getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('dialog',{name:'先不确认？'}).getByRole('button',{name:/^先收起/}).click();
 await page.locator('#live-state .qa-mini').getByText('Claude 在等你确认 · 已收起').waitFor();
 await page.locator('.sheet').waitFor({state:'detached'});await page.waitForTimeout(450);
 await page.screenshot({path:path.join(folder,`ask-menu-aside-${tag}.png`)});
 await page.context().close();}
console.log('PASS: question cards and folded bars fit light/dark at 390 and 320');

assert.deepEqual(errors,[]);
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
