// 继续这个对话 (pickup.js): resume a past conversation from 历史 (row actions, the read-only
// view's footer and ⋯), 打开 instead when it already runs, clear refusals (directory gone, CLI
// missing, already running, unknown outcome never retried), 最近断开的 after a Herdr restart with
// 全部继续 (confirmation, one request after another, no chat jumping open), an agent that quit in
// its pane is not listed, the seen list surviving an app restart (encrypted cache fake), and tmux on
// a computer without Herdr. Native SSH is a strict offline fake: nothing leaves the page.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
const root=path.resolve(__dirname,'..');
const html=require('./ui_bundle.cjs')(root);
const folder=path.join(root,'ui-artifacts');fs.mkdirSync(folder,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const errors=[];
const C1='c1111111-1111-4111-8111-111111111111',C2='c2222222-2222-4222-8222-222222222222',C4='c4444444-4444-4444-8444-444444444444';
const X1='01a14c4a-77b5-7011-82f0-56c046b68001',X9='01a14c4a-77b5-7011-82f0-56c046b68009',CH='5fce5692-ae33-5ace-ca33-0f2f2a89b9ab',C7='c7777777-7777-4777-8777-777777777777';
const IDS={C1,C2,C4,X1,X9,CH,C7};

// One page = one app start. `cache` is the native encrypted cache (LocalCache) of the previous start.
async function boot(opts={}){
 const page=await browser.newPage({viewport:{width:opts.width||390,height:opts.height||844},deviceScaleFactor:2});
 page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
 await page.addInitScript(([IDS,opts])=>{
  const {C1,C2,C4,X1,X9,CH,C7}=IDS,now=Date.now()/1000,iso=s=>new Date((now-s)*1000).toISOString();
  const D={A:{id:'A',name:'工作站',user:'me',host:'work.invalid',port:22,remember:true},T:{id:'T',name:'树莓派',user:'pi',host:'pi.invalid',port:22,remember:true}};
  const rec=(id,thread,provider,title,cwd,extra={})=>({id,thread,provider,title,cwd,parent:null,modified:now-600,size:1000,...extra});
  const R={c1:rec('rc1',C1,'claude','修复登录跳转','/home/me/site'),c2:rec('rc2',C2,'claude','整理部署脚本','/home/me/ops'),c4:rec('rc4',C4,'claude','写周报','/home/me/notes'),
   x1:rec('rx1',X1,'codex','查询翻面电机步数','/home/me/stm32'),x9:rec('rx9',X9,'codex','重构配置加载','/home/me/old'),sub:rec('rsub','aaaaaaaa-1111-4222-8333-444455556666','claude','子任务：跑测试','/home/me/site',{parent:C1}),
   c7:rec('rc7',C7,'claude','整理日志轮转','/home/pi/logs')};
  const ag=(pane,term,agent,record,extra={})=>({pane_id:pane,terminal_id:term,identity:'id-'+pane,agent,agent_status:'idle',cwd:record?record.cwd:'/home/me',foreground_cwd:record?record.cwd:'/home/me',
   terminal_title:record?record.title:'',workspace_id:'w1',...(record?{history_ref:{status:'matched',source:'native-process',record_id:record.id,thread:record.thread,record}}:{}),...extra});
  const A={a1:ag('w1:p1','t1','claude',R.c1),a2:ag('w1:p2','t2','codex',R.x1),a3:ag('w1:p3','t3','claude',null,{cwd:'/home/me/IterxAI/stm32_host',foreground_cwd:'/home/me/IterxAI/stm32_host',
   terminal_title:'stm32_host: ch --host zhenyu resume '+CH,ch_resume:{host:'zhenyu',session:CH},history_ref:{status:'remote_missing',reason:'远端这个工作目录下还没有历史记录'}}),a4:ag('w1:p4','t4','claude',R.c4)};
  window.fx={D,R,A,calls:[],cache:new Map(Object.entries(opts.cache||{})),agents:opts.agents?opts.agents.map(k=>A[k]):[A.a1,A.a2,A.a3,A.a4],panes:[],created:[],createError:'',
   inflight:0,maxInflight:0,tmux:[],tmuxAgent:null,
   history:[{id:'1:0',kind:'user',text:'看一下这个功能',title:'',call_id:'',timestamp:iso(900)},{id:'2:0',kind:'assistant',text:'好的，改完了。',title:'',call_id:'',timestamp:iso(880)}]};
  const MUTATIONS=['prompt','key','answer','exitAgent','closePane','paneRun','paneText','paneKey','tmuxSend','tmuxKill'];
  window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);let data={},delay=10;
   try{
    if(op==='devices')data={devices:[D.A,D.T],version:'test'};
    else if(op==='connect'){const d=D[a.id];data={device:d,devices:[D.A,D.T],ready:true,connections:[d],host:d.id==='A'?{python:'3.12',herdr:true,running:1,tmux:true}:{python:'3.11',herdr:false,running:null,tmux:true}};}
    else if(op==='activate'){}
    else if(op==='cacheGet'){const v=fx.cache.get(a.device+'\n'+a.key);data={value:v?JSON.parse(v):null};}
    else if(op==='cachePut'){fx.cache.set(a.device+'\n'+a.key,JSON.stringify(a.value));data={saved:true};}
    else if(op==='remote'){fx.calls.push({...a});const T=a.device==='T';
     if(MUTATIONS.includes(a.op))throw Error('mutation in this test: '+a.op);
     if(a.op==='sessions')data=T?{sessions:[],herdr:false,tmux:true}:{herdr:true,sessions:[{name:'default',running:true}]};
     else if(a.op==='agents'&&a.target)data={follow:true,state:'same',agents:fx.agents.filter(x=>x.pane_id===a.target),pane:null};
     else if(a.op==='agents'||a.op==='status')data={agents:fx.agents};
     else if(a.op==='panes')data={panes:fx.panes};
     else if(a.op==='catalog')data={records:a.thread?Object.values(R).filter(r=>r.thread===a.thread):[R.c1,R.c2,R.x9,R.sub],total:4,next:null};
     else if(a.op==='history')data={messages:fx.history,before:0,has_more:false,children:[]};
     else if(a.op==='create'){fx.created.push(a);fx.inflight++;fx.maxInflight=Math.max(fx.maxInflight,fx.inflight);delay=250;
      const err=typeof fx.createError==='function'?fx.createError(a):fx.createError;
      if(err){setTimeout(()=>{fx.inflight--;nativeResult(id,{ok:false,error:err});},delay);return;}
      const n=fx.created.length;data={created:true,kind:a.kind,cwd:a.cwd,pane_id:'w1:p'+(8+n),tab_id:'w1:t'+(8+n),workspace_id:'w1',new_workspace:false,workspace_label:'site',state:'starting',agent_name:'pocket-x',resume:a.resume};
      setTimeout(()=>{fx.inflight--;nativeResult(id,{ok:true,data});},delay);return;}
     else if(a.op==='tmux'){data={available:true,looked:['/tmp/tmux-1000'],skipped:[],servers:[],panes:fx.tmux.map(p=>p.pane_id===fx.tmuxAgent?.pane_id?{...p,agent:fx.tmuxAgent}:p)};}
     else if(a.op==='tmuxNew'){fx.tmuxNew=a;const p={pane_id:'%9',identity:'tm-9',session:'3',window_index:0,window_name:'zsh',pane_index:0,window_panes:1,active:true,attached:false,command:'zsh',cwd:a.cwd,width:80,height:24};
      fx.tmux.push(p);data={created:true,session:'3',cwd:a.cwd,pane:p,resume:a.resume,typed:true};}
     else if(a.op==='glance')data={previews:{}};
     else if(a.op==='hidden')data={ids:[]};
     else if(a.op==='account')data={ssh_user:'me',hostname:'work'};
     else if(a.op==='read')data={text:'❯ ',agent_status:'idle',modes:null,bg:null};
     else if(a.op==='hello')data={version:'test'};
     else data={};}
    else if(['watchState','protect','settings','setAlerts','dropImages','dropFiles'].includes(op))data={};
    else throw Error('unexpected native op '+op);
   }catch(e){setTimeout(()=>nativeResult(id,{ok:false,error:e.message}),10);return;}
   setTimeout(()=>nativeResult(id,{ok:true,data}),delay);}};
 },[IDS,opts]);
 await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
 await page.evaluate(()=>{window.followInterval=()=>1e9;});
 return page;}
const role=(page,r,name)=>page.getByRole(r,{name,exact:true});
const calls=(page,op)=>page.evaluate(op=>fx.calls.filter(c=>c.op===op),op);
const shot=async(page,name)=>{await page.evaluate(()=>{const t=document.getElementById('toast');t?.classList.remove('show');});await page.waitForTimeout(350);await page.screenshot({path:path.join(folder,'resume2-'+name+'.png')});};
const dark=async(page,name)=>{await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});await shot(page,name+'-dark');await page.evaluate(()=>{document.documentElement.dataset.theme='light';});};
const overflow=page=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
async function connect(page,name='工作站'){await page.locator('.device-card').filter({hasText:name}).getByRole('button',{name:'连接设备',exact:true}).click();}
const swipeAct=(row,label)=>row.locator('xpath=ancestor::div[contains(@class,"swipe")][1]').locator('.swipe-act',{hasText:label});

// ── 1. 历史: 开着 tags, 继续 from the row actions, the 正在启动 row, the chat opening ──
let saved;
{const page=await boot();
 await connect(page);
 await page.locator('.agent-row').filter({hasText:'修复登录跳转'}).waitFor();
 // The seen list is written to the encrypted cache (debounced) for the next app start.
 await page.waitForFunction(()=>[...fx.cache.keys()].some(k=>k.endsWith('\npickup:seen')),null,{timeout:5000});
 assert.equal(await page.locator('.pk-list').count(),0,'nothing is disconnected while everything runs');
 await role(page,'button','历史').click();
 const row=t=>page.locator('.history-row').filter({hasText:t});
 await row('整理部署脚本').waitFor();
 assert.equal(await row('修复登录跳转').locator('.pk-live-tag').textContent(),'开着');
 assert.equal(await row('整理部署脚本').locator('.pk-live-tag').count(),0);
 // Running → 打开在线会话 (no second copy).
 await row('修复登录跳转').dispatchEvent('contextmenu');
 let sheet=page.getByRole('dialog');
 assert.equal(await sheet.getByRole('button',{name:/^继续这个对话/}).count(),0);
 await sheet.getByRole('button',{name:/^打开在线会话/}).click();
 await page.waitForFunction(()=>S.chat?.agent?.pane_id==='w1:p1');
 await role(page,'button','返回列表').click();
 // A sub-agent record cannot be resumed.
 await role(page,'button','历史').click();
 await row('子任务：跑测试').dispatchEvent('contextmenu');
 assert.equal(await page.getByRole('dialog').getByRole('button',{name:/^(继续这个对话|打开在线会话)/}).count(),0,'no resume for a sub-agent');
 await page.evaluate(()=>closeSheet());
 // Not running → 继续这个对话 → the sheet says what and where.
 await row('整理部署脚本').dispatchEvent('contextmenu');
 await page.getByRole('dialog').getByRole('button',{name:/^继续这个对话/}).click();
 sheet=page.getByRole('dialog',{name:'继续这个对话'});await sheet.waitFor();
 for(const t of ['整理部署脚本','~/ops','claude --resume c2222222…'])await sheet.getByText(t,{exact:true}).waitFor();
 await sheet.getByText(/同目录的工作区里新开标签页/).waitFor();
 await shot(page,'sheet-390');await dark(page,'sheet-390');
 await sheet.getByRole('button',{name:'继续这个对话',exact:true}).click();
 await page.waitForFunction(()=>fx.created.length===1);
 const [req]=await page.evaluate(()=>fx.created);
 assert.deepEqual({...req,id:undefined,device:undefined},{op:'create',session:'default',kind:'claude',cwd:'/home/me/ops',workspace:'auto',resume:{id:C2},id:undefined,device:undefined});
 assert.match(req.id,/^[0-9a-f-]{36}$/);
 // 正在启动 row on 会话 (it says 继续), then the agent shows up and its chat opens.
 await page.locator('.new-pending').filter({hasText:'正在继续「整理部署脚本」'}).waitFor({timeout:5000});
 await shot(page,'pending-390');
 await page.evaluate(()=>{fx.agents.push({pane_id:'w1:p9',terminal_id:'t9',identity:'id-w1:p9',agent:'claude',agent_status:'idle',cwd:'/home/me/ops',workspace_id:'w1',
  history_ref:{status:'matched',source:'process',record_id:'rc2',thread:fx.R.c2.thread,record:fx.R.c2}});});
 await page.waitForFunction(()=>S.chat?.agent?.pane_id==='w1:p9',null,{timeout:8000});
 assert.equal((await page.evaluate(()=>fx.created.length)),1,'started once');
 await role(page,'button','返回列表').click();
 console.log('PASS: 历史 rows show 开着, offer 打开 / 继续, and a resume goes through the create flow once');

 // ── 2. Read-only view: the footer and ⋯; refusals are clear and never retried ──
 await role(page,'button','历史').click();
 await row('重构配置加载').click();
 await page.getByText('好的，改完了。').waitFor();
 const foot=page.locator('#composer .pk-bar');await foot.waitFor();
 assert.equal(await foot.locator('.readonly').textContent(),'历史只读 · 想接着聊就继续它');
 await shot(page,'history-footer-390');await dark(page,'history-footer-390');
 await role(page,'button','更多操作').click();
 assert.equal(await page.getByRole('dialog').locator('.menu-item').first().locator('.menu-label').textContent(),'继续这个对话','first in ⋯');
 await page.evaluate(()=>closeSheet());
 const missing='没继续：目录 /home/me/old 不存在了（可能被删掉或改名了）';
 await page.evaluate(m=>{fx.createError=m;},missing);
 await foot.getByRole('button',{name:'继续这个对话'}).click();
 sheet=page.getByRole('dialog',{name:'继续这个对话'});
 await sheet.getByRole('button',{name:'继续这个对话',exact:true}).click();
 await sheet.getByText(missing,{exact:true}).waitFor();
 assert.equal(await sheet.getByRole('button',{name:'继续这个对话',exact:true}).isDisabled(),false,'a refusal can be fixed and tried again');
 await page.evaluate(()=>{fx.createError='没继续：这台电脑上没找到 codex 命令（装好，或检查它在不在 PATH / ~/.local/bin 里）';});
 await sheet.getByRole('button',{name:'继续这个对话',exact:true}).click();
 await sheet.getByText(/没找到 codex 命令/).waitFor();
 await shot(page,'error-390');
 // Unknown outcome: says so, offers a refresh, never sends again by itself.
 await page.evaluate(()=>{fx.createError='Herdr timeout; mutation outcome may be unknown. Do not resend blindly.';});
 await sheet.getByRole('button',{name:'继续这个对话',exact:true}).click();
 await sheet.getByText(/^结果未知：Herdr timeout/).waitFor();
 await page.waitForTimeout(400);
 assert.equal(await page.evaluate(()=>fx.created.length),4,'one request per tap, nothing retried');
 assert.equal(await sheet.getByRole('button',{name:'刷新列表看看'}).count(),1);
 await page.evaluate(()=>closeSheet());
 // Already running elsewhere (the bridge says so; the list then finds it): 打开 instead.
 // (Status polls held, so only the refusal makes the app look again.)
 await page.evaluate(()=>{S.statusSupported=false;fx.createError='没继续：这段对话已经在运行了（在某个终端里开着）。打开那个就行，不用再开一个';
  fx.agents.push({pane_id:'w1:p20',terminal_id:'t20',identity:'id-w1:p20',agent:'codex',agent_status:'working',cwd:'/home/me/old',workspace_id:'w1',
   history_ref:{status:'matched',source:'title',record_id:'rx9',thread:fx.R.x9.thread,record:fx.R.x9}});});
 await foot.getByRole('button',{name:'继续这个对话'}).click();
 await page.getByRole('dialog',{name:'继续这个对话'}).getByRole('button',{name:'继续这个对话',exact:true}).click();
 sheet=page.getByRole('dialog',{name:'这段对话已经开着'});await sheet.waitFor();
 await sheet.getByRole('button',{name:'打开',exact:true}).click();
 await page.waitForFunction(()=>S.chat?.agent?.pane_id==='w1:p20');
 await role(page,'button','返回列表').click();
 await page.evaluate(()=>{S.statusSupported=true;fx.createError='';fx.agents=fx.agents.filter(a=>a.pane_id!=='w1:p20');});
 console.log('PASS: the read-only view offers 继续; directory / CLI / running / unknown outcomes are clear, never retried');
 await page.waitForTimeout(1500);
 saved=await page.evaluate(()=>Object.fromEntries(fx.cache));
 await page.close();}

// ── 3. Herdr restarted: 最近断开的 from the cache of the last start, 全部继续 ──
{const restart={};for(const [k,v] of Object.entries(saved))if(k.endsWith('\npickup:seen'))restart[k]=v;
 const page=await boot({cache:restart,agents:[]});
 // After the restart: pane w1:p1 exists again but is a new terminal; w1:p4 kept its terminal
 // (that Claude was quit in its pane before): only the first counts as disconnected.
 await page.evaluate(()=>{fx.panes=[{pane_id:'w1:p1',terminal_id:'t-new',identity:'p1'},{pane_id:'w1:p4',terminal_id:'t4',identity:'p4'}];});
 await connect(page);
 const sect=page.locator('.pk-list');await sect.waitFor({timeout:6000});
 const titles=await sect.locator('.pk-row .card-title').allTextContents();
 assert.ok(titles.includes('修复登录跳转')&&titles.includes('查询翻面电机步数'),'the disconnected ones are listed');
 assert.ok(!titles.includes('写周报'),'quit in a pane that is still there: not listed');
 assert.ok(titles.includes('stm32_host · ch 5fce5692'),'the ch session is listed by project and short id');
 assert.equal(await page.locator('.pk-label .group-count').textContent(),String(titles.length));
 assert.equal(await page.evaluate(()=>window.pickupCount()),titles.length,'count for other screens (Herdr guardian)');
 assert.ok((await calls(page,'panes')).length>=1,'pane check read');
 assert.equal(await overflow(page),false);
 await shot(page,'gone-390');await dark(page,'gone-390');
 // 全部继续: a confirmation listing them; one unticked; requests one after another.
 await page.getByRole('button',{name:/^全部继续/}).click();
 const sheet=page.getByRole('dialog',{name:'全部继续？'});await sheet.waitFor();
 assert.equal(await sheet.getByRole('checkbox').count(),titles.length);
 await shot(page,'bulk-390');await dark(page,'bulk-390');
 await sheet.getByRole('checkbox',{name:/查询翻面电机步数/}).click();
 assert.equal(await sheet.getByRole('checkbox',{name:/查询翻面电机步数/}).getAttribute('aria-checked'),'false');
 const n=titles.length-1;
 await sheet.getByRole('button',{name:'继续 '+n+' 个'}).click();
 await page.waitForFunction(n=>fx.created.length===n&&!PK.bulk,n,{timeout:8000});
 const made=await page.evaluate(()=>fx.created.map(c=>({kind:c.kind,resume:c.resume,workspace:c.workspace,cwd:c.cwd})));
 assert.equal(await page.evaluate(()=>fx.maxInflight),1,'one request at a time');
 assert.ok(made.every(c=>c.workspace==='auto'));
 assert.ok(made.some(c=>c.kind==='claude'&&c.resume.id===C1&&c.cwd==='/home/me/site'));
 assert.ok(made.some(c=>c.kind==='ch'&&c.resume.id===CH&&c.resume.host==='zhenyu'&&c.cwd==='/home/me/IterxAI/stm32_host'));
 assert.ok(!made.some(c=>c.resume.id===X1),'the unticked one was not started');
 await page.locator('.new-pending').first().waitFor();
 assert.equal(await page.locator('.new-pending').count(),n);
 // Only the unticked one is left under 最近断开的 (alone: no 全部继续).
 await page.waitForFunction(()=>document.querySelectorAll('.pk-row').length===1);
 assert.equal(await page.getByRole('button',{name:/^全部继续/}).count(),0);
 await shot(page,'after-bulk-390');
 // They come up: rows go, and no chat jumps open (several at once).
 await page.evaluate(()=>{fx.created.forEach((c,i)=>fx.agents.push({pane_id:'w1:p'+(9+i),terminal_id:'tn'+i,identity:'id-n'+i,agent:'claude',agent_status:'idle',cwd:c.cwd,workspace_id:'w1'}));});
 await page.waitForFunction(()=>!document.querySelector('.new-pending'),null,{timeout:8000});
 assert.equal(await page.evaluate(()=>S.chat),null,'quiet: no chat opened by itself');
 // A tap on the last one opens its sheet; 不用了 (swipe action) drops it from the section.
 await swipeAct(page.locator('.pk-row').first(),'不用了').dispatchEvent('click');
 await page.waitForFunction(()=>!document.querySelector('.pk-list'));
 console.log('PASS: after a Herdr restart 最近断开的 lists what was running (not what was quit), 全部继续 confirms and goes one by one');

 // ── 4. Tablet width ──
 await page.setViewportSize({width:1024,height:768});
 await page.evaluate(()=>{const e=PK.store.items.find(x=>x.id===fx.R.x1.thread);if(e)delete e.dismissed;render();});
 await page.locator('.pk-list').waitFor();
 assert.equal(await overflow(page),false);
 await shot(page,'gone-tablet');
 await role(page,'button','历史').click();
 await page.locator('.history-row').filter({hasText:'重构配置加载'}).click();
 await page.locator('#composer .pk-bar').waitFor();
 await shot(page,'history-tablet');
 await page.close();}

// ── 5. No Herdr on the computer: resume into a new tmux session ──
{const page=await boot({agents:[]});
 await page.evaluate(()=>{fx.tmux=[{pane_id:'%1',identity:'tm-1',session:'main',window_index:1,window_name:'claude',pane_index:0,window_panes:1,active:true,attached:false,command:'node',cwd:'/home/pi/logs',width:120,height:40}];
  fx.tmuxAgent={pane_id:'%1',identity:'ag-1',agent:'claude',agent_status:'idle',terminal_id:'tmux:tm-1',terminal_title:'✳ 整理日志轮转',cwd:'/home/pi/logs',foreground_cwd:'/home/pi/logs',tmux:true,
   history_ref:{status:'matched',source:'open-file',record_id:'rc7',thread:fx.R.c7.thread,record:fx.R.c7}};});
 await connect(page,'树莓派');
 await page.locator('.tmux-agents .agent-row').waitFor();
 await page.waitForFunction(()=>pkEntries().some(e=>e.where==='tmux'));
 // The tmux server went away (reboot): a new one with another pane.
 await page.evaluate(()=>{fx.tmuxAgent=null;fx.tmux=[{pane_id:'%0',identity:'tm-new',session:'0',window_index:0,window_name:'zsh',pane_index:0,window_panes:1,active:true,attached:false,command:'zsh',cwd:'/home/pi',width:80,height:24}];});
 await page.evaluate(()=>tmuxLoad());
 const row=page.locator('.pk-row').filter({hasText:'整理日志轮转'});await row.waitFor({timeout:6000});
 assert.equal(await row.locator('.tmux-tag').count(),1);
 await shot(page,'tmux-gone-390');
 await row.click();
 const sheet=page.getByRole('dialog',{name:'继续这个对话'});
 await sheet.getByText(/新的 tmux 会话/).waitFor();
 await sheet.getByRole('button',{name:'继续这个对话',exact:true}).click();
 await page.waitForFunction(()=>!!fx.tmuxNew);
 const req=await page.evaluate(()=>fx.tmuxNew);
 assert.deepEqual({cwd:req.cwd,resume:req.resume},{cwd:'/home/pi/logs',resume:{kind:'claude',id:C7}});
 assert.equal((await calls(page,'create')).length,0,'no Herdr create without Herdr');
 // The agent shows up in the new pane: its chat opens.
 await page.evaluate(()=>{fx.tmuxAgent={pane_id:'%9',identity:'ag-9',agent:'claude',agent_status:'idle',terminal_id:'tmux:tm-9',terminal_title:'✳ 整理日志轮转',cwd:'/home/pi/logs',tmux:true,
  history_ref:{status:'matched',source:'process',record_id:'rc7',thread:fx.R.c7.thread,record:fx.R.c7}};});
 await page.waitForFunction(()=>S.chat?.agent?.pane_id==='%9',null,{timeout:8000});
 console.log('PASS: without Herdr a conversation is resumed in a new tmux session and its chat opens');
 await page.close();}

// ── 6. Demo: shown, never started ──
{const page=await browser.newPage({viewport:{width:390,height:844}});
 await page.addInitScript(()=>{window.PocketNative={request(id,op){if(!['devices','demo','disconnect','protect','watchState'].includes(op))throw Error('Forbidden native call in offline UI test: '+op);setTimeout(()=>nativeResult(id,{ok:true,data:op==='devices'?{devices:[]}:{}}),0);}};});
 await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
 await page.getByRole('button',{name:'体验聊天演示',exact:true}).click();
 await page.getByText('离线演示 · 示例数据，不连接电脑',{exact:true}).waitFor();
 await page.evaluate(()=>pickupSheet(pkConv('claude','c2222222-2222-4222-8222-222222222222',{cwd:'/home/demo/site',title:'演示对话'})));
 await page.getByRole('dialog',{name:'继续这个对话'}).getByRole('button',{name:'继续这个对话',exact:true}).click();
 await page.getByText('演示模式：不会真的继续',{exact:true}).waitFor();
 await page.close();
 console.log('PASS: demo never resumes anything');}

await browser.close();
assert.deepEqual(errors,[]);
console.log('resume2 UI checks passed');
})().catch(e=>{console.error(e);process.exit(1);});
