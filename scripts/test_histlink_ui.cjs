// History links that stay put: a ch pane whose other computer drops off for a moment keeps its
// conversation on screen; a manual pick goes to the bridge and sticks; the remote picker lists
// that computer's records. Native SSH is replaced with an offline fixture; nothing leaves the page.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
const root=path.resolve(__dirname,'..');
const html=require('./ui_bundle.cjs')(root);
const shots=path.join(root,'ui-artifacts');fs.mkdirSync(shots,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});
const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
await page.addInitScript(()=>{
 const now=Date.now()/1000,iso=s=>new Date((now-s)*1000).toISOString();
 const ctx={session:'fx',target:'w1:p2',identity:'id-ch',provider:'claude'};
 const rec=(id,thread,title,remote)=>({id,thread,title,provider:'claude',parent:null,cwd:'/remote/ws',modified:now-60,...(remote?{remote:ctx}:{})});
 const R={live:rec('remote:k:'+'a'.repeat(64),'t-live','远端的对话',true),moved:rec('remote:k:'+'b'.repeat(64),'t-moved','搬过来的对话',true),
  local:rec('c'.repeat(64),'t-local','本机的对话',false)};
 const msg=(id,kind,text,age)=>({id:id+':0',kind,text,title:'',call_id:'',timestamp:iso(age)});
 const H={[R.live.id]:[msg(1,'user','远端：帮我看看日志',90),msg(2,'assistant','远端的回答：日志正常。',80)],
  [R.moved.id]:[msg(5,'user','搬过来之前问的',900),msg(6,'assistant','搬过来的回答：已经处理。',890)],
  [R.local.id]:[msg(9,'user','本机问题',50),msg(10,'assistant','本机回答。',40)]};
 const matched=(r,source='native-process',extra={})=>({status:'matched',source,record_id:r.id,thread:r.thread,record:r,remote:ctx,...extra});
 const CH={pane_id:'w1:p2',terminal_id:'term-ch',agent:'claude',agent_status:'done',identity:'id-ch',cwd:'/home/u/proj',title:'远端的对话',
  terminal_title_stripped:'proj: ch --host fx resume 5fce',history_ref:matched(R.live)};
 const CH2={pane_id:'w1:p3',terminal_id:'term-ch2',agent:'claude',agent_status:'done',identity:'id-ch2',cwd:'/home/u/other',title:'ch-cli',
  terminal_title_stripped:'other: ch --host fx resume 6abc',history_ref:{status:'remote_missing',remote:{...ctx,target:'w1:p3',identity:'id-ch2'},candidates:[],reason:'远端会话没有公开可核实的会话标识'}};
 window.fx={R,CH,CH2,matched,list:[CH,CH2],follow:null,history:'ok',calls:[],links:[],catalogs:[]};
 const device={id:'fx',name:'测试电脑',user:'u',host:'fixture.invalid',port:22,remember:true};
 const strip=a=>{const {history_ref,...rest}=a;return rest;};
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);let data={},fail='';
  if(op==='devices')data={devices:[device],version:'test',connected:device};
  else if(op==='remote'){fx.calls.push(a.op);
   if(a.op==='sessions')data={sessions:[{name:'fx',running:true}]};
   else if(a.op==='agents')data=a.target?JSON.parse(JSON.stringify(fx.follow||{follow:true,state:'same',agents:[fx.list.find(x=>x.pane_id===a.target)],pane:null})):{agents:JSON.parse(JSON.stringify(fx.list))};
   else if(a.op==='status')data={agents:fx.list.map(strip)};
   else if(a.op==='history'){if(fx.history!=='ok')fail=fx.history;else data={record:Object.values(R).find(r=>r.id===a.record_id),messages:H[a.record_id]||[],before:0,has_more:false,children:[]};}
   else if(a.op==='read')data={text:'$ '};
   else if(a.op==='catalog'){fx.catalogs.push(a);data=a.remote?{records:[R.moved],total:1,next:null}:{records:[R.local],total:1,next:null};}
   else if(a.op==='link'){fx.links.push(a);const r=Object.values(R).find(x=>x.id===a.record_id);data={linked:matched(r,'manual')};}
   else if(a.op==='account')data={ssh_user:'u',hostname:'fx'};
   else throw Error('unexpected remote op '+a.op);}
  else if(!['watchState','protect','setAlerts','cacheGet','cachePut'].includes(op))throw Error('unexpected native op '+op);
  setTimeout(()=>nativeResult(id,fail?{ok:false,error:fail}:{ok:true,data}),0);}};
});
await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
await page.evaluate(()=>{window.followInterval=()=>1e9;});
const run=()=>page.evaluate(async()=>{FOLLOW.last=0;await followRun();});
const poll=()=>page.evaluate(async()=>{S.chat.retryAt=0;await fetchHistory();});
const shot=name=>page.screenshot({path:path.join(shots,'histlink-'+name+'.png')});

// 1. The other computer drops off while the chat is open: the messages stay, a quiet note, no pause.
await page.getByRole('button',{name:/远端的对话/}).click();
await page.getByText('远端的回答：日志正常。').waitFor();
await page.evaluate(()=>{fx.history='ch 正在重新连接远端电脑，稍后自动重试';});
await poll();
await page.getByText('暂时读不到，正在重试').waitFor();
assert(await page.getByText('远端的回答：日志正常。').isVisible());
assert(await page.getByText('ch 正在重新连接远端电脑，稍后自动重试').isVisible());
assert.equal(await page.locator('.note.error').count(),0);
assert.equal(await page.evaluate(()=>S.paused),false);
// Polls back off while waiting; they do not hammer the other computer.
const before=await page.evaluate(()=>fx.calls.filter(x=>x==='history').length);
await page.evaluate(async()=>{await fetchHistory();await fetchHistory();});
assert.equal(await page.evaluate(()=>fx.calls.filter(x=>x==='history').length),before);
await shot('retry');
// The follow poll sees the bridge's stale stand-in (same conversation): nothing switches or unlinks.
await page.evaluate(()=>{const a={...fx.CH,history_ref:fx.matched(fx.R.live,'native-process',{stale:true,transient:true,reason:'ch 正在重新连接远端电脑'})};fx.follow={follow:true,state:'same',agents:[a],pane:null};});
await run();await run();
assert.equal(await page.evaluate(()=>S.chat.record?.id),await page.evaluate(()=>fx.R.live.id));
assert.equal(await page.getByText('还没关联到对话记录').count(),0);
// Back: the note goes away by itself.
await page.evaluate(()=>{fx.history='ok';fx.follow=null;});
await poll();
await page.waitForFunction(()=>!document.querySelector('.history-retry'));
assert(await page.getByText('远端的回答：日志正常。').isVisible());
console.log('PASS: a transient remote failure keeps the messages, shows a quiet retry note, backs off and recovers');

// 2. A record that is really gone still says so with 重试 (and stops polling).
await page.evaluate(()=>{fx.history='历史记录已不存在，请刷新列表';});
await poll();
await page.locator('.note.error').getByText(/已不存在/).waitFor();
assert.equal(await page.evaluate(()=>S.paused),true);
await page.evaluate(()=>{fx.history='ok';});
await page.locator('.note.error').getByRole('button',{name:'重试'}).click();
await page.waitForFunction(()=>!document.querySelector('.note.error'));
console.log('PASS: a missing record is still an explicit error');

// 3. Opened while the bridge stands in with the last confirmed conversation: it opens straight away.
await page.getByRole('button',{name:'返回列表',exact:true}).click();
await page.evaluate(()=>{fx.list[0]={...fx.CH,history_ref:fx.matched(fx.R.live,'native-process',{stale:true,transient:true,reason:'远端电脑响应超时'})};S.agents=JSON.parse(JSON.stringify(fx.list));render();});
await page.getByRole('button',{name:/远端的对话/}).click();
await page.getByText('远端的回答：日志正常。').waitFor();
assert.equal(await page.getByText('还没关联到对话记录').count(),0);
console.log('PASS: a stale stand-in opens the last confirmed conversation');

// 4. Nothing known yet and the other computer unreachable: 暂时连不上, not 找不到; it links itself once back.
await page.getByRole('button',{name:'返回列表',exact:true}).click();
await page.evaluate(()=>{fx.list[0]={...fx.CH,history_ref:{status:'remote_error',transient:true,reason:'ch 正在重新连接远端电脑',remote:{session:'fx',target:'w1:p2',identity:'id-ch',provider:'claude'}}};S.agents=JSON.parse(JSON.stringify(fx.list));render();});
await page.getByRole('button',{name:/远端的对话/}).click();
await page.getByText('还没关联到对话记录').waitFor();
await page.getByText(/远端电脑暂时连不上（ch 正在重新连接远端电脑），正在重试/).waitFor();
assert.equal(await page.getByText(/没有能确认的会话标识/).count(),0);
await shot('reconnecting');
await page.evaluate(()=>{fx.follow={follow:true,state:'same',agents:[{...fx.CH}],pane:null};});
await run();
await page.getByText('远端的回答：日志正常。').waitFor();
console.log('PASS: unreachable reads as 暂时连不上 and the chat links itself once the computer answers');

// 5. A ch pane with no verifiable id: the picker lists that computer's records, and a pick goes to the bridge.
await page.getByRole('button',{name:'返回列表',exact:true}).click();
await page.getByRole('button',{name:/ch-cli/}).click();
await page.getByText(/远端连上了，但没找到这个会话的记录/).waitFor();
await page.getByRole('button',{name:'选择历史记录'}).click();
await page.getByRole('button',{name:/搬过来的对话/}).click();
assert.deepEqual(await page.evaluate(()=>fx.catalogs.at(-1).remote),{session:'fx',target:'w1:p3',identity:'id-ch2',provider:'claude'});
await page.getByRole('button',{name:'关联当前 Agent'}).click();
await page.getByText('搬过来的回答：已经处理。').waitFor();
await page.waitForFunction(()=>fx.links.length===1);
assert.deepEqual(await page.evaluate(()=>{const l=fx.links[0];return [l.target,l.identity,l.record_id];}),['w1:p3','id-ch2',await page.evaluate(()=>fx.R.moved.id)]);
assert.match(await page.locator('#chat-meta').textContent(),/手动关联/);
console.log('PASS: the remote picker lists the other computer\'s records and the pick is sent to the bridge');

// 6. The pick sticks: an app restart (memory gone) and a failed auto-match still open it, from the bridge.
await page.getByRole('button',{name:'返回列表',exact:true}).click();
await page.evaluate(()=>{S.bindings.clear();fx.list[1]={...fx.CH2,history_ref:fx.matched(fx.R.moved,'manual',{auto_status:'remote_missing',remote:{...fx.CH2.history_ref.remote}})};S.agents=JSON.parse(JSON.stringify(fx.list));render();});
await page.getByRole('button',{name:/ch-cli/}).click();
await page.getByText('搬过来的回答：已经处理。').waitFor();
assert.match(await page.locator('#chat-meta').textContent(),/手动关联/);
// The bridge failing to answer this time (old bridge or no state) still keeps the in-app pick.
await page.getByRole('button',{name:'返回列表',exact:true}).click();
await page.evaluate(()=>{S.bindings.set(bindingKey(fx.CH2),fx.R.moved);fx.list[1]={...fx.CH2,identity:'id-ch2b',history_ref:{status:'remote_error',transient:true,reason:'远端电脑响应超时',remote:fx.CH2.history_ref.remote}};S.agents=JSON.parse(JSON.stringify(fx.list));render();});
await page.getByRole('button',{name:/ch-cli/}).click();
await page.getByText('搬过来的回答：已经处理。').waitFor();
console.log('PASS: a manual pick survives an app restart, an identity change and a failed auto-match');

// 7. A pane whose computer is not known yet (process lookup failed): never offers this computer's records.
await page.getByRole('button',{name:'返回列表',exact:true}).click();
await page.evaluate(()=>{S.bindings.clear();fx.list[1]={...fx.CH2,history_ref:{status:'retry',transient:true,reason:'这次没读到窗格的进程信息'}};S.agents=JSON.parse(JSON.stringify(fx.list));render();});
await page.getByRole('button',{name:/ch-cli/}).click();
await page.getByText('这次没读到窗格信息，正在重试…').waitFor();
const asked=await page.evaluate(()=>fx.catalogs.length);
await page.getByRole('button',{name:'选择历史记录'}).click();
await page.getByText(/还不知道历史在哪台电脑上/).waitFor();
assert.equal(await page.evaluate(()=>fx.catalogs.length),asked);
assert.equal(await page.getByText('本机的对话').count(),0);
await page.keyboard.press('Escape');
console.log('PASS: an unknown computer never gets this computer\'s records offered');

await page.setViewportSize({width:320,height:640});
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
assert.deepEqual(errors,[]);
console.log('PASS: no page errors; narrow layout fits');
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
