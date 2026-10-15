// Slash commands: suggestions while typing "/", the 「命令输出」 card after sending one, panels that need
// Esc, and Claude's own command rows. Offline: native SSH is a strict fake that records every request.
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
 const rec=(id,thread,title,provider)=>({id,thread,title,provider,parent:null,cwd:'/work/proj',modified:now-60});
 const R={r1:rec('r1','t1','整理发布脚本','claude'),r2:rec('r2','t2','Codex 修 bug','codex')};
 let n=50;const msg=(kind,text,age=30)=>({id:(++n)+':0',kind,text,title:'',call_id:'',timestamp:iso(age)});
 const H={r1:[msg('user','把发布脚本整理一下',400),msg('assistant','好，整理完了。',390),
   msg('user','<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>',300),
   msg('user','<local-command-stdout>Set model to `opus` and saved as your default</local-command-stdout>',300),
   msg('user','<local-command-caveat>Caveat</local-command-caveat>',299)],
  r2:[msg('user','修一下登录',200),msg('assistant','修好了。',190)]};
 const ref=r=>({status:'matched',source:'native-process',record_id:r.id,thread:r.thread,record:r});
 const A1={pane_id:'w1:p1',terminal_id:'term1',agent:'claude',agent_status:'idle',identity:'id-1',cwd:'/work/proj',title:'整理发布脚本',history_ref:ref(R.r1)};
 const A2={pane_id:'w1:p2',terminal_id:'term2',agent:'codex',agent_status:'idle',identity:'id-2',cwd:'/work/proj',title:'Codex 修 bug',history_ref:ref(R.r2)};
 const STATUS='❯ /status\n\n Status   Config   Usage\n\n Version: 2.1.268\n Model: opus\n Account: demo@example.invalid\n\n Esc to cancel';
 const PICK=' Select model\n\n ❯ 1. Default (recommended)\n   2. Opus\n   3. Haiku\n\n Enter to confirm · Esc to exit';
 const MENU={kind:'question',multi:false,cursor:1,question:'Select model',context:['Select model'],tabs:[],options:[{n:1,label:'Default (recommended)'},{n:2,label:'Opus'},{n:3,label:'Haiku'}],submit:null,fingerprint:'m1'};
 const IDLE='❯ \n  ? for shortcuts';
 window.fx={R,H,A1,A2,list:[A1,A2],screen:IDLE,menu:null,STATUS,PICK,MENU,IDLE,prompts:[],keys:[],reads:[],nx:[],commands:{
   'w1:p1':{provider:'claude',commands:[{name:'deploy',kind:'command',scope:'project'},{name:'pdf-tools',kind:'skill',scope:'user'},{name:'status',kind:'command',scope:'user'}]},
   'w1:p2':{provider:'codex',commands:[{name:'prompts:fix',kind:'prompt',scope:'user'}]}}};
 const device={id:'fx',name:'测试电脑',user:'u',host:'fixture.invalid',port:22,remember:true};
 const strip=a=>{const {history_ref,...rest}=a;return rest;};
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);let data={};fx.nx.push({op,args:a});
  try{
  if(op==='devices')data={devices:[device],version:'test',connected:device};
  else if(op==='remote'){
   if(a.op==='sessions')data={sessions:[{name:'fx',running:true}]};
   else if(a.op==='agents'){if(a.target){const row=fx.list.find(x=>x.pane_id===a.target);data=row?{follow:true,state:'same',agents:[row],pane:null}:{follow:true,state:'gone',agents:[],pane:null};}else data={agents:fx.list};}
   else if(a.op==='status')data={agents:fx.list.map(strip)};
   else if(a.op==='history')data={record:Object.values(R).find(r=>r.id===a.record_id),messages:H[a.record_id]||[],before:0,has_more:false,children:[]};
   else if(a.op==='read'){fx.reads.push(a);const row=fx.list.find(x=>x.pane_id===a.target);data={text:fx.screen,agent_status:row?.agent_status,...(a.menu===true?{menu:fx.menu}:{})};}
   else if(a.op==='commands')data=fx.commands[a.target];
   else if(a.op==='prompt'){fx.prompts.push(a);data={sent:true,receipt:a.id};}
   else if(a.op==='key'){fx.keys.push(a.key);if(a.key==='esc'){fx.screen=fx.IDLE;fx.menu=null;}data={sent:true,receipt:a.id};}
   else if(a.op==='catalog')data={records:[],total:0,next:null};
   else if(a.op==='account')data={ssh_user:'u',hostname:'fx'};
   else throw Error('unexpected remote op '+a.op);}
  else if(!['watchState','protect','setAlerts','dropImages'].includes(op))throw Error('unexpected native op '+op);
  }catch(e){setTimeout(()=>nativeResult(id,{ok:false,error:e.message}),10);return;}
  setTimeout(()=>nativeResult(id,{ok:true,data}),10);}};
});
await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
await page.evaluate(()=>{window.followInterval=()=>1e9;});
const shot=async name=>{await page.evaluate(()=>document.getElementById('toast').classList.remove('show'));await page.waitForTimeout(250);await page.screenshot({path:path.join(shots,'slash-'+name+'.png')});};
const box=()=>page.getByRole('textbox',{name:'消息输入框',exact:true});
const pop=()=>page.getByRole('listbox',{name:'可用命令'});
const options=()=>pop().getByRole('option');
const sendBtn=()=>page.getByRole('button',{name:'发送消息',exact:true});
const prompts=()=>page.evaluate(()=>fx.prompts.map(p=>p.text));
const fits=async width=>{assert(await page.evaluate(()=>document.scrollingElement.scrollWidth<=innerWidth),'no sideways scroll at '+width);
 for(const b of await options().all()){const r=await b.boundingBox();if(!r)continue;assert(r.height>=44,'row is tall enough');assert(r.x>=0&&r.x+r.width<=width+0.5,'row fits');}};

await page.getByRole('button',{name:/整理发布脚本/}).click();
await page.getByText('好，整理完了。').first().waitFor();

// 1. Claude's own record of /model is a command card with what it printed (the caveat stays hidden).
const logged=page.locator('.slash-card.logged');
await logged.getByText('/model',{exact:true}).waitFor();
await logged.getByText(/Set model to `opus`/).waitFor();
assert.equal(await page.getByText('Caveat',{exact:true}).count(),0);
assert.match(await box().getAttribute('placeholder'),/\/ 看命令/);

// 2. "/" opens the list: built-ins with Chinese descriptions plus the user's own commands (by name).
await box().fill('/');
await pop().waitFor();
assert(await options().count()>40,'the full Claude list');
await pop().getByText('/deploy',{exact:true}).waitFor();
await pop().getByText('/pdf-tools',{exact:true}).waitFor();
assert.equal(await pop().getByText('/status',{exact:true}).count(),1,'a custom command with a built-in name is listed once');
assert.equal(await page.evaluate(()=>fx.nx.filter(x=>x.args.op==='commands').length),1);
assert.equal(await box().getAttribute('aria-expanded'),'true');
await shot('list-390');
// Filtering: by name prefix, then by the Chinese description.
await box().fill('/mo');
assert.equal(await options().first().locator('.slash-name').textContent(),'/model');
await box().fill('/切换');
assert.match(await options().first().textContent(),/切换/);
await box().fill('/zzzz');
await pop().getByText(/没有匹配的命令/).waitFor();
// Keyboard: ↓ then Enter inserts the highlighted command and closes the list.
await box().fill('/sta');
const first=await options().nth(0).locator('.slash-name').textContent(),second=await options().nth(1).locator('.slash-name').textContent();
assert.equal(first,'/status');
await box().press('ArrowDown');
assert.equal(await options().nth(1).getAttribute('aria-selected'),'true');
await box().press('Enter');
assert.equal(await box().inputValue(),second+' ');
assert.equal(await pop().count(),0,'the list closes after inserting');
// Escape closes; tapping a row inserts.
await box().fill('/');await pop().waitFor();await box().press('Escape');assert.equal(await pop().count(),0);
await box().fill('/stat');await options().first().click();
assert.equal(await box().inputValue(),'/status ');
assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'消息输入框','focus stays in the composer');
// 320 px: rows stay ≥44 px and inside the screen.
await box().fill('/');await pop().waitFor();
await page.setViewportSize({width:320,height:640});await page.waitForTimeout(200);
await fits(320);
await shot('list-320');
await page.setViewportSize({width:390,height:844});await page.waitForTimeout(150);

// 3. Sending /status: the prompt goes out once (trimmed), no pending bubble, a 「命令输出」 card reads the screen.
await page.evaluate(()=>{fx.screen=fx.STATUS;});
await box().fill('/status ');await box().press('Escape');
await sendBtn().click();
const card=page.locator('.slash-card:not(.logged)').filter({hasText:'/status'});
await card.getByText(/Version: 2\.1\.268/).waitFor();
assert.deepEqual(await prompts(),['/status']);
assert.equal(await page.locator('.message.pending').count(),0,'no "已送达" bubble that never settles');
assert.equal(await box().inputValue(),'');
assert.doesNotMatch(await box().getAttribute('placeholder'),/排队/,'no optimistic "working" after a slash command');
await card.getByText('面板开着',{exact:true}).waitFor();
await card.getByRole('button',{name:'Esc 关闭'}).waitFor();
assert(await page.evaluate(()=>fx.reads.some(r=>r.menu===true)),'capture asks the bridge to parse a picker');
assert.equal(await page.evaluate(()=>slashStateText({state:'sent',readAt:Date.now()})),'读于 '+await page.evaluate(()=>new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})));
await shot('status-390');
await page.setViewportSize({width:320,height:640});await page.waitForTimeout(200);
assert(await page.evaluate(()=>document.scrollingElement.scrollWidth<=innerWidth),'card fits at 320');
for(const b of await card.locator('.slash-keys button, .slash-actions button').all()){const r=await b.boundingBox();assert(r.height>=44&&r.x>=0&&r.x+r.width<=320.5,'card buttons fit and are tall enough');}
await shot('status-320');
await page.setViewportSize({width:390,height:844});await page.waitForTimeout(150);

// 4. While the panel is open, a normal message is held (it would land in the panel).
await box().fill('接着整理');await sendBtn().click();
await page.getByText(/面板还开着/).waitFor();
assert.deepEqual(await prompts(),['/status'],'nothing sent into the open panel');
assert.equal(await box().inputValue(),'接着整理','draft kept');
// Esc from the card closes it (one key, fresh id), the card re-reads, and sending works again.
await card.getByRole('button',{name:'Esc 关闭'}).click();
await card.getByText('面板已关',{exact:true}).waitFor();
assert.equal(await card.getByText(/Version: 2\.1\.268/).count(),1,'what the panel showed stays in the card');
assert.deepEqual(await page.evaluate(()=>fx.keys),['esc']);
assert.equal(await card.getByRole('button',{name:'Esc 关闭'}).count(),0);
await sendBtn().click();
await page.waitForFunction(()=>fx.prompts.length===2);
assert.deepEqual(await prompts(),['/status','接着整理']);
await page.evaluate(()=>{fx.list=fx.list.map(a=>({...a,agent_status:'idle'}));S.chat.agent={...S.chat.agent,agent_status:'idle'};S.outbox=[];renderComposer();});

// 5. A picker (/model): the parsed menu brings arrows and Enter; a closed panel gets refresh/copy only.
await page.evaluate(()=>{fx.screen=fx.PICK;fx.menu=fx.MENU;});
await box().fill('/model');await box().press('Escape');await sendBtn().click();
const pick=page.locator('.slash-card:not(.logged)').filter({has:page.locator('.slash-cmd',{hasText:/^\/model$/})});
await pick.getByText('Select model').waitFor();
await pick.getByText('等你选',{exact:true}).waitFor();
for(const k of ['↑','↓','Enter','Esc 关闭'])await pick.getByRole('button',{name:k,exact:true}).waitFor();
await pick.getByRole('button',{name:'↓',exact:true}).click();
await page.waitForFunction(()=>fx.keys.includes('down'));
await shot('picker-390');
await pick.getByRole('button',{name:'Esc 关闭'}).click();
await page.waitForFunction(()=>fx.keys.at(-1)==='esc');
await pick.getByText('面板已关',{exact:true}).waitFor();
assert.match(await pick.locator('.slash-state').textContent(),/面板已关/);
// Collapsing a card removes it for good.
await pick.getByRole('button',{name:'收起'}).click();
assert.equal(await pick.count(),0);

// 6. A path is a message, not a command.
await page.evaluate(()=>{fx.screen=fx.IDLE;fx.list=fx.list.map(a=>({...a,agent_status:'idle'}));S.chat.agent={...S.chat.agent,agent_status:'idle'};renderComposer();});
await box().fill('/tmp/report.png');
assert.equal(await pop().count(),0,'no list once the text is a path');
await sendBtn().click();
await page.locator('.message.pending').filter({hasText:'/tmp/report.png'}).waitFor();

// 7. Busy agent: a slash command queues like any message (TUIs take them only when idle).
await page.evaluate(()=>{fx.list=fx.list.map(a=>({...a,agent_status:'working'}));S.chat.agent={...S.chat.agent,agent_status:'working'};S.outbox=[];renderComposer();});
const before=(await prompts()).length;
await box().fill('/compact');await box().press('Escape');await sendBtn().click();
await page.locator('.message.queued').filter({hasText:'/compact'}).waitFor();
assert.equal((await prompts()).length,before,'not sent while working');

// 8. Codex: its own list (and prompts), no Claude-only commands.
await page.evaluate(()=>{Q.clear();});
await page.getByRole('button',{name:'返回列表',exact:true}).click();
await page.getByRole('button',{name:/Codex 修 bug/}).click();
await page.getByText('修好了。').first().waitFor();
await box().fill('/');await pop().waitFor();
await pop().getByText('Codex 命令').waitFor();
await pop().getByText('/new',{exact:true}).waitFor();
await pop().getByText('/prompts:fix',{exact:true}).waitFor();
assert.equal(await pop().getByText('/rewind',{exact:true}).count(),0);
await shot('codex-390');

assert.deepEqual(errors,[]);
await browser.close();
console.log('slash UI checks passed');
})().catch(e=>{console.error(e);process.exit(1);});
