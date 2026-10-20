// 模型 · CC Switch: list Claude/Codex providers, mark the current one, explain that only new
// sessions change, refuse official rows, and switch with a confirmation. Offline: the native side
// is a strict fake; a switch only changes fixture values (never a real ~/.cc-switch / ~/.claude /
// ~/.codex). The fake response also carries token/base-URL fields the page must not render.
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
 const record={id:'r1',thread:'t1',title:'模型测试',provider:'claude',parent:null,cwd:'/work/proj',modified:Date.now()/1000-60};
 const agent={pane_id:'w1:p1',terminal_id:'term1',agent:'claude',agent_status:'idle',identity:'id-1',cwd:'/work/proj',title:'模型测试',history_ref:{status:'matched',source:'native-process',record_id:'r1',thread:'t1',record}};
 const device={id:'fx',name:'测试电脑',user:'u',host:'fixture.invalid',port:22,remember:true};
 const claude=[
  {id:'deepseek',app_type:'claude',name:'DeepSeek',is_current:true,official:false,switchable:true,
   models:[{slot:'默认',model:'deepseek-chat'},{slot:'Haiku',model:'deepseek-haiku',name:'DeepSeek Haiku'}],
   token:'sk-SHOULD-NOT-RENDER',base_url:'https://deepseek.invalid'},
  {id:'other',app_type:'claude',name:'Other Provider',is_current:false,official:false,switchable:true,
   models:[{slot:'默认',model:'other-model',name:'Other Model'}],token:'sk-SHOULD-NOT-RENDER',base_url:'https://other.invalid'},
  {id:'claude-official',app_type:'claude',name:'Claude Official',is_current:false,official:true,switchable:false,
   reason:'官方登录：请在电脑的 CC Switch 里切换或重新登录',models:[]}];
 const codex=[
  {id:'default',app_type:'codex',name:'default',is_current:true,official:true,switchable:false,
   reason:'官方登录：请在电脑的 CC Switch 里切换或重新登录',models:[{slot:'默认',model:'gpt-5.5'}]},
  {id:'kimi',app_type:'codex',name:'kimi',is_current:false,official:false,switchable:true,
   models:[{slot:'默认',model:'kimi-for-coding'}],model_provider:'custom',token:'sk-SHOULD-NOT-RENDER',base_url:'https://kimi.invalid'}];
 window.fx={calls:[],current:{claude:'deepseek',codex:'default'},claude,codex,missing:false};
 const reply=(id,data,err)=>setTimeout(()=>nativeResult(id,err?{ok:false,error:err}:{ok:true,data}),0);
 function providers(){return [...fx.claude,...fx.codex].map(p=>({...p,is_current:fx.current[p.app_type]===p.id}));}
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);fx.calls.push({op,a});
  if(op==='devices')return reply(id,{devices:[device],version:'test',connected:device});
  if(op==='settings')return reply(id,{version:'test',versionCode:1,theme:'system',dark:false,textZoom:100,autoResume:false,keepAlive:false,keepAliveMinutes:60,autoUpdate:false,notifications:true,secureScreen:false,alerts:true});
  if(op==='cacheInfo')return reply(id,{bytes:0,entries:0});
  if(op!=='remote'){if(['watchState','protect','setAlerts','cacheGet','cachePut','demo','disconnect'].includes(op))return reply(id,{});throw Error('unexpected native op '+op);}
  if(a.op==='sessions')return reply(id,{sessions:[{name:'fx',running:true}]});
  if(a.op==='agents')return reply(id,{agents:[agent]});
  if(a.op==='status')return reply(id,{agents:[agent]});
  if(a.op==='history')return reply(id,{record,messages:[{id:'m1:0',kind:'user',text:'你好',timestamp:new Date().toISOString()}],before:0,has_more:false,children:[]});
  if(a.op==='catalog')return reply(id,{records:[record],total:1,next:null});
  if(a.op==='read')return reply(id,{text:'$ '});
  if(a.op==='ccswitch'){
   if(fx.missing)return reply(id,{available:false,reason:'电脑上没有 CC Switch',apps:['claude','codex'],current:{claude:null,codex:null},providers:[]});
   return reply(id,{available:true,apps:['claude','codex'],current:{...fx.current},providers:providers(),note:'密钥只留在电脑上。'});}
  if(a.op==='ccswitchSwitch'){
   const app=a.app,provider=a.provider;
   if(!fx[app].some(p=>p.id===provider&&p.switchable))return reply(id,null,'这个供应商不能切换');
   fx.current[app]=provider;
   return reply(id,{switched:true,app,provider,name:fx[app].find(p=>p.id===provider).name,new_sessions_only:true,
    backup_count:1,message:'已切换到「'+fx[app].find(p=>p.id===provider).name+'」。新打开的 '+(app==='claude'?'Claude':'Codex')+' 会话会用它；正在运行的 Agent 不受影响，密钥只留在电脑上。'});}
  throw Error('blocked remote op '+a.op);}};
});
await page.goto(require('./ui_bundle.cjs').url(html));
await page.evaluate(()=>{window.followInterval=()=>1e9;S.paused=true;});
const shot=async name=>{await page.evaluate(()=>document.getElementById('toast').classList.remove('show'));await page.waitForTimeout(250);await page.screenshot({path:path.join(shots,'ccswitch-'+name+'.png')});};
const calls=op=>page.evaluate(o=>fx.calls.filter(c=>c.a.op===o||c.op===o),op);

// The settings page has the same entry when a computer is connected.
await page.getByRole('button',{name:'设置',exact:true}).click();
await page.getByRole('heading',{name:'设置',exact:true}).waitFor();
await page.locator('.main').getByRole('button',{name:/模型 · CC Switch/}).waitFor();
await page.getByRole('button',{name:'会话',exact:true}).click();
console.log('PASS: 模型 · CC Switch is also reachable from 设置');

await page.getByRole('button',{name:/模型测试/}).click();
await page.getByText('你好',{exact:true}).waitFor();
await page.getByRole('button',{name:'更多操作',exact:true}).click();
const menu=page.getByRole('dialog',{name:'对话操作'});
await menu.getByRole('button',{name:/模型 · CC Switch/}).click();
const sheet=page.getByRole('dialog',{name:'模型 · CC Switch'});
await sheet.waitFor();
await sheet.getByText('DeepSeek Haiku',{exact:false}).first().waitFor();
console.log('PASS: 模型 · CC Switch opens from the conversation menu');

// Current marker, model slots and official display-only rows.
const current=sheet.locator('.ccs-provider').filter({hasText:'DeepSeek'}).first();
assert.equal(await current.getAttribute('aria-current'),'true');
assert.match(await current.innerText(),/当前/);
assert.match(await current.innerText(),/DeepSeek Haiku/);
const official=sheet.locator('.ccs-provider').filter({hasText:'Claude Official'});
assert.equal(await official.isDisabled(),true,'official Claude provider cannot be switched from the phone');
assert.match(await official.innerText(),/官方 · 仅显示/);
const rendered=await sheet.innerText();
for(const secret of ['sk-SHOULD-NOT-RENDER','https://deepseek.invalid','https://other.invalid','https://kimi.invalid','token']){
 assert(!rendered.includes(secret),'page must not render '+secret);}
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
await shot('claude');

// Refresh asks the bridge again (read-only).
await sheet.getByRole('button',{name:'刷新',exact:true}).click();
await page.waitForFunction(()=>fx.calls.filter(c=>c.a.op==='ccswitch').length===2);
await sheet.getByRole('tab',{name:'Codex',exact:true}).click();
await sheet.getByText('gpt-5.5',{exact:false}).first().waitFor();
assert.equal(await sheet.locator('.ccs-provider').filter({hasText:'default'}).isDisabled(),true);
await shot('codex');
console.log('PASS: tabs, current marker, model slots, refresh and official display-only rows');

// Switch with a confirmation that says new sessions only; running agents are not restarted.
await sheet.getByRole('tab',{name:'Claude',exact:true}).click();
await sheet.locator('.ccs-provider').filter({hasText:'Other Provider'}).click();
const confirm=page.getByRole('dialog',{name:'切换模型供应商'});
await confirm.waitFor();
const confirmText=await confirm.innerText();
assert.match(confirmText,/新打开的 Claude 会话/);
assert.match(confirmText,/正在运行的 Agent 不会重启/);
assert.match(confirmText,/密钥不会发到手机/);
await confirm.getByRole('button',{name:'切换',exact:true}).click();
await page.getByText('已切换到「Other Provider」',{exact:false}).waitFor();
const switchCalls=await calls('ccswitchSwitch');
assert.equal(switchCalls.at(-1).a.app,'claude');
assert.equal(switchCalls.at(-1).a.provider,'other');
const reopened=page.getByRole('dialog',{name:'模型 · CC Switch'});
await reopened.locator('.ccs-provider').filter({hasText:'Other Provider'}).first().waitFor();
assert.equal(await reopened.locator('.ccs-provider').filter({hasText:'Other Provider'}).first().getAttribute('aria-current'),'true');
console.log('PASS: confirmation, switch call and current provider update');

// Codex switch (third-party), then the friendly missing-CC-Switch state.
await reopened.getByRole('tab',{name:'Codex',exact:true}).click();
await reopened.locator('.ccs-provider').filter({hasText:'kimi'}).click();
await page.getByRole('dialog',{name:'切换模型供应商'}).getByRole('button',{name:'切换',exact:true}).click();
await page.getByText('已切换到「kimi」',{exact:false}).waitFor();
{const last=(await calls('ccswitchSwitch')).at(-1).a;
 assert.equal(last.app,'codex');assert.equal(last.provider,'kimi');}
const codexSheet=page.getByRole('dialog',{name:'模型 · CC Switch'});
await codexSheet.locator('.ccs-provider').filter({hasText:'kimi'}).first().waitFor();
assert.equal(await codexSheet.locator('.ccs-provider').filter({hasText:'kimi'}).first().getAttribute('aria-current'),'true');
await page.evaluate(()=>{fx.missing=true;});
await codexSheet.getByRole('button',{name:'刷新',exact:true}).click();
await codexSheet.getByText('电脑上没有 CC Switch',{exact:true}).waitFor();
await shot('missing');
console.log('PASS: Codex switch and friendly missing-CC-Switch message');

// Narrow phone, dark theme and tablet: no horizontal overflow; the sheet stays usable.
await page.evaluate(()=>{fx.missing=false;});
await codexSheet.getByRole('button',{name:'刷新',exact:true}).click();
await codexSheet.getByText('kimi',{exact:false}).first().waitFor();
await page.evaluate(()=>document.documentElement.dataset.theme='dark');
await page.setViewportSize({width:320,height:640});await page.waitForTimeout(200);
{const fit=await page.evaluate(()=>{const s=document.querySelector('#overlay .sheet');const r=s.getBoundingClientRect();return {width:r.width,right:r.right,inView:r.right<=innerWidth+0.5,scroll:document.documentElement.scrollWidth<=innerWidth};});
 assert(fit.inView&&fit.scroll,'320 px: sheet and page fit without horizontal scroll: '+JSON.stringify(fit));}
await codexSheet.getByRole('tab',{name:'Claude',exact:true}).click();
await shot('narrow-dark');
await page.setViewportSize({width:1024,height:768});await page.waitForTimeout(250);
{const fit=await page.evaluate(()=>{const s=document.querySelector('#overlay .sheet');const r=s.getBoundingClientRect();return {inView:r.right<=innerWidth+0.5,scroll:document.documentElement.scrollWidth<=innerWidth};});
 assert(fit.inView&&fit.scroll,'tablet: sheet and page fit: '+JSON.stringify(fit));}
await shot('tablet-dark');
assert.deepEqual(errors,[],'no page errors');
console.log('PASS: dark/narrow/tablet layout, no overflow, no page errors');
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
