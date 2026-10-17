// The live activity line (activity.js): right after a send it says 已发出，等它开始…, then what the
// agent does (正在执行 <tool> / 正在思考 / 正在输出) with a clock, the agent's own status words from its
// screen (bridge `read` → `activity`) and its running sub-agents; it goes away on blocked / done and
// says so when the status goes stale or is unknown. Sub-agent rows on the list say who produces what,
// a running sub-agent's record shows the same line, reduced motion stops every animation.
// Offline: native SSH is a strict fake; nothing is sent anywhere (the prompt op is recorded only).
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
const root=path.resolve(__dirname,'..');
const html=require('./ui_bundle.cjs')(root);
const shots=path.join(root,'ui-artifacts');fs.mkdirSync(shots,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const errors=[];

async function open(width,height,opts={}){
 const ctx=await browser.newContext({viewport:{width,height},deviceScaleFactor:opts.scale||1,hasTouch:width<840,colorScheme:opts.dark?'dark':'light',reducedMotion:opts.calm?'reduce':'no-preference'});
 const page=await ctx.newPage();
 page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
 await page.addInitScript(()=>{
  const now=()=>Date.now()/1000,iso=s=>new Date(Date.now()-s*1000).toISOString();
  const rec={id:'r1',thread:'t-r1',title:'整理发布脚本',provider:'claude',parent:null,cwd:'/work/pocket',modified:now()-60};
  let n=10;const msg=(kind,text,age,extra={})=>({id:(++n)+':0',kind,text,title:'',call_id:'',timestamp:iso(age),...extra});
  const H=[msg('user','先看看发布脚本哪里慢。',900),msg('assistant','慢在打包那一步：每次都重新下载依赖。我加了缓存，现在 40 秒。',880,{phase:'final_answer'})];
  const agent={pane_id:'w1:p1',terminal_id:'term1',agent:'claude',agent_status:'idle',identity:'id-1',cwd:'/work/pocket',title:'整理发布脚本',
   history_ref:{status:'matched',source:'native-process',record_id:'r1',thread:'t-r1',record:rec}};
  window.fx={rec,H,msg,iso,agent,calls:[],status:'idle',read:{text:'$ '},kids:null,kidRec:{},statusFails:false,readFails:false};
  const device={id:'fx',name:'测试电脑',user:'u',host:'fixture.invalid',port:22,remember:true};
  window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);let data={};
   try{
    if(op==='devices')data={devices:[device],version:'test',connected:device};
    else if(op==='remote'){fx.calls.push(a);
     const live={...fx.agent,agent_status:fx.status};
     if(a.op==='sessions')data={sessions:[{name:'fx',running:true}]};
     else if(a.op==='agents')data={agents:[live]};
     else if(a.op==='status'){if(fx.statusFails)throw Error('连接超时');const {history_ref,...rest}=live;data={agents:[rest]};}
     else if(a.op==='history'){
      if(a.record_id==='r1'){data={record:fx.rec,messages:fx.H.slice(),before:0,has_more:false,children:[]};if(fx.kids)data.kids=JSON.parse(JSON.stringify(fx.kids));}
      else{const k=fx.kidRec[a.record_id];if(!k)throw Error('no record '+a.record_id);data={record:k.rec,messages:k.H.slice(),before:0,has_more:false,children:[],kid:{running:k.running}};}}
     else if(a.op==='read'){if(fx.readFails)throw Error('读取超时');data={...fx.read,agent_status:fx.status};}
     else if(a.op==='prompt')data={sent:true,text:a.text};
     else if(a.op==='catalog')data={records:[fx.rec],total:1,next:null};
     else if(a.op==='account')data={ssh_user:'u',hostname:'fx'};
     else if(a.op==='glance'){const previews={};for(const it of a.items||[])previews[it.key]=fx.kids?{kids:JSON.parse(JSON.stringify(fx.kids))}:{missing:true};data={previews};}
     else if(a.op==='commands')data={commands:[]};
     else throw Error('unexpected remote op '+a.op);}
    else if(!['watchState','protect','setAlerts','settings','cacheGet','cachePut','cacheList'].includes(op))throw Error('unexpected native op '+op);
   }catch(e){setTimeout(()=>nativeResult(id,{ok:false,error:e.message}),5);return;}
   setTimeout(()=>nativeResult(id,{ok:true,data}),5);}};
 });
 await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
 if(opts.dark)await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
 return page;}

const act=page=>page.locator('#act');
const label=page=>page.locator('#act .act-label').textContent();
const shot=async(page,name)=>{await page.evaluate(()=>{const t=document.getElementById('toast');t.classList.remove('show');});await page.waitForTimeout(300);await page.screenshot({path:path.join(shots,'activity-'+name+'.png')});};
const overflow=page=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
const until=(page,fn,arg,timeout=8000)=>page.waitForFunction(fn,arg,{timeout,polling:100});
// A Claude turn in the transcript: the prompt, a note, an open Bash call (no result yet).
const working=page=>page.evaluate(()=>{fx.status='working';fx.H.push(fx.msg('user','把测试也跑一遍',4),fx.msg('assistant','好，我先跑一遍测试。',3,{phase:''}),
 fx.msg('tool',JSON.stringify({command:'npm test -- --runInBand'}),2,{title:'Bash',call_id:'c1'}));
 fx.read={text:'⏺ Bash(npm test)\n\n✽ Ionizing… (42s · ↓ 1.2k tokens · esc to interrupt)\n\n'+'─'.repeat(30)+'\n❯ \n'+'─'.repeat(30),activity:{verb:'Ionizing',seconds:42,dir:'↓',tokens:'1.2k',line:'✽ Ionizing… (42s · ↓ 1.2k tokens · esc to interrupt)'}};});
const kidsReport=()=>{const now=Date.now()/1000,iso=s=>new Date(Date.now()-s*1000).toISOString();
 const kid=(id,title,running,act,started)=>({id,thread:id+'-t',provider:'claude',parent:'t-r1',title,role:'general-purpose',cwd:'/work/pocket',modified:now-5,running,state:running?'running':'done',...(act?{activity:act}:{}),...(started?{started:iso(started)}:{})});
 return {total:3,running:2,stamp:'k1',items:[kid('k1','补接口回归用例',true,{kind:'tool',verb:'run',text:'pytest -k api_cursor',open:true,at:iso(3)},80),
  kid('k2','检查暗色模式对比度',true,{kind:'note',text:'对比度不够的有 3 处：链接、占位符和禁用按钮。',open:false,at:iso(2)},50),kid('k3','整理日志格式',false,null,0)]};};

// ── Phone: send → 等它开始 → 正在执行 → kids → blocked / done ───────────────────
for(const dark of [false,true]){
 const tag=dark?'dark':'light',page=await open(390,844,{dark,scale:2});
 await page.locator('.agent-row').filter({hasText:'整理发布脚本'}).click();
 await page.getByText('慢在打包那一步').first().waitFor();
 assert.equal(await act(page).count(),0,'idle: no activity line');
 // Send while Herdr still reads idle: the line says it went out and waits for the start.
 await page.getByRole('textbox',{name:'消息输入框',exact:true}).fill('把测试也跑一遍');
 await page.getByRole('button',{name:'发送消息',exact:true}).click();
 await act(page).waitFor();
 await until(page,()=>document.querySelector('#act .act-label')?.textContent==='已发出，等它开始…');
 await until(page,()=>document.getElementById('chat-meta').textContent.includes('已发出 · 等它开始'));
 assert.equal(await page.evaluate(()=>fx.calls.filter(c=>c.op==='prompt').length),1,'one prompt, recorded only');
 assert.ok(await page.locator('#act .act-time').isVisible(),'the wait has a clock');
 if(!dark)await shot(page,'phone-sent-'+tag);
 // The agent's spinner shows on its screen before Herdr flips: the line reads it.
 const reads=await page.evaluate(()=>fx.calls.filter(c=>c.op==='read').length);
 await until(page,n=>fx.calls.filter(c=>c.op==='read').length>n,reads,6000);
 // Herdr says working, the transcript has an open Bash call, the screen has Claude's status line.
 await working(page);
 await until(page,()=>document.querySelector('#act .act-label')?.textContent==='正在执行',null,10000);
 await until(page,()=>document.querySelector('#act .act-tool')?.textContent.includes('npm test -- --runInBand'));
 await until(page,()=>document.querySelector('#act .act-words')?.textContent==='Claude：Ionizing… · ↓ 1.2k tokens',null,8000);
 const t=await page.locator('#act .act-time').textContent();assert.match(t,/^0:4\d$/,'the agent\'s own clock: '+t);
 assert.match(await page.locator('#chat-meta').textContent(),/执行中 0:4\d/,'header uses the same clock');
 // The rail keeps 中断 and the words, without a second clock while the line is in view.
 await page.locator('#foot-rail .foot-lead.t-work').waitFor();
 await until(page,()=>document.getElementById('activity-line')?.textContent.includes('npm test'));
 await until(page,()=>document.getElementById('composer').classList.contains('act-seen'));
 assert.equal(await page.locator('#foot-rail .foot-lead.t-work .since').isVisible(),false,'one clock on screen');
 assert.equal(await page.locator('#act .act-live').textContent(),'正在执行：运行 npm test -- --runInBand','screen readers hear the state, not the clock');
 assert.ok(await overflow(page)<=0);
 await shot(page,'phone-tool-'+tag);
 // The command finished; tokens keep coming: 正在输出. Thinking on its screen: 正在思考.
 await page.evaluate(()=>{fx.H.push(fx.msg('result','42 passed\nExit code 0',1,{title:'执行结果',call_id:'c1'}));fx.read={...fx.read,activity:{...fx.read.activity,seconds:47,tokens:'1.9k'}};});
 await until(page,()=>document.querySelector('#act .act-label')?.textContent==='正在输出',null,10000);
 assert.equal(await page.locator('#act .act-tool').isVisible(),false,'no open tool: no tool line');
 await page.evaluate(()=>{fx.read={...fx.read,activity:{...fx.read.activity,seconds:52,tokens:'1.9k',thinking:true}};});
 await until(page,()=>document.querySelector('#act .act-label')?.textContent==='正在思考',null,10000);
 // Sub-agents: two run, each says what it does; the finished one is not in the line.
 await page.evaluate(k=>{fx.kids=k;},kidsReport());
 await until(page,()=>document.querySelectorAll('#act .act-kid').length===2,null,10000);
 assert.equal(await page.locator('#act .act-kids-head').textContent(),'2 个子 Agent 在跑');
 const rows=await page.locator('#act .act-kid').allTextContents();
 assert.ok(rows[0].includes('补接口回归用例')&&rows[0].includes('运行')&&rows[0].includes('pytest -k api_cursor')&&/1:2\d/.test(rows[0]),'kid 1: '+rows[0]);
 assert.ok(rows[1].includes('检查暗色模式对比度')&&rows[1].includes('在输出')&&rows[1].includes('对比度不够的有 3 处'),'kid 2: '+rows[1]);
 await page.evaluate(()=>{const b=document.getElementById('chat-scroll');b.scrollTop=b.scrollHeight;});
 await shot(page,'phone-kids-'+tag);
 // A question on screen: the line goes at once (the question card takes over).
 await page.evaluate(()=>{fx.status='blocked';fx.read={text:'Do you want to proceed?\n❯ 1. Yes\n  2. No\n\nEsc to cancel'};});
 await until(page,()=>!document.getElementById('act'),null,4000);
 // Back to work, then done with the reply: gone, 做完了 in the rail.
 await page.evaluate(()=>{fx.status='working';fx.read={text:'$ '};});
 await act(page).waitFor({timeout:6000});
 // 做完了 shows for 8 s only: note it the moment it appears, so a slow machine can't miss it.
 await page.evaluate(()=>{window.__sawDone=false;const seen=()=>{if(document.querySelector('#foot-rail .foot-lead.t-done'))window.__sawDone=true;};new MutationObserver(seen).observe(document.body,{subtree:true,childList:true,attributes:true});});
 await page.evaluate(()=>{fx.kids={total:3,running:0,stamp:'k2',items:[]};fx.status='done';fx.H.push(fx.msg('assistant','测试都过了，42 个。',0,{phase:'final_answer'}));});
 await until(page,()=>!document.getElementById('act'),null,8000);
 await until(page,()=>window.__sawDone,null,8000);
 await page.context().close();}
console.log('PASS: send → 等它开始 → 正在执行 / 输出 / 思考 with the agent\'s clock and words, sub-agents, gone on blocked / done');

// ── Honest when it does not know: stale status, unknown status ─────────────────
{const page=await open(390,844);
 await page.locator('.agent-row').filter({hasText:'整理发布脚本'}).click();await page.getByText('慢在打包那一步').first().waitFor();
 await working(page);await page.evaluate(async()=>{S.statusBusy=false;await refreshStatus();});
 await until(page,()=>document.querySelector('#act .act-label')?.textContent==='正在执行',null,8000);
 // Status and screen reads start failing: after a while the line stops moving and says so.
 await page.evaluate(()=>{fx.statusFails=true;fx.readFails=true;S.liveAt=Date.now()-20000;ACT.readAt=Date.now()-20000;ACT.resumeAt=0;S.chat.sentAt=0;});
 await until(page,()=>document.querySelector('#act .act-label')?.textContent==='状态有一会儿没更新了',null,6000);
 assert.ok(await page.locator('#act.calm').count(),'calm: no animation');
 assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('#act .act-glyph'),'::before').animationName),'none');
 assert.match(await page.locator('#act .act-note').textContent(),/上次更新是 .*前/);
 assert.equal(await page.locator('#act .act-time').isVisible(),false,'no clock that pretends to know');
 await shot(page,'phone-stale-light');
 // Back: it moves again.
 await page.evaluate(async()=>{fx.statusFails=false;fx.readFails=false;S.statusBusy=false;await refreshStatus();});
 await until(page,()=>document.querySelector('#act .act-label')?.textContent==='正在执行',null,8000);
 // A state this app does not know, right after a send: 状态未知, with what Herdr said.
 await page.evaluate(async()=>{fx.status='hatching';S.chat.sentAt=Date.now();S.statusBusy=false;await refreshStatus();});
 await until(page,()=>document.querySelector('#act .act-label')?.textContent==='状态未知',null,6000);
 assert.match(await page.locator('#act .act-note').textContent(),/hatching/);
 await page.context().close();}
console.log('PASS: stale status stops the animation and says so; an unknown state is called unknown');

// ── Reduced motion: the line is there, nothing moves ─────────────────────────────
{const page=await open(390,844,{calm:true});
 await page.locator('.agent-row').filter({hasText:'整理发布脚本'}).click();await page.getByText('慢在打包那一步').first().waitFor();
 await working(page);await page.evaluate(async()=>{S.statusBusy=false;await refreshStatus();});
 await act(page).waitFor({timeout:8000});
 const anim=await page.evaluate(()=>[getComputedStyle(document.querySelector('#act .act-glyph'),'::before').animationName,getComputedStyle(document.querySelector('#act .act-label')).animationName,getComputedStyle(document.getElementById('act')).animationName]);
 assert.deepEqual(anim,['none','none','none'],'reduced motion: '+anim);
 await page.context().close();}
console.log('PASS: reduced motion keeps the line still');

// ── List rows and a running sub-agent's own record ───────────────────────────────
{const page=await open(390,844,{scale:2});
 await page.evaluate(k=>{fx.kids=k;fx.status='idle';
  const r=k.items[0];fx.kidRec[r.id]={running:true,rec:r,H:[fx.msg('user','补 api_cursor 的回归用例',90),fx.msg('assistant','先看现有的用例。',60,{phase:''}),fx.msg('tool',JSON.stringify({command:'pytest -k api_cursor'}),5,{title:'Bash',call_id:'k1c'})]};},kidsReport());
 await page.evaluate(()=>loadLive());
 const strip=page.locator('.kids-strip');await strip.waitFor();
 await page.getByRole('button',{name:'子 Agent 3 · 2 运行中，展开',exact:true}).waitFor();
 await strip.locator('.kids-live').waitFor({timeout:8000});
 assert.equal(await strip.locator('.kids-live-who').textContent(),'补接口回归用例');
 assert.equal(await strip.locator('.kids-live-what').textContent(),'运行 pytest -k api_cursor');
 await shot(page,'phone-list-kids-light');
 // Expanded: each running one says its step.
 await page.getByRole('button',{name:'子 Agent 3 · 2 运行中，展开',exact:true}).click();
 const subs=await page.locator('.kids-strip .kid-sub').allTextContents();
 assert.ok(subs.some(s=>s.includes('运行 pytest -k api_cursor')),'expanded: '+subs.join('|'));
 assert.ok(subs.some(s=>s.startsWith('已结束')),'finished one says so: '+subs.join('|'));
 // The parent idles while its sub-agents run: the chat line says so and lists them.
 await page.locator('.agent-row').filter({hasText:'整理发布脚本'}).click();await page.getByText('慢在打包那一步').first().waitFor();
 await until(page,()=>document.querySelector('#act .act-label')?.textContent==='子 Agent 在跑 · 2',null,8000);
 // Open a running sub-agent from the line: its record, read-only, shows its own live step.
 await page.locator('#act .act-kid').first().click();
 await page.getByText('补 api_cursor 的回归用例').first().waitFor();
 await until(page,()=>document.querySelector('#act .act-label')?.textContent==='子 Agent 正在执行',null,8000);
 assert.ok((await page.locator('#act .act-tool').textContent()).includes('pytest -k api_cursor'));
 assert.ok((await page.locator('#act .act-note').textContent()).includes('只读'));
 assert.equal(await page.locator('#composer textarea').count(),0,'a sub-agent record has no input');
 const h0=await page.evaluate(()=>fx.calls.filter(c=>c.op==='history'&&c.record_id==='k1').length);
 await page.waitForTimeout(3200);
 assert.ok(await page.evaluate(()=>fx.calls.filter(c=>c.op==='history'&&c.record_id==='k1').length)-h0>=1,'its record is read while it runs');
 await shot(page,'phone-kid-record-light');
 // It finishes: the line goes.
 await page.evaluate(()=>{const k=fx.kidRec.k1;k.running=false;k.H.push(fx.msg('result','3 passed',1,{title:'执行结果',call_id:'k1c'}),fx.msg('assistant','补好了，3 个用例都过了。',0,{phase:'final_answer'}));});
 await until(page,()=>!document.getElementById('act'),null,12000);
 assert.deepEqual(await page.evaluate(()=>fx.calls.filter(c=>['prompt','key','answer'].includes(c.op)).length),0,'nothing sent to a sub-agent');
 await page.context().close();}
console.log('PASS: list rows say which sub-agent produces what; a running sub-agent\'s record shows its live step');

// ── Tablet: the line in the conversation pane ──────────────────────────────────
for(const dark of [false,true]){const page=await open(1280,800,{dark});
 await page.locator('.wide-list .card-button').filter({hasText:'整理发布脚本'}).click();await page.getByText('慢在打包那一步').first().waitFor();
 await page.evaluate(k=>{fx.kids=k;},kidsReport());await working(page);await page.evaluate(async()=>{S.statusBusy=false;await refreshStatus();});
 await until(page,()=>document.querySelector('#act .act-label')?.textContent==='正在执行',null,8000);
 await until(page,()=>document.querySelectorAll('#act .act-kid').length===2,null,10000);
 const w=await page.evaluate(()=>[document.getElementById('act').getBoundingClientRect().width,document.querySelector('.timeline').getBoundingClientRect().width]);
 assert.ok(Math.abs(w[0]-w[1])<2,'the line spans the reading column: '+w);
 // The footer rail lines up with the composer under the reading column.
 const edges=await page.evaluate(()=>{const r=document.getElementById('foot-rail').getBoundingClientRect(),c=document.querySelector('#composer .composer').getBoundingClientRect();return [Math.round(r.left-c.left),Math.round(r.right-c.right)];});
 assert.deepEqual(edges,[0,0],'rail and composer share edges');
 assert.ok(await overflow(page)<=0);
 await page.evaluate(()=>{const b=document.getElementById('chat-scroll');b.scrollTop=b.scrollHeight;});
 await shot(page,'tablet-1280-'+(dark?'dark':'light'));
 await page.context().close();}
console.log('PASS: tablet keeps the line in the reading column');

await browser.close();
assert.deepEqual(errors,[],'no page errors');
console.log('PASS: activity line');
})().catch(e=>{console.error(e);process.exit(1);});
