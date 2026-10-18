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
   else if(a.op==='createInfo')data={kinds:[{kind:'codex',found:true},{kind:'claude',found:true},{kind:'ch',found:false}],home:'/home/u',workspaces:[{workspace_id:'w1',label:'proj',focused:true,dirs:[{path:'/home/u/proj',agents:1,panes:1}]}],dirs:[{path:'/home/u/proj',source:'pane',agents:1,workspace_id:'w1'}]};
   else if(a.op==='tmux'){if(!fx.tmuxKnown)throw Error('Unknown operation');if(fx.tmuxFail)throw Error(fx.tmuxFail);data={available:true,panes:fx.tmux,looked:['/tmp/tmux-1000'],skipped:fx.skipped||[],servers:fx.servers||[]};}
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
await page.goto(require('./ui_bundle.cjs').url(html));
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
// The row-gesture hint is said once, after every list (not between the Herdr list and tmux).
const hints=page.locator('.close-hint');assert.equal(await hints.count(),1,'one row hint');
assert.ok(await page.evaluate(()=>{const h=document.querySelector('.close-hint'),lists=[...document.querySelectorAll('.list-card')];return lists.every(l=>!!(l.compareDocumentPosition(h)&Node.DOCUMENT_POSITION_FOLLOWING))&&!h.closest('.agent-list');}),'the hint comes after the Herdr and tmux lists');
await shot('list');await dark('list');
console.log('PASS: tmux panes are listed under the agents with session:window, command and 活动');

// ── 1b. 新建会话 offers 新建 tmux 会话 on top, set apart from the Agent form ──
await page.getByRole('button',{name:'新建会话',exact:true}).click();
{const sheet=page.getByRole('dialog',{name:'新建会话'});await sheet.getByRole('radio',{name:'Codex',exact:true}).waitFor();
 const row=sheet.locator('.new-tmux');await row.waitFor();
 const gap=await page.evaluate(()=>{const r=document.querySelector('.new-tmux').getBoundingClientRect(),n=document.querySelector('.new-body .section-label').getBoundingClientRect();return n.top-r.bottom;});
 assert.ok(gap>=16,'space under 新建 tmux 会话: '+gap);
 assert.ok((await row.boundingBox()).height>=44);
 await page.waitForTimeout(450);await shot('new-sheet');await dark('new-sheet');
 await sheet.getByRole('button',{name:'关闭',exact:true}).click();}
console.log('PASS: 新建 tmux 会话 sits apart above the Agent form');

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
// No Herdr agent but tmux sessions listed: a quiet note, never 「暂时没有会话」 above sessions.
{const keep=await page.evaluate(()=>{const k=fx.agents;fx.agents=[];return k;});await page.evaluate(()=>loadLive());
 await page.getByText('Herdr 里还没有 Agent',{exact:true}).waitFor();
 assert.equal(await page.getByText('暂时没有会话',{exact:true}).count(),0);assert.equal(await rows.count(),2);
 await page.evaluate(k=>{fx.agents=k;},keep);await page.evaluate(()=>loadLive());await page.locator('.agent-row').first().waitFor();}
await page.evaluate(()=>{fx.tmux=[];});await page.evaluate(()=>loadLive());
await page.waitForFunction(()=>!document.querySelector('.tmux-label'));
await page.evaluate(()=>{fx.tmuxKnown=false;fx.tmux=[{pane_id:'%9',identity:'x'}];});
const asked=(await calls('tmux')).length;
await page.evaluate(()=>loadLive());await page.waitForTimeout(400);await page.evaluate(()=>loadLive());await page.waitForTimeout(400);
assert.equal((await calls('tmux')).length,asked+1,'an old bridge is not asked again');
assert.equal(await page.locator('.tmux-label').count(),0);
assert.equal(await page.getByText(/Unknown operation/).count(),0,'no error for an old bridge');
console.log('PASS: no tmux, no section; an old bridge stays quiet');

// ── 7b. Nothing running: one quiet line says where it looked; named servers; it follows on its own ──
await page.evaluate(()=>{fx.tmuxKnown=true;fx.tmux=[];TX.by.clear();});
await page.evaluate(()=>loadLive());
const none=page.locator('.tmux-none-note');await none.waitFor();
assert.match(await none.textContent(),/没找到正在运行的 tmux（看过 \/tmp\/tmux-1000）/);
assert.match(await none.textContent(),/别的电脑上.*「设备」页/);
assert.equal(await page.locator('.tmux-label').count(),0);
await page.evaluate(()=>{fx.skipped=[{path:'/tmp/tmux-1000',reason:'权限太宽，别人也能写'}];fx.servers=[{name:'default',default:true,state:'none',panes:0},{name:'work',default:false,state:'error',panes:0,error:'tmux 没有及时回应'}];});
await page.evaluate(()=>loadLive());
await page.waitForFunction(()=>/跳过了 \/tmp\/tmux-1000（权限太宽/.test(document.querySelector('.tmux-none-note')?.textContent||''));
assert.match(await none.textContent(),/有 tmux 服务器读不了：work/);
await shot('none');
// A failed read is not "nothing running"; the next good read brings the plain note back.
await page.evaluate(()=>{fx.tmuxFail='tmux 没有及时回应';});await page.evaluate(()=>loadLive());
await page.waitForFunction(()=>/这次没读到 tmux（tmux 没有及时回应）/.test(document.querySelector('.tmux-none-note')?.textContent||''));
assert.doesNotMatch(await none.textContent(),/没找到正在运行/);
await page.evaluate(()=>{fx.tmuxFail='';});await page.evaluate(()=>loadLive());
await page.waitForFunction(()=>/没找到正在运行的 tmux/.test(document.querySelector('.tmux-none-note')?.textContent||''));
// A session started on the computer (default server, and a named one `tmux -L work`, which counts
// panes from %0 too) shows up while the list is on screen, without a refresh.
const K='0123456789ab';
await page.evaluate(K=>{fx.skipped=[];fx.servers=[];const base={session:'main',window_index:0,window_name:'bash',pane_index:0,window_panes:1,active:true,attached:false,command:'bash',cwd:'/home/u',width:120,height:40};
 fx.tmux=[{...base,pane_id:'%0',identity:'tm-d0'},{...base,pane_id:'%0@'+K,identity:'tm-w0',server:'work',window_name:'repl',command:'python3'}];fx.screen['%0@'+K]='>>> 1+1\n2';},K);
await page.waitForFunction(()=>document.querySelectorAll('.tmux-row').length===2,null,{timeout:6000});
assert.equal(await none.count(),0);
const named=rows.filter({hasText:'服务器 work'});assert.equal(await named.count(),1);
assert.equal(await rows.filter({hasText:'服务器'}).count(),1,'the default server is not named');
assert.equal(await overflow(),false);
await shot('servers');
// Back from the background: asked at once. In the background: not polled.
let n0=(await calls('tmux')).length;
await page.evaluate(()=>{setForeground(false);setForeground(true);});
await page.waitForFunction(n=>fx.calls.filter(c=>c.op==='tmux').length>n,n0,{timeout:1500});
await page.evaluate(()=>setForeground(false));await page.waitForTimeout(300);n0=(await calls('tmux')).length;
await page.waitForTimeout(4600);
assert.equal((await calls('tmux')).length,n0,'no tmux polling in the background');
await page.evaluate(()=>setForeground(true));
// The named server's pane opens by its own id; its long-press sheet names the server.
await named.click();
await page.waitForFunction(()=>(document.getElementById('pane-screen')?.textContent||'').includes('>>> 1+1'));
assert.equal((await calls('tmuxRead')).at(-1).target,'%0@'+K);
await page.getByRole('button',{name:'返回列表',exact:true}).click();await rows.first().waitFor();
await named.dispatchEvent('contextmenu');
await page.getByRole('dialog').getByText(/服务器 work/).first().waitFor();
await page.evaluate(()=>closeSheet());await page.waitForFunction(()=>!document.querySelector('.sheet'));
console.log('PASS: empty tmux says where it looked; named servers are shown; the list follows tmux while shown, not in the background');

// ── 8. Small screen ──
await page.evaluate(()=>{fx.tmuxKnown=true;fx.tmux=[{pane_id:'%7',identity:'tm-7',session:'a-very-long-session-name-for-testing',window_index:3,window_name:'an-equally-long-window-name',pane_index:0,window_panes:1,active:true,attached:true,command:'python3',cwd:'/home/u/some/really/deep/project/folder/that/goes/on',width:200,height:50}];TX.by.clear();});
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
