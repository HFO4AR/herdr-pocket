// Sharing into Herdr Pocket from another app (native.js). Offline: the native layer is a strict
// fake that records drops and haptics; `remote` is a recorded fake. Nothing is sent anywhere, and a
// share must never send by itself.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const PIXEL='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async()=>{
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});
const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
await page.addInitScript(()=>{
 window.nx={calls:[],haptics:[]};
 window.PocketNative={haptic(kind){nx.haptics.push(kind);},request(id,op,raw){const args=JSON.parse(raw);nx.calls.push({op,args});
  const ok=data=>setTimeout(()=>nativeResult(id,{ok:true,data}),20);
  if(['devices','protect','watchState','dropFiles','dropImages','settings'].includes(op))return ok(op==='devices'?{devices:[]}:op==='settings'?{theme:'system',textZoom:100,alerts:true,notifications:true,version:'test'}:{});
  if(op==='cacheGet')return ok({value:null});if(op==='cachePut')return ok({saved:false});
  throw Error('Forbidden native call in offline UI test: '+op);}};});
await page.goto(require('./ui_bundle.cjs').url(html));
const folder=path.join(root,'ui-artifacts');fs.mkdirSync(folder,{recursive:true});
const shot=async file=>{await page.evaluate(()=>document.getElementById('toast').classList.remove('show'));await page.waitForTimeout(250);await page.screenshot({path:file});};
const banner=page.getByRole('status',{name:'分享',exact:true});

// 1. Not connected: the share waits behind a clear banner.
await page.evaluate(()=>pocketShare({preparing:true}));
await banner.getByText('正在读取分享的内容…',{exact:true}).waitFor();
await page.evaluate(P=>pocketShare({text:'https://example.com/issues/42\n这个报错帮我看看是哪里挂了',images:[{id:'img-1',thumb:P,width:1,height:1,bytes:120000,type:'image/jpeg'}],
 files:[{id:'doc-1',name:'crash-2026-10-15.log',size:5321,mime:'text/plain'}],failed:0,reason:'',extra:0}),PIXEL);
await banner.getByText('待发送：文字、1 张图片、1 个文件',{exact:true}).waitFor();
await banner.getByText('连上电脑后，选发给哪个 Agent',{exact:true}).waitFor();
assert.equal(await banner.getByRole('button',{name:'去连接',exact:true}).count(),0,'already on 设备');
await page.getByRole('button',{name:'历史',exact:true}).click();
await banner.getByRole('button',{name:'去连接',exact:true}).click();
await page.getByRole('heading',{name:'设备',exact:true}).waitFor();
await shot(path.join(folder,'share-waiting-390.png'));
await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});await shot(path.join(folder,'share-waiting-dark-390.png'));
await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
console.log('PASS: share waits with a banner while not connected');

// 2. Connected: the live list loads and the picker opens by itself.
await page.evaluate(()=>{
 const rec=(id,title)=>({id,thread:id+'-thread',provider:'claude',title,cwd:'/home/demo/api',modified:Date.now()/1000});
 window.fx={calls:[],agents:[
  {pane_id:'w1:p1',identity:'id-a',agent:'claude',agent_status:'working',cwd:'/home/demo/api',terminal_title:'重构登录流程',agent_session:{value:'a'},history_ref:{status:'matched',record:rec('rec-a','重构登录流程')}},
  {pane_id:'w1:p2',identity:'id-b',agent:'codex',agent_status:'idle',cwd:'/home/demo/web',terminal_title:'排查线上报错',agent_session:{value:'b'},history_ref:{status:'matched',record:rec('rec-b','排查线上报错')}}]};
 remote=async(op,args={})=>{fx.calls.push({op,args});await new Promise(r=>setTimeout(r,30));
  if(op==='sessions')return{sessions:[{name:'fixture',running:true}]};
  if(op==='agents'&&args.target)return{follow:true,state:'same',agents:fx.agents.filter(a=>a.pane_id===args.target),pane:null};
  if(op==='agents'||op==='status')return{agents:fx.agents};
  if(op==='history')return{record:fx.agents.find(a=>a.history_ref.record.id===args.record_id)?.history_ref.record,messages:[],children:[],before:0,has_more:false};
  if(op==='read')return{text:'› '};
  if(op==='account')return{ssh_user:'demo',hostname:'box'};
  if(op==='catalog')return{records:[],total:0,next:null};
  if(op==='commands')return{commands:[]};
  if(op==='prompt')return{sent:true,receipt:args.id};
  throw Error('unexpected op '+op);};
 S.device={id:'dev-1',name:'家里的电脑',host:'box',user:'demo',port:22};render();});
const picker=page.getByRole('dialog',{name:'发给哪个 Agent',exact:true});
await picker.waitFor();
await picker.getByText('这个报错帮我看看是哪里挂了',{exact:false}).waitFor();
assert.equal(await picker.locator('.share-peek-imgs img').count(),1);
await picker.getByText('crash-2026-10-15.log',{exact:true}).waitFor();
assert.deepEqual(await picker.locator('.agent-pick .menu-label').allTextContents(),['重构登录流程','排查线上报错'],'working first, then idle');
assert(await page.locator('.share-banner').evaluate(n=>n.classList.contains('hidden')),'banner hides under the sheet');
await shot(path.join(folder,'share-picker-390.png'));
await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});await shot(path.join(folder,'share-picker-dark-390.png'));
await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
await page.setViewportSize({width:320,height:640});await page.waitForTimeout(150);
assert(await page.evaluate(()=>document.scrollingElement.scrollWidth<=innerWidth),'no sideways scroll at 320');
await shot(path.join(folder,'share-picker-320.png'));
await page.setViewportSize({width:390,height:844});

// "稍后再选" keeps the share; the banner reopens the picker.
await picker.getByRole('button',{name:'稍后再选',exact:true}).click();
await banner.getByRole('button',{name:'选 Agent',exact:true}).click();
await picker.waitFor();
console.log('PASS: picker opens once connected, previews the share, can wait');

// 3. Pick: the chat opens with a draft (text, picture, file); nothing is sent.
await picker.getByRole('button',{name:/排查线上报错/}).click();
const input=page.getByRole('textbox',{name:'消息输入框',exact:true});
await input.waitFor();
assert.equal(await input.inputValue(),'https://example.com/issues/42\n这个报错帮我看看是哪里挂了');
assert.equal(await page.getByRole('list',{name:'要发送的图片',exact:true}).getByRole('listitem').count(),1);
assert.equal(await page.getByRole('list',{name:'要发送的文件',exact:true}).getByRole('listitem').count(),1);
assert.equal(await page.evaluate(()=>fx.calls.filter(c=>c.op==='prompt').length),0,'a share never sends by itself');
await page.waitForFunction(()=>!document.querySelector('.share-banner'));
assert(await page.evaluate(()=>nx.haptics.includes('tick')),'light haptic when the draft lands');
await page.getByText('已放进输入框，看一眼再发',{exact:true}).waitFor();
await shot(path.join(folder,'share-draft-390.png'));
console.log('PASS: chosen agent gets the share as a draft');

// 4. Another share while typing in this chat: appended after what is already there; current agent first.
await input.fill('先别改代码');
await page.evaluate(()=>pocketShare({text:'日志在附件里',images:[],files:[],failed:0}));
await picker.waitFor();
assert.equal(await picker.locator('.agent-pick').first().locator('.menu-label').textContent(),'排查线上报错','current agent first');
await picker.getByText(/^当前 · /).waitFor();
await picker.getByRole('button',{name:/排查线上报错/}).click();
await page.waitForFunction(()=>document.querySelector('.composer textarea')?.value==='先别改代码\n\n日志在附件里');
console.log('PASS: a second share appends to the draft');

// 5. Cancelling drops prepared attachments natively.
await page.evaluate(P=>pocketShare({text:'',images:[{id:'img-9',thumb:P,bytes:1000}],files:[{id:'doc-9',name:'a.zip',size:10}],failed:0}),PIXEL);
await picker.waitFor();
await picker.getByRole('button',{name:'取消分享',exact:true}).click();
await page.getByText('已取消分享',{exact:true}).waitFor();
const drops=await page.evaluate(()=>nx.calls.filter(c=>c.op==='dropImages'||c.op==='dropFiles').map(c=>c.args.ids.join()));
assert(drops.includes('img-9')&&drops.includes('doc-9'),'cancel drops both: '+drops);
assert.equal(await page.locator('.share-banner').count(),0);
console.log('PASS: cancel drops the prepared attachments');

// 6. Unreadable share: says so, nothing pending.
await page.evaluate(()=>pocketShare({text:'',images:[],files:[],failed:1,reason:'没有权限'}));
await page.getByText('分享的内容读不到：没有权限',{exact:true}).waitFor();
assert.equal(await page.locator('.share-banner').count(),0);

// 7. Sending (by the user) gives confirm feedback; the send itself is the normal path.
await page.getByRole('button',{name:'删掉图片 1',exact:true}).click();
await page.getByRole('button',{name:'删掉文件 crash-2026-10-15.log',exact:true}).click();
await page.getByRole('button',{name:'发送消息',exact:true}).click();
await page.waitForFunction(()=>fx.calls.some(c=>c.op==='prompt'));
assert.equal(await page.evaluate(()=>fx.calls.find(c=>c.op==='prompt').args.text),'先别改代码\n\n日志在附件里');
assert(await page.evaluate(()=>nx.haptics.includes('confirm')),'confirm haptic on send');
console.log('PASS: haptics on send; unreadable share reported');

assert.deepEqual(errors,[]);
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
