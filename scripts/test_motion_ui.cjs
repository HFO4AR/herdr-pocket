// Conversation motion: earlier pages (spinner, reading upwards loads by itself, the reader stays
// put, one read at a time, inline error + 重试, record start) and sending (immediate feedback, the
// bubble enters once, labels crossfade through the states, the transcript copy takes over without a
// jump, no replays on refresh, reduced motion). Offline: native SSH is a strict fake; nothing is sent.
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
 const r1={id:'r1',thread:'t1',title:'整理发布流程',provider:'claude',parent:null,cwd:'/work/proj',modified:now-60};
 // Three pages, newest first: ids are byte offsets, so page k holds k00…k34.
 const page=k=>{const out=[];for(let i=0;i<35;i+=5){const n=k*100+i,id=x=>(n+x)+':0',ts=iso(100000-n*60);
  out.push({id:id(0),kind:'user',text:'第 '+k+' 页的问题 '+i,title:'',call_id:'',timestamp:ts,...(i===30&&k===1?{images:[{block:0}]}:{})},
   {id:id(1),kind:'tool',text:JSON.stringify({command:'npm test'}),title:'Bash',call_id:'c'+n,timestamp:ts},
   {id:id(2),kind:'result',text:'PASS: a\nPASS: b\nExit code 0',title:'执行结果',call_id:'c'+n,timestamp:ts},
   {id:id(3),kind:'assistant',text:'第 '+k+' 页的回答 '+i+'。\n\n'+'这里是一段说明，读起来要有点长度。'.repeat(3+i%3),title:'',call_id:'',timestamp:ts});}
  return out;};
 const pages={3:page(3),2:page(2),1:page(1)};
 window.fx={pages,calls:[],history:[],inflight:0,maxInflight:0,delay:30,failNext:'',prompts:[],promptDelay:30,promptErrors:[],haptics:[],extra:[]};
 const A1={pane_id:'w1:p1',terminal_id:'term1',agent:'claude',agent_status:'idle',identity:'id-1',cwd:'/work/proj',title:'整理发布流程',history_ref:{status:'matched',source:'native-process',record_id:'r1',thread:'t1',record:r1}};
 fx.A1=A1;
 const device={id:'fx',name:'测试电脑',user:'u',host:'fixture.invalid',port:22,remember:true};
 window.PocketNative={haptic(k){fx.haptics.push(k);},request(id,op,raw){const a=JSON.parse(raw);let data={},wait=10;
  const reply=(ok,v)=>setTimeout(()=>nativeResult(id,ok?{ok:true,data:v}:{ok:false,error:v}),wait);
  try{
  if(op==='devices')data={devices:[device],version:'test',connected:device};
  else if(op==='remote'){fx.calls.push(a.op);
   if(a.op==='sessions')data={sessions:[{name:'fx',running:true}]};
   else if(a.op==='agents')data=a.target?{follow:true,state:'same',agents:[fx.A1],pane:null}:{agents:[fx.A1]};
   // fx.statusGate (an array): status answers wait there until the test lets them land.
   else if(a.op==='status'){const answer=()=>{const {history_ref,...rest}=fx.A1;return {agents:[rest]};};
    if(fx.statusGate){fx.statusGate.push(()=>nativeResult(id,{ok:true,data:answer()}));return;}data=answer();}
   else if(a.op==='history'){
    fx.history.push(a.before===undefined?'poll':'before:'+a.before);fx.inflight++;fx.maxInflight=Math.max(fx.maxInflight,fx.inflight);
    const k=a.before===undefined?3:a.before/100-1,fail=a.before!==undefined&&fx.failNext;if(fail)fx.failNext='';
    const msgs=JSON.parse(JSON.stringify(k===3?pages[3].concat(fx.extra):pages[k]));
    setTimeout(()=>{fx.inflight--;nativeResult(id,fail?{ok:false,error:fail}:{ok:true,data:{record:r1,messages:msgs,before:k*100,has_more:k>1,children:[]}});},fx.delay);return;}
   else if(a.op==='prompt'){wait=fx.promptDelay;const e=fx.promptErrors.shift();if(e){setTimeout(()=>nativeResult(id,{ok:false,error:e}),wait);return;}fx.prompts.push(a.text);data={sent:true,receipt:a.id};}
   else if(a.op==='read')data={text:'$ '};
   else if(a.op==='catalog')data={records:[],total:0,next:null};
   else if(a.op==='account')data={ssh_user:'u',hostname:'fx'};
   else throw Error('blocked remote op '+a.op);}
  else if(!['watchState','protect','setAlerts','cacheGet','cachePut'].includes(op))throw Error('unexpected native op '+op);
  }catch(e){reply(false,e.message);return;}
  reply(true,data);}};
});
await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
// No background polling or follow checks: every read in this test is one the test asks for.
await page.evaluate(()=>{window.followInterval=()=>1e9;S.paused=true;
 // Transcript pictures arrive late (like a slow SSH read): tall, so a late load would push the text.
 const c=document.createElement('canvas');c.width=200;c.height=320;const g=c.getContext('2d');g.fillStyle='#9d552d';g.fillRect(0,0,200,320);const url=c.toDataURL();
 imgFetch=()=>new Promise(r=>setTimeout(()=>r(url),900));});
const shot=async name=>{await page.evaluate(()=>document.getElementById('toast').classList.remove('show'));await page.waitForTimeout(260);await page.screenshot({path:path.join(shots,'motion-'+name+'.png')});};
const n=()=>page.locator('#chat-scroll');
// A kept row in view and where it sits on screen.
const mark=()=>page.evaluate(()=>{const body=document.getElementById('chat-scroll'),vt=body.getBoundingClientRect().top;
 const t=[...document.querySelectorAll('.timeline>.turn>.message')].find(x=>x.getBoundingClientRect().top>vt+60);window.__m=t;return t.getBoundingClientRect().top;});
const markNow=()=>page.evaluate(()=>window.__m.isConnected?window.__m.getBoundingClientRect().top:NaN);

await page.getByRole('button',{name:/整理发布流程/}).click();
await page.getByText('第 3 页的回答 30。',{exact:false}).waitFor();
await page.evaluate(()=>{S.paused=true;});
assert.equal(await page.locator('.message.fresh,.message.send-in').count(),0,'the first paint of a chat is quiet');
await page.getByRole('button',{name:'加载更早消息',exact:true}).waitFor();

// 1. Tap: the spinner shows at once, nothing shifts, and the reader stays on the same row.
await page.evaluate(()=>{window.__near=olderNear;olderNear=()=>false;fx.delay=900;const b=document.getElementById('chat-scroll');S.stick=false;b.scrollTop=0;});
await page.waitForTimeout(100);
const top0=await mark();
await page.getByRole('button',{name:'加载更早消息',exact:true}).click();
assert(await page.locator('.older.is-loading .spinner').isVisible(),'spinner right after the tap');
await page.getByText('正在加载更早消息…',{exact:true}).waitFor({timeout:200});
{const d=await markNow()-top0;const h=await page.evaluate(()=>[document.querySelector('.older').offsetHeight,document.querySelector('.older').firstChild.offsetHeight,getComputedStyle(document.querySelector('.older-status')).cssText.length,getComputedStyle(document.querySelector('.older-status')).lineHeight,getComputedStyle(document.querySelector('.older')).paddingTop,document.getElementById('chat-scroll').scrollTop]);assert(Math.abs(d)<1,'the loading state takes the button place without shifting the list '+d+' '+h);}
await shot('loading');
await page.getByText('第 2 页的回答 30。',{exact:false}).waitFor();
{const d=await markNow();assert(Math.abs(d-top0)<=2,'reading position kept when an earlier page is prepended '+top0+' '+d+' '+await page.evaluate(()=>[window.__m.dataset.mid,[...document.querySelectorAll('.timeline>*')].slice(0,3).map(x=>x.className+x.dataset.id)]));}
assert.equal(await page.locator('.message.fresh').count(),0,'an earlier page does not animate');
console.log('PASS: tapping 加载更早消息 shows a spinner at once and keeps the reading position');

// 2. A late picture in the page that came in above the reader does not push the text either.
await page.evaluate(()=>{olderNear=window.__near;fx.delay=60;});
await page.evaluate(()=>{const b=document.getElementById('chat-scroll');b.scrollTop=b.scrollTop+400;});
await page.waitForTimeout(150);
// Reading upwards near the top loads the next page by itself, with the spinner, once.
const calls0=await page.evaluate(()=>fx.history.length);
await page.evaluate(()=>{fx.delay=700;const b=document.getElementById('chat-scroll');b.scrollTop=120;});
await page.locator('.older.is-loading').waitFor({timeout:500});
// Polls and more taps meanwhile: still one read at a time; the poll is not lost, it runs after.
await page.evaluate(()=>{fetchHistory();fetchHistory(true);fetchHistory();const b=document.getElementById('chat-scroll');b.scrollTop=b.scrollTop-10;});
await page.waitForTimeout(80);
const top1=await mark();
await page.getByText('第 1 页的回答 30。',{exact:false}).waitFor();
{const d=await markNow();assert(Math.abs(d-top1)<=2,'position kept on an automatic load '+top1+' '+d+' '+await page.evaluate(()=>[document.getElementById('chat-scroll').scrollTop,window.__m.dataset.mid,S.stick]));}
await page.waitForFunction(()=>fx.history.at(-1)==='poll'&&fx.inflight===0);
const seq=await page.evaluate(n=>fx.history.slice(n),calls0);
assert.deepEqual(seq,['before:200','poll'],'one earlier page, then the deferred poll: '+seq.join(', '));
assert.equal(await page.evaluate(()=>fx.maxInflight),1,'never two history reads at once');
// The picture lands 900 ms later, above the reader.
await page.locator('.img-tile img').first().waitFor({state:'attached',timeout:5000});
await page.waitForTimeout(300);
assert(Math.abs(await markNow()-top1)<=2,'a picture loading above does not move the text ('+top1+' → '+await markNow()+')');
console.log('PASS: reading upwards loads earlier pages by itself, one read at a time, polls deferred not dropped, pictures do not shift');

// 3. Record start: a quiet line, no button, no more reads.
await page.locator('.older.is-start').getByText('已到记录起点',{exact:true}).waitFor();
assert.equal(await page.getByRole('button',{name:'加载更早消息',exact:true}).count(),0);
await page.evaluate(()=>{document.getElementById('chat-scroll').scrollTop=0;});
await shot('start');
console.log('PASS: the record start is a quiet line');

// 4. A failed page: inline error with 重试, the chat keeps going, no automatic retries.
await page.evaluate(()=>{fx.delay=40;fx.failNext='连接断了';S.stick=true;S.paused=false;return fetchHistory(false,true);});
await page.evaluate(()=>{S.paused=true;});
await page.getByRole('button',{name:'加载更早消息',exact:true}).waitFor();
await page.evaluate(()=>{const b=document.getElementById('chat-scroll');S.stick=false;b.scrollTop=40;});
await page.locator('.older.is-error').getByText('没加载出来：连接断了',{exact:true}).waitFor();
const failed=await page.evaluate(()=>fx.history.length);
await page.evaluate(()=>{const b=document.getElementById('chat-scroll');b.scrollTop=10;});await page.waitForTimeout(150);
await page.evaluate(()=>{const b=document.getElementById('chat-scroll');b.scrollTop=0;});await page.waitForTimeout(150);
assert.equal(await page.evaluate(()=>fx.history.length),failed,'no automatic retry after an error');
assert.equal(await page.locator('.note.error').count(),0,'the chat itself is not marked failed');
await shot('error');
const top2=await mark();
await page.getByRole('button',{name:'重试',exact:true}).click();
await page.getByText('第 2 页的回答 30。',{exact:false}).waitFor();
assert(Math.abs(await markNow()-top2)<=2,'position kept after 重试');
console.log('PASS: a failed page says so in place and 重试 loads it');

// Herdr's first status after a send (still idle: the agent has not picked the prompt up yet) lands
// whenever the next poll happens to answer: before the transcript copy or after it. Steps 5–6 hold
// status answers back, so each order is played on purpose.
const holdStatus=async()=>{await page.evaluate(()=>{fx.statusGate=[];});await page.waitForFunction(()=>!S.statusBusy);};
const statusLands=async()=>{await page.evaluate(()=>{const q=fx.statusGate||[];fx.statusGate=null;if(q.length)q.forEach(f=>f());else refreshStatus();});
 await page.waitForFunction(()=>S.chat.agent.agent_status==='idle'&&!S.statusBusy);};
// Where a bubble sits once the rows' own motion is over, and the room the footer leaves above it.
const settled=()=>page.waitForFunction(()=>!document.getAnimations().some(a=>a.playState==='running'&&a.effect?.target?.closest?.('.timeline .message')));
const where=async text=>{await settled();return page.evaluate(t=>{const b=[...document.querySelectorAll('.timeline .message .bubble')].filter(x=>x.textContent.includes(t));
 return {n:b.length,top:b.length?b.at(-1).getBoundingClientRect().top:NaN,foot:document.getElementById('composer').offsetHeight,view:document.getElementById('chat-scroll').clientHeight,stick:S.stick};},text);};
const still=(a,b,what)=>{assert.equal(b.n,1,what+': one bubble');assert(Math.abs(b.top-a.top)<=2,what+' without a jump ('+a.top+' → '+b.top+'; footer '+a.foot+' → '+b.foot+', view '+a.view+' → '+b.view+')');};

// 5. Sending: immediate feedback, the bubble rises in once, the label walks through the states.
await page.evaluate(()=>{fx.delay=30;S.stick=true;scrollBottom();fx.promptDelay=700;});await holdStatus();
const box=page.getByRole('textbox',{name:'消息输入框',exact:true});
await box.fill('把发布流程写进文档');
await page.getByRole('button',{name:'发送消息',exact:true}).click();
const row=page.locator('.message.user.pending').filter({hasText:'把发布流程写进文档'});
await row.waitFor({timeout:300});
assert.deepEqual(await page.evaluate(()=>{const r=document.querySelector('.message.pending');window.__row=r;return [r.classList.contains('send-in'),getComputedStyle(r).animationName,document.querySelector('#composer .send').classList.contains('fired')];}),[true,'send-in',true],'bubble animates in and the button answers the press');
assert.equal(await page.evaluate(()=>fx.haptics.at(-1)),'confirm','a haptic tick on send');
await row.getByText('发送中…',{exact:true}).waitFor();
await shot('sending');
await page.waitForTimeout(400);
assert.equal(await page.evaluate(()=>window.__row.classList.contains('send-in')),false,'entry class dropped once it has played');
await row.getByText('已送达 Agent',{exact:true}).waitFor();
assert(await page.evaluate(()=>document.querySelector('.message.pending')===window.__row),'same bubble through the state change');
assert(await page.evaluate(()=>window.__row.classList.contains('sent')&&!window.__row.classList.contains('sending')));
// Repaints and polls do not replay anything.
await page.evaluate(()=>{paintTimeline();paintTimeline();});
assert.equal(await page.locator('.send-in,.message.fresh').count(),0,'no replay on repaint');
console.log('PASS: send feedback is immediate, the bubble enters once and changes state in place');

// 6. Hand-off: the transcript copy takes the bubble's place with no jump and no entrance, and Herdr's
// late idle after it moves nothing either (the footer keeps its 已发出 line, so it keeps its height).
const before=await where('把发布流程写进文档');
await page.evaluate(()=>{fx.extra.push({id:'999:0',kind:'user',text:'把发布流程写进文档',title:'',call_id:'',timestamp:new Date().toISOString()});return fetchHistory();});
await page.waitForFunction(()=>!document.querySelector('.message.pending'));
const prompt=page.locator('.message.prompt[data-mid="999:0"]');
await prompt.waitFor();
const after=await where('把发布流程写进文档');still(before,after,'hand-off');
assert.equal(await prompt.evaluate(r=>r.classList.contains('fresh')),false,'the transcript copy has no entrance of its own');
await statusLands();
still(before,await where('把发布流程写进文档'),'Herdr still idle after the hand-off');
// A new reply in a poll fades in once; a refresh does not replay anything.
await page.evaluate(()=>{fx.extra.push({id:'999:1',kind:'assistant',text:'写好了。',title:'',call_id:'',timestamp:new Date().toISOString()});return fetchHistory();});
await page.locator('.message[data-mid="999:1"]').waitFor();
assert.equal(await page.locator('.message.fresh').count(),1,'a new reply fades in');
await page.waitForTimeout(400);
await page.evaluate(()=>{S.paused=false;return fetchHistory(false,true);});await page.evaluate(()=>{S.paused=true;});
assert.equal(await page.locator('.message.fresh,.send-in').count(),0,'no replay on a history refresh');
// The other order: Herdr's idle lands first, while the bubble still waits; then the transcript copy.
await holdStatus();
await box.fill('顺手把测试也跑一下');
await page.getByRole('button',{name:'发送消息',exact:true}).click();
await page.locator('.message.pending').filter({hasText:'顺手把测试也跑一下'}).getByText('已送达 Agent',{exact:true}).waitFor();
const before2=await where('顺手把测试也跑一下');
await statusLands();
const idle2=await where('顺手把测试也跑一下');still(before2,idle2,'Herdr still idle before the hand-off');
assert.equal(await page.locator('.message.pending').filter({hasText:'顺手把测试也跑一下'}).count(),1,'still the waiting bubble');
assert.equal(await page.locator('#act').getAttribute('data-kind'),'sent','the line still says it waits for the start');
await page.evaluate(()=>{fx.extra.push({id:'999:2',kind:'user',text:'顺手把测试也跑一下',title:'',call_id:'',timestamp:new Date().toISOString()});return fetchHistory();});
await page.locator('.message.prompt[data-mid="999:2"]').waitFor();
await page.waitForFunction(()=>!document.querySelector('.message.pending'));
still(before2,await where('顺手把测试也跑一下'),'hand-off after Herdr said idle');
assert.equal(await page.locator('.message.prompt[data-mid="999:2"]').evaluate(r=>r.classList.contains('fresh')),false);
console.log('PASS: the transcript copy replaces the bubble seamlessly in either order with Herdr\'s status; only new replies fade in, refreshes are quiet');

// 7. Unconfirmed and refused sends never look delivered; a refused one becomes the queued bubble in place.
await page.evaluate(()=>{fx.promptDelay=200;fx.promptErrors.push('连接超时');fx.A1={...fx.A1,agent_status:'idle'};S.chat.agent={...S.chat.agent,agent_status:'idle'};renderComposer();});
await box.fill('第二条：看一下日志');
await page.getByRole('button',{name:'发送消息',exact:true}).click();
const bad=page.locator('.message.pending').filter({hasText:'第二条'});
await bad.getByText('发送未确认',{exact:true}).waitFor();
assert(await bad.evaluate(r=>r.classList.contains('failed')&&!r.classList.contains('sent')));
await shot('unconfirmed');
await page.evaluate(()=>{S.outbox=[];Q.clear();paintTimeline();fx.promptDelay=400;fx.promptErrors.push('没发出去：Agent 停在一个提问或授权框');});
await box.fill('第三条：先排着');
await page.getByRole('button',{name:'发送消息',exact:true}).click();
await page.locator('.message.pending').filter({hasText:'第三条'}).waitFor();
const pend=await page.evaluate(()=>{window.__p=document.querySelector('.message.pending');return true;});assert(pend);
const queued=page.locator('.message.queued').filter({hasText:'第三条'});
await queued.waitFor();
assert(await page.evaluate(()=>document.querySelector('.message.queued')===window.__p),'refused bubble turns into the queued one in place');
await page.evaluate(()=>{queuePause(Q.get(draftKey()),'先停着',true);paintTimeline();});
await page.waitForTimeout(300);
assert.equal(await page.locator('.send-in').count(),0);
await shot('queued');
console.log('PASS: unconfirmed sends stay marked, refused ones move into the queue in place');

// 8. Queue bubbles: written while busy, they rise in once and never replay.
await page.evaluate(()=>{const q=Q.get(draftKey());q.items.forEach(it=>{it.state='queued';});queuePause(q,'先停着',true);S.chat.agent={...S.chat.agent,agent_status:'working'};renderComposer();paintTimeline();});
await box.fill('第四条：排在后面');
await page.getByRole('button',{name:'发送消息',exact:true}).click();
const q4=page.locator('.message.queued').filter({hasText:'第四条'});
await q4.waitFor();
assert(await q4.evaluate(r=>r.classList.contains('send-in')),'queued bubble rises in');
await page.waitForTimeout(400);
await page.evaluate(()=>{paintTimeline();paintTimeline();});
assert.equal(await page.locator('.send-in').count(),0,'queued bubbles do not replay on repaint');
console.log('PASS: queued bubbles enter once');

// 9. Reduced motion: no entrance, no glide, the state still changes.
await page.emulateMedia({reducedMotion:'reduce'});
await page.evaluate(()=>{Q.clear();S.outbox=[];S.chat.agent={...S.chat.agent,agent_status:'idle'};fx.promptDelay=200;renderComposer();paintTimeline();});
await box.fill('第五条：安静一点');
await page.getByRole('button',{name:'发送消息',exact:true}).click();
const calm=page.locator('.message.pending').filter({hasText:'第五条'});
await calm.waitFor();
assert.deepEqual(await calm.evaluate(r=>[r.classList.contains('send-in'),getComputedStyle(r).animationName]),[false,'none']);
await calm.getByText('已送达 Agent',{exact:true}).waitFor();
assert.equal(await calm.locator('.swap').count(),0,'no label crossfade with reduced motion');
await page.emulateMedia({reducedMotion:'no-preference'});
console.log('PASS: reduced motion turns the motion off');

// 10. Layout: 320 and 390, light and dark, no horizontal overflow in any state.
await page.evaluate(()=>{fx.promptDelay=100000;});
await box.fill('第六条：看看窄屏');await page.getByRole('button',{name:'发送消息',exact:true}).click();
for(const theme of ['light','dark'])for(const w of [320,390]){
 await page.setViewportSize({width:w,height:w===320?640:844});
 await page.evaluate(t=>{document.documentElement.dataset.theme=t;S.stick=true;scrollBottom();},theme);
 const over=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);assert(over<=0,'no horizontal overflow at '+w+' '+theme);
 await shot('send-'+theme+'-'+w);
 await page.evaluate(()=>{HQ.epoch=S.epoch;HQ.state='error';HQ.error='远端读取超时，稍后再试';olderSync();document.getElementById('chat-scroll').scrollTop=0;});
 await shot('top-'+theme+'-'+w);
 await page.evaluate(()=>{HQ.state='loading';olderSync();});await shot('top-loading-'+theme+'-'+w);
 await page.evaluate(()=>{HQ.state='';olderSync();});}
assert.deepEqual(errors,[]);
console.log('PASS: motion states at 320/390 in light and dark');
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
