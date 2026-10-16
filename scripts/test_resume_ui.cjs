// 启动时自动重连: on launch the computers that were connected when the app went away reconnect by
// themselves, the one that was on screen first (its cached list shows while it connects), the others
// quietly after. A computer that needs a typed password or a fingerprint check is never prompted at
// launch; an explicit 断开 keeps it from reconnecting next time; the setting turns it all off; offline
// launches wait for the network; links kept by the keep-alive service are reattached, not reconnected.
// Offline: native is a strict fake that mirrors ResumeSet.kt (ids + active, add on connect, remove on 断开).
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
const root=path.resolve(__dirname,'..');
const html=require('./ui_bundle.cjs')(root);
const shots=path.join(root,'ui-artifacts');fs.mkdirSync(shots,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const errors=[];

// One "launch" of the app: a fresh page whose native side starts from `cfg`.
async function launch(cfg){
 const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});
 page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
 await page.addInitScript(cfg=>{
  const now=Date.now()/1000;
  const D={
   A:{id:'A',name:'家里的电脑',user:'u',host:'home.invalid',port:22,auth:'password',remember:true},
   B:{id:'B',name:'公司工作站',user:'w',host:'work.invalid',port:2222,auth:'key',remember:false},
   C:{id:'C',name:'实验室服务器',user:'lab',host:'lab.invalid',port:22,auth:'password',remember:false},
   E:{id:'E',name:'树莓派',user:'pi',host:'pi.invalid',port:22,auth:'password',remember:true}};
  // What ResumeSet.need would say for each (C has no saved password, E was never trusted).
  const NEED={A:'',B:'',C:'password',E:'trust'};
  const agent=(dev,title)=>({pane_id:'w1:p1',terminal_id:'term-'+dev,agent:'claude',agent_status:'idle',identity:'id-'+dev,cwd:'/work/'+dev,title});
  window.fx={D,calls:[],set:cfg.set,enabled:cfg.enabled!==false,online:cfg.online!==false,links:[...(cfg.kept||[])],active:cfg.kept?.at(-1)||'',
   fail:cfg.fail||{},delay:cfg.delay||{},held:new Map(),prefs:{theme:'system',dark:false,textZoom:100,secureScreen:false,autoUpdate:false,seenUpdate:'',alerts:true,keepAlive:true,keepAliveMinutes:60,autoResume:cfg.enabled!==false,version:'test',versionCode:1,update:null}};
  const info=()=>({enabled:fx.enabled,online:fx.online,active:fx.set.active,ids:fx.set.ids.map(id=>({id,need:NEED[id]}))});
  const reply=(id,ok,v,ms=10)=>setTimeout(()=>nativeResult(id,ok?{ok:true,data:v}:{ok:false,error:v.error,code:v.code}),ms);
  window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);fx.calls.push({op,a});let data={};
   try{
    if(op==='devices'){data={devices:Object.values(D),version:'test',alerts:true,connections:fx.links.map(x=>D[x]),resume:info()};if(fx.active)data.connected=D[fx.active];}
    else if(op==='connect'){
     const d=D[a.id];
     // The same refusals as MainActivity.connect for a quiet reconnect.
     if(a.auto&&(!fx.enabled||!fx.set.ids.includes(a.id)))return reply(id,false,{code:'resume_off',error:'不再自动重连这台电脑'});
     if(a.auto&&NEED[a.id])return reply(id,false,{code:'resume_'+NEED[a.id],error:'needs '+NEED[a.id]});
     const f=(fx.fail[a.id]||[]).shift();
     if(f)return reply(id,false,f,fx.delay[a.id]||30);
     const done=()=>{if(!fx.links.includes(a.id))fx.links.push(a.id);if(!(a.auto&&a.background)||!fx.active)fx.active=a.id;
      if(!fx.set.ids.includes(a.id))fx.set.ids.push(a.id);if(!(a.auto&&a.background))fx.set.active=a.id;
      reply(id,true,{device:d,devices:Object.values(D),ready:true,connections:fx.links.map(x=>D[x]),host:{herdr:true,running:1}},0);};
     if(fx.delay[a.id]==='hold'){fx.held.set(a.id,done);return;}
     setTimeout(done,fx.delay[a.id]||30);return;}
    else if(op==='activate'){if(!fx.links.includes(a.device))throw Error('not connected');fx.active=a.device;fx.set.active=a.device;}
    else if(op==='disconnect'){
     if(a.device){fx.links=fx.links.filter(x=>x!==a.device);fx.set.ids=fx.set.ids.filter(x=>x!==a.device);}
     else{fx.links=[];fx.set={ids:[],active:''};}
     if(!fx.links.includes(fx.active))fx.active=fx.links.at(-1)||'';if(!fx.set.ids.includes(fx.set.active))fx.set.active=fx.active;}
    else if(op==='remote'){
     if(!a.device||!fx.links.includes(a.device))throw Error('device not connected: '+a.device);
     const t=a.device==='A'?'Alpha 任务':'Beta 任务';
     if(a.op==='sessions')data={sessions:[{name:'main',running:true}]};
     else if(a.op==='agents')data={agents:[agent(a.device,t)]};
     else if(a.op==='status')data={agents:[agent(a.device,t)]};
     else if(a.op==='catalog')data={records:[],total:0,next:null};
     else if(a.op==='account')data={ssh_user:'u',hostname:a.device};
     else if(a.op==='doctor')data={herdr:true,running:1};
     else if(a.op==='glance')data={previews:{}};
     else throw Error('unexpected remote op '+a.op);}
    else if(op==='cacheGet'){
     // B's list from last time, shown while it connects.
     data={value:a.device==='B'&&a.key==='live'?{session:'main',sessions:['main'],agents:[agent('B','Beta 缓存任务')],at:Date.now()-3*60000}:null};}
    else if(op==='settings')data=fx.prefs;
    else if(op==='setSetting'){fx.prefs[a.key]=a.value;if(a.key==='autoResume')fx.enabled=a.value;data=fx.prefs;}
    else if(op==='cacheInfo')data={bytes:0,entries:0};
    else if(!['protect','cachePut','setAlerts','watchState'].includes(op))throw Error('unexpected native op '+op);
   }catch(e){return reply(id,false,{error:e.message});}
   reply(id,true,data);}};
 },cfg);
 await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
 await page.evaluate(()=>{window.followInterval=()=>1e9;});
 return page;}

const connects=page=>page.evaluate(()=>fx.calls.filter(c=>c.op==='connect').map(c=>c.a.id+(c.a.auto?'':'!')+(c.a.background?'~':'')));
const card=(page,name)=>page.locator('.device-card').filter({hasText:name});
const theme=(page,t)=>page.evaluate(t=>{document.documentElement.dataset.theme=t;},t);
const shot=async(page,name)=>{await page.evaluate(()=>document.getElementById('toast')?.classList.remove('show'));await page.waitForTimeout(250);await page.screenshot({path:path.join(shots,'resume-'+name+'.png')});};
const shots2=async(page,name)=>{await shot(page,name+'-light');await theme(page,'dark');await shot(page,name+'-dark');await theme(page,'light');};
const noSheet=async page=>assert.equal(await page.locator('.sheet').count(),0,'nothing pops up at launch');

// 1. B was on screen, A connected too, C needs a typed password. B goes first with its cached list.
let page=await launch({set:{ids:['A','B','C'],active:'B'},delay:{B:'hold'}});
await page.waitForFunction(()=>fx.held.has('B'));
await page.getByText(/正在连接 · 显示上次读取的列表/).waitFor();
await page.getByRole('button',{name:/Beta 缓存任务/}).first().waitFor();
assert.deepEqual(await connects(page),['B'],'the one on screen connects first, alone');
await noSheet(page);
await shots2(page,'connecting');
await page.evaluate(()=>fx.held.get('B')());
await page.getByRole('button',{name:/Beta 任务/}).first().waitFor();
await page.waitForFunction(()=>LINKS.ids.length===2);
assert.deepEqual(await connects(page),['B','A~'],'then A, in the background');
assert.deepEqual(await page.evaluate(()=>[S.device.id,LINKS.ids,fx.active]),['B',['B','A'],'B'],'B stays on screen');
assert.equal(await page.getByRole('button',{name:/Alpha 任务/}).count(),0);
await page.getByRole('group',{name:'切换设备',exact:true}).waitFor();
await noSheet(page);
console.log('PASS: launch reconnects B first (cached list while connecting), then A quietly');

// C was not connected and was not prompted: a quiet row; a tap runs the normal password prompt.
await page.getByRole('button',{name:'设备',exact:true}).click();
const rowC=card(page,'实验室服务器').getByRole('button',{name:'上次连着 · 要输入密码，点一下重新连接',exact:true});
await rowC.waitFor();
assert.equal(await card(page,'实验室服务器').getByRole('button',{name:'连接设备',exact:true}).isDisabled(),false);
await noSheet(page);
await card(page,'实验室服务器').scrollIntoViewIfNeeded();
await shots2(page,'devices');
await rowC.click();
await page.getByRole('dialog',{name:'连接 实验室服务器'}).waitFor();
await page.getByRole('button',{name:'取消',exact:true}).click();
assert.deepEqual(await connects(page),['B','A~'],'the prompt only opened; nothing connected');
console.log('PASS: a password device is not prompted at launch; its row opens the normal prompt');

// 2. Explicit 断开 of A: it is off the list, so the next launch does not reconnect it.
await card(page,'家里的电脑').getByRole('button',{name:'断开',exact:true}).click();
await page.getByRole('dialog',{name:'断开 家里的电脑？'}).getByRole('button',{name:'断开',exact:true}).click();
await page.waitForFunction(()=>LINKS.ids.length===1);
let set=await page.evaluate(()=>fx.set);
assert.deepEqual(set,{ids:['B','C'],active:'B'});
await page.close();
page=await launch({set});
await page.getByRole('button',{name:/Beta 任务/}).first().waitFor();
await page.waitForTimeout(400);
assert.deepEqual(await connects(page),['B'],'A was disconnected on purpose and stays disconnected');
await page.close();
console.log('PASS: explicit disconnect removes the computer from the next launch');

// 3. 设置 off: nothing connects at launch; the switch is in 设置 → 连接 and on by default.
page=await launch({set:{ids:['A','B'],active:'B'}});
await page.waitForFunction(()=>LINKS.ids.length===2);
await page.getByRole('button',{name:'设置',exact:true}).click();
const sw=page.getByRole('checkbox',{name:'启动时自动重连',exact:true});
await sw.waitFor({state:'attached'});
assert.equal(await sw.isChecked(),true,'on by default');
await shots2(page,'settings');
await sw.evaluate(n=>n.click());
await page.waitForFunction(()=>fx.prefs.autoResume===false);
set=await page.evaluate(()=>fx.set);await page.close();
page=await launch({set,enabled:false});
await page.getByRole('button',{name:'添加设备',exact:true}).waitFor();
await page.waitForTimeout(400);
assert.deepEqual(await connects(page),[],'setting off: no connect at launch');
assert.equal(await page.locator('.resume-line').count(),0);
await page.close();
console.log('PASS: 启动时自动重连 off → nothing connects at launch');

// 4. Offline at launch: wait for the network instead of failing; then connect.
page=await launch({set:{ids:['A','B'],active:'A'},online:false});
await card(page,'家里的电脑').getByText('上次连着 · 等网络好了自动连接').waitFor();
await page.waitForTimeout(300);
assert.deepEqual(await connects(page),[],'no connect while offline');
assert.equal(await page.locator('.connection-status.failed').count(),0,'no error while waiting for the network');
await shots2(page,'offline');
await page.evaluate(()=>nativeEvent({type:'online',detail:'',device:''}));
await page.waitForFunction(()=>LINKS.ids.length===2);
assert.deepEqual(await connects(page),['A','B~']);
assert.equal(await page.evaluate(()=>S.device.id),'A');
await page.close();
console.log('PASS: offline launch waits for the network, then reconnects (active first)');

// 5. Failures: a timeout waits for the network again (bounded); a changed key never retries.
page=await launch({set:{ids:['A','B','E'],active:'A'},fail:{A:[{code:'timeout',error:'连接超时'}],B:[{code:'hostkey_changed',error:'电脑的 SSH 指纹变了'}]}});
await page.waitForFunction(()=>fx.calls.filter(c=>c.op==='connect').length===2&&!RESUME.running);
await noSheet(page);
// Nothing could connect: back on the devices page, the reasons on the cards, no page banner.
await page.waitForFunction(()=>S.tab==='devices');
assert.equal(await page.locator('.connection-status.failed').count(),0,'told on the cards, not in a banner');
await card(page,'家里的电脑').getByText(/连不上，超时了 · 网络变了会自动再试/).waitFor();
await card(page,'公司工作站').getByRole('button',{name:/电脑指纹变了，已停止自动重连/}).waitFor();
await card(page,'树莓派').getByRole('button',{name:/要先核对指纹/}).waitFor();
assert.equal(await page.locator('.device-card .device-actions .primary').count(),1,'one filled 连接设备 among the cards, the rest quiet');
assert.deepEqual(await connects(page),['A','B'],'E (untrusted key) was never tried');
await shots2(page,'failed');
await page.evaluate(()=>nativeEvent({type:'online',detail:'',device:''}));
await page.waitForFunction(()=>LINKS.ids.includes('A'));
assert.deepEqual(await connects(page),['A','B','A'],'only the network failure was retried');
await page.evaluate(()=>nativeEvent({type:'online',detail:'',device:''}));
await page.waitForTimeout(300);
assert.deepEqual(await connects(page),['A','B','A'],'no loop once connected');
// The changed key is shown through the normal flow when the user taps it.
await page.getByRole('button',{name:'设备',exact:true}).click();
await page.evaluate(()=>{fx.fail.B=[{code:'hostkey_changed',error:'指纹变了',info:{fingerprint:'SHA256:x'}}];});
await card(page,'公司工作站').getByRole('button',{name:/电脑指纹变了/}).click();
await page.waitForFunction(()=>fx.calls.filter(c=>c.op==='connect').length===4);
assert.equal(await page.evaluate(()=>fx.calls.filter(c=>c.op==='connect').at(-1).a.auto),undefined,'a tap is a normal connect');
await page.close();
console.log('PASS: timeout retried on network change only; changed key / untrusted key never retried');

// 6. The keep-alive service still holds A and B: reattach, no connect at all.
page=await launch({set:{ids:['A','B'],active:'B'},kept:['A','B']});
await page.getByRole('button',{name:/Beta 任务/}).first().waitFor();
await page.waitForTimeout(400);
assert.deepEqual(await connects(page),[],'kept links are reattached, not reconnected');
assert.deepEqual(await page.evaluate(()=>LINKS.ids),['A','B']);
// Only the missing one is connected when the service kept part of the set.
await page.close();
page=await launch({set:{ids:['A','B'],active:'B'},kept:['B']});
await page.waitForFunction(()=>LINKS.ids.length===2);
assert.deepEqual(await connects(page),['A~']);
assert.equal(await page.evaluate(()=>S.device.id),'B');
for(const w of [320,390]){await page.setViewportSize({width:w,height:w===320?640:844});await page.getByRole('button',{name:'设备',exact:true}).click();assert(await page.evaluate(()=>document.scrollingElement.scrollWidth<=innerWidth),'no sideways scroll at '+w);}
await page.close();
console.log('PASS: keep-alive links reattached; only the missing computer reconnects');

assert.deepEqual(errors,[]);
console.log('PASS: no page errors');
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
