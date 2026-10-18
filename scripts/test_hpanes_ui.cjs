// Herdr's plain terminals in 会话 (hpanes.js): a 「Herdr 终端」 section between the agents and tmux,
// fed by the agent list's own reads (`agents` / `status` with `panes: true`), rows that open the
// pane's terminal, swipe / long press (打开终端, 复制目录, 新建终端, 关闭窗格), no repaint under a
// swiped row. Native SSH is a strict offline fake; nothing leaves the page.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
const root=path.resolve(__dirname,'..');
const html=require('./ui_bundle.cjs')(root);
const shots=process.env.SHOTS||'';if(shots)fs.mkdirSync(shots,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const errors=[];
async function open(viewport={width:390,height:844}){
 const page=await browser.newPage({viewport,deviceScaleFactor:2});
 page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
 await page.addInitScript(()=>{
  const CL={pane_id:'w1:p1',terminal_id:'term_cl',agent:'claude',agent_status:'idle',identity:'id-cl',cwd:'/home/u/proj',title:'整理发布脚本'};
  const pane=(id,o)=>({pane_id:id,terminal_id:'term_'+id,tab_id:id.split(':')[0]+':t1',workspace_id:id.split(':')[0],workspace_label:'proj',identity:'pid-'+id,cwd:'/home/u/proj',foreground_cwd:'/home/u/proj',focused:false,terminal_title:'~/proj',kind:'shell',foreground:'zsh',tab_label:'1',...o});
  window.mkPane=pane;
  window.fx={agents:[CL],calls:[],unexpected:[],tmux:[],paneFail:false,
   panes:[pane('w1:p2',{focused:true,tab_label:'2'}),
    pane('w1:p3',{terminal_title:'proj: npm run dev',kind:'run',foreground:'npm',tab_label:'服务'}),
    // The agent's own pane, as a race between Herdr's lists could return it: never a terminal row.
    pane('w1:p1',{terminal_title:'proj: claude',kind:'run',foreground:'claude'}),
    pane('w2:p1',{workspace_label:'ops',terminal_title:'ops: ch --host box resume 1234',kind:'ch',foreground:'python3'}),
    pane('w2:p2',{workspace_label:'ops',terminal_title:'ops: herdr',kind:'herdr',foreground:'herdr'}),
    pane('w2:p3',{workspace_label:'ops',terminal_title:'ops: tmux attach',kind:'tmux',foreground:'tmux'}),
    pane('w2:p4',{workspace_label:'ops',cwd:'/srv/ops',foreground_cwd:'/srv/ops',terminal_title:'ops: ssh build-box',kind:'ssh',foreground:'ssh'})],
   screen:{'w1:p3':'> vite\n  ready in 300 ms\n  ➜  Local: http://localhost:5173/'}};
  const device={id:'fx',name:'测试电脑',user:'u',host:'fixture.invalid',port:22,remember:true};
  window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);let data={};
   try{
   if(op==='devices')data={devices:[device],version:'test',connected:device};
   else if(op==='remote'){fx.calls.push({op:a.op,args:a});
    if(a.op==='sessions')data={sessions:[{name:'fx',running:true}]};
    else if(a.op==='agents'||a.op==='status'){data={agents:fx.agents};if(a.panes&&!fx.paneFail)data.panes=JSON.parse(JSON.stringify(fx.panes));}
    else if(a.op==='glance')data={items:[]};
    else if(a.op==='account')data={ssh_user:'u',hostname:'fx'};
    else if(a.op==='tmux')data={available:true,panes:fx.tmux,looked:['/tmp/tmux-1000'],skipped:[],servers:[]};
    // The 终端 tab's own read: no kind / foreground / tab label (bridge panes() without details).
    else if(a.op==='panes')data={panes:fx.panes.filter(p=>p.pane_id!=='w1:p1').map(({kind,foreground,tab_label,...p})=>p)};
    else if(a.op==='paneRead'){const p=fx.panes.find(x=>x.pane_id===a.target);if(!p||p.identity!==a.identity)throw Error('Pane changed or now contains an Agent; reload terminals');data={text:fx.screen[a.target]||'$ '};}
    else if(a.op==='closeInfo'){const p=fx.panes.find(x=>x.pane_id===a.target);if(!p||p.identity!==a.identity)throw Error('没关：窗格变了');data={pane_id:p.pane_id,agent:null,focused:p.focused,workspace_label:p.workspace_label,tab_label:p.tab_label,tab_panes:2,workspace_panes:3,ch:false};}
    else if(a.op==='closePane'){fx.panes=fx.panes.filter(x=>x.pane_id!==a.target);data={closed:true,pane_id:a.target,agent:null,verified:true};}
    else if(a.op==='create'){if(fx.createFail)throw Error(fx.createFail);const np=window.mkPane('w1:p9',{tab_id:'w1:t9',cwd:a.cwd,foreground_cwd:a.cwd,terminal_title:'~/proj'});delete np.kind;delete np.foreground;delete np.tab_label;
     fx.panes=fx.panes.concat(np);data={created:true,kind:'shell',cwd:a.cwd,pane_id:'w1:p9',tab_id:'w1:t9',workspace_id:a.workspace,new_workspace:false,state:'ready',pane:np};}
    else throw Error('unexpected remote op '+a.op);}
   else if(['watchState','protect','setAlerts','settings','cachePut','dropImages'].includes(op))data={};
   else if(op==='cacheGet')data={value:null};
   else{fx.unexpected.push(op);data={};}
   }catch(e){setTimeout(()=>nativeResult(id,{ok:false,error:e.message}),10);return;}
   setTimeout(()=>nativeResult(id,{ok:true,data}),10);}};
 });
 await page.goto(require('./ui_bundle.cjs').url(html));
 return page;}
const shot=async(page,name)=>{if(!shots)return;await page.evaluate(()=>document.getElementById('toast')?.classList.remove('show'));await page.waitForTimeout(300);await page.screenshot({path:path.join(shots,'hpanes-'+name+'.png')});};
const dark=async(page,name)=>{await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});await shot(page,name+'-dark');await page.evaluate(()=>{document.documentElement.dataset.theme='light';});};
const calls=(page,op)=>page.evaluate(o=>fx.calls.filter(c=>c.op===o).map(c=>c.args),op);
const overflow=page=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
const status=page=>page.evaluate(async()=>{await refreshStatus();});
async function swipe(page,locator){
 await locator.evaluate(row=>{row.scrollIntoView({block:'center'});const r=row.getBoundingClientRect();const ev=(t,x)=>row.dispatchEvent(new PointerEvent(t,{bubbles:true,pointerType:'touch',clientX:x,clientY:r.top+20,pointerId:7,isPrimary:true}));
  ev('pointerdown',r.right-20);for(let i=1;i<=8;i++)ev('pointermove',r.right-20-i*25);ev('pointerup',r.right-220);});
 await page.waitForTimeout(300);}

const page=await open();
const rows=page.locator('.hp-row');
// ── 1. The section: after the agents, before tmux; agents / ch / Herdr clients left out ──
await page.locator('.agent-row').first().waitFor();
await rows.first().waitFor();
const label=page.locator('.hp-label');
assert.equal((await label.textContent()).replace(/\s+/g,''),'Herdr终端4','agent pane, ch relay and Herdr client are not terminal rows; tmux client stays while tmux lists nothing');
assert.ok(await page.evaluate(()=>{const a=document.querySelector('.agent-row'),t=document.querySelector('.hp-label');return !!(a.compareDocumentPosition(t)&Node.DOCUMENT_POSITION_FOLLOWING);}),'terminals come after the agents');
const titles=await rows.locator('.card-title').allTextContents();
assert.deepEqual(titles,['npm run dev','空闲 shell','tmux attach','ssh build-box'],'grouped by workspace, commands before idle shells');
assert.deepEqual(await page.locator('.hp-ws').allTextContents(),['工作区 · proj','工作区 · ops']);
assert.equal(await rows.nth(1).locator('.hp-focus').textContent(),'当前','the pane on the computer screen is marked');
assert.equal(await rows.nth(0).locator('.hp-focus').count(),0);
assert.equal((await rows.nth(0).locator('.card-meta').textContent()).replace(/\s+/g,''),'~/proj标签页服务','the group header names the workspace (the · is CSS)');
assert.equal(await rows.nth(0).locator('.avatar .status-dot.ok').count(),1,'something runs in front');
assert.equal(await rows.nth(1).locator('.avatar.idle').count(),1,'a shell at its prompt is quiet');
assert.equal(await rows.nth(3).locator('.hp-tag').textContent(),'SSH');
assert.equal(await rows.nth(2).locator('.hp-tag').textContent(),'tmux');
assert.match(await rows.nth(3).getAttribute('aria-label'),/Herdr 终端 ssh build-box · \/srv\/ops/);
assert.ok((await rows.nth(0).boundingBox()).height>=44,'rows are touch-sized');
// One round trip: the panes come with the agents; nothing else asks for them.
const agentCalls=await calls(page,'agents');assert.ok(agentCalls.length>=1&&agentCalls.every(a=>a.panes===true));
assert.equal((await calls(page,'panes')).length,0,'no separate panes read for 会话');
assert.equal(await page.locator('.close-hint').count(),1,'one row-gesture hint');
assert.equal(await overflow(page),false);
await shot(page,'list');await dark(page,'list');

// ── 2. tmux lists that session: the Herdr pane holding its client goes ──
await page.evaluate(()=>{fx.tmux=[{pane_id:'%0',identity:'tm-0',session:'main',window_index:0,window_name:'zsh',pane_index:0,window_panes:1,active:true,attached:true,command:'zsh',cwd:'/home/u/proj'}];});
await page.evaluate(()=>tmuxLoad());await page.locator('.tmux-row').first().waitFor();
assert.deepEqual(await rows.locator('.card-title').allTextContents(),['npm run dev','空闲 shell','ssh build-box']);
assert.ok(await page.evaluate(()=>{const h=document.querySelector('.hp-label'),t=document.querySelector('.tmux-label');return !!(h.compareDocumentPosition(t)&Node.DOCUMENT_POSITION_FOLLOWING);}),'tmux comes after the Herdr terminals');
assert.equal(await page.locator('.close-hint').count(),1);
assert.ok(await page.evaluate(()=>{const h=document.querySelector('.close-hint'),t=document.querySelector('.tmux-list');return !!(t.compareDocumentPosition(h)&Node.DOCUMENT_POSITION_FOLLOWING);}),'the hint stays under everything');

// ── 3. Freshness: the status read brings them; same answer, same rows; a change repaints ──
await status(page);
const st1=await calls(page,'status');assert.ok(st1.length&&st1.at(-1).panes===true,'status asks for panes while the list is shown');
await page.evaluate(()=>{window.keep=document.querySelector('.hp-row');});
await status(page);
assert.equal(await page.evaluate(()=>keep.isConnected),true,'nothing changed: no repaint');
await page.evaluate(()=>{fx.panes.find(p=>p.pane_id==='w1:p2').terminal_title='proj: cargo build';Object.assign(fx.panes.find(p=>p.pane_id==='w1:p2'),{kind:'run',foreground:'cargo'});});
await status(page);
assert.equal(await page.evaluate(()=>keep.isConnected),false,'a command started: repainted');
const cargo=rows.filter({hasText:'cargo build'});await cargo.waitFor();
assert.equal(await cargo.locator('.hp-focus').count(),1,'focused wins over the change time');
await page.evaluate(()=>{fx.panes.find(p=>p.pane_id==='w1:p2').focused=false;});await status(page);
assert.match(await cargo.locator('.hp-changed').textContent(),/刚刚/,'changed recently');
// A failed pane listing keeps the rows (agents still update).
await page.evaluate(()=>{fx.paneFail=true;});await status(page);
assert.equal(await rows.count(),3);
await page.evaluate(()=>{fx.paneFail=false;});

// ── 4. Never repaint under a row swiped open ──
await swipe(page,rows.nth(2));
assert.equal(await page.locator('.swipe.open').count(),1);
await page.evaluate(()=>{window.openRow=document.querySelector('.swipe.open');fx.panes.find(p=>p.pane_id==='w2:p4').terminal_title='ops: ssh other-box';});
await status(page);
assert.equal(await page.evaluate(()=>openRow.isConnected&&openRow.classList.contains('open')),true,'the swiped row stays open');
assert.equal(await rows.filter({hasText:'other-box'}).count(),0);
await page.evaluate(()=>swipeShut());
await status(page);
await rows.filter({hasText:'other-box'}).waitFor();
assert.equal(await page.evaluate(()=>openRow.isConnected),false,'repainted on the next answer once closed');

// ── 5. A row opens that pane's terminal; nothing is typed ──
await rows.filter({hasText:'npm run dev'}).click();
await page.locator('#pane-screen').waitFor();
await page.waitForFunction(()=>/ready in 300 ms/.test(document.getElementById('pane-screen')?.textContent||''));
assert.equal(await page.locator('#term-title').textContent(),'npm run dev');
assert.match(await page.locator('.term-where').textContent(),/Herdr 窗格 · proj · w1:p3/);
const reads=await calls(page,'paneRead');assert.deepEqual(reads.at(-1),{op:'paneRead',session:'fx',target:'w1:p3',identity:'pid-w1:p3',device:'fx'});
await status(page);
assert.equal((await calls(page,'status')).at(-1).panes,undefined,'no pane list while a terminal covers it');
await shot(page,'terminal');
assert.equal(await page.locator('.term-head .icon-btn').first().getAttribute('aria-label'),'返回列表');
await page.locator('.term-head .icon-btn').first().click();
await rows.first().waitFor();
for(const op of ['paneRun','paneText','paneKey','prompt','key'])assert.equal((await calls(page,op)).length,0,op+' must not be called');

// ── 6. Long press: the actions sheet ──
await rows.filter({hasText:'npm run dev'}).dispatchEvent('contextmenu');
const sheet=page.locator('.sheet');await sheet.waitFor();
assert.equal(await sheet.locator('h2').first().textContent(),'npm run dev');
assert.deepEqual(await sheet.locator('.menu-label').allTextContents(),['打开终端','复制目录','新建终端','关闭窗格…']);
assert.match(await sheet.locator('.close-sub').textContent(),/npm · 工作区 proj · 标签页 服务/);
await shot(page,'actions');await dark(page,'actions');
await page.evaluate(()=>{window.copied=[];copyText=t=>{copied.push(t);};});
await sheet.locator('.menu-item',{hasText:'复制目录'}).click();
assert.deepEqual(await page.evaluate(()=>copied),['/home/u/proj'],'the full directory, not the short one');

// ── 7. 关闭窗格: the close sheet with its checks; the row goes ──
await swipe(page,rows.filter({hasText:'npm run dev'}));
await page.locator('.swipe.open .swipe-act.danger').click();
const close=page.locator('.close-sheet');await close.waitFor();
await page.waitForFunction(()=>(fx.calls.filter(c=>c.op==='closeInfo').length>0));
assert.deepEqual((await calls(page,'closeInfo')).at(-1),{op:'closeInfo',session:'fx',target:'w1:p3',identity:'pid-w1:p3',device:'fx'});
assert.match(await close.locator('.close-warns').textContent(),/里面正在运行 npm，关闭会结束它/);
assert.equal(await close.locator('.close-opt').count(),1,'a terminal has only 关闭整个窗格');
await shot(page,'close');
await close.locator('.close-opt').click();await close.locator('.danger-fill').click();
await page.waitForFunction(()=>!document.querySelector('.close-sheet'));
const closes=await calls(page,'closePane');assert.equal(closes.length,1);assert.equal(closes[0].target,'w1:p3');assert.equal(closes[0].identity,'pid-w1:p3');assert.match(closes[0].id,/^[0-9a-f-]{36}$/);
await page.waitForFunction(()=>![...document.querySelectorAll('.hp-row')].some(r=>/npm run dev/.test(r.textContent)));

// ── 8. 新建终端: a tab with a shell in the same workspace, opened at once ──
await rows.filter({hasText:'cargo build'}).dispatchEvent('contextmenu');
await sheet.waitFor();await sheet.locator('.menu-item',{hasText:'新建终端'}).click();
await page.locator('#pane-screen').waitFor();
const made=await calls(page,'create');assert.equal(made.length,1);
assert.deepEqual({kind:made[0].kind,workspace:made[0].workspace,cwd:made[0].cwd,session:made[0].session},{kind:'shell',workspace:'w1',cwd:'/home/u/proj',session:'fx'});
assert.match(made[0].id,/^[0-9a-f-]{36}$/);
assert.equal((await calls(page,'paneRead')).at(-1).target,'w1:p9','the new pane is open');
// 终端选项 of a Herdr pane: 新建终端 and 关闭窗格 there too.
await page.locator('.term-head .icon-btn[aria-label="终端选项"]').click();await sheet.waitFor();
const opts=await sheet.locator('.menu-label').allTextContents();assert.ok(opts.includes('新建终端')&&opts.includes('关闭窗格…'),opts.join(','));
await page.keyboard.press('Escape');await page.evaluate(()=>closeSheet());
await page.locator('.term-head .icon-btn').first().click();await rows.first().waitFor();
await status(page);
assert.equal(await rows.filter({hasText:'空闲 shell'}).count(),1,'the new shell is listed');
// A refusal says so; an unknown outcome says not to retry.
await page.evaluate(()=>{fx.createFail='没创建：那个工作区已经不在了，刷新一下';});
await page.evaluate(()=>hpNew(hpVisible()[0]));
await page.waitForFunction(()=>/没创建：那个工作区已经不在了/.test(document.getElementById('toast').textContent));
await page.evaluate(()=>{fx.createFail='timeout';});
await page.evaluate(()=>hpNew(hpVisible()[0]));
await page.waitForFunction(()=>/新建结果未知/.test(document.getElementById('toast').textContent));
assert.equal((await calls(page,'create')).length,3,'every tap one request, nothing retried');

// ── 9. Many panes fold; none at all hides the section ──
await page.evaluate(()=>{for(let i=10;i<20;i++)fx.panes.push(mkPane('w3:p'+i,{workspace_label:'many'}));});
await status(page);
assert.equal(await rows.count(),6,'folded to the first few');
const more=page.locator('.hp-more');assert.match(await more.textContent(),/显示全部 13 个终端/);
await more.click();await page.waitForFunction(()=>document.querySelectorAll('.hp-row').length===13);
await page.evaluate(()=>{fx.panes=fx.panes.filter(p=>['ch','herdr'].includes(p.kind));});
await status(page);
assert.equal(await page.locator('.hp-label').count(),0,'no rows, no section, no empty note');
// Herdr with no agent but terminals: a quiet note, not the big empty page.
await page.evaluate(async()=>{fx.tmux=[];await tmuxLoad();fx.panes.push(mkPane('w1:p5',{}));fx.agents=[];});
await page.evaluate(()=>loadLive());await rows.first().waitFor();
assert.equal(await page.locator('.herdr-none').count(),1);
assert.equal(await page.locator('.hp-ws').count(),0,'one workspace: no group header');assert.match(await rows.first().locator('.card-meta').textContent(),/标签页 1.*proj/,'its name on the row');assert.equal(await page.locator('.empty').count(),0);
// Per computer and session: another computer's list never shows here.
assert.equal(await page.evaluate(()=>{hpTake([mkPane('w9:p1',{})],'other','fx');return hpVisible().some(p=>p.pane_id==='w9:p1');}),false);

// ── 10. 320 px and the 终端 tab still list them ──
await page.setViewportSize({width:320,height:640});await page.evaluate(()=>render());
assert.equal(await overflow(page),false,'no sideways scroll at 320 px');
await shot(page,'320');
await page.evaluate(()=>setTab('terminals'));await page.locator('.term-row:not(.ssh-row)').first().waitFor();
assert.equal(await page.locator('.term-row .term-cmd.idle').first().textContent(),'空闲 shell','a shell titled with its directory is idle there too');
await page.close();

// ── 11. Tablet: beside an open chat the list keeps its terminals ──
const tab=await open({width:1280,height:800});
await tab.locator('.wide-list .hp-row').first().waitFor();
await tab.locator('.wide-list .agent-row').first().click();
await tab.waitForFunction(()=>document.documentElement.classList.contains('wide-split'));
await tab.evaluate(()=>{fx.panes.find(p=>p.pane_id==='w2:p4').terminal_title='ops: ssh tablet-box';});
await tab.evaluate(async()=>{await refreshStatus();});
assert.equal((await tab.evaluate(()=>fx.calls.filter(c=>c.op==='status').at(-1).args.panes)),true,'tablet list beside a chat stays fresh');
await tab.locator('.wide-list .hp-row',{hasText:'tablet-box'}).waitFor();
await shot(tab,'tablet');await dark(tab,'tablet');
await tab.locator('.wide-list .hp-row',{hasText:'npm run dev'}).click();
await tab.locator('#pane-screen').waitFor();
assert.equal(await tab.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
await tab.close();

assert.deepEqual(errors,[]);
await browser.close();
console.log('hpanes ui ok');
})().catch(e=>{console.error(e);process.exit(1);});
