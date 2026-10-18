// /status as one card: Claude's settings panel (Status · Config · Usage · Stats) walked by the bridge
// `panelTour` after the phone's own /status or /usage, every tab shown as rows; Codex /status read
// as rows from its one screen. Screens are the bridge fixtures (tests/fixtures/claude_panel.json).
// Offline: native SSH is a strict fake that records every request.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
const root=path.resolve(__dirname,'..');
const html=require('./ui_bundle.cjs')(root);
const shots=path.join(root,'ui-artifacts');fs.mkdirSync(shots,{recursive:true});
const P=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/claude_panel.json'),'utf8'));
// What `panelTour` returns for these screens: the rows between the tab row and the key hint.
const body=t=>{const l=t.split('\n');const at=l.findIndex(x=>/^\s*Settings\s{2,}Status/.test(x));const rest=l.slice(at+1);while(rest.length&&!rest.at(-1).trim())rest.pop();
 if(/Esc to|to switch|ctrl\+s to copy/.test(rest.at(-1)||''))rest.pop();while(rest.length&&!rest.at(-1).trim())rest.pop();while(rest.length&&!rest[0].trim())rest.shift();return rest.join('\n');};
// Claude with a subscription shows bars on Usage (written after the 2.1.268 layout; this machine bills by API).
const PLAN='   Current session\n   █████████████▌                                     27% used\n   Resets 5pm (Asia/Shanghai)\n\n   Current week (all models)\n   ██████                                             12% used\n   Resets Oct 23, 10am (Asia/Shanghai)';
const TOUR={tabs:[{tab:'Status',text:body(P.status),more:false},{tab:'Config',text:body(P.config),more:true},{tab:'Usage',text:body(P.usage)+'\n\n'+PLAN,more:false},{tab:'Stats',text:body(P.stats),more:false}],
 order:['Status','Config','Usage','Stats'],start:'Status',closed:true,steps:['right','right','right','esc'],sent:true};
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});
const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
await page.addInitScript(({P,TOUR})=>{
 const now=Date.now()/1000,iso=s=>new Date((now-s)*1000).toISOString();
 const rec=(id,thread,title,provider)=>({id,thread,title,provider,parent:null,cwd:'/work/proj',modified:now-60});
 const R={r1:rec('r1','t1','整理发布脚本','claude'),r2:rec('r2','t2','Codex 修 bug','codex')};
 let n=50;const msg=(kind,text,age=30)=>({id:(++n)+':0',kind,text,title:'',call_id:'',timestamp:iso(age)});
 const H={r1:[msg('user','把发布脚本整理一下',400),msg('assistant','好，整理完了。',390)],r2:[msg('user','修一下登录',200),msg('assistant','修好了。',190)]};
 const ref=r=>({status:'matched',source:'native-process',record_id:r.id,thread:r.thread,record:r});
 const A1={pane_id:'w1:p1',terminal_id:'term1',agent:'claude',agent_status:'idle',identity:'id-1',cwd:'/work/proj',title:'整理发布脚本',history_ref:ref(R.r1)};
 const A2={pane_id:'w1:p2',terminal_id:'term2',agent:'codex',agent_status:'idle',identity:'id-2',cwd:'/work/proj',title:'Codex 修 bug',history_ref:ref(R.r2)};
 const IDLE='❯ \n  ? for shortcuts';
 window.fx={P,TOUR,list:[A1,A2],screen:IDLE,menu:null,IDLE,prompts:[],keys:[],tours:[],reads:0,tourDelay:700,tourResult:TOUR,tourError:null,copied:null,nx:[]};
 const device={id:'fx',name:'测试电脑',user:'u',host:'fixture.invalid',port:22,remember:true};
 const strip=a=>{const {history_ref,...rest}=a;return rest;};
 const reply=(id,res,ms=10)=>setTimeout(()=>nativeResult(id,res),ms);
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);let data={};fx.nx.push({op,args:a});
  try{
  if(op==='devices')data={devices:[device],version:'test',connected:device};
  else if(op==='remote'){
   if(a.op==='sessions')data={sessions:[{name:'fx',running:true}]};
   else if(a.op==='agents'){if(a.target){const row=fx.list.find(x=>x.pane_id===a.target);data={follow:true,state:'same',agents:[row],pane:null};}else data={agents:fx.list};}
   else if(a.op==='status')data={agents:fx.list.map(strip)};
   else if(a.op==='history')data={record:Object.values(R).find(r=>r.id===a.record_id),messages:H[a.record_id]||[],before:0,has_more:false,children:[]};
   else if(a.op==='read'){fx.reads++;const row=fx.list.find(x=>x.pane_id===a.target);data={text:fx.screen,agent_status:row?.agent_status,...(a.menu===true?{menu:fx.menu}:{})};}
   else if(a.op==='commands')data={provider:'claude',commands:[]};
   else if(a.op==='prompt'){fx.prompts.push(a);data={sent:true,receipt:a.id};}
   else if(a.op==='key'){fx.keys.push(a.key);if(a.key==='esc'){fx.screen=fx.IDLE;fx.menu=null;}data={sent:true,receipt:a.id};}
   else if(a.op==='panelTour'){fx.tours.push(a);
    // The bridge closes the panel at the end: the screen is the input box again.
    if(fx.tourError){reply(id,{ok:false,error:fx.tourError},fx.tourDelay);return;}
    setTimeout(()=>{if(fx.tourResult.closed)fx.screen=fx.IDLE;},fx.tourDelay-5);reply(id,{ok:true,data:{...fx.tourResult,receipt:a.id}},fx.tourDelay);return;}
   else if(a.op==='catalog')data={records:[],total:0,next:null};
   else if(a.op==='account')data={ssh_user:'u',hostname:'fx'};
   else throw Error('unexpected remote op '+a.op);}
  else if(!['watchState','protect','setAlerts','dropImages'].includes(op))throw Error('unexpected native op '+op);
  }catch(e){reply(id,{ok:false,error:e.message});return;}
  reply(id,{ok:true,data});}};
},{P,TOUR});
await page.goto('data:text/html;charset=utf-8;base64,'+Buffer.from(html).toString('base64'));
await page.evaluate(()=>{window.followInterval=()=>1e9;window.copyText=t=>{fx.copied=t;};});
const shot=async name=>{await page.evaluate(()=>document.getElementById('toast').classList.remove('show'));await page.waitForTimeout(250);await page.screenshot({path:path.join(shots,'status-'+name+'.png')});};
const box=()=>page.getByRole('textbox',{name:'消息输入框',exact:true});
const sendBtn=()=>page.getByRole('button',{name:'发送消息',exact:true});
const send=async text=>{await box().fill(text);await box().press('Escape');await sendBtn().click();};
const cardFor=cmd=>page.locator('.slash-card:not(.logged)').filter({has:page.locator('.slash-cmd',{hasText:new RegExp('^'+cmd.replace('/','\\/')+'$')})}).last();
// Between steps: the input box is back and no card is still reading the screen.
const idle=async()=>{await page.evaluate(()=>{fx.screen=fx.IDLE;fx.menu=null;fx.list=fx.list.map(a=>({...a,agent_status:'idle'}));S.chat.agent={...S.chat.agent,agent_status:'idle'};S.outbox=[];renderComposer();});
 await page.waitForFunction(()=>slashCards().every(c=>!c.capturing&&!c.panel&&c.tour!=='running'),null,{timeout:15000});};

await page.getByRole('button',{name:/整理发布脚本/}).click();
await page.getByText('好，整理完了。').first().waitFor();

// 1. /status: the first read finds the panel, the bridge walks it once (fresh id, command "status").
await page.evaluate(()=>{fx.screen=fx.P.status;});
await send('/status');
const card=cardFor('/status');
await card.getByText('正在翻面板…',{exact:true}).waitFor();
await card.getByText(/逐个翻 状态 → 设置 → 用量 → 统计/).waitFor();
assert.equal(await card.getByRole('button',{name:'Esc 关闭'}).count(),0,'no keys to press while the bridge walks it');
// While it walks, a normal message waits (it would land in the panel).
await send('接着整理');
await page.getByText(/正在读 \/status 的面板/).waitFor();
assert.deepEqual(await page.evaluate(()=>fx.prompts.map(p=>p.text)),['/status']);
assert.equal(await box().inputValue(),'接着整理','draft kept');
await box().fill('');
await card.getByText('读完了 · 面板已关',{exact:true}).waitFor();
const tours=await page.evaluate(()=>fx.tours);
assert.equal(tours.length,1);
assert.equal(tours[0].command,'status');assert.match(tours[0].id,/^[0-9a-f-]{36}$/);
assert.deepEqual(Object.keys(tours[0]).filter(k=>k!=='device').sort(),['command','id','identity','op','session','target'],'device picks the computer and is dropped natively');
assert.deepEqual(await page.evaluate(()=>fx.keys),[],'the phone itself pressed nothing');
// Every tab as a section; Status and Usage open, Config and Stats folded.
await card.getByText('4 个标签都读到了：状态 · 设置 · 用量 · 统计').waitFor();
const sec=tab=>card.locator('.panel-section[data-tab="'+tab+'"]');
assert.deepEqual(await card.locator('.panel-section').evaluateAll(n=>n.map(x=>[x.dataset.tab,x.open])),[['Status',true],['Config',false],['Usage',true],['Stats',false]]);
const kv=async(tab,k)=>(await sec(tab).locator('.panel-kv').filter({has:page.locator('.panel-k',{hasText:new RegExp('^'+k.replace(/[()]/g,'\\$&')+'$')})}).locator('.panel-v').textContent());
assert.equal(await kv('Status','Version'),'2.1.268');
assert.equal(await kv('Status','cwd'),'/home/me/work/demo');
assert.equal(await kv('Status','Model'),'glm-5.3-flashx[1M] (glm-5.3-flashx[1m])');
assert.equal(await kv('Status','Managed settings (remote)'),'not fetched — not available with a custom ANTHROPIC_BASE_URL');
assert.equal(await kv('Usage','Total cost'),'$0.0000');
// Usage bars: percent, a meter for screen readers, the reset time under it.
const bars=sec('Usage').locator('.panel-bar');
assert.equal(await bars.count(),2);
assert.equal(await bars.nth(0).locator('.panel-k').textContent(),'Current session');
assert.equal(await bars.nth(0).locator('.panel-pct').textContent(),'27% 已用');
assert.equal(await bars.nth(0).getByRole('meter').getAttribute('aria-valuenow'),'27');
assert.equal(await bars.nth(0).locator('.panel-reset').textContent(),'重置：5pm (Asia/Shanghai)');
assert.equal(await bars.nth(1).locator('.panel-k').textContent(),'Current week (all models)');
await shot('card-390');
await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
await shot('card-dark-390');
await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
// Config folded: open it, settings rows and the "more below" note (the rest is never scrolled to).
await sec('Config').locator('summary').click();
assert.equal(await kv('Config','Auto-compact'),'true');
assert.equal(await kv('Config','Theme'),'Dark mode');
await sec('Config').getByText('还有 10 项没显示，要在终端里往下翻').waitFor();
assert.equal(await sec('Config').getByText(/Search settings/).count(),0,'the search box is not a row');
await sec('Stats').locator('summary').click();
assert.equal(await kv('Stats','Favorite model'),'deepseek-v4…');
assert.equal(await kv('Stats','Longest session'),'1d 1h 27m');
await sec('Stats').getByText('活跃度热力图只在终端里看得到').waitFor();
assert.equal(await sec('Stats').getByText(/·····/).count(),0);
await shot('config-stats-390');
// Copy: every tab as text; the terminal text stays one tap away.
await card.getByRole('button',{name:'复制'}).click();
const copied=await page.evaluate(()=>fx.copied);
assert.match(copied,/^【状态 Status】\nVersion:\s+2\.1\.268/);
for(const s of ['【设置 Config】','【用量 Usage】','【统计 Stats】','Auto-compact','27% used'])assert(copied.includes(s),s);
await card.locator('.panel-raw summary').click();
await card.locator('.panel-raw pre').getByText(/── Usage ──/).waitFor();
assert.equal(await card.getByRole('button',{name:'刷新'}).count(),0,'nothing left to re-read once it is closed');
// Fits a phone: no sideways scroll, tap targets ≥44 px.
for(const w of [320,390]){await page.setViewportSize({width:w,height:w===320?640:844});await page.waitForTimeout(150);
 assert(await page.evaluate(()=>document.scrollingElement.scrollWidth<=innerWidth),'no sideways scroll at '+w);
 for(const b of await card.locator('summary, .slash-actions button').all()){const r=await b.boundingBox();if(!r)continue;assert(r.height>=44,'tap target '+r.height);assert(r.x>=0&&r.x+r.width<=w+0.5,'inside at '+w);}}
await page.setViewportSize({width:390,height:844});
// The held draft goes now.
await send('接着整理');
await page.waitForFunction(()=>fx.prompts.length===2);
await idle();

// 2. /usage: same walk, named "usage"; the bridge stopping half-way leaves the panel up with its keys.
await page.evaluate(()=>{fx.screen=fx.P.usage;fx.tourDelay=200;fx.tourResult={...fx.TOUR,tabs:fx.TOUR.tabs.slice(2,3),start:'Usage',closed:false,stopped:'按 → 之后没认出 Stats 标签，已停下'};});
await send('/usage');
const usage=cardFor('/usage');
await usage.getByText(/没认出 Stats 标签/).waitFor();
assert.equal((await page.evaluate(()=>fx.tours.at(-1))).command,'usage');
await usage.getByRole('button',{name:'Esc 关闭'}).waitFor();
await usage.getByText(/面板还开着，用下面的键处理/).waitFor();
await usage.getByRole('button',{name:'Esc 关闭'}).click();
await page.waitForFunction(()=>fx.keys.at(-1)==='esc');
await usage.getByText('读完了 · 面板已关',{exact:true}).waitFor();
await idle();

// 3. A failed walk: no retry, a fresh read, the keys for the person.
await page.evaluate(()=>{fx.screen=fx.P.status;fx.tourError='Herdr timeout; mutation outcome may be unknown. Do not resend blindly.';});
const toursBefore=await page.evaluate(()=>fx.tours.length);
await send('/status');
const failed=cardFor('/status');
await failed.getByText(/没读全：Herdr timeout.*不会自动重来/).waitFor();
await failed.getByRole('button',{name:'Esc 关闭'}).waitFor();
await failed.locator('.slash-screen').getByText(/Version:\s+2\.1\.268/).waitFor();
await page.waitForTimeout(400);
assert.equal(await page.evaluate(()=>fx.tours.length),toursBefore+1,'tried once, never again');
await failed.getByRole('button',{name:'Esc 关闭'}).click();
await page.waitForFunction(()=>fx.keys.at(-1)==='esc');
await page.evaluate(()=>{fx.tourError=null;});
await idle();

// 4. Something else on screen (a picker): no walk, and the card says why.
await page.evaluate(()=>{fx.screen=fx.P.status;fx.menu={kind:'question',multi:false,cursor:1,question:'Pick',context:[],tabs:[],options:[{n:1,label:'A'}],submit:null,fingerprint:'x'};});
const toursNow=await page.evaluate(()=>fx.tours.length);
await send('/status');
await cardFor('/status').getByText('屏幕上有个选择框在等你，没去翻面板。').waitFor();
assert.equal(await page.evaluate(()=>fx.tours.length),toursNow);
await page.evaluate(()=>{fx.keys=[];});
await cardFor('/status').getByRole('button',{name:'Esc 关闭'}).click();
await page.waitForFunction(()=>fx.keys.at(-1)==='esc');
await idle();
// A /status typed with an argument, or /config, is left alone (only the plain commands walk it).
await page.evaluate(()=>{fx.screen=fx.P.config;});
await send('/config');
await cardFor('/config').getByRole('button',{name:'Esc 关闭'}).waitFor();
await page.waitForTimeout(300);
assert.equal(await page.evaluate(()=>fx.tours.length),toursNow,'/config opens settings: no walk');
await cardFor('/config').getByRole('button',{name:'Esc 关闭'}).click();
await page.waitForFunction(()=>fx.keys.at(-1)==='esc');
await idle();

// 5. Codex /status: one screen, read as rows; no walk, no keys.
await page.getByRole('button',{name:'返回列表',exact:true}).click();
await page.getByRole('button',{name:/Codex 修 bug/}).click();
await page.getByText('修好了。').first().waitFor();
await page.evaluate(()=>{fx.screen=fx.P.codex;});
const codexTours=await page.evaluate(()=>fx.tours.length);
await send('/status');
const cx=cardFor('/status');
await cx.locator('.panel-kv').first().waitFor();
const ckv=async k=>cx.locator('.panel-kv').filter({has:page.locator('.panel-k',{hasText:new RegExp('^'+k+'$')})}).locator('.panel-v').textContent();
assert.equal(await ckv('Model'),'GPT-6-Astra (reasoning medium)');
assert.equal(await ckv('Account'),'someone@example.com (Pro 200)');
assert.equal(await ckv('Directory'),'/home/me/work/demo');
const weekly=cx.locator('.panel-bar');
assert.equal(await weekly.locator('.panel-k').textContent(),'Weekly limit');
assert.equal(await weekly.locator('.panel-pct').textContent(),'83% 剩余');
assert.equal(await weekly.locator('.panel-reset').textContent(),'重置：07:55 on 25 Oct');
assert.equal(await cx.locator('.panel-rows').getByText(/Ask Codex to do anything/).count(),0,'the composer is not a row');
assert.equal(await page.evaluate(()=>fx.tours.length),codexTours);
await shot('codex-390');
await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
await shot('codex-dark-390');
await cx.getByRole('button',{name:'复制'}).click();
assert.match(await page.evaluate(()=>fx.copied),/^>_ OpenAI Codex \(v0\.163\.0\)[\s\S]*Weekly limit:/);

assert.deepEqual(errors,[]);
await browser.close();
console.log('status UI checks passed');
})().catch(e=>{console.error(e);process.exit(1);});
