// A Claude in a tmux pane is a full chat, like one in Herdr (tmux.js): its row has the preview line,
// it is in 切换 Agent and in the background watcher's seed (tmux: true), messages written while it
// works queue and go out when its screen says it stopped, 立即发送 presses Esc first and sends only
// after the pane reads idle, an unknown outcome is never resent, its question is a card answered
// with the menu's fingerprint, pictures and files go along, 中断 is Esc, the mode chip switches
// with Shift+Tab. The computer has no Herdr. Native SSH is a strict offline fake.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
const root=path.resolve(__dirname,'..');
const html=require('./ui_bundle.cjs')(root);
const shots=process.env.SHOTS||'';if(shots)fs.mkdirSync(shots,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});
const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
await page.addInitScript(()=>{
 const now=Date.now()/1000,iso=s=>new Date((now-s)*1000).toISOString();
 const D={id:'A',name:'树莓派',user:'pi',host:'pi.invalid',port:22,remember:true};
 const rec={id:'rec1',thread:'T1',title:'整理日志轮转',provider:'claude',parent:null,cwd:'/home/pi/logs',modified:now-90};
 const ref={status:'matched',source:'open-file',record_id:'rec1',thread:'T1',record:rec};
 const pane=(id,o)=>({pane_id:id,identity:'tm-'+id.slice(1),session:'main',window_index:0,window_name:'bash',pane_index:0,window_panes:1,active:false,attached:false,command:'bash',cwd:'/home/pi',width:120,height:40,...o});
 const claude=(more)=>({pane_id:'%1',identity:'ag-1',agent:'claude',agent_status:fx.status,terminal_id:'tmux:tm-1',terminal_title:'✳ 整理日志轮转',cwd:'/home/pi/logs',foreground_cwd:'/home/pi/logs',tmux:true,tmux_session:'main',...more});
 const MENU={kind:'question',multi:false,cursor:1,question:'日志保留几天？',context:['日志保留几天？'],esc:{action:'cancel',option:null},tabs:[],submit:null,fingerprint:'0123456789abcdef0123',
  options:[{n:1,label:'7 天',description:'省空间',checked:null,chosen:false,input:false,chat:false},{n:2,label:'14 天',description:'和现在一样',checked:null,chosen:false,input:false,chat:false},
   {n:3,label:'Type something.',description:'',checked:null,chosen:false,input:true,chat:false},{n:4,label:'Chat about this',description:'',checked:null,chosen:false,input:false,chat:true}]};
 let n=10;const msg=(kind,text,age)=>({id:(++n)+':0',kind,text,title:'',call_id:'',timestamp:iso(age)});
 window.fx={calls:[],nx:[],status:'working',prompts:[],promptErrors:[],escStops:true,
  history:[msg('user','把 /var/log 的轮转配置理一下',300),msg('assistant','改好了 logrotate，保留 14 天。',280)],
  pic(){const c=document.createElement('canvas');c.width=240;c.height=180;const g=c.getContext('2d');g.fillStyle='hsl(200,55%,52%)';g.fillRect(0,0,240,180);return c.toDataURL('image/jpeg',0.8);}};
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);let data={};fx.nx.push({op,args:a});
  try{
   if(op==='devices')data={devices:[D],version:'test'};
   else if(op==='connect')data={device:D,devices:[D],ready:true,connections:[D],host:{python:'3.11',herdr:false,running:null,tmux:true}};
   else if(op==='activate'){}
   else if(op==='remote'){fx.calls.push({...a});
    if(!a.device)throw Error('request without device: '+a.op);
    if(a.op==='sessions')data={sessions:[],herdr:false,tmux:true};
    else if(a.op==='doctor')data={herdr:false,running:null,tmux:true};
    else if(a.op==='tmux')data={available:true,panes:[pane('%0',{command:'htop'}),{...pane('%1',{window_index:1,window_name:'claude',command:'node',cwd:'/home/pi/logs'}),agent:claude(a.resolve?{history_ref:ref}:{})}]};
    else if(a.op==='status'&&a.target)data={tmux:true,agents:[claude()]};
    else if(a.op==='agents'&&a.target)data={follow:true,state:'same',agents:[claude({history_ref:ref,tmux_pane:pane('%1',{command:'node'})})],pane:null};
    else if(a.op==='glance')data={previews:Object.fromEntries((a.items||[]).map(it=>[it.key,{activity:{kind:'tool',verb:'run',text:'logrotate -d /etc/logrotate.conf',open:true},status:fx.status,stamp:'s1'}]))};
    else if(a.op==='history')data={record:rec,messages:fx.history,before:0,has_more:false,children:[]};
    else if(a.op==='catalog')data={records:[rec],total:1,next:null};
    else if(a.op==='commands')data={commands:[]};
    else if(a.op==='read'){if(a.target!=='%1'||a.identity!=='ag-1')throw Error('Agent changed or disappeared; reload the agent list');
     data={text:fx.status==='working'?'✻ Working… (esc to interrupt)':'❯ ',agent_status:fx.status,modes:{agent:'claude',permission:fx.mode||'acceptEdits',goal:null,cycle:true},bg:null,...(fx.status==='blocked'?{menu:MENU}:{})};}
    else if(a.op==='key'){if(a.key==='esc'&&fx.escStops)setTimeout(()=>{fx.status='idle';},1500);if(a.key==='shift+tab')fx.mode='plan';data={sent:true,receipt:a.id};}
    else if(a.op==='answer'){data={sent:true,receipt:a.id,result:{answered:true,option:a.option}};fx.status='working';}
    else if(a.op==='stageFile')data={remote:false,path:'/home/pi/.herdr-pocket/uploads/'+a.name};
    else if(a.op==='prompt'){if(fx.status!=='idle')throw Error('Agent is busy or waiting for confirmation; refresh and inspect it first');
     const e=fx.promptErrors.shift();if(e)throw Error(e);fx.prompts.push(a);fx.status='working';data={sent:true,receipt:a.id};}
    else if(a.op==='account')data={ssh_user:'pi',hostname:'pi'};
    else throw Error('unexpected remote op '+a.op);}
   else if(op==='pickImages')data={images:[{id:'att-1',thumb:fx.pic(),width:800,height:600,bytes:40000,type:'jpg'}],failed:0};
   else if(op==='pickFiles')data={files:[{id:'doc-1',name:'nginx.conf',size:2048,mime:'text/plain'}],failed:0};
   else if(op==='uploadImage')data={name:'2026-10-15/'+'e'.repeat(64)+'.jpg',sha256:'e'.repeat(64),bytes:40000};
   else if(op==='uploadFile')data={name:'2026-10-15/'+'f'.repeat(16)+'/nginx.conf',sha256:'f'.repeat(64),size:2048};
   else if(op==='image')data={url:fx.pic(),width:240,height:180};
   else if(['watchState','protect','settings','cachePut','setAlerts','dropImages','dropFiles'].includes(op))data={};
   else if(op==='cacheGet')data={value:null};
   else throw Error('unexpected native op '+op);
  }catch(e){setTimeout(()=>nativeResult(id,{ok:false,error:e.message}),10);return;}
  setTimeout(()=>nativeResult(id,{ok:true,data}),10);}};
});
await page.goto(require('./ui_bundle.cjs').url(html));
await page.evaluate(()=>{window.followInterval=()=>1e9;});
const shot=async name=>{if(!shots)return;await page.evaluate(()=>document.getElementById('toast')?.classList.remove('show'));await page.waitForTimeout(300);await page.screenshot({path:path.join(shots,'tmuxagent-'+name+'.png')});};
const both=async name=>{await shot(name);await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});await shot(name+'-dark');await page.evaluate(()=>{document.documentElement.dataset.theme='light';});};
const calls=op=>page.evaluate(o=>fx.calls.filter(c=>c.op===o),op);
const role=(r,name)=>page.getByRole(r,{name,exact:true});
const box=()=>role('textbox','消息输入框');
const send=async text=>{await box().fill(text);await role('button','发送消息').click();};
const bubble=text=>page.locator('.message.queued').filter({hasText:text});
const prompts=()=>page.evaluate(()=>fx.prompts.map(p=>p.text));
const setStatus=st=>page.evaluate(st=>{fx.status=st;},st);

// ── 1. The list: preview line on the row; the watcher is told about the tmux agent ──
await page.locator('.device-card').filter({hasText:'树莓派'}).getByRole('button',{name:'连接设备',exact:true}).click();
const row=page.locator('.tmux-agents .agent-row');await row.first().waitFor();
await page.waitForFunction(()=>/logrotate -d/.test(document.querySelector('.tmux-agents .agent-row .glance')?.textContent||''),null,{timeout:15000});
assert.match(await row.locator('.glance').textContent(),/运行/);
await page.waitForFunction(()=>fx.nx.some(x=>x.op==='watchState'&&x.args.tmux===true&&x.args.states['%1/ag-1']==='working'));
const watch=await page.evaluate(()=>fx.nx.filter(x=>x.op==='watchState'&&x.args.tmux).at(-1).args);
assert.equal(watch.session,'','no Herdr session on this computer');
assert.equal(watch.kids['%1/ag-1']?.record_id,'rec1','the watcher can check its sub-agents before saying 做完了');
await both('list');
console.log('PASS: a tmux agent row has its preview line and is handed to the background watcher');

// ── 2. Busy: messages queue; 切换 Agent lists it ──
await row.first().click();
await page.getByText('改好了 logrotate，保留 14 天。').first().waitFor();
assert.match(await box().getAttribute('placeholder'),/写好会排队/);
// 中断 (it leads the rail while it works) is Esc, after a confirmation.
await page.evaluate(()=>{fx.escStops=false;});
await page.locator('#foot-rail').getByRole('button',{name:'中断',exact:true}).click();
await page.locator('.sheet').getByRole('button',{name:'中断',exact:true}).click();
await page.waitForFunction(()=>fx.calls.some(c=>c.op==='key'&&c.key==='esc'));
const esc=(await calls('key')).at(-1);assert.deepEqual([esc.target,esc.identity],['%1','ag-1']);
assert.equal((await calls('prompt')).length,0,'an interrupt sends no message by itself');
await send('第一条：顺便看看 nginx');
await bubble('第一条').getByText('排队中 · 等它停下再发',{exact:true}).waitFor();
await send('第二条：再检查 cron');
await bubble('第二条').getByText('排队中 · 第 2 条',{exact:true}).waitFor();
assert.equal((await calls('prompt')).length,0,'nothing is sent while it works');
await role('button','切换 Agent').click();
const pick=page.locator('.sheet .agent-pick');await pick.first().waitFor();
assert.match(await pick.first().textContent(),/当前 · Claude · tmux/);
await page.evaluate(()=>closeSheet());
await both('queue');
console.log('PASS: busy tmux agent: messages queue, it is in 切换 Agent, 中断 presses Esc');

// ── 3. 立即发送: Esc, wait until the pane reads idle, then one checked send ──
await page.evaluate(()=>{fx.escStops=true;});
const keysBefore=(await calls('key')).length;
await bubble('第二条').getByRole('button',{name:'立即发送',exact:true}).click();
await page.waitForFunction(()=>fx.prompts.length===1,null,{timeout:25000});
assert.deepEqual(await prompts(),['第二条：再检查 cron'],'the chosen one goes first');
assert.equal((await calls('key')).length,keysBefore+1,'one Esc');
const order=await page.evaluate(()=>{const esc=fx.calls.findLastIndex(c=>c.op==='key'&&c.key==='esc');
 return {esc,status:fx.calls.findIndex((c,i)=>i>esc&&c.op==='status'),prompt:fx.calls.findIndex(c=>c.op==='prompt'&&c.text==='第二条：再检查 cron')};});
assert.ok(order.esc<order.status&&order.status<order.prompt,'Esc, then a status read of the pane, then the prompt: '+JSON.stringify(order));
// The first one follows once the pane worked and stopped again.
await page.waitForTimeout(1500);await setStatus('idle');
await page.waitForFunction(()=>fx.prompts.length===2,null,{timeout:25000});
assert.deepEqual(await prompts(),['第二条：再检查 cron','第一条：顺便看看 nginx']);
console.log('PASS: 立即发送 interrupts with Esc, waits for idle, sends; the rest follows in order');

// ── 4. An unknown outcome is never resent ──
await page.waitForTimeout(800);await setStatus('working');
await page.waitForFunction(()=>S.chat?.agent?.agent_status==='working');
await page.evaluate(()=>{fx.promptErrors.push('SSH 连接断了，结果未知');});
await send('第三条：结果会未知');
await bubble('第三条').waitFor();
await page.waitForTimeout(1500);await setStatus('idle');
await bubble('第三条').getByText('结果未知 · 不会自动重发',{exact:true}).waitFor({timeout:25000});
const tries=(await calls('prompt')).filter(c=>c.text==='第三条：结果会未知').length;
await page.waitForTimeout(6000);
assert.equal((await calls('prompt')).filter(c=>c.text==='第三条：结果会未知').length,tries,'never retried on its own');
assert.equal(tries,1);
await bubble('第三条').getByRole('button',{name:'删掉',exact:true}).click();
console.log('PASS: an unknown outcome stops the queue and is not resent');

// ── 5. Pictures and files go along ──
await role('button','添加附件').click();await page.getByRole('button',{name:/从相册选/}).click();
await page.locator('.att-tray .att').first().waitFor();
await role('button','添加附件').click();await page.getByRole('button',{name:/^文件/}).click();
await page.locator('.file-tray').waitFor();
await send('看看这张图和配置');
await page.waitForFunction(()=>fx.prompts.some(p=>p.text==='看看这张图和配置'),null,{timeout:15000});
const withPic=(await calls('prompt')).find(c=>c.text==='看看这张图和配置');
assert.deepEqual(withPic.images,[{name:'2026-10-15/'+'e'.repeat(64)+'.jpg',sha256:'e'.repeat(64)}]);
assert.deepEqual(withPic.files,[{name:'2026-10-15/'+'f'.repeat(16)+'/nginx.conf',sha256:'f'.repeat(64)}]);
assert.equal(withPic.remote,false);
const stage=(await calls('stageFile')).at(-1);assert.deepEqual([stage.target,stage.identity],['%1','ag-1']);
assert.ok(await page.evaluate(()=>fx.calls.findIndex(c=>c.op==='stageFile')<fx.calls.findIndex(c=>c.op==='prompt'&&c.files)),'the file is checked before the prompt');
console.log('PASS: pictures and files are uploaded and checked, then sent with the prompt');

// ── 6. A question: a card, answered with the menu's fingerprint ──
await setStatus('blocked');
const card=page.locator('.qa-card');await card.waitFor({timeout:15000});
assert.match(await card.textContent(),/Claude 在问你/);
assert.match(await card.textContent(),/日志保留几天？/);
assert.equal(await page.locator('.confirm-keys').count(),0,'a card, not raw keys');
await both('question');
await card.locator('.qa-opt').filter({hasText:'14 天'}).click();
await card.getByRole('button',{name:'发送回答',exact:true}).click();
await page.waitForFunction(()=>fx.calls.some(c=>c.op==='answer'));
const ans=(await calls('answer'))[0];
assert.deepEqual([ans.target,ans.identity,ans.action,ans.option,ans.label,ans.fingerprint],['%1','ag-1','select',2,'14 天','0123456789abcdef0123']);
assert.match(ans.id,/^[0-9a-f-]{36}$/);
console.log('PASS: a tmux agent\'s question is a card; the answer names its option and fingerprint');

// ── 7. Mode chip and Shift+Tab ──
await setStatus('idle');
// Leading the rail it is the mode bar with 切换模式; behind 「做完了」 a compact chip that opens the sheet.
const modeShown=()=>page.waitForFunction(()=>{const t=(document.querySelector('#mode-bar .mode-chips')?.textContent||'')+(document.querySelector('#foot-rail .foot-chip.mode-chip')?.textContent||'');return t;},null,{timeout:15000}).then(h=>h.jsonValue());
assert.match(await modeShown(),/自动(接受)?编辑/);
await page.waitForFunction(()=>!S.chat.doneAt||Date.now()-S.chat.doneAt>8200,null,{timeout:12000});
await page.getByRole('button',{name:'切换模式（Shift+Tab）',exact:true}).click();
await page.waitForFunction(()=>fx.calls.some(c=>c.op==='key'&&c.key==='shift+tab'));
const st=(await calls('key')).find(c=>c.key==='shift+tab');assert.deepEqual([st.target,st.identity],['%1','ag-1']);
await page.waitForFunction(()=>/计划模式/.test(document.querySelector('#mode-bar .mode-chips')?.textContent||''),null,{timeout:10000});
await both('mode');
console.log('PASS: the mode chip shows the footer\'s mode; 切换模式 presses Shift+Tab in the pane');

await page.setViewportSize({width:320,height:640});await page.waitForTimeout(300);
assert.ok(await page.evaluate(()=>document.scrollingElement.scrollWidth<=innerWidth),'no sideways scroll at 320 px');
assert.deepEqual(errors,[]);
console.log('PASS: tmux agent UI');
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
