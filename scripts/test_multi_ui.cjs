// Several computers connected at the same time: connecting B leaves A connected, switching back is
// instant (no reconnect), each computer disconnects on its own, every device-bound request names its
// computer, and a queued message is only ever sent to the computer it was written on.
// Offline: native is a strict fake with one session per device; nothing leaves the page.
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
 const D={A:{id:'A',name:'家里的电脑',user:'u',host:'home.invalid',port:22,remember:true},B:{id:'B',name:'公司工作站',user:'w',host:'work.invalid',port:2222,remember:true}};
 // Each computer has its own Herdr session, agent and transcript.
 const mk=(dev,title,status)=>{const rec={id:'r'+dev,thread:'t'+dev,title,provider:'claude',parent:null,cwd:'/work/'+dev,modified:now-60};
  return {rec,agent:{pane_id:'w1:p1',terminal_id:'term-'+dev,agent:'claude',agent_status:status,identity:'id-'+dev,cwd:'/work/'+dev,title,
   history_ref:{status:'matched',source:'native-process',record_id:rec.id,thread:rec.thread,record:rec}},
   history:[{id:'1:0',kind:'user',text:'问 '+title,title:'',call_id:'',timestamp:iso(300)},{id:'2:0',kind:'assistant',text:title+' 的回答。',title:'',call_id:'',timestamp:iso(290)}]};};
 window.fx={D,S:{A:mk('A','Alpha 任务','working'),B:mk('B','Beta 任务','idle')},links:[],active:'',calls:[],prompts:[],unnamed:[]};
 const strip=a=>{const {history_ref,...rest}=a;return rest;};
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);let data={};fx.calls.push({op,a});
  try{
   if(op==='devices')data={devices:[D.A,D.B],version:'test'};
   else if(op==='connect'){const d=D[a.id];if(!fx.links.includes(d.id))fx.links.push(d.id);fx.active=d.id;data={device:d,devices:[D.A,D.B],ready:true,connections:fx.links.map(x=>D[x])};}
   else if(op==='activate'){if(!fx.links.includes(a.device))throw Error('not connected');fx.active=a.device;data={};}
   else if(op==='disconnect'){if(a.device)fx.links=fx.links.filter(x=>x!==a.device);else fx.links=[];if(!fx.links.includes(fx.active))fx.active=fx.links.at(-1)||'';data={};}
   else if(op==='remote'){
    // Every request names its computer, and that computer must be connected.
    if(!a.device){fx.unnamed.push(a.op);throw Error('request without device: '+a.op);}
    if(!fx.links.includes(a.device))throw Error('device not connected: '+a.device);
    const s=fx.S[a.device];
    if(a.op==='sessions')data={sessions:[{name:'main',running:true}]};
    else if(a.op==='agents'){data=a.target?{follow:true,state:'same',agents:[s.agent],pane:null}:{agents:[s.agent]};}
    else if(a.op==='status')data={agents:[strip(s.agent)]};
    else if(a.op==='history')data={record:s.rec,messages:s.history,before:0,has_more:false,children:[]};
    else if(a.op==='read')data={text:'$ '};
    else if(a.op==='catalog')data={records:[s.rec],total:1,next:null};
    else if(a.op==='account')data={ssh_user:'u',hostname:a.device};
    else if(a.op==='doctor')data={herdr:true,running:1};
    else if(a.op==='glance')data={previews:{}};
    else if(a.op==='prompt'){fx.prompts.push({device:a.device,text:a.text});data={sent:true,receipt:a.id};}
    else throw Error('unexpected remote op '+a.op);}
   else if(op==='watchState'){if(!a.device)fx.unnamed.push('watchState');}
   else if(!['protect','settings','cacheGet','cachePut','setAlerts'].includes(op))throw Error('unexpected native op '+op);
   if(op==='cacheGet')data={value:null};
  }catch(e){setTimeout(()=>nativeResult(id,{ok:false,error:e.message}),10);return;}
  setTimeout(()=>nativeResult(id,{ok:true,data}),10);}};
});
await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
await page.evaluate(()=>{window.followInterval=()=>1e9;});
const count=op=>page.evaluate(o=>fx.calls.filter(c=>c.op===o).length,op);
const card=name=>page.locator('.device-card').filter({hasText:name});
const theme=t=>page.evaluate(t=>{document.documentElement.dataset.theme=t;},t);
const shot=async name=>{await page.evaluate(()=>document.getElementById('toast').classList.remove('show'));await page.waitForTimeout(300);await page.screenshot({path:path.join(shots,'multi-'+name+'.png')});};
const agentRow=title=>page.getByRole('button',{name:new RegExp(title)});

// 1. Connect A, then B: A stays connected (no disconnect, no "切换设备？" confirmation).
await card('家里的电脑').getByRole('button',{name:'连接设备',exact:true}).click();
await agentRow('Alpha 任务').first().waitFor();
await page.getByRole('button',{name:'设备',exact:true}).click();
await card('公司工作站').getByRole('button',{name:'连接设备',exact:true}).click();
await agentRow('Beta 任务').first().waitFor();
assert.equal(await count('disconnect'),0,'connecting B does not disconnect A');
assert.equal(await count('connect'),2);
assert.deepEqual(await page.evaluate(()=>[LINKS.ids,fx.links,S.device.id]),[['A','B'],['A','B'],'B']);
assert.equal(await agentRow('Alpha 任务').count(),0,'B shows only its own agents');
// The switcher row under the top bar, and the chip shows how many are connected.
const switcher=page.getByRole('group',{name:'切换设备',exact:true});
await switcher.waitFor();
assert.equal(await switcher.getByRole('button').count(),2);
assert.equal(await switcher.getByRole('button',{name:'公司工作站'}).getAttribute('aria-pressed'),'true');
assert.equal(await page.getByRole('button',{name:'当前设备，共连着 2 台',exact:true}).count(),1);
await shot('live-light');await theme('dark');await shot('live-dark');await theme('light');
console.log('PASS: connecting B leaves A connected; switcher shows both');

// 2. Switch back to A: instant, its list as it was, no reconnect.
const connectsBefore=await count('connect');
await switcher.getByRole('button',{name:'家里的电脑'}).click();
await agentRow('Alpha 任务').first().waitFor();
assert.equal(await count('connect'),connectsBefore,'switching never reconnects');
assert.deepEqual(await page.evaluate(()=>[S.device.id,fx.active]),['A','A']);
assert.equal(await agentRow('Beta 任务').count(),0);
console.log('PASS: switching back to A is instant, no reconnect');

// 3. A message queued on A (agent busy) stays bound to A while B is on screen.
await agentRow('Alpha 任务').first().click();
await page.getByText('Alpha 任务 的回答。').first().waitFor();
await page.getByRole('textbox',{name:'消息输入框',exact:true}).fill('给 A 的排队消息');
await page.getByRole('button',{name:'发送消息',exact:true}).click();
await page.locator('.message.queued').filter({hasText:'给 A 的排队消息'}).waitFor();
assert.equal(await page.evaluate(()=>[...Q.values()][0].items[0].dev),'A','the queued item remembers its computer');
// A stops working, but the screen moves to B first.
await page.evaluate(()=>{fx.S.A.agent.agent_status='idle';});
await page.getByRole('button',{name:'返回列表',exact:true}).click();
await page.evaluate(()=>switchDevice(LINKS.devs.get('B')));
await agentRow('Beta 任务').first().waitFor();
assert.equal(await page.evaluate(()=>Q.size),0,'B has no queue of its own');
await agentRow('Beta 任务').first().click();
await page.getByText('Beta 任务 的回答。').first().waitFor();
await page.waitForTimeout(3500);// a few queue pump ticks on B
assert.deepEqual(await page.evaluate(()=>fx.prompts),[],'nothing from A\'s queue reaches B (or A while it is not on screen)');
await page.getByRole('textbox',{name:'消息输入框',exact:true}).fill('给 B 的消息');
await page.getByRole('button',{name:'发送消息',exact:true}).click();
await page.waitForFunction(()=>fx.prompts.length===1);
assert.deepEqual(await page.evaluate(()=>fx.prompts),[{device:'B',text:'给 B 的消息'}]);
// Back on A, with its chat open: the queued message goes to A.
await page.getByRole('button',{name:'返回列表',exact:true}).click();
await page.evaluate(()=>switchDevice(LINKS.devs.get('A')));
await agentRow('Alpha 任务').first().waitFor();
await agentRow('Alpha 任务').first().click();
await page.evaluate(async()=>{S.statusBusy=false;await refreshStatus();});
await page.waitForFunction(()=>fx.prompts.length===2,null,{timeout:20000});
assert.deepEqual(await page.evaluate(()=>fx.prompts[1]),{device:'A',text:'给 A 的排队消息'});
assert.deepEqual(await page.evaluate(()=>fx.unnamed),[],'every device-bound request named its computer');
console.log('PASS: queued message bound to A; B\'s message went to B');

// 4. Devices page: both connected, each disconnects on its own.
await page.getByRole('button',{name:'返回列表',exact:true}).click();
await page.getByRole('button',{name:'设备',exact:true}).click();
await card('公司工作站').getByText('已连接',{exact:true}).waitFor();
await card('家里的电脑').getByText('正在看',{exact:true}).waitFor();
assert.equal(await card('公司工作站').getByRole('button',{name:'切换到这台',exact:true}).count(),1);
await shot('devices-light');await theme('dark');await shot('devices-dark');await theme('light');
// The chip opens a quick switch sheet.
await page.getByRole('button',{name:'当前设备，共连着 2 台',exact:true}).click();
await page.getByRole('dialog',{name:'切换设备'}).waitFor();
await shot('sheet-light');await theme('dark');await shot('sheet-dark');await theme('light');
await page.getByRole('button',{name:'关闭',exact:true}).click();
await card('公司工作站').getByRole('button',{name:'断开',exact:true}).click();
await page.getByRole('dialog',{name:'断开 公司工作站？'}).getByRole('button',{name:'断开',exact:true}).click();
await page.waitForFunction(()=>LINKS.ids.length===1);
assert.deepEqual(await page.evaluate(()=>[LINKS.ids,fx.links,S.device.id]),[['A'],['A'],'A']);
assert.equal(await page.evaluate(()=>fx.calls.filter(c=>c.op==='disconnect').map(c=>c.a.device)).then(x=>x.join()),'B','only B was disconnected');
await card('公司工作站').getByRole('button',{name:'连接设备',exact:true}).waitFor();
assert.equal(await page.getByRole('group',{name:'切换设备'}).count(),0);
// Disconnecting the computer on screen hands over to the other one.
await card('公司工作站').getByRole('button',{name:'连接设备',exact:true}).click();
await agentRow('Beta 任务').first().waitFor();
await page.getByRole('button',{name:'设备',exact:true}).click();
await page.locator('.account-card').getByRole('button',{name:'断开连接',exact:true}).click();
await page.getByRole('dialog',{name:'断开当前设备？'}).getByRole('button',{name:'断开',exact:true}).click();
await page.waitForFunction(()=>LINKS.ids.length===1&&S.device?.id==='A');
assert.deepEqual(await page.evaluate(()=>fx.links),['A']);
console.log('PASS: per-device disconnect; the shown one hands over to the other');

// 5. The cap: a fifth computer is refused before anything is sent.
await page.evaluate(()=>{LINKS.ids=['A','x1','x2','x3'];});
await page.evaluate(()=>doConnect(fx.D.B));
assert.equal(await page.evaluate(()=>fx.calls.filter(c=>c.op==='connect').length),3,'no connect beyond the cap');
await page.evaluate(()=>{LINKS.ids=['A'];});
// Disconnect all (e.g. 断开 on the notification).
await page.evaluate(()=>disconnect());
assert.deepEqual(await page.evaluate(()=>[LINKS.ids,S.device,LINKS.views.size]),[[],null,0]);
for(const w of [320,390]){await page.setViewportSize({width:w,height:w===320?640:844});assert(await page.evaluate(()=>document.scrollingElement.scrollWidth<=innerWidth),'no sideways scroll at '+w);}
assert.deepEqual(errors,[]);
console.log('PASS: cap, disconnect all, no page errors');
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
