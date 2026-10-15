// Agent modes (mode.js): live chips above the composer from the bridge's own footer parser, 「切换模式」
// sends Shift+Tab through the `key` op (also for a ch-relayed agent) and re-reads the screen, the
// 终端按键 sheet, safety (never while a question waits or a send is in flight), list tags, and
// light/dark/320 px. Offline: native SSH is a strict fake and `remote` a recorded fixture whose
// screens follow the real Claude Code / Codex footers; modes are parsed by the bridge (python3).
const {chromium}=require('playwright');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const RULE='─'.repeat(64);
const claude=line=>['● 好了，改完了。','',RULE,'❯ ',RULE,'  ~/site [.venv] Opus 5.5','  '+line,''].join('\n');
const codex=right=>['• 测试都过了。','','› Ask Codex to do anything','  GPT-6 medium fast · ~/site · Context 3% used'+(right?'        '+right:''),'  ← for agents · ? for shortcuts',''].join('\n');
const SCREENS={
 c_default:claude('⏸ manual mode on · ← for agents'),
 c_edits:claude('⏵⏵ accept edits on (shift+tab to cycle) · ← for agents'),
 c_plan:claude('⏸ plan mode on (shift+tab to cycle) · ◎ /goal active (12m) · ← for agents'),
 c_bypass:claude('⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent'),
 x_default:codex(''),
 x_plan:codex('Plan mode (shift+tab to cycle)'),
};
const MODES=JSON.parse(execFileSync('python3',['-c',`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('b',sys.argv[1]);b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
print(json.dumps({k:b.screen_modes(v,'claude' if k[0]=='c' else 'codex') for k,v in json.loads(sys.argv[2]).items()},ensure_ascii=False))`,path.join(root,'bridge/pocket_bridge.py'),JSON.stringify(SCREENS)],{encoding:'utf8'}));
assert.equal(MODES.c_plan.permission,'plan');assert.equal(MODES.c_plan.goal.state,'active');assert.equal(MODES.x_plan.collaboration,'plan');

(async()=>{
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const folder=path.join(root,'ui-artifacts');fs.mkdirSync(folder,{recursive:true});
const errors=[];
async function fresh(width=390,height=844,dark=false){
 const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:2,hasTouch:true,colorScheme:dark?'dark':'light'});
 const page=await context.newPage();page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
 await page.addInitScript(()=>{window.PocketNative={request(id,op){if(!['devices','demo','disconnect','protect','watchState','settings','cacheGet','cachePut','haptic'].includes(op))throw Error('Forbidden native call in offline UI test: '+op);setTimeout(()=>nativeResult(id,{ok:true,data:op==='devices'?{devices:[]}:{}}),0);},haptic(k){(window.haptics=window.haptics||[]).push(k);}};});
 await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
 if(dark)await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
 await page.evaluate(({screens,modes})=>{
  const t=n=>new Date(Date.UTC(2026,9,15,9,n)).toISOString();
  const rec=(id,thread,provider,title)=>({id,thread,provider,title,cwd:'/home/demo/site',modified:Date.now()/1000});
  // Claude runs behind ch on another computer (remote history, relay pane); Codex is local.
  const c={pane_id:'w1:p1',identity:'id-claude',agent:'claude',agent_status:'idle',cwd:'/home/demo/site',terminal_title:'site: ch --host remote resume 1',title:'整理日志',
   history_ref:{status:'matched',remote:{route:'remote'},record:rec('rec-c','11111111-1111-1111-1111-111111111111','claude','整理日志')}};
  const x={pane_id:'w1:p2',identity:'id-codex',agent:'codex',agent_status:'idle',cwd:'/home/demo/site',terminal_title:'改登录页 | site',
   history_ref:{status:'matched',record_id:'a'.repeat(64),thread:'22222222-2222-2222-2222-222222222222',record:rec('a'.repeat(64),'22222222-2222-2222-2222-222222222222','codex','改登录页')}};
  window.fx={calls:[],keyError:null,cycle:{claude:['c_default','c_edits','c_plan','c_bypass'],codex:['x_default','x_plan']},at:{'w1:p1':0,'w1:p2':0},lag:0,agents:[c,x],
   msgs:[{id:'1:0',kind:'user',text:'把日志整理一下',title:'',call_id:'',timestamp:t(1)},{id:'2:0',kind:'assistant',text:'好了，改完了。',title:'',call_id:'',timestamp:t(2)}]};
  const screenOf=p=>{const a=fx.agents.find(z=>z.pane_id===p);return fx.cycle[a.agent][fx.at[p]];};
  remote=async(op,args={})=>{fx.calls.push({op,args});await new Promise(r=>setTimeout(r,20));
   if(op==='status'||op==='agents')return{agents:fx.agents};
   if(op==='history')return{record:args.record_id==='rec-c'?c.history_ref.record:x.history_ref.record,messages:fx.msgs,children:[],before:0,has_more:false};
   if(op==='read'){const k=screenOf(args.target);return{text:screens[k],agent_status:fx.agents.find(z=>z.pane_id===args.target).agent_status,modes:fx.hide?null:modes[k]};}
   if(op==='key'){if(fx.keyError)throw Error(fx.keyError);
    // The agent itself moves on to its next mode; the screen shows it a moment later.
    if(args.key==='shift+tab'){const a=fx.agents.find(z=>z.pane_id===args.target);setTimeout(()=>{fx.at[args.target]=(fx.at[args.target]+1)%fx.cycle[a.agent].length;},fx.lag);}
    return{sent:true,receipt:args.id};}
   if(op==='glance')return{previews:{}};
   if(op==='sessions')return{sessions:[{name:'default',running:true,default:true}]};
   if(op==='catalog')return{records:[]};
   throw Error('unexpected op '+op);};
  S.demo=false;S.device={id:'fx',name:'工作站',user:'demo',host:'ws',port:22};S.session='default';S.agents=fx.agents;S.statusSupported=true;
 },{screens:SCREENS,modes:MODES});
 return page;}
const keyCalls=page=>page.evaluate(()=>fx.calls.filter(c=>c.op==='key').map(c=>c.args));
const chips=page=>page.locator('#mode-bar .mode-chip').allTextContents();
// Chips come from a screen read that may still be on its way (another read in flight, slow CI): wait for them.
const waitChips=async(page,want)=>{try{await page.waitForFunction(w=>JSON.stringify([...document.querySelectorAll('#mode-bar .mode-chip')].map(n=>n.textContent))===w,JSON.stringify(want),{timeout:8000});}catch(_){}assert.deepEqual(await chips(page),want);};
const switchBtn=page=>page.getByRole('button',{name:'切换模式（Shift+Tab）',exact:true});
const overflow=page=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
const open=async(page,i)=>{await page.evaluate(i=>openAgent(fx.agents[i]),i);await page.getByText('好了，改完了。',{exact:true}).first().waitFor();await page.evaluate(()=>fetchTerminal(true));};

// ── ch-relayed Claude: chips, Shift+Tab through the key op, re-read ───────────
let page=await fresh();
await open(page,0);
await page.locator('#mode-bar').waitFor();
await waitChips(page,['手动确认']);
await switchBtn(page).click();
await page.waitForFunction(()=>[...document.querySelectorAll('#mode-bar .mode-chip')].map(n=>n.textContent).join()==='自动接受编辑');
let keys=await keyCalls(page);
assert.equal(keys.length,1);
assert.deepEqual({key:keys[0].key,target:keys[0].target,identity:keys[0].identity,session:keys[0].session},{key:'shift+tab',target:'w1:p1',identity:'id-claude',session:'default'});
assert.match(keys[0].id,/^[a-f0-9-]{36}$/);
assert.ok((await page.evaluate(()=>window.haptics||[])).includes('tick'),'haptic on switch');
// Each press is a new request id; the chip follows the screen (plan + a separate goal).
await page.evaluate(()=>{fx.lag=500;});
await switchBtn(page).click();
await page.locator('.mode-switch.busy').waitFor();
assert.ok(await switchBtn(page).isDisabled(),'disabled while switching');
await page.waitForFunction(()=>document.querySelector('#mode-bar .mode-chip')?.textContent==='计划模式',null,{timeout:5000});
await waitChips(page,['计划模式','目标进行中 · 12m']);
keys=await keyCalls(page);assert.equal(keys.length,2);assert.notEqual(keys[0].id,keys[1].id);
await page.screenshot({path:path.join(folder,'mode-claude-plan.png')});
console.log('PASS: ch Claude shows its mode, Shift+Tab goes out as key op and the chip follows the re-read screen');

// Details sheet explains the native cycle and the separate goal.
await page.getByRole('button',{name:/^模式详情/}).click();
const sheetBox=page.getByRole('dialog',{name:'Agent 模式'});
await sheetBox.getByText(/Shift\+Tab 的切换顺序：手动确认 → 自动接受编辑 → 计划模式/).waitFor();
await sheetBox.getByText('目标进行中 · 12m',{exact:true}).waitFor();
await page.screenshot({path:path.join(folder,'mode-sheet.png')});
await sheetBox.getByRole('button',{name:'知道了',exact:true}).click();

// 终端按键 has Shift+Tab too.
await page.getByRole('button',{name:'更多操作',exact:true}).click();
await page.getByRole('button',{name:/终端按键.*Shift\+Tab/}).click();
await page.getByRole('button',{name:'Shift+Tab 切换模式',exact:true}).click();
await page.waitForFunction(()=>document.querySelector('#mode-bar .mode-chip')?.textContent==='跳过权限确认',null,{timeout:5000});
assert.equal((await keyCalls(page)).length,3);
console.log('PASS: details sheet and 终端按键 → Shift+Tab');

// A refused key is reported, never retried; the button comes back.
await page.evaluate(()=>{fx.keyError='没发出去：Agent 还没准备好，等它空闲了再发';fx.lag=0;});
await switchBtn(page).click();
await page.getByText('没发出去：Agent 还没准备好，等它空闲了再发',{exact:true}).waitFor();
await page.waitForTimeout(800);
assert.equal((await keyCalls(page)).length,4);
assert.equal(await switchBtn(page).isDisabled(),false);
await waitChips(page,['跳过权限确认']);
await page.evaluate(()=>{fx.keyError=null;});

// Blocked on a question, or a message being sent: no Shift+Tab (it could approve a dialog).
await page.evaluate(()=>{fx.agents[0]={...fx.agents[0],agent_status:'blocked'};S.chat.agent=fx.agents[0];S.agents=fx.agents;renderComposer();});
assert.ok(await switchBtn(page).isDisabled(),'disabled while blocked');
assert.match(await switchBtn(page).getAttribute('title'),/可能直接批准/);
await page.evaluate(()=>{fx.agents[0]={...fx.agents[0],agent_status:'idle'};S.chat.agent=fx.agents[0];S.outbox.push({key:draftKey(),text:'x',state:'sending',at:Date.now()});renderComposer();});
assert.ok(await switchBtn(page).isDisabled(),'disabled while a send is in flight');
await page.evaluate(()=>{S.outbox=[];renderComposer();});
assert.equal(await switchBtn(page).isDisabled(),false);
// A menu covering the footer (modes: null) keeps the last seen mode.
await page.evaluate(async()=>{fx.hide=true;await fetchTerminal(true);fx.hide=false;});
await waitChips(page,['跳过权限确认']);
assert.equal((await keyCalls(page)).length,4,'nothing sent by the checks');
console.log('PASS: refused key reported once; disabled while blocked or sending; hidden footer keeps the last mode');

// ── Local Codex: collaboration mode on screen, approval from the transcript ──
await page.evaluate(()=>{glanceOf(fx.agents[1]);GL.map.set(agentKey(fx.agents[1]),{status:'idle',modified:Date.now()/1000,modes:{source:'transcript',collaboration:'default',approval:'never',sandbox:'danger-full-access',goal:{state:'paused',objective:'把整套测试补齐'}}});});
await open(page,1);
await page.waitForFunction(()=>document.querySelector('#mode-bar .mode-chip')?.textContent==='默认模式');
await waitChips(page,['默认模式','完全访问']);
await switchBtn(page).click();
await page.waitForFunction(()=>document.querySelector('#mode-bar .mode-chip')?.textContent==='计划模式');
assert.deepEqual((await keyCalls(page)).at(-1).target,'w1:p2');
await page.screenshot({path:path.join(folder,'mode-codex-plan.png')});
// The list row carries a compact tag.
await page.getByRole('button',{name:'返回列表',exact:true}).click();
await page.evaluate(()=>setTab('live'));
await page.locator('.agent-row').first().waitFor();
await page.locator('.agent-row',{hasText:'改登录页'}).locator('.mode-tag',{hasText:'计划'}).waitFor();
await page.screenshot({path:path.join(folder,'mode-list.png')});
console.log('PASS: Codex plan chip after Shift+Tab, approval chip from transcript, list tag');
assert.equal(await overflow(page),0);
await page.context().close();

// ── 320 px and dark ───────────────────────────────────────────────────────────
for(const [w,h,dark,name] of [[320,640,false,'mode-320.png'],[390,844,true,'mode-dark.png'],[844,390,true,'mode-landscape-dark.png']]){
 page=await fresh(w,h,dark);
 await page.evaluate(()=>{fx.at['w1:p1']=2;});
 await open(page,0);
 await page.waitForFunction(()=>document.querySelector('#mode-bar .mode-chip')?.textContent==='计划模式');
 assert.equal(await overflow(page),0,'no horizontal overflow at '+w);
 const box=await switchBtn(page).boundingBox();assert.ok(box.height>=44&&box.width>=44,'touch target '+JSON.stringify(box));
 const bar=await page.locator('#mode-bar').boundingBox();assert.ok(bar.x>=0&&bar.x+bar.width<=w+0.5,'bar inside the screen');
 // The chips never wrap onto a second line.
 assert.ok((await page.locator('#mode-bar .mode-chips').boundingBox()).height<=34);
 if(dark){const c=await page.locator('#mode-bar .mode-chip').first().evaluate(n=>getComputedStyle(n).color);assert.notEqual(c,'rgb(15, 110, 120)','dark token in use');}
 await page.screenshot({path:path.join(folder,name)});
 await page.context().close();}
console.log('PASS: 320 px, dark and landscape layouts');

// ── Demo: explorable, never sends ─────────────────────────────────────────────
const ctx=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:2});page=await ctx.newPage();
page.on('pageerror',e=>{errors.push(e.message);});
await page.addInitScript(()=>{window.PocketNative={request(id,op){if(!['devices','demo','disconnect','protect','watchState','settings'].includes(op))throw Error('Forbidden native call: '+op);setTimeout(()=>nativeResult(id,{ok:true,data:op==='devices'?{devices:[]}:{}}),0);}};});
await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
await page.getByRole('button',{name:'体验聊天演示',exact:true}).click();
await page.locator('.agent-row',{hasText:'把移动端做成真正的聊天工具'}).click();
await page.locator('#mode-bar').waitFor();
const before=await chips(page);
await switchBtn(page).click();
await page.getByText('演示：没有真的发送按键',{exact:true}).waitFor();
assert.notDeepEqual(await chips(page),before);
await ctx.close();
console.log('PASS: demo cycles locally and sends nothing');

await browser.close();
assert.deepEqual(errors,[]);
console.log('mode UI: all passed');
})().catch(e=>{console.error(e);process.exit(1);});
