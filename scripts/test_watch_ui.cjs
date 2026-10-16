// What the UI hands the background watcher (native `watchState`, read by WatchService when the app
// goes to the background), and where a notification tap lands.
//  · asks: the Codex async questions the app already knows — from the list's glance (local), the
//    remote sub-agent read (ch panes, which now also asks "ask" for a stopped Codex) and the open
//    chat's history — keyed like the watcher (pane/identity), with 暂不回答 marked as aside.
//    The watcher never notifies those; it counts shown ones as waiting.
//  · A 在问你 notification opens that chat (EXTRA_PANE → openFromNotification) with the card shown.
// Offline: native is a fake that records watchState payloads; `remote` is a fixture.
const {chromium}=require('playwright');
const path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');

(async()=>{
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const errors=[];
const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:2});
const page=await context.newPage();page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
await page.addInitScript(()=>{window.watchPayloads=[];window.cacheStore=new Map();
 window.PocketNative={request(id,op,raw){if(!['devices','demo','disconnect','protect','watchState','settings','cacheGet','cachePut'].includes(op))throw Error('Forbidden native call in offline UI test: '+op);
  const a=JSON.parse(raw||'{}');let data=op==='devices'?{devices:[]}:{};
  if(op==='watchState')watchPayloads.push(a);
  if(op==='cachePut')cacheStore.set(a.key,a.value);if(op==='cacheGet')data={value:cacheStore.get(a.key)||null};
  setTimeout(()=>nativeResult(id,{ok:true,data}),0);}};});
await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
await page.getByRole('button',{name:'体验聊天演示',exact:true}).click();
await page.getByText('离线演示 · 示例数据，不连接电脑',{exact:true}).waitFor();
const ASYNC=id=>JSON.stringify({questions:[{title:'先修哪个？ '+id,options:['修测试','写文档']}]});
await page.evaluate(ASYNC=>{
 const t=n=>new Date(Date.UTC(2026,9,15,9,n)).toISOString();
 const msg=(n,kind,text,extra={})=>({id:n+':0',kind,text,title:'',call_id:'',timestamp:t(n),...extra});
 const asked=id=>[msg(1,'user','用选择题问我。'),msg(2,'tool',ASYNC[id],{title:'request_user_input_async',call_id:id}),msg(3,'result','{"accepted":true}',{title:'执行结果',call_id:id}),msg(4,'assistant','问题已发出。',{phase:'final_answer'})];
 const remoteCtx={session:'fixture',target:'w1:rc',identity:'id-rc',provider:'codex'};
 const agent=(id,provider,status,extra={},remote=null)=>({pane_id:'w1:'+id,identity:'id-'+id,agent:provider,agent_status:status,cwd:'/home/demo/site',terminal_title:'任务 '+id,
  history_ref:{status:'matched',record_id:'rec-'+id,thread:'t-'+id,record:{id:'rec-'+id,thread:'t-'+id,provider,title:'任务 '+id,cwd:'/home/demo/site',modified:Date.now()/1000,...(remote?{remote}:{})}},...extra});
 window.fx={calls:[],agents:[
   agent('cx','codex','idle',{messages:asked('call_l')}),
   agent('rc','codex','idle',{messages:asked('call_r')},remoteCtx),
   agent('hx','codex','idle',{messages:asked('call_h')}),
   agent('wk','codex','working'),agent('cl','claude','idle')],
  local:{'fixture/id-cx':{ask:{text:'先修哪个？',count:1,call_id:'call_l',at:t(2)},reply:{text:'问题已发出。',current:true},stamp:'1:1'},'fixture/id-hx':{reply:{text:'问题已发出。',current:true},stamp:'1:3'}},
  far:{'fixture/id-rc':{kids_only:true,kids:{total:0,running:0,items:[],stamp:'k'},ask:{text:'先修哪个？',count:1,call_id:'call_r',at:t(2)},ask_stamp:'r:1'}}};
 remote=async(op,args={})=>{fx.calls.push({op,args});await new Promise(r=>setTimeout(r,20));
  if(op==='sessions')return{sessions:[{name:'fixture',running:true}]};
  if(op==='agents'||op==='status')return{agents:structuredClone(fx.agents.map(({messages,...a})=>a))};
  if(op==='history'){const a=fx.agents.find(x=>x.history_ref.record.id===args.record_id);return{record:a.history_ref.record,messages:structuredClone(a.messages||[]),children:[],before:0,has_more:false};}
  if(op==='read')return{text:'',agent_status:'idle'};
  if(op==='glance'){const far=args.items.some(x=>x.remote);const src=far?fx.far:fx.local;return{previews:Object.fromEntries(args.items.filter(x=>src[x.key]).map(x=>[x.key,structuredClone(src[x.key])]))};}
  if(['prompt','key','answer'].includes(op))throw Error('nothing may be sent: '+op);
  return {};};
 S.demo=false;S.session='fixture';S.device={id:'dev-fixture',name:'工作站',user:'demo',host:'w',port:22};S.agents=structuredClone(fx.agents.map(({messages,...a})=>a));setTab('live');
},Object.fromEntries(['call_l','call_r','call_h'].map(id=>[id,ASYNC(id)])));
const last=()=>page.evaluate(()=>watchPayloads[watchPayloads.length-1]||null);
async function until(fn,what){for(let i=0;i<100;i++){const v=await fn();if(v)return v;await page.waitForTimeout(100);}throw Error('timed out: '+what);}

// ─── 1. The list knows two questions (local glance, ch remote read); the watcher gets both ──────
await page.evaluate(()=>{refreshStatus?.();glanceRefresh(true);});
for(const id of ['cx','rc'])await page.locator('.agent-row',{has:page.locator('.card-title',{hasText:'任务 '+id})}).locator('.glance.g-ask').waitFor();
const p1=await until(async()=>{const p=await last();return p&&p.asks&&p.asks['w1:cx/id-cx']&&p.asks['w1:rc/id-rc']?p:null;},'watchState with both asks');
assert.deepEqual(p1.asks,{'w1:cx/id-cx':{call_id:'call_l',aside:false},'w1:rc/id-rc':{call_id:'call_r',aside:false}});
assert.equal(p1.session,'fixture');
assert.equal(p1.states['w1:cx/id-cx'],'idle','the state stays Herdr\'s; the watcher derives "ask" from asks');
assert.deepEqual(p1.kids['w1:rc/id-rc'].remote,{session:'fixture',target:'w1:rc',identity:'id-rc',provider:'codex'},'ch item names its remote context');
// The remote read asked "ask" only for the stopped Codex ch pane.
const farItems=await page.evaluate(()=>fx.calls.filter(c=>c.op==='glance'&&c.args.items.some(x=>x.remote)).flatMap(c=>c.args.items));
assert(farItems.length&&farItems.every(x=>x.key==='fixture/id-rc'&&x.ask===true&&x.kids===true),'remote glance asks the ch Codex question: '+JSON.stringify(farItems));
// Next remote read sends the stamp back, so an unchanged transcript costs a stat there.
await page.evaluate(()=>{K.ask.clear();fx.far['fixture/id-rc']={kids_only:true,kids:{same:true},ask_same:true,ask_stamp:'r:1'};return kidsRemoteRefresh();});
const again=await until(()=>page.evaluate(()=>fx.calls.filter(c=>c.op==='glance'&&c.args.items.some(x=>x.remote)).map(c=>c.args.items[0]).find(x=>x.ask_stamp)),'stamped remote ask');
assert.equal(again.ask_stamp,'r:1');
assert.equal(await page.locator('.agent-row .glance.g-ask').count(),2,'"same" keeps the question shown');
console.log('PASS: watchState carries the questions the list shows (local and ch), keyed like the watcher');

// ─── 2. 暂不回答 reaches the watcher at once (it must not notify that question) ─────────────────
const before=await page.evaluate(()=>watchPayloads.length);
await page.evaluate(()=>qaSetAside('async:call_l',true));
const p2=await until(async()=>{const p=await page.evaluate(n=>watchPayloads.length>n?watchPayloads[watchPayloads.length-1]:null,before);return p;},'watchState after 暂不回答');
assert.deepEqual(p2.asks['w1:cx/id-cx'],{call_id:'call_l',aside:true});
assert.deepEqual(p2.asks['w1:rc/id-rc'],{call_id:'call_r',aside:false});
console.log('PASS: a question put aside is handed over as aside');

// ─── 3. Notification tap: opens that chat with the question card ───────────────────────────────
await page.evaluate(()=>openFromNotification('w1:rc'));
await page.locator('.qa-log.waiting .qa-card').waitFor();
assert.equal(await page.evaluate(()=>S.chat?.agent?.pane_id),'w1:rc');
assert.match(await page.locator('.qa-log.waiting').textContent(),/先修哪个？ call_r/);
assert(await page.locator('.qa-log.waiting .qa-card').isVisible());
// An aside question opens folded (还没回答 · 点开回答), never as a popped card.
await page.evaluate(()=>openFromNotification('w1:cx'));
await until(()=>page.evaluate(()=>S.chat?.agent?.pane_id==='w1:cx'&&!!document.querySelector('.qa-log.waiting .qa-reopen')),'aside question folded');
assert.equal(await page.locator('.qa-log.waiting .qa-card').count(),0);
console.log('PASS: a notification tap opens the right chat and shows its question card');

// ─── 4. The open chat knows a question the list's glance did not have yet ──────────────────────
await page.evaluate(()=>openFromNotification('w1:hx'));
await page.locator('.qa-log.waiting .qa-card').waitFor();
await page.evaluate(()=>syncWatch());
const p4=await until(async()=>{const p=await last();return p?.asks?.['w1:hx/id-hx']?p:null;},'chat ask in watchState');
assert.deepEqual(p4.asks['w1:hx/id-hx'],{call_id:'call_h',aside:false});
assert(!p4.asks['w1:wk/id-wk']&&!p4.asks['w1:cl/id-cl'],'only questions');
const sent=await page.evaluate(()=>fx.calls.filter(c=>['prompt','key','answer'].includes(c.op)).length);
assert.equal(sent,0,'nothing was sent to an agent');
console.log('PASS: the open chat\'s question is handed over too; nothing is sent');

assert.deepEqual(errors,[]);
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
