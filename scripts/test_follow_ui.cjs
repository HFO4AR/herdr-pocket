// Following a pane: /clear, Codex /new, agent exit and a new agent in the same pane.
// Native SSH is replaced with an offline fixture; nothing leaves the page.
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
 const rec=(id,thread,title,provider='claude',age=600)=>({id,thread,title,provider,parent:null,cwd:'/work/proj',modified:now-age});
 const R={r1:rec('r1','t-old','修复登录页',undefined,900),r2:rec('r2','t-new','整理测试脚本',undefined,5),r3:rec('r3','t-cx','检查构建缓存','codex',30),r4:rec('r4','t-cx2','重新部署预览','codex',2)};
 const msg=(id,kind,text,age,extra={})=>({id:id+':0',kind,text,title:'',call_id:'',timestamp:iso(age),...extra});
 const H={r1:[msg(1,'user','登录页在手机上错位了',1000),msg(2,'assistant','旧对话的回答：已修好登录页布局。',950)],
  r2:[msg(10,'user','把测试脚本整理一下',20),msg(11,'assistant','新对话的回答：脚本已整理。',10)],
  r3:[msg(20,'user','看看构建缓存',40),msg(21,'assistant','Codex 的回答：缓存正常。',35,{phase:'final_answer'})],
  r4:[msg(30,'user','重新部署预览',4),msg(31,'assistant','部署好了。',3,{phase:'final_answer'})]};
 const ref=(r,source='native-process')=>({status:'matched',source,record_id:r.id,thread:r.thread,record:r});
 const A1={pane_id:'w1:p1',terminal_id:'term1',agent:'claude',agent_status:'idle',identity:'id-1',cwd:'/work/proj',title:'修复登录页',history_ref:ref(R.r1)};
 window.fx={R,A1,list:[A1],follow:{follow:true,state:'same',agents:[A1],pane:null},prompts:[],calls:[]};
 const device={id:'fx',name:'测试电脑',user:'u',host:'fixture.invalid',port:22,remember:true};
 const strip=a=>{const {history_ref,...rest}=a;return rest;};
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);let data={};
  if(op==='devices')data={devices:[device],version:'test',connected:device};
  else if(op==='remote'){fx.calls.push(a.op);
   if(a.op==='sessions')data={sessions:[{name:'fx',running:true}]};
   else if(a.op==='agents')data=a.target?JSON.parse(JSON.stringify(fx.follow)):{agents:fx.list};
   else if(a.op==='status')data={agents:fx.list.map(strip)};
   else if(a.op==='history')data={record:Object.values(R).find(r=>r.id===a.record_id),messages:H[a.record_id]||[],before:0,has_more:false,children:[]};
   else if(a.op==='read')data={text:'$ '};
   else if(a.op==='catalog')data={records:[],total:0,next:null};
   else if(a.op==='prompt'){fx.prompts.push(a);data={sent:true,receipt:a.id};}
   else if(a.op==='account')data={ssh_user:'u',hostname:'fx'};
   else throw Error('unexpected remote op '+a.op);}
  else if(!['watchState','protect','setAlerts'].includes(op))throw Error('unexpected native op '+op);
  setTimeout(()=>nativeResult(id,{ok:true,data}),0);}};
});
await page.goto(require('./ui_bundle.cjs').url(html));
// Drive following by hand: no background follow polls during the test.
await page.evaluate(()=>{window.followInterval=()=>1e9;});
const run=()=>page.evaluate(async()=>{FOLLOW.last=0;await followRun();});
const shot=name=>page.screenshot({path:path.join(shots,'follow-'+name+'.png')});

await page.getByRole('button',{name:/修复登录页/}).click();
await page.getByText('旧对话的回答：已修好登录页布局。').waitFor();
const box=page.getByRole('textbox',{name:'消息输入框',exact:true});
await box.fill('草稿：帮我再跑一遍测试');

// 1. Claude /clear: same identity, new runtime session. The first sighting only holds sending.
await page.evaluate(()=>{const a={...fx.A1,title:'整理测试脚本',history_ref:{status:'matched',source:'native-process',record_id:'r2',thread:'t-new',record:fx.R.r2}};fx.follow={follow:true,state:'same',agents:[a],pane:null};fx.list=[a];});
await run();
assert.equal(await page.evaluate(()=>S.chat.following),true);
await page.getByRole('button',{name:'发送消息',exact:true}).click();
await page.getByText('窗格里的对话好像变了，正在确认，草稿先留着').waitFor();
assert.equal(await page.evaluate(()=>fx.prompts.length),0);
await run();
await page.getByText('新对话的回答：脚本已整理。').waitFor();
assert.equal(await page.getByText('旧对话的回答：已修好登录页布局。').count(),0);
assert(await page.getByText('新会话 · /clear 之后').isVisible());
assert.equal(await box.inputValue(),'草稿：帮我再跑一遍测试');
assert.equal(await page.locator('.chat-head h2').textContent(),'整理测试脚本');
// Right after a switch sending waits a moment, then goes to the pane the person now sees.
await page.getByRole('button',{name:'发送消息',exact:true}).click();
await page.getByText('刚换了一段对话，看一眼再发').waitFor();
assert.equal(await page.evaluate(()=>fx.prompts.length),0);
await shot('clear');
await page.waitForTimeout(2600);
await page.getByRole('button',{name:'发送消息',exact:true}).click();
await page.waitForFunction(()=>fx.prompts.length===1);
assert.deepEqual(await page.evaluate(()=>({t:fx.prompts[0].target,i:fx.prompts[0].identity})),{t:'w1:p1',i:'id-1'});
// The previous transcript stays one tap away, read-only, and back returns to the live chat.
await page.getByRole('button',{name:/看之前的对话/}).click();
await page.getByText('旧对话的回答：已修好登录页布局。').waitFor();
assert(await page.getByText(/历史只读/).first().isVisible());
await page.getByRole('button',{name:'返回列表',exact:true}).click();
await page.getByText('新对话的回答：脚本已整理。').waitFor();
assert(await page.getByRole('textbox',{name:'消息输入框',exact:true}).isVisible());
console.log('PASS: Claude /clear holds sending, confirms twice, switches with a marker, keeps the draft and the previous transcript');

// 2. A flapping weak signal never bounces the view: startup argv ("process") is ignored.
await page.evaluate(()=>{const a={...fx.A1,title:'整理测试脚本',history_ref:{status:'matched',source:'process',record_id:'r1',thread:'t-old',record:fx.R.r1}};fx.follow={follow:true,state:'same',agents:[a],pane:null};});
await run();await run();
assert.equal(await page.evaluate(()=>S.chat.record.id),'r2');
assert.equal(await page.evaluate(()=>S.chat.following),false);
console.log('PASS: startup argv evidence does not switch back');

// 3. The agent exits: the pane is a shell again. Old transcript stays, sending stops, terminal offered.
await page.evaluate(()=>{fx.follow={follow:true,state:'exited',agents:[],pane:{pane_id:'w1:p1',terminal_id:'term1',identity:'pane-1',terminal_title_stripped:'~/proj',cwd:'/work/proj',workspace_id:'w1',tab_id:'w1:t1'}};fx.list=[];});
await page.evaluate(()=>refreshStatus());
await page.locator('.follow-card').getByText('Claude 已退出').waitFor();
assert.equal(await page.getByRole('textbox',{name:'消息输入框',exact:true}).count(),0);
assert(await page.getByText('新对话的回答：脚本已整理。').isVisible());
assert(await page.getByRole('button',{name:'打开这个终端'}).isVisible());
assert.match(await page.locator('#chat-meta').textContent(),/已退出 · 只读/);
await shot('exited');

// 4. A new agent starts in the same pane: offered, never switched to silently.
const A2={pane_id:'w1:p1',terminal_id:'term1',agent:'codex',agent_status:'idle',identity:'id-2',cwd:'/work/proj',terminal_title:'检查构建缓存 | proj',agent_session:{kind:'id',value:'t-cx'},history_ref:{status:'matched',source:'title',record_id:'r3',thread:'t-cx'}};
await page.evaluate(a=>{a.history_ref.record=fx.R.r3;fx.follow={follow:true,state:'changed',agents:[a],pane:null};fx.list=[a];},A2);
await page.evaluate(()=>refreshStatus());
await page.getByRole('button',{name:'打开新的 Codex'}).waitFor();
assert(await page.getByText('新对话的回答：脚本已整理。').isVisible());
await shot('new-agent');
await page.getByRole('button',{name:'打开新的 Codex'}).click();
await page.getByText('Codex 的回答：缓存正常。').waitFor();
console.log('PASS: exit is plain, transcript stays readable, terminal offered, a new agent in the pane is offered');

// 5. Codex /new changes the Herdr identity: held at once, then followed with a /new marker.
await page.evaluate(()=>{const a={...S.chat.agent,identity:'id-3',terminal_title:'重新部署预览 | proj',agent_session:{kind:'id',value:'t-cx2'},history_ref:{status:'matched',source:'title',record_id:'r4',thread:'t-cx2',record:fx.R.r4}};fx.follow={follow:true,state:'changed',agents:[a],pane:null};fx.list=[a];});
await run();
await page.getByText('窗格里的对话变了，正在确认…').waitFor();
assert.equal(await page.getByRole('textbox',{name:'消息输入框',exact:true}).count(),0);
await run();
await page.getByText('部署好了。').waitFor();
assert(await page.getByText('新会话 · /new 之后').isVisible());
assert.equal(await page.evaluate(()=>S.chat.agent.identity),'id-3');
await page.getByRole('textbox',{name:'消息输入框',exact:true}).waitFor();
console.log('PASS: Codex /new identity change holds sending, then follows with the new identity');

// 6. A status blip (identity flickers back) releases the hold without switching.
await page.evaluate(()=>{fx.list=[];refreshStatus();});
await page.waitForFunction(()=>S.chat.stale===true);
await page.evaluate(()=>{const a={...S.chat.agent};fx.follow={follow:true,state:'same',agents:[a],pane:null};fx.list=[a];});
await run();
await page.getByRole('textbox',{name:'消息输入框',exact:true}).waitFor();
assert.equal(await page.evaluate(()=>S.chat.record.id),'r4');
console.log('PASS: status blip is released without switching');

// 7. The session list shows what the pane runs now.
await page.getByRole('button',{name:'返回列表',exact:true}).click();
await page.evaluate(()=>refreshStatus());
await page.getByRole('button',{name:/重新部署预览/}).waitFor();
assert.equal(await page.getByRole('button',{name:/修复登录页/}).count(),0);

// 8. Old bridges ignore `target`: following turns itself off instead of polling the full list.
await page.evaluate(()=>{fx.follow={agents:fx.list};});
await page.getByRole('button',{name:/重新部署预览/}).click();
await page.getByText('部署好了。').waitFor();
await run();
assert.equal(await page.evaluate(()=>FOLLOW.supported),false);
console.log('PASS: list follows the pane; older bridge disables following');

// Layout: the exit footer and marker fit narrow phones.
await page.evaluate(()=>{FOLLOW.supported=true;fx.follow={follow:true,state:'exited',agents:[],pane:{pane_id:'w1:p1',terminal_id:'term1',identity:'pane-1'}};});
await run();
await page.setViewportSize({width:320,height:640});
await page.getByText(/Codex 已退出/).first().waitFor();
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
await shot('exited-320');
assert.deepEqual(errors,[]);
console.log('PASS: no page errors; narrow layout fits');
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
