// tmux sessions (tmux.js): listed under the Herdr agents in 会话, opened straight on a colored
// terminal screen (no 对话), typed into with the line input and key bar through tmuxSend (one
// UUID per press, an unconfirmed send pauses input and is never resent). Native SSH is a strict
// offline fake; nothing leaves the page.
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
 const CL={pane_id:'w1:p1',terminal_id:'term_cl',agent:'claude',agent_status:'idle',identity:'id-cl',cwd:'/home/u/proj',title:'整理发布脚本'};
 const pane=(id,o)=>({pane_id:id,identity:'tm-'+id.slice(1),session:'main',window_index:0,window_name:'bash',pane_index:0,window_panes:1,active:false,attached:true,command:'bash',cwd:'/home/u/proj',width:120,height:40,...o});
 window.fx={agents:[CL],calls:[],sends:[],unexpected:[],tmuxKnown:true,sendFail:'',readFail:'',
  tmux:[pane('%0',{window_name:'editor',command:'vim',active:true}),pane('%1',{window_index:1,window_name:'server',command:'node',cwd:'/home/u/proj/api'}),
   pane('%4',{session:'build',window_name:'logs',command:'tail',attached:false,cwd:'/var/log',window_panes:2,pane_index:1})],
  screen:{'%0':'\x1b[1;32m~/proj$\x1b[0m vim notes.md\n\x1b[2m~\x1b[0m\n\x1b[2m~\x1b[0m\n\x1b[33m-- INSERT --\x1b[0m','%1':'listening on :8080'}};
 const device={id:'fx',name:'测试电脑',user:'u',host:'fixture.invalid',port:22,remember:true};
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);let data={};
  try{
  if(op==='devices')data={devices:[device],version:'test',connected:device};
  else if(op==='remote'){fx.calls.push({op:a.op,target:a.target||''});
   if(a.op==='sessions')data={sessions:[{name:'fx',running:true}]};
   else if(a.op==='agents')data={agents:fx.agents};
   else if(a.op==='status')data={agents:fx.agents};
   else if(a.op==='glance')data={items:[]};
   else if(a.op==='account')data={ssh_user:'u',hostname:'fx'};
   else if(a.op==='tmux'){if(!fx.tmuxKnown)throw Error('Unknown operation');data={available:true,panes:fx.tmux};}
   else if(a.op==='tmuxRead'){if(fx.readFail)throw Error(fx.readFail);const p=fx.tmux.find(x=>x.pane_id===a.target);
    if(!p||p.identity!==a.identity)throw Error('这个 tmux 窗格已经关了或换了，回到列表刷新一下');const ansi=fx.screen[a.target]||'$ ';data={text:ansi.replace(/\x1b\[[0-9;]*m/g,''),ansi,pane:p};}
   else if(a.op==='tmuxSend'){fx.sends.push(a);if(fx.sendFail)throw Error(fx.sendFail);data={sent:true,receipt:a.id};}
   else throw Error('unexpected remote op '+a.op);}
  else if(['watchState','protect','setAlerts','settings','cachePut','dropImages'].includes(op))data={};
  else if(op==='cacheGet')data={value:null};
  else{fx.unexpected.push(op);data={};}
  }catch(e){setTimeout(()=>nativeResult(id,{ok:false,error:e.message}),10);return;}
  setTimeout(()=>nativeResult(id,{ok:true,data}),10);}};
});
await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
const shot=async name=>{if(!shots)return;await page.evaluate(()=>document.getElementById('toast')?.classList.remove('show'));await page.waitForTimeout(300);await page.screenshot({path:path.join(shots,'tmux-'+name+'.png')});};
const dark=async name=>{await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});await shot(name+'-dark');await page.evaluate(()=>{document.documentElement.dataset.theme='light';});};
const calls=op=>page.evaluate(o=>fx.calls.filter(c=>c.op===o),op);
const sends=()=>page.evaluate(()=>fx.sends.map(({op,target,identity,id,action,text,key})=>({op,target,identity,id,action,text,key})));
const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
const rows=page.locator('.tmux-row');

// ── 1. 会话 list: a tmux section under the agents ──
await page.locator('.agent-row').first().waitFor();
await rows.first().waitFor();
assert.equal(await rows.count(),3);
const label=page.locator('.tmux-label');
assert.equal((await label.textContent()).replace(/\s+/g,''),'tmux3');
const order=await page.evaluate(()=>{const a=document.querySelector('.agent-row'),t=document.querySelector('.tmux-label');return !!(a.compareDocumentPosition(t)&Node.DOCUMENT_POSITION_FOLLOWING);});
assert.ok(order,'tmux comes after the Herdr agents');
assert.equal(await rows.nth(0).locator('.card-title').textContent(),'main:editor');
assert.match(await rows.nth(0).locator('.card-meta').textContent(),/vim/);
assert.equal(await rows.nth(0).locator('.badge').textContent(),'活动');
assert.equal(await rows.nth(1).locator('.badge').count(),0,'only the pane on screen is 活动');
assert.match(await rows.nth(2).locator('.card-meta').textContent(),/窗格 1/,'a split window says which pane');
const box=await rows.nth(0).boundingBox();assert.ok(box.height>=44,'rows are touch-sized');
assert.equal(await overflow(),false);
await shot('list');await dark('list');
console.log('PASS: tmux panes are listed under the agents with session:window, command and 活动');

// ── 2. Open: terminal screen only, colored, header = session:window ──
await rows.nth(0).click();
await page.locator('#pane-screen .ansi-line').first().waitFor();
assert.equal(await page.locator('.term-head h2').textContent(),'main:editor');
assert.equal(await page.getByRole('button',{name:'对话',exact:true}).count(),0,'no 对话 tab');
assert.equal(await page.getByRole('button',{name:'返回列表',exact:true}).count(),1);
assert.match(await page.locator('.term-sub').textContent(),/tmux · vim/);
await page.waitForFunction(()=>(document.getElementById('pane-screen')?.textContent||'').includes('-- INSERT --'));
const colored=await page.locator('#pane-screen span').first().evaluate(n=>n.style.color);
assert.ok(colored.startsWith('rgb'),'SGR colors are painted');
const reads=await calls('tmuxRead');assert.equal(reads[0].target,'%0');
assert.equal(await overflow(),false);
await shot('screen');await dark('screen');
console.log('PASS: a tmux pane opens straight on its colored screen');

// ── 3. Refreshes on its own ──
await page.evaluate(()=>{fx.screen['%0']+='\nsaved notes.md';});
await page.waitForFunction(()=>(document.getElementById('pane-screen')?.textContent||'').includes('saved notes.md'),null,{timeout:8000});
console.log('PASS: the screen follows the pane');

// ── 4. Input: a line with or without Enter, and named keys; one UUID each ──
const input=page.getByRole('textbox',{name:'终端输入',exact:true});
await input.fill(':w');await page.getByRole('button',{name:'执行',exact:true}).click();
await page.waitForFunction(()=>fx.sends.length===1);
let s=await sends();
assert.deepEqual({...s[0],id:undefined},{op:'tmuxSend',target:'%0',identity:'tm-0',id:undefined,action:'run',text:':w',key:undefined});
assert.match(s[0].id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
await page.waitForFunction(()=>document.querySelector('textarea[aria-label="终端输入"]').value==='');
await page.locator('#terminal-enter').uncheck();
await input.fill('hello');await input.press('Enter');
await page.waitForFunction(()=>fx.sends.length===2);
s=await sends();assert.equal(s[1].action,'text');assert.equal(s[1].text,'hello');
for(const [name,key] of [['Esc','esc'],['Ctrl+C','ctrl+c'],['上','up'],['Tab','tab']]){
 const n=(await sends()).length;await page.getByRole('button',{name,exact:true}).click();
 await page.waitForFunction(n=>fx.sends.length===n+1,n);s=await sends();assert.equal(s[n].action,'key');assert.equal(s[n].key,key);assert.equal(s[n].text,undefined);}
s=await sends();assert.equal(new Set(s.map(x=>x.id)).size,s.length,'every press has its own id');
console.log('PASS: line input and keys go to the pane through tmuxSend');

// ── 5. Unconfirmed send: paused, never resent ──
await page.evaluate(()=>{fx.sendFail='只发出去一部分，结果未知：先看一眼终端，别直接重发';});
const before=(await sends()).length;
await page.getByRole('button',{name:'Enter',exact:true}).click();
await page.locator('#pty-status.show').waitFor();
assert.match(await page.locator('#pty-status').textContent(),/输入未确认，已暂停；不会重发/);
await page.waitForTimeout(1500);
assert.equal((await sends()).length,before+1,'not retried');
await page.getByRole('button',{name:'Esc',exact:true}).click();
await page.waitForTimeout(400);
assert.equal((await sends()).length,before+1,'paused input sends nothing');
await shot('paused');
await page.evaluate(()=>{fx.sendFail='';});
await page.getByRole('button',{name:'恢复读取',exact:true}).click();
await page.locator('#pty-status.show').waitFor({state:'hidden'});
console.log('PASS: an unconfirmed send pauses input and is not replayed');

// ── 6. The pane went away ──
await page.evaluate(()=>{fx.tmux=fx.tmux.filter(p=>p.pane_id!=='%0');});
await page.waitForFunction(()=>/已经关了/.test(document.getElementById('pty-status')?.textContent||''),null,{timeout:8000});
assert.equal(await page.locator('#term-state').textContent(),'已结束');
console.log('PASS: a closed pane ends the view instead of retrying');

// ── 7. Back to the list; empty tmux hides the section; an old bridge is asked once ──
await page.getByRole('button',{name:'返回列表',exact:true}).click();
await page.locator('.agent-row').first().waitFor();
await page.evaluate(()=>loadLive());
await page.waitForFunction(()=>document.querySelectorAll('.tmux-row').length===2);
await page.evaluate(()=>{fx.tmux=[];});await page.evaluate(()=>loadLive());
await page.waitForFunction(()=>!document.querySelector('.tmux-label'));
await page.evaluate(()=>{fx.tmuxKnown=false;fx.tmux=[{pane_id:'%9',identity:'x'}];});
const asked=(await calls('tmux')).length;
await page.evaluate(()=>loadLive());await page.waitForTimeout(400);await page.evaluate(()=>loadLive());await page.waitForTimeout(400);
assert.equal((await calls('tmux')).length,asked+1,'an old bridge is not asked again');
assert.equal(await page.locator('.tmux-label').count(),0);
assert.equal(await page.getByText(/Unknown operation/).count(),0,'no error for an old bridge');
console.log('PASS: no tmux, no section; an old bridge stays quiet');

// ── 8. Small screen ──
await page.evaluate(()=>{fx.tmuxKnown=true;fx.tmux=[{pane_id:'%7',identity:'tm-7',session:'a-very-long-session-name-for-testing',window_index:3,window_name:'an-equally-long-window-name',pane_index:0,window_panes:1,active:true,attached:true,command:'python3',cwd:'/home/u/some/really/deep/project/folder/that/goes/on',width:200,height:50}];TX.supported=true;TX.dev='';});
await page.setViewportSize({width:320,height:640});
await page.evaluate(()=>loadLive());await rows.first().waitFor();
assert.equal(await overflow(),false,'no sideways scroll at 320 px');
await shot('narrow');
await rows.first().click();await page.locator('#pane-screen').waitFor();
assert.equal(await overflow(),false);

assert.deepEqual(errors,[]);
assert.deepEqual(await page.evaluate(()=>fx.unexpected),[]);
console.log('PASS: tmux UI');
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
