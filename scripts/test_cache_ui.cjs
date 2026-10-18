// Show-then-refresh cache: the last list and chat appear while SSH connects, are read-only
// until it is up, then get replaced by fresh reads. Native SSH and storage are offline fixtures.
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
 const r1={id:'r1',thread:'t-1',title:'修复登录页',provider:'claude',parent:null,cwd:'/work/proj',modified:now-60};
 const msg=(id,kind,text,age)=>({id:id+':0',kind,text,title:'',call_id:'',timestamp:iso(age)});
 const A1={pane_id:'w1:p1',terminal_id:'term1',agent:'claude',agent_status:'idle',identity:'id-1',cwd:'/work/proj',title:'修复登录页',history_ref:{status:'matched',source:'native-process',record_id:'r1',thread:'t-1',record:r1}};
 const device={id:'fx',name:'测试电脑',user:'u',host:'fixture.invalid',port:22,remember:true};
 const at=Date.now()-5*60000;
 // Native cache store, keyed like LocalCache: device + key.
 const store=new Map([
  ['fx\nlive',{session:'fx',sessions:['fx'],agents:[A1],at}],
  ['fx\ncatalog',{records:[r1],total:1,next:null,at}],
  ['fx\nchat:r1:',{messages:[msg(1,'user','登录页错位了',400),msg(2,'assistant','缓存里的旧回答',390)],children:[],at}]]);
 window.fx={store,calls:[],puts:[],gets:[],connect:null,history:[msg(1,'user','登录页错位了',400),msg(2,'assistant','缓存里的旧回答',390),msg(3,'user','再检查一下',30),msg(4,'assistant','新鲜的回答：都好了。',20)]};
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);let data={};
  if(op==='devices')data={devices:[device],version:'test'};
  else if(op==='connect'){fx.connect=id;return;}
  else if(op==='cacheGet'){fx.gets.push(a);data={value:store.get(a.device+'\n'+a.key)||null};}
  else if(op==='cachePut'){fx.puts.push(a);store.set(a.device+'\n'+a.key,a.value);data={saved:true};}
  else if(op==='cacheInfo')data={bytes:JSON.stringify([...store.values()]).length,entries:store.size};
  else if(op==='cacheClear'){store.clear();}
  else if(op==='remote'){fx.calls.push(a.op);
   if(a.op==='sessions')data={sessions:[{name:'fx',running:true}]};
   else if(a.op==='agents')data={agents:[A1]};
   else if(a.op==='status')data={agents:[{...A1,history_ref:undefined}]};
   else if(a.op==='history')data={record:r1,messages:fx.history,before:0,has_more:false,children:[]};
   else if(a.op==='read')data={text:'$ ',agent_status:'idle'};
   else if(a.op==='catalog')data={records:[r1],total:1,next:null};
   else if(a.op==='hidden')data={ids:[]};
   else if(a.op==='commands')data={commands:[]};
   else if(a.op==='account')data={ssh_user:'u',hostname:'fx'};
   else throw Error('unexpected remote op '+a.op);}
  else if(!['watchState','protect','setAlerts','demo','disconnect'].includes(op))throw Error('unexpected native op '+op);
  setTimeout(()=>nativeResult(id,{ok:true,data}),0);}};
});
await page.goto(require('./ui_bundle.cjs').url(html));
const shot=name=>page.screenshot({path:path.join(shots,'cache-'+name+'.png')});

// 1. Connecting: the cached list shows at once, nothing is read over SSH yet.
await page.getByRole('button',{name:'连接设备',exact:true}).click();
await page.getByText(/正在连接 · 显示上次读取的列表 · 5 分钟前/).waitFor();
await page.getByRole('button',{name:/修复登录页/}).waitFor();
assert.equal(await page.evaluate(()=>S.tab),'live');
assert.deepEqual(await page.evaluate(()=>fx.calls),[]);
await shot('list-connecting');

// The history tab also has its cached catalog while connecting.
await page.locator('.bottom-nav').getByRole('button',{name:'历史',exact:true}).click();
await page.locator('.history-row').filter({hasText:'修复登录页'}).waitFor();
await page.locator('.bottom-nav').getByRole('button',{name:'会话',exact:true}).click();

// 2. Opening the agent paints the cached chat; it is read-only until SSH is up.
await page.getByRole('button',{name:/修复登录页/}).click();
await page.getByText('缓存里的旧回答').waitFor();
await page.getByText(/连接好后自动刷新/).waitFor();
await page.getByText(/连上后才能发送/).waitFor();
// The draft can be written while connecting, but nothing can be sent from the cache.
assert(await page.getByRole('button',{name:'发送消息',exact:true}).isDisabled());
assert.deepEqual(await page.evaluate(()=>fx.calls),[]);
await shot('chat-connecting');

// 3. Connected: the reader stays in the chat, which refreshes in place and becomes writable.
await page.evaluate(()=>nativeResult(fx.connect,{ok:true,data:{device:{id:'fx',name:'测试电脑',user:'u',host:'fixture.invalid',port:22,remember:true},ready:true}}));
await page.getByText('新鲜的回答：都好了。').waitFor();
assert.equal(await page.evaluate(()=>!!S.chat&&S.chat.record.id),'r1');
await page.getByRole('textbox',{name:'消息输入框',exact:true}).waitFor();
assert.equal(await page.getByText(/上次读取/).count(),0);
assert(await page.evaluate(()=>fx.calls.includes('history')&&fx.calls.includes('agents')));
// Fresh content is written back (debounced).
await page.waitForFunction(()=>fx.store.get('fx\nchat:r1:')?.messages?.length===4,null,{timeout:5000});
await page.waitForFunction(()=>fx.store.get('fx\nlive')?.at>Date.now()-60000,null,{timeout:5000});
await shot('chat-fresh');

// 4. Reopening the same chat later paints from memory before the read returns.
await page.getByRole('button',{name:'返回列表',exact:true}).click();
assert.equal(await page.getByText(/正在连接/).count(),0);
await page.evaluate(()=>{window.origRequest=PocketNative.request;PocketNative.request=(id,op,raw)=>{const a=JSON.parse(raw);if(op==='remote'&&a.op==='history'){fx.heldHistory=id;return;}origRequest(id,op,raw);};});
await page.getByRole('button',{name:/修复登录页/}).click();
await page.getByText('新鲜的回答：都好了。').waitFor();
await page.getByText(/正在更新/).waitFor();
await page.evaluate(()=>{PocketNative.request=origRequest;fx.history=fx.history.concat([{id:'5:0',kind:'assistant',text:'又一条新回答',title:'',call_id:'',timestamp:new Date().toISOString()}]);origRequest(fx.heldHistory,'remote',JSON.stringify({op:'history',record_id:'r1'}));});
await page.getByText('又一条新回答').waitFor();
assert.equal(await page.getByText(/正在更新/).count(),0);
await page.getByRole('button',{name:'返回列表',exact:true}).click();

// 5. Demo mode never writes the cache.
await page.waitForTimeout(1500);
const before=await page.evaluate(()=>fx.puts.length);
await page.evaluate(async()=>{await disconnect(false);await startDemo();});
await page.getByRole('button',{name:/./}).first().waitFor();
await page.evaluate(async()=>{const a=S.agents[0];await openAgent(a);});
await page.waitForTimeout(1800);
assert.equal(await page.evaluate(()=>fx.puts.length),before);

// 6. Clearing: native store and memory both empty.
await page.evaluate(async()=>{await rpc('cacheClear');cacheForget();});
assert.equal(await page.evaluate(()=>fx.store.size),0);
assert.equal(await page.evaluate(()=>CACHE.mem.size),0);
assert.equal(await page.evaluate(async()=>{S.demo=false;const v=await cacheGet('live','fx');S.demo=true;return v;}),null);

assert.deepEqual(errors,[]);
console.log('PASS: cached list/chat while connecting, refresh in place, demo never cached, clear works');
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
