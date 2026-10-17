// New session from the phone: the 新建 sheet, the create request, opening the new chat and the
// first message going out only once the agent is ready. Offline: native SSH is a strict fixture
// and `remote` is a recorded fake, so nothing is ever created or sent anywhere.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');

(async()=>{
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const folder=path.join(root,'ui-artifacts');fs.mkdirSync(folder,{recursive:true});
const errors=[];
async function fresh(width=390,height=844){
 const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:2});
 page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
 await page.addInitScript(()=>{window.PocketNative={request(id,op){if(!['devices','demo','disconnect','protect','watchState'].includes(op))throw Error('Forbidden native call in offline UI test: '+op);setTimeout(()=>nativeResult(id,{ok:true,data:op==='devices'?{devices:[]}:{}}),0);}};});
 await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
 await page.getByRole('button',{name:'体验聊天演示',exact:true}).click();
 await page.getByText('离线演示 · 示例数据，不连接电脑',{exact:true}).waitFor();
 return page;}
// A connected-looking fixture: one existing agent, Herdr options, and a create/agents/prompt fake.
async function live(page){
 await page.evaluate(()=>{
  const now=Date.now()/1000;
  window.fx={calls:[],created:null,createError:null,newAgent:null,newVisible:true,
   info:{kinds:[{kind:'codex',found:true},{kind:'claude',found:true},{kind:'ch',found:true}],home:'/home/me',
    workspaces:[{workspace_id:'w1',label:'stm32_host',focused:true,dirs:[{path:'/home/me/IterxAI/stm32_host',agents:7,panes:9},{path:'/mnt/E/project/ch-cli',agents:3,panes:3}]},
     {workspace_id:'w3',label:'dmimu_host_app',dirs:[{path:'/mnt/E/project/dmimu_host_app',agents:0,panes:2}]},{workspace_id:'w4',label:'~',dirs:[{path:'/home/me',agents:0,panes:2}]}],
    dirs:[{path:'/home/me/IterxAI/stm32_host',source:'pane',agents:7,workspace_id:'w1'},{path:'/mnt/E/project/ch-cli',source:'pane',agents:3,workspace_id:'w1'},
     {path:'/mnt/E/project/dmimu_host_app',source:'pane',agents:0,workspace_id:'w3'},{path:'/home/me',source:'pane',agents:0,workspace_id:'w4'},
     {path:'/home/me/notes',source:'history',modified:now-86400*3},{path:'/home/me/site',source:'history',modified:now-86400*9}]}};
  fx.old={pane_id:'w1:p1',identity:'id-old',agent:'codex',agent_status:'idle',cwd:'/home/me/IterxAI/stm32_host',terminal_title:'检查设备显示 | stm32_host',agent_session:{value:'s0'},history_ref:{status:'unavailable'}};
  remote=async(op,args={})=>{fx.calls.push({op,args});await new Promise(r=>setTimeout(r,40));
   if(op==='sessions')return{sessions:[{name:'default',running:true}]};
   const list=()=>[fx.old,...(fx.newAgent&&fx.newVisible?[fx.newAgent]:[])];
   if(op==='agents'&&args.target)return{follow:true,agents:list().filter(a=>a.pane_id===args.target)};
   if(op==='agents'||op==='status')return{agents:list()};
   if(op==='createInfo')return fx.info;
   if(op==='create'){if(fx.createError)throw Error(fx.createError);return fx.created;}
   if(op==='read')return{text:'Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit'};
   if(op==='prompt')return{sent:true,receipt:args.id};
   if(op==='panes')return{panes:[{pane_id:'w7:p1',terminal_id:'t71',identity:'p71',cwd:'/home/me/notes',workspace_label:'notes'},{pane_id:'w1:p4',terminal_id:'t14',identity:'p14',cwd:'/home/me',workspace_label:'stm32_host'}]};
   if(op==='paneRead')return{text:'me@h:~/notes$ '};
   throw Error('unexpected op '+op);};
  try{localStorage.clear();}catch(_){}
  S.demo=false;S.device={id:'d1',name:'工作站',user:'me',host:'h',port:22};S.agents=[];S.session='';
 });
 await page.evaluate(()=>setTab('live'));
 await page.getByRole('button',{name:/检查设备显示/}).waitFor();}
const calls=(page,op)=>page.evaluate(op=>fx.calls.filter(c=>c.op===op).map(c=>c.args),op);
const newAgent=(status,extra={})=>({pane_id:'w1:p9',identity:'id-new',agent:'claude',agent_status:status,cwd:'/mnt/E/project/ch-cli',terminal_title:'ch-cli: ch',agent_session:{value:'s9'},history_ref:{status:'pending',reason:'会话刚开始，历史文件还没写出'},...extra});

// 1. Demo: the action is there, the sheet works, nothing is created.
{const page=await fresh();
 await page.getByRole('button',{name:'新建会话',exact:true}).click();
 const sheet=page.getByRole('dialog',{name:'新建会话'});
 await sheet.getByRole('radio',{name:'Codex',exact:true}).waitFor();
 await sheet.getByRole('button',{name:'开始新建',exact:true}).click();
 await page.getByText('演示模式：不会真的新建',{exact:true}).waitFor();
 assert.equal(await page.getByRole('dialog').count(),0);
 await page.close();
 console.log('PASS: demo shows 新建 and never creates anything');}

// 2. ch in an existing workspace, matched by directory; first message sent once ready.
{const page=await fresh();await live(page);
 await page.screenshot({path:path.join(folder,'new-list-390.png')});
 await page.getByRole('button',{name:'新建会话',exact:true}).click();
 const sheet=page.getByRole('dialog',{name:'新建会话'});
 await sheet.getByRole('radio',{name:'Claude · ch',exact:true}).waitFor();
 // Defaults: first kind, most used directory, its workspace.
 assert.equal(await sheet.getByRole('radio',{name:'Codex',exact:true}).getAttribute('aria-checked'),'true');
 assert.equal(await sheet.getByRole('radio',{name:/^stm32_host\s?~\/IterxAI/}).getAttribute('aria-checked'),'true');
 assert.equal(await sheet.getByRole('radio',{name:'stm32_host',exact:true}).getAttribute('aria-checked'),'true');
 await sheet.getByText('在「stm32_host」里加一个标签页，电脑上的画面不会被切走。',{exact:true}).waitFor();
 // Only four directories until asked; history directories say when they were used.
 assert.equal(await sheet.locator('.new-dir').count(),5);
 await sheet.getByRole('button',{name:'更多目录 · 2'}).click();
 await sheet.getByText('~/notes · 3 天前用过',{exact:true}).waitFor();
 await page.screenshot({path:path.join(folder,'new-sheet-390.png')});
 await sheet.getByRole('radio',{name:'Claude · ch',exact:true}).click();
 await sheet.getByRole('radio',{name:/^dmimu_host_app\s?\//}).click();
 assert.equal(await sheet.getByRole('radio',{name:'dmimu_host_app',exact:true}).getAttribute('aria-checked'),'true','workspace follows the directory');
 await sheet.getByRole('radio',{name:/^ch-cli/}).click();
 assert.equal(await sheet.getByRole('radio',{name:'stm32_host',exact:true}).getAttribute('aria-checked'),'true');
 // A directory nobody uses yet goes to a new workspace.
 await sheet.getByRole('radio',{name:/^site\s?~\/site/}).click();
 assert.equal(await sheet.getByRole('radio',{name:'新工作区',exact:true}).getAttribute('aria-checked'),'true');
 await sheet.getByRole('radio',{name:/^ch-cli/}).click();
 await sheet.getByRole('textbox',{name:'第一条消息',exact:true}).fill('看看连接为什么会断');
 await page.evaluate(()=>{fx.created={created:true,kind:'ch',cwd:'/mnt/E/project/ch-cli',pane_id:'w1:p9',tab_id:'w1:t5',workspace_id:'w1',state:'ready',detected:true};
  const orig=remote;remote=async(op,args)=>{const r=await orig(op,args);if(op==='create'){fx.newAgent={pane_id:'w1:p9',identity:'id-new',agent:'claude',agent_status:'idle',cwd:'/mnt/E/project/ch-cli',terminal_title:'ch-cli: ch',agent_session:{value:'s9'},history_ref:{status:'pending',reason:'会话刚开始，历史文件还没写出'}};}return r;};});
 await sheet.getByRole('button',{name:'开始新建',exact:true}).click();
 await page.getByRole('button',{name:'返回列表',exact:true}).waitFor();
 const [req]=await calls(page,'create');
 assert.deepEqual({...req,id:undefined},{session:'default',id:undefined,kind:'ch',cwd:'/mnt/E/project/ch-cli',workspace:'w1'});
 assert.match(req.id,/^[a-f0-9-]{36}$/);
 await page.waitForFunction(()=>fx.calls.some(c=>c.op==='prompt'));
 const prompts=await calls(page,'prompt');
 assert.equal(prompts.length,1);
 assert.deepEqual({target:prompts[0].target,identity:prompts[0].identity,text:prompts[0].text},{target:'w1:p9',identity:'id-new',text:'看看连接为什么会断'});
 assert.notEqual(prompts[0].id,req.id,'second receipt');
 assert.equal(await page.evaluate(()=>S.chat.agent.pane_id),'w1:p9');
 await page.close();
 console.log('PASS: ch create request, directory → workspace matching, opens the chat, first message once');}

// 3. Blocked at startup (trust prompt): the chat opens, the message waits in the box.
{const page=await fresh();await live(page);
 await page.evaluate(a=>{fx.created={created:true,kind:'codex',cwd:'/home/me/IterxAI/stm32_host',pane_id:'w1:p9',state:'blocked'};fx.newAgent=a;fx.newVisible=true;},newAgent('blocked',{agent:'codex'}));
 await page.getByRole('button',{name:'新建会话',exact:true}).click();
 const sheet=page.getByRole('dialog',{name:'新建会话'});
 await sheet.getByRole('textbox',{name:'第一条消息',exact:true}).fill('先跑测试');
 await sheet.getByRole('button',{name:'开始新建',exact:true}).click();
 await page.getByText('第一条消息放在输入框里了，它准备好再发',{exact:true}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'消息输入框'}).inputValue(),'先跑测试');
 assert.equal((await calls(page,'prompt')).length,0);
 await page.close();
 console.log('PASS: blocked startup keeps the first message as a draft');}

// 4. Refused / unknown / failed outcomes are honest and never retried.
{const page=await fresh();await live(page);
 await page.evaluate(()=>{fx.createError='没创建：这个目录不存在';});
 await page.getByRole('button',{name:'新建会话',exact:true}).click();
 const sheet=page.getByRole('dialog',{name:'新建会话'});
 await sheet.getByRole('radio',{name:/^其他目录/}).click();
 await sheet.getByRole('textbox',{name:'目录路径',exact:true}).fill('~/nope');
 assert.equal(await sheet.getByRole('radio',{name:'新工作区',exact:true}).getAttribute('aria-checked'),'true');
 await sheet.getByRole('button',{name:'开始新建',exact:true}).click();
 await sheet.getByText('没创建：这个目录不存在',{exact:true}).waitFor();
 assert.equal(await sheet.getByRole('button',{name:'开始新建',exact:true}).isDisabled(),false);
 const first=(await calls(page,'create'))[0];assert.equal(first.cwd,'~/nope');
 await page.screenshot({path:path.join(folder,'new-error-390.png')});
 await page.evaluate(()=>{fx.createError='等了 35 秒还没有回应；请求已经发出，结果未知。先刷新看看，别直接重发。';});
 await sheet.getByRole('button',{name:'开始新建',exact:true}).click();
 await sheet.getByText(/^结果未知：/).waitFor();
 assert(await sheet.getByRole('button',{name:'开始新建',exact:true}).isDisabled(),'no retry after an unknown outcome');
 const both=await calls(page,'create');assert.equal(both.length,2);assert.notEqual(both[0].id,both[1].id);
 await sheet.getByRole('button',{name:'刷新列表看看',exact:true}).click();
 await page.evaluate(()=>{fx.createError=null;fx.created={created:true,kind:'codex',pane_id:'w1:p9',state:'failed',code:'agent_start_failed',detail:'codex: command not found',typed:true};});
 await page.getByRole('button',{name:'新建会话',exact:true}).click();
 await page.getByRole('dialog',{name:'新建会话'}).getByRole('button',{name:'开始新建',exact:true}).click();
 const failed=page.getByRole('dialog',{name:'Codex 没起来'});
 await failed.getByText(/新标签页已经开好了，但 Codex 没启动成功：codex: command not found/).waitFor();
 assert.equal(await failed.getByText(/w1:p9/).count(),0,'no raw pane id');
 await failed.getByText(/标签页留在电脑上，没有关掉/).waitFor();
 await failed.getByRole('button',{name:'去终端看看',exact:true}).waitFor();
 await page.close();
 console.log('PASS: refused, unknown and failed starts are reported in place without retries');}

// 5. Agent not visible yet: the sheet answers in seconds, a 正在启动 row is on the list right away,
//    and the chat opens (first message sent) once Herdr shows the agent. Never a second create.
{const page=await fresh();await live(page);
 await page.evaluate(a=>{fx.created={created:true,kind:'codex',cwd:'/home/me/IterxAI/stm32_host',pane_id:'w1:p9',tab_id:'w1:t5',state:'starting',new_workspace:false};fx.newAgent=a;fx.newVisible=false;},newAgent('idle',{agent:'codex',cwd:'/home/me/IterxAI/stm32_host'}));
 await page.getByRole('button',{name:'新建会话',exact:true}).click();
 const sheet=page.getByRole('dialog',{name:'新建会话'});
 await sheet.getByRole('textbox',{name:'第一条消息',exact:true}).fill('跑一下测试');
 await sheet.getByRole('button',{name:'开始新建',exact:true}).click();
 await page.getByText('标签页开好了，Codex 正在启动，出来后自动打开',{exact:true}).waitFor();
 const row=page.getByRole('button',{name:/^正在启动 Codex… · stm32_host/});
 await row.waitFor();
 assert.equal(await page.getByRole('dialog').count(),0,'the sheet is gone at once');
 assert.equal(await page.evaluate(()=>!!S.chat),false);
 assert.equal(await page.locator('.new-pending-label').textContent(),'正在启动1');
 await row.getByText('标签页开好了，等它出来',{exact:true}).waitFor();
 await page.evaluate(()=>document.getElementById('toast').classList.remove('show'));await page.waitForTimeout(350);
 await page.screenshot({path:path.join(folder,'new-starting-390.png')});
 await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});await page.waitForTimeout(150);
 await page.screenshot({path:path.join(folder,'new-starting-390-dark.png')});
 await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
 // The row explains and offers the terminal; nothing starts again from here.
 await row.click();
 const info=page.getByRole('dialog',{name:'正在启动 Codex'});
 await info.getByText(/新标签页已经开好了，Codex 正在启动/).waitFor();
 // In words, not the pane id: which Agent, which directory, which workspace.
 assert.equal(await info.getByText(/w1:p9/).count(),0,'no raw pane id');
 await info.locator('.new-fact').filter({hasText:'Agent'}).getByText('Codex · 本机运行',{exact:true}).waitFor();
 await info.locator('.new-fact').filter({hasText:'目录'}).getByText('~/IterxAI/stm32_host',{exact:true}).waitFor();
 await info.locator('.new-fact').filter({hasText:'开在'}).getByText('「stm32_host」里的新标签页',{exact:true}).waitFor();
 await info.getByText(/不会再启动一次/).waitFor();
 await info.getByRole('button',{name:'去终端看看',exact:true}).waitFor();
 await page.waitForTimeout(450);// the sheet's rise animation
 await page.screenshot({path:path.join(folder,'new-starting-sheet-390.png')});
 await info.getByRole('button',{name:'关闭',exact:true}).click();
 // Polled with the cheap status read; the agent shows up → its chat opens, the message goes out once.
 await page.waitForFunction(()=>fx.calls.filter(c=>c.op==='status').length>=2,null,{timeout:8000});
 // From here until the chat is open the row stays (起来了，正在打开): the list never shows neither.
 await page.evaluate(()=>{window.gap=false;new MutationObserver(()=>{if(!S.chat&&S.tab==='live'&&document.querySelector('.main')&&!document.querySelector('.new-pending'))gap=true;}).observe(document.getElementById('app'),{childList:true,subtree:true});});
 await page.evaluate(()=>{fx.newVisible=true;});
 await page.waitForFunction(()=>S.chat?.agent?.pane_id==='w1:p9',null,{timeout:8000});
 await page.waitForFunction(()=>fx.calls.some(c=>c.op==='prompt'));
 const prompts=await calls(page,'prompt');
 assert.equal(prompts.length,1);assert.equal(prompts[0].text,'跑一下测试');assert.equal(prompts[0].target,'w1:p9');
 assert.equal((await calls(page,'create')).length,1,'one create, never repeated');
 assert.equal(await page.evaluate(()=>gap),false,'the 正在启动 row stayed until the chat opened');
 await page.getByRole('button',{name:'返回列表',exact:true}).click();
 await page.getByRole('button',{name:/检查设备显示/}).waitFor();
 assert.equal(await page.locator('.new-pending').count(),0,'no 正在启动 row once the agent is listed');
 await page.close();
 console.log('PASS: a slow start answers at once, shows 正在启动 and opens the chat once the agent appears');}

// 5b. It never shows up: the row says so, then stops asking; 不等了 removes it, nothing is retried.
{const page=await fresh();await live(page);
 await page.evaluate(()=>{fx.created={created:true,kind:'claude',cwd:'/home/me/notes',pane_id:'w7:p1',state:'starting',new_workspace:true};fx.newVisible=false;});
 await page.getByRole('button',{name:'新建会话',exact:true}).click();
 const sheet=page.getByRole('dialog',{name:'新建会话'});
 await sheet.getByRole('radio',{name:'Claude',exact:true}).click();
 await sheet.getByRole('button',{name:'开始新建',exact:true}).click();
 await page.getByRole('button',{name:/^正在启动 Claude…/}).waitFor();
 await page.evaluate(()=>{NEW.pending[0].at-=50000;});
 const slow=page.getByRole('button',{name:/^Claude 还没出现/});await slow.waitFor({timeout:5000});
 await slow.getByText('等得有点久，点开看看',{exact:true}).waitFor();
 await page.evaluate(()=>document.getElementById('toast').classList.remove('show'));await page.waitForTimeout(350);
 await page.screenshot({path:path.join(folder,'new-slow-390.png')});
 await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});await page.waitForTimeout(150);
 await page.screenshot({path:path.join(folder,'new-slow-390-dark.png')});
 await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
 await page.evaluate(()=>{NEW.pending[0].at-=100000;});
 await slow.getByText('没等到，去电脑上看看那个标签页',{exact:true}).waitFor({timeout:5000});
 assert.equal(await page.evaluate(()=>NEW.pending[0].state),'lost');
 await slow.click();
 const info=page.getByRole('dialog',{name:'Claude 还没出现'});
 await info.getByText(/新工作区已经开好了，可 Claude 一直没出现/).waitFor();
 await info.locator('.new-fact').filter({hasText:'开在'}).getByText('新工作区',{exact:true}).waitFor();
 await info.locator('.new-fact').filter({hasText:'目录'}).getByText('~/notes',{exact:true}).waitFor();
 await info.getByRole('button',{name:'不等了',exact:true}).click();
 await page.getByText('不等了，标签页还留在电脑上',{exact:true}).waitFor();
 assert.equal(await page.locator('.new-pending').count(),0);
 assert.equal((await calls(page,'create')).length,1);assert.equal((await calls(page,'prompt')).length,0);
 await page.close();
 console.log('PASS: a start that never shows up says so, stops waiting, and is never retried');}

// 5c. Given up with a first message: 去终端看看 opens that very tab; if the agent shows up later,
//     the message goes into its input box (never sent on its own).
{const page=await fresh();await live(page);
 await page.evaluate(a=>{fx.created={created:true,kind:'claude',cwd:'/home/me/notes',pane_id:'w7:p1',state:'starting',new_workspace:true};fx.newAgent=a;fx.newVisible=false;},newAgent('idle',{pane_id:'w7:p1',identity:'id-late',cwd:'/home/me/notes'}));
 await page.getByRole('button',{name:'新建会话',exact:true}).click();
 const sheet=page.getByRole('dialog',{name:'新建会话'});
 await sheet.getByRole('radio',{name:'Claude',exact:true}).click();
 await sheet.getByRole('textbox',{name:'第一条消息',exact:true}).fill('整理一下笔记');
 // Back with a typed first message keeps the sheet.
 await page.evaluate(()=>pocketBack());
 assert.equal(await page.getByRole('dialog',{name:'新建会话'}).count(),1,'back does not throw the first message away');
 await sheet.getByRole('button',{name:'开始新建',exact:true}).click();
 await page.getByRole('button',{name:/^正在启动 Claude…/}).waitFor();
 await page.evaluate(()=>{NEW.pending[0].at-=150000;});
 const lost=page.getByRole('button',{name:/^Claude 还没出现/});
 await lost.getByText('没等到，去电脑上看看那个标签页',{exact:true}).waitFor({timeout:5000});
 await lost.click();
 const info=page.getByRole('dialog',{name:'Claude 还没出现'});
 await info.getByText('不会再启动一次。第一条消息没发；它之后出来的话，会放在它的输入框里。',{exact:true}).waitFor();
 await info.getByRole('button',{name:'去终端看看',exact:true}).click();
 await page.locator('#pane-screen').waitFor();
 assert.equal(await page.evaluate(()=>T.view?.pane?.pane_id),'w7:p1','the new tab itself, not just the 终端 list');
 await page.getByRole('button',{name:'返回终端列表',exact:true}).click();
 await page.evaluate(()=>{fx.newVisible=true;setTab('live');});
 await page.getByText('Claude 出来了；第一条消息放在它的输入框里了，没发',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>S.drafts.get('default/id-late')),'整理一下笔记');
 assert.equal(await page.locator('.new-pending').count(),0);
 assert.equal((await calls(page,'prompt')).length,0,'nothing sent on its own');
 await page.close();
 console.log('PASS: a given-up start opens its own tab; a late agent gets the first message as a draft');}

// 6. Small screens: no horizontal overflow, the sheet fits.
for(const [w,h] of [[320,640],[390,844]]){
 const page=await fresh(w,h);await live(page);
 await page.getByRole('button',{name:'新建会话',exact:true}).click();
 const sheet=page.getByRole('dialog',{name:'新建会话'});
 await sheet.getByRole('radio',{name:'Claude · ch',exact:true}).waitFor();
 await page.waitForTimeout(400);// let the sheet's rise animation finish
 const over=await page.evaluate(()=>[...document.querySelectorAll('.sheet *')].filter(n=>n.getBoundingClientRect().right>innerWidth+0.5).map(n=>n.className||n.tagName).slice(0,5));
 assert.deepEqual(over,[],'nothing overflows at '+w);
 const small=await page.evaluate(()=>[...document.querySelectorAll('.sheet button')].filter(b=>b.offsetParent&&b.getBoundingClientRect().height<43.5&&!b.classList.contains('link-btn')).map(b=>b.textContent));
 assert.deepEqual(small,[],'touch targets at '+w);
 await page.screenshot({path:path.join(folder,'new-sheet-'+w+'.png')});
 await sheet.evaluate(n=>n.scrollTop=n.scrollHeight);
 await page.screenshot({path:path.join(folder,'new-sheet-'+w+'-bottom.png')});
 await page.close();}
console.log('PASS: sheet fits 320 and 390 wide');

assert.deepEqual(errors,[]);
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
