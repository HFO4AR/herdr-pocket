// Scrolling through question cards with a finger (touch emulation, real CDP touch drags).
// The report: with several questions on screen, a vertical drag that starts in the middle of the card
// (on a question, an option, its description) did not scroll, so the questions below were hard to
// reach. Cause: .qa-body was overflow:auto + overscroll-behavior:contain; current Chromium (and so an
// up-to-date Android WebView) treats that box as a scroll container even when nothing overflows, and
// `contain` stopped the drag from reaching the conversation behind it.
// Covers (a) a Claude multi-question card above the input with long options, (b) a Codex async card
// with three questions inline in the timeline, (c) the docked card when it gets less room than its
// content. Offline: native SSH is a strict fixture and `remote` is a recorded fake.
const {chromium}=require('playwright');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const folder=path.join(root,'ui-artifacts');fs.mkdirSync(folder,{recursive:true});
const RULE='─'.repeat(64);
const LONG='这一项会改动比较多的文件，需要你在开始之前确认一下影响范围，然后它会按顺序一个个处理，中途不会停下来再问你。';
// Claude's TUI shows one question of three; the transcript has all of them (full descriptions).
const rows=[];for(let i=1;i<=5;i++)rows.push((i===1?'❯ ':'  ')+i+'. 方案 '+i+'：先做这一部分','     '+LONG.slice(0,24));
rows.push('  6. Type something.',RULE,'  7. Chat about this');
const SCREEN=[RULE,'←  ☐ 范围  ☐ 顺序  ☐ 测试  ✔ Submit  →','','第 1 个问题：先改哪一块？','',...rows,'','Enter to select · Tab/Arrow keys to navigate · Esc to cancel'].join('\n');
const MENU=JSON.parse(execFileSync('python3',['-c',`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('b',sys.argv[1]);b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
print(json.dumps(b.parse_menu(sys.argv[2],'claude'),ensure_ascii=False))`,path.join(root,'bridge/pocket_bridge.py'),SCREEN],{encoding:'utf8'}));
assert(MENU&&MENU.options.length>=5,'bridge parsed the Claude menu');

(async()=>{
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const errors=[];

async function open(w,h,dark){
 const ctx=await browser.newContext({viewport:{width:w,height:h},deviceScaleFactor:2,hasTouch:true,isMobile:true,colorScheme:dark?'dark':'light'});
 const page=await ctx.newPage();page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
 await page.addInitScript(()=>{window.PocketNative={request(id,op){if(!['devices','demo','disconnect','protect','watchState'].includes(op))throw Error('Forbidden native call in offline UI test: '+op);setTimeout(()=>nativeResult(id,{ok:true,data:op==='devices'?{devices:[]}:{}}),0);}};});
 await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
 await page.getByRole('button',{name:'体验聊天演示',exact:true}).click();
 if(dark)await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
 const cdp=await ctx.newCDPSession(page);
 // A finger drag: touchStart, small moves at ~60 Hz, touchEnd (dy < 0 scrolls the content down).
 page.drag=async(x,y,dy,steps=14)=>{
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
  for(let i=1;i<=steps;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+dy*i/steps}]});await page.waitForTimeout(16);}
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(350);};
 page.ctx=ctx;return page;}
// Fixture installer shared by the cases: messages, agent, and a fake `remote` that records every call.
async function fixture(page,{agent,messages,screen,menu}){
 await page.evaluate(({agent,messages,screen,menu})=>{
  window.fx={calls:[],agent,messages};
  remote=async(op,args={})=>{fx.calls.push({op,args});await new Promise(r=>setTimeout(r,30));
   if(op==='status')return{agents:[fx.agent]};
   if(op==='history')return{record:fx.agent.history_ref.record,messages:structuredClone(fx.messages),children:[],before:0,has_more:false};
   if(op==='read')return menu?{text:screen,menu}:{text:'›'};
   if(op==='answer')return{sent:true,receipt:args.id,result:{answered:true}};
   if(op==='prompt'||op==='key')return{sent:true};
   throw Error('unexpected op '+op);};
  S.demo=false;S.session='fixture';S.agents=[fx.agent];openAgent(fx.agent);},{agent,messages,screen,menu});}
const ts=n=>new Date(Date.UTC(2026,9,18,9,n)).toISOString();
const msg=(n,kind,text,extra={})=>({id:'7'+n+':0',kind,text,title:'',call_id:'',timestamp:ts(n),...extra});
const record=(id,provider,title)=>({status:'matched',record:{id,thread:id,provider,title,cwd:'/home/demo/site',modified:Date.now()/1000}});
const center=b=>({x:b.x+b.width/2,y:b.y+b.height/2});
const inView=(b,v)=>b&&b.y>=v.y-1&&b.y+b.height<=v.y+v.height+1;
const scrollTop=(page,sel)=>page.evaluate(s=>document.querySelector(s).scrollTop,sel);

// ─── (b) Codex async: three questions inline in the timeline ─────────────────────────────
async function codexAsync(w,h,dark){
 const page=await open(w,h,dark);
 const qs=[1,2,3].map(k=>({header:'问题'+k,id:'q'+k,question:'第 '+k+' 个问题：接下来你希望怎么处理这一部分的工作？',
  options:[{label:'方案 A：先做最小改动',description:LONG},{label:'方案 B：一次性全部重构',description:LONG},{label:'方案 C：先写测试再动手',description:LONG}]}));
 await fixture(page,{agent:{pane_id:'w1:p7',identity:'id-codex',agent:'codex',agent_status:'idle',cwd:'/home/demo/site',terminal_title:'三个问题',agent_session:{value:'c3'},history_ref:record('rec-c3','codex','三个问题')},
  messages:[msg(1,'user','用选择题问我三个问题。'),msg(2,'tool',JSON.stringify({questions:qs},null,2),{title:'request_user_input_async',call_id:'call_three'}),
   msg(3,'result','{"accepted":true}',{title:'执行结果',call_id:'call_three'}),msg(4,'assistant','已弹出三个选择题。',{phase:'final_answer'})]});
 const card=page.locator('.qa-log.waiting .qa-card');await card.waitFor();await page.waitForTimeout(500);
 assert.match(await card.locator('.qa-head').textContent(),/Codex 在等你回答.*已答 0\/3/);
 assert.deepEqual(await card.locator('.qa-num').allTextContents(),['第 1/3 题','第 2/3 题','第 3/3 题']);
 // Only the conversation scrolls: no scroll box (and no scroll trap) inside the card.
 assert.deepEqual(await card.evaluate(c=>{const b=c.querySelector('.qa-body'),s=getComputedStyle(b);return [s.overflowY,getComputedStyle(c).overflowY,s.overscrollBehaviorY];}),['visible','clip','auto']);
 // Put the first question at the top of the view, like the person reading it.
 await page.evaluate(()=>{const c=document.querySelector('.qa-log .qa-q'),b=document.getElementById('chat-scroll');b.scrollTop+=c.getBoundingClientRect().top-b.getBoundingClientRect().top-8;});
 await page.waitForTimeout(200);
 const view=await page.locator('#chat-scroll').boundingBox();
 if(dark===false&&w===390)await page.screenshot({path:path.join(folder,'qscroll-codex-top.png')});
 // Drags that start in the middle of the card: on an option's description, then on the next question.
 for(const target of [card.locator('.qa-q').nth(0).locator('.qa-desc').nth(1),card.locator('.qa-q').nth(0).locator('.qa-opt').nth(2)]){
  const before=await scrollTop(page,'#chat-scroll');const p=center(await target.boundingBox());
  const y=Math.min(p.y,view.y+view.height*0.62);await page.drag(p.x,y,-260);
  const after=await scrollTop(page,'#chat-scroll');assert(after-before>150,`drag from the middle of the card scrolls (${w}x${h}): ${before} -> ${after}`);}
 // A drag is not a tap: nothing got selected on the way.
 assert.equal(await card.locator('.qa-opt[aria-checked="true"]').count(),0,'dragging over options selects nothing');
 // The answer bar stays in view while the card is on screen, above the back-to-latest arrow.
 const submit=card.getByRole('button',{name:'发送回答',exact:true});
 assert(inView(await submit.boundingBox(),view),'发送回答 stays in view while scrolling the card');
 const jump=await page.locator('#jump:not(.hidden)').boundingBox();const bar=await card.locator('.qa-foot').boundingBox();
 assert(Math.abs(bar.y+bar.height-(view.y+view.height))<=2,'the answer bar sits on the bottom edge of the conversation, nothing shows under it');
 if(jump)assert(jump.y+jump.height<=bar.y+1,'the jump arrow does not cover the answer bar');
 // Back to question 1, answer it with a tap: the next open question comes to the top by itself.
 await page.evaluate(()=>{const c=document.querySelector('.qa-log .qa-q'),b=document.getElementById('chat-scroll');b.scrollTop+=c.getBoundingClientRect().top-b.getBoundingClientRect().top-8;});
 await page.waitForTimeout(200);
 const a1=card.locator('.qa-q').nth(0).getByRole('radio',{name:/方案 B/});await page.touchscreen.tap(...Object.values(center(await a1.boundingBox())));
 assert.equal(await a1.getAttribute('aria-checked'),'true','a tap selects the option');
 await page.waitForFunction(()=>{const q=document.querySelectorAll('.qa-log .qa-q')[1],b=document.getElementById('chat-scroll');const d=q.getBoundingClientRect().top-b.getBoundingClientRect().top;return d>=0&&d<40;},null,{timeout:4000});
 assert.match(await card.locator('.qa-head').textContent(),/已答 1\/3/);
 assert.equal(await card.locator('.qa-num').first().textContent(),'第 1/3 题 · 已答');
 assert.match(await card.locator('.qa-progress').textContent(),/已答 1\/3.*去第 2 题/);
 if(w===390)await page.screenshot({path:path.join(folder,`qscroll-codex-next${dark?'-dark':''}.png`)});
 // Skip question 2 for now: a drag from the middle reaches question 3, and a tap answers it.
 for(let i=0;i<4;i++){const q3=await card.locator('.qa-q').nth(2).locator('.qa-opt').nth(2).boundingBox();if(inView(q3,{y:view.y,height:view.height-bar.height}))break;
  const p=center(await card.locator('.qa-q').nth(1).boundingBox());await page.drag(view.x+view.width/2,Math.min(Math.max(p.y,view.y+view.height*0.4),view.y+view.height*0.6),-260);}
 const a3=card.locator('.qa-q').nth(2).getByRole('radio',{name:/方案 C/});
 const b3=await a3.boundingBox();assert(inView(b3,view),'the last question is reachable by dragging');
 await page.touchscreen.tap(b3.x+b3.width/2,b3.y+Math.min(b3.height/2,20));
 assert.equal(await a3.getAttribute('aria-checked'),'true','the last question is answerable');
 // The one still open is above: 去第 2 题 brings it back.
 await page.waitForTimeout(500);
 await card.locator('.qa-progress').getByRole('button',{name:'去第 2 题'}).click();
 await page.waitForFunction(()=>{const q=document.querySelectorAll('.qa-log .qa-q')[1],b=document.getElementById('chat-scroll');const d=q.getBoundingClientRect().top-b.getBoundingClientRect().top;return d>=0&&d<40;},null,{timeout:4000});
 const a2=card.locator('.qa-q').nth(1).getByRole('radio',{name:/方案 A/});await page.touchscreen.tap(...Object.values(center(await a2.boundingBox())));
 assert.match(await card.locator('.qa-progress').textContent(),/3 题都答好了/);
 assert(inView(await submit.boundingBox(),view),'发送回答 is in view after the last answer');
 if(w===390)await page.screenshot({path:path.join(folder,`qscroll-codex-done${dark?'-dark':''}.png`)});
 await page.touchscreen.tap(...Object.values(center(await submit.boundingBox())));
 await page.waitForFunction(()=>fx.calls.some(c=>c.op==='prompt'));
 const sent=await page.evaluate(()=>fx.calls.filter(c=>c.op==='prompt'));assert.equal(sent.length,1);
 const items=JSON.parse(sent[0].args.text.split('\n')[1]);
 assert.deepEqual(items.map(x=>x.answer),['方案 B：一次性全部重构','方案 A：先做最小改动','方案 C：先写测试再动手']);
 assert.deepEqual(items.map(x=>JSON.parse(x.questionItemId)[2]),[0,1,2]);
 await page.ctx.close();
 console.log(`PASS: (b) Codex async with 3 questions scrolls from the middle, jumps to the next open one and answers all (${w}x${h}${dark?' dark':''})`);}

// ─── (a)/(c) Claude: the card above the input, content taller than its room ───────────────
async function claudeDocked(w,h,dark,label){
 const page=await open(w,h,dark);
 const q=k=>({question:'第 '+k+' 个问题：先改哪一块？',header:['范围','顺序','测试'][k-1],multiSelect:false,options:[1,2,3,4,5].map(i=>({label:'方案 '+i+'：先做这一部分',description:LONG}))});
 await fixture(page,{agent:{pane_id:'w1:p9',identity:'id-claude-q',agent:'claude',agent_status:'blocked',cwd:'/home/demo/site',terminal_title:'整理',agent_session:{value:'s3'},history_ref:record('rec-s3','claude','整理')},
  messages:[msg(1,'user','整理一下。'),msg(2,'assistant','先确认三件事。'),msg(3,'tool',JSON.stringify({questions:[q(1),q(2),q(3)]}),{title:'AskUserQuestion',call_id:'toolu_three'})],screen:SCREEN,menu:MENU});
 await page.evaluate(()=>fetchTerminal(true));
 const card=page.locator('#live-state .qa-card');await card.waitFor();await page.waitForTimeout(500);
 assert.match(await card.locator('.qa-head').textContent(),/Claude 在问你.*第 1\/3 题/);
 const body=card.locator('.qa-body');const box=await body.boundingBox();
 const room=await body.evaluate(b=>b.scrollHeight-b.clientHeight);assert(room>100,label+': the options are taller than the room they get ('+room+')');
 const submit=card.getByRole('button',{name:'发送回答',exact:true});const vp={y:0,height:h};
 if(w===390&&h===844)await page.screenshot({path:path.join(folder,`qscroll-claude${dark?'-dark':''}.png`)});
 // Drag from the middle of the card body until the last option shows; the answer bar never moves away.
 const last=card.getByRole('radio',{name:/方案 5/});
 const atEnd=()=>body.evaluate(n=>n.scrollTop>=n.scrollHeight-n.clientHeight-1);
 for(let i=0;i<10&&!inView(await last.boundingBox(),box)&&!await atEnd();i++){
  const before=await body.evaluate(n=>n.scrollTop);await page.drag(box.x+box.width/2,box.y+box.height*0.6,-Math.min(200,box.height*0.5));
  const now=await body.evaluate(n=>n.scrollTop);assert(now>before,label+': a drag from the middle of the card scrolls its options '+JSON.stringify({before,now,box}));
  assert(inView(await submit.boundingBox(),vp),label+': 发送回答 stays on screen');}
 assert.equal(await card.locator('.qa-opt[aria-checked="true"]').count(),0,label+': dragging selects nothing');
 // Reachable: on a short screen the option may be taller than its share of the card; enough of it shows to tap.
 const lb=await last.boundingBox();const top=Math.max(lb.y,box.y),bottom=Math.min(lb.y+lb.height,box.y+box.height);
 assert(bottom-top>=Math.min(44,lb.height),label+': the last option is reachable '+JSON.stringify({lb,box}));
 await page.touchscreen.tap(lb.x+lb.width/2,(top+bottom)/2);
 assert.equal(await last.getAttribute('aria-checked'),'true',label+': the last option is answerable with a tap');
 await page.touchscreen.tap(...Object.values(center(await submit.boundingBox())));
 await page.waitForFunction(()=>fx.calls.some(c=>c.op==='answer'));
 const ans=await page.evaluate(()=>fx.calls.find(c=>c.op==='answer').args);assert.equal(ans.action,'select');assert.equal(ans.option,5);
 await page.ctx.close();
 console.log(`PASS: ${label} docked Claude card scrolls from the middle, last option answerable, send in reach (${w}x${h}${dark?' dark':''})`);}

await codexAsync(390,844,false);
await codexAsync(390,844,true);
await codexAsync(360,780,false);
await claudeDocked(390,844,false,'(a)');
await claudeDocked(390,844,true,'(a)');
await claudeDocked(360,780,false,'(a)');
await claudeDocked(390,620,false,'(c)');
await claudeDocked(360,600,false,'(c)');
assert.deepEqual(errors,[]);
await browser.close();
console.log('PASS: question cards scroll with a finger anywhere');
})().catch(e=>{console.error(e);process.exit(1);});
