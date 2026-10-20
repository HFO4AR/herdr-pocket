'use strict';
// Send queue. A message written while the agent is working or waiting for a confirmation, or
// one Herdr provably refused before anything reached the pane ("没发出去：…"), waits here and
// goes out by itself when the agent stops, in order, one at a time.
// Safety:
//  · Only never-attempted items and items refused with a not-sent error are ever sent automatically.
//    Any other failure (timeout, connection lost after the write, unknown error) marks the item
//    "结果未知" and stops the queue; it is never retried.
//  · Each attempt uses a fresh request UUID; pictures are uploaded first (idempotent by hash).
//  · Automatic sending only happens in the foreground, with this agent's chat open, after a fresh
//    read-only follow check confirms the pane still runs the conversation the message was queued
//    for. A changed conversation or an exited agent pauses the queue and says so.
//  · The queue lives in memory for this run (per Herdr session + agent identity). Nothing here is
//    handed to the background watcher: it never sends input.
//  · An agent in a tmux pane (tmux.js) queues the same way: its state comes from its screen
//    (bridge `status` with the pane as target) instead of Herdr's, everything else is shared.
//  · Each item belongs to the computer it was written on (it.dev, several can be connected). It is
//    sent only while that computer is on screen, and the request names it explicitly.
const Q=new Map();// agentKey → {items:[], paused:'', resumable, inflight, retryAt, ackAt}
let qSeq=0;
const QUEUE_SETTLE=15000;// after a send whose start Herdr did not report, wait this long before the next
function queueOf(key,make){let q=Q.get(key);if(!q&&make){q={items:[],paused:'',resumable:true,inflight:false,retryAt:0,ackAt:0,tries:0};Q.set(key,q);}return q;}
function queueItems(key=draftKey()){return Q.get(key)?.items||[];}
function queueTidy(key){const q=Q.get(key);if(q&&!q.items.length&&!q.inflight)Q.delete(key);}
// A prompt can go in now: idle/done, or a parent held by its running sub-agents (kids.js). A new
// message queues only while the agent itself works or waits for the person.
function queueSendable(a){return ['idle','done','kids'].includes(agentState(a));}
function queueWhy(a){const st=agentState(a);return st==='blocked'?(qaPicker(a)?'排好队了，选完就发':'排好队了，处理完确认就发'):st==='working'?'排好队了，它停下就发':'排在前面那条后面';}
// Errors that prove nothing reached the pane (bridge NOT_SENT codes, uploads, and the bridge's own
// status re-check, which runs before the request is recorded).
function queueNotSent(msg){return /^没发出去/.test(msg)||/^Agent is busy or waiting for confirmation/.test(msg);}
// Refusals that clear up on their own once the agent stops; anything else needs a look first.
// The bridge's own screen check ("停在一个提问或选择框上": a dialog Herdr still calls idle) clears up once answered.
// So does Claude still putting an earlier paste into its box ("Pasting…").
function queueTransient(msg){return /停在一个提问或(授权|选择)框|还没准备好|还在处理上一次粘贴|^Agent is busy/.test(msg);}
// New messages queue up while the agent is busy, and behind anything already waiting (order is kept).
function queueWants(a,key){return !!a&&(['working','blocked'].includes(agentState(a))||queueItems(key).length>0);}
function queueAdd(key,a,text,pics,opts={}){
 const q=queueOf(key,true);const qid='q'+(++qSeq);const item={qid,row:opts.row||qid,text,pics,docs:opts.docs||[],at:Date.now(),state:'queued',reason:opts.reason||'',record:S.chat?.record?.id||null,pane:a.pane_id,identity:a.identity,dev:S.demo?'':S.device?.id||''};
 if(opts.front)q.items.unshift(item);else q.items.push(item);return item;}
// The composer's text and pictures move into the queue; the draft is cleared.
function queueCompose(input,key,a,text,pics,docs=[]){
 queueAdd(key,a,text,pics,{docs});queueTakeDraft(input,key,text,pics,docs);
 toast(S.demo?'演示：排好队了，不会真的发':queueWhy(a));
 S.stick=true;paintTimeline();renderComposer();}
// A message the app wrote itself (rename.js): queued the same way, the composer's draft untouched.
function queueOwn(key,a,text){
 const it=queueAdd(key,a,text,[]);
 toast(queueWhy(a));
 S.stick=true;paintTimeline();renderComposer();return it;}
function queueTakeDraft(input,key,text,pics,docs=[]){
 if(S.drafts.get(key)===text)S.drafts.delete(key);if(input&&input.value===text){input.value='';input.style.height='auto';}
 if(pics.length)imgSet(key,imgAttached(key).filter(p=>!pics.includes(p)));
 if(docs.length)fileSet(key,fileAttached(key).filter(f=>!docs.includes(f)));}
// A direct send refused before reaching the pane goes into the queue instead of only a toast.
function queueRejected(key,a,item,text,pics,input,msg,docs=[]){
 S.outbox=S.outbox.filter(o=>o!==item);
 const qi=queueAdd(key,a,text,pics,{front:true,reason:msg,docs,row:item.row});qi.tries=1;queueTakeDraft(input,key,text,pics,docs);
 const q=queueOf(key);if(queueTransient(msg))q.retryAt=Date.now()+5000;else queuePause(q,'上一条没发出去，队列先停下。处理好再点继续',true);
 toast('没发出去，放进队列了'+(queueTransient(msg)?'，它停下就再发':''));
 paintTimeline();renderComposer();setTimeout(()=>refreshStatus(),300);return qi;}
// An unknown outcome of a direct send stops anything queued behind it.
function queueHalt(key){const q=Q.get(key);if(q?.items.length)queuePause(q,'上一条发送结果未知，排队的先不发。看一眼再点继续',true);}
function queuePause(q,reason,resumable){q.paused=reason;q.resumable=resumable;}
function queueDrop(key,qid){
 const q=Q.get(key);if(!q)return;const it=q.items.find(x=>x.qid===qid);if(!it||it.state==='sending'||it.state==='checking')return;
 q.items=q.items.filter(x=>x!==it);if(it.pics.length)rpc('dropImages',{ids:it.pics.map(p=>p.id)}).catch(()=>{});if(it.docs?.length)rpc('dropFiles',{ids:it.docs.map(f=>f.id)}).catch(()=>{});
 if(!q.items.length){q.paused='';q.tries=0;}queueTidy(key);paintTimeline();renderComposer();}
// Back into the composer for editing (only into an empty one, so nothing typed is lost).
function queueEdit(key,qid){
 const q=Q.get(key);const it=q?.items.find(x=>x.qid===qid);if(!it||it.state==='sending'||it.state==='checking')return;
 const input=document.querySelector('#composer textarea');
 if(!input||S.chat?.stale||draftKey()!==key){copyText(it.text);return;}
 if(input.value.trim()||imgAttached(key).length||fileAttached(key).length){toast('输入框里还有草稿，先发出去或清空再改');return;}
 q.items=q.items.filter(x=>x!==it);if(!q.items.length)q.paused='';queueTidy(key);
 if(it.text)S.drafts.set(key,it.text);imgSet(key,it.pics);if(it.docs?.length)fileSet(key,it.docs);renderComposer();paintTimeline();input.focus();}
// "继续" / "现在发": the person has seen the chat; the conversation on screen is the one to send to.
function queueGo(key,now){
 const q=Q.get(key);if(!q)return;
 if(S.chat?.exited||S.chat?.stale){toast('窗格还没确认好，先别发');return;}
 q.paused='';q.tries=0;q.retryAt=0;q.ackAt=Date.now();const rec=S.chat?.record?.id||null;q.items.forEach(x=>{if(x.state==='queued')x.record=rec;});
 paintTimeline();queuePump(now);}

// 「立即发送」: this message goes first. A working (or waiting) agent is interrupted with Esc, then
// the pane must report the same agent stopped before the message is sent, through the normal
// checked send (fresh request id, receipts, unknown outcomes never retried). The queue is held for
// the whole time, so nothing else can slip in or go out twice.
async function queueNow(key,qid){
 const c=S.chat,q=Q.get(key);if(!c?.agent||!q||q.inflight)return;
 const it=q.items.find(x=>x.qid===qid);if(!it||it.state!=='queued')return;
 if(it.dev&&it.dev!==S.device?.id)return;
 if(c.stale||c.exited){toast('窗格还没确认好，先别发');return;}
 if(S.demo){toast('演示：不会真的中断和发送');return;}
 q.items=[it,...q.items.filter(x=>x!==it)];q.paused='';q.tries=0;q.retryAt=0;q.ackAt=Date.now();it.record=c.record?.id||null;it.reason='';
 q.inflight=true;it.state='interrupting';paintTimeline();
 // A parent held by its sub-agents takes the message now (no Esc): Claude queues it itself.
 const busy=()=>!queueSendable(S.chat?.agent);
 let handed=false;
 try{
  if(busy()){
   try{await remote('key',{session:S.session,target:c.agent.pane_id,identity:c.agent.identity,key:'esc',id:uuid(),...(it.dev?{device:it.dev}:{})});}
   catch(e){const msg=e.message||String(e);it.reason=queueNotSent(msg)?msg:'中断没确认：'+msg;queuePause(q,'没能中断它，消息先没发。看一眼再点继续',true);return;}
   // Wait for Herdr (or the tmux pane's screen) to report the same agent stopped (polled, not guessed).
   const until=Date.now()+20000;
   while(Date.now()<until){
    await new Promise(r=>setTimeout(r,1000));if(S.chat!==c)break;
    try{const cur=await queueStatusNow(c);
     if(!cur||cur.identity!==c.agent.identity){c.stale=true;break;}
     S.agents=S.agents.map(a=>a.pane_id===cur.pane_id?{...a,agent_status:cur.agent_status}:a);
     if(cur.agent_status!==c.agent.agent_status){const was=c.agent.agent_status;c.agent={...c.agent,agent_status:cur.agent_status};noteStatus([c.agent]);onAgentStatus(was,cur.agent_status);}
     if(queueSendable(cur))break;}
    catch(_){}}
   if(S.chat!==c||c.stale||busy()){it.reason=c.stale?'窗格里的 Agent 变了，没发':'中断后它还没停下，消息没发。可以再点一次立即发送';return;}
  }
  it.state='queued';q.inflight=false;c.sentAt=0;handed=true;
  await queueRun(c,key,q,true);
 }
 finally{if(it.state==='interrupting')it.state='queued';if(!handed)q.inflight=false;queueTidy(key);paintTimeline();renderComposer();}}
// Waiting on a question or a confirmation, 立即发送 means Esc on that dialog first: say what that
// does there (answer.js qaEscText) and go only after a yes. Working or idle: as before.
function queueNowAsk(key,qid){
 const a=S.chat?.agent;if(a?.agent_status!=='blocked'||S.demo)return queueNow(key,qid);
 const menu=qaFresh(a);confirmAction(menu?.picker?'先关掉它的选择框？':'先取消它在等的'+(menu?.kind==='approval'?'确认':'问题')+'？',(menu?qaEscText(menu,a):'会按 Esc 取消它正在等的确认框。')+'然后发这条消息。','按 Esc 再发',()=>queueNow(key,qid),true);}
// Why the head of the queue cannot go now ('' = it can). Pauses that need a person are set here.
function queueBlock(c,key,q,force){
 const head=q.items[0];if(!head)return 'empty';
 if(head.state==='unknown'){if(!q.paused)queuePause(q,'上一条发送结果未知，没有自动重发',true);return 'paused';}
 if(head.state!=='queued')return 'busy';
 if(c.exited){queuePause(q,providerName(c.agent.agent)+' 已退出，排队的消息不会再发',false);return 'paused';}
 if(c.stale||c.following||c.unsure)return 'hold';
 // The last slash command left a panel or picker open (slash.js): wait until it is closed.
 if(slashPanelOpen(key)){
  // A panel that is gone from the screen must not hold the queue forever: re-read it now and then.
  const card=slashPanelCard(key);if(card&&!card.capturing&&Date.now()-(card.readAt||0)>3000)slashCapture(card,{quick:true});
  return 'hold';}
 const switched=c.switched&&c.switched.at>Math.max(head.at,q.ackAt);
 if(switched||(head.record&&c.record&&head.record!==c.record.id)){queuePause(q,'窗格里换了一段对话，排队的先不发。看一眼再点继续',true);return 'paused';}
 if(c.switched&&Date.now()-c.switched.at<FOLLOW_SETTLE)return 'hold';
 if(!force&&q.paused)return 'paused';
 if(!queueSendable(c.agent))return 'busy';
 if(S.outbox.some(o=>o.key===key&&o.state==='sending'))return 'busy';
 if(force)return '';
 if(q.retryAt>Date.now())return 'wait';
 // The last message must have been taken up: Herdr saw it working after the send and stopped since,
 // or the transcript already shows it and a while has passed.
 const mine=S.outbox.filter(o=>o.key===key);
 const last=Math.max(c.sentAt||0,...mine.map(o=>o.at)),rec=S.since.get(key),seen=mine.some(o=>o.state==='sent');
 const ran=rec&&rec.at>last&&rec.prev==='working'&&['idle','done'].includes(rec.status);
 // Never wait on the transcript forever: pictures, slash commands or an interrupt can keep the text
 // from matching. Herdr reporting the agent stopped well after the send is enough.
 if(last&&!ran&&Date.now()-last<QUEUE_SETTLE)return 'wait';
 return '';}
function queuePump(force){
 const c=S.chat;if(!c?.agent||S.demo||!S.active||!S.device)return;if(typeof T!=='undefined'&&T.view)return;
 const key=draftKey(),q=Q.get(key);if(!q||q.inflight||!q.items.length)return;
 const was=q.paused,prev=q.why,why=queueBlock(c,key,q,force);q.why=why;if(q.paused!==was||prev!==why)paintTimeline();
 if(why){if(force&&why!=='paused')toast(why==='hold'?'窗格还在确认，稍后再发':why==='busy'?'它还没停下，停下后自动发':'稍等一下再发');return;}
 queueRun(c,key,q,force);}
// The open agent's row right now: Herdr's status, or the tmux pane's (tmux.js). Read-only.
async function queueStatusNow(c){if(c.agent.tmux)return tmuxStatusOne(c.agent);const r=await remote('status',{session:S.session});return r.agents.find(a=>a.pane_id===c.agent.pane_id);}
// Read-only re-check of the pane right before sending. The latest status poll must show the same
// agent, stopped; the conversation itself is confirmed by a follow check (follow.js). A follow check
// that confirmed it moments ago is reused: on a remote (ch) pane each one takes seconds, and racing
// the follow poll for it used to keep a message queued indefinitely.
// A tmux chat's own agent is the newest copy (its pane is read on every status beat).
function queueStatusOk(c){const cur=c.agent.tmux?c.agent:S.agents.find(x=>x.pane_id===c.agent.pane_id);return S.chat===c&&!!cur&&cur.identity===c.agent.identity&&queueSendable(cur)&&!c.stale&&!c.exited&&!c.following&&!c.unsure&&!c.followPending;}
async function queueVerify(c,force){
 if(!FOLLOW.supported)return queueStatusOk(c);
 for(let i=0;FOLLOW.busy&&i<120;i++)await new Promise(r=>setTimeout(r,250));
 if(S.chat!==c)return false;
 if(FOLLOW.okAt&&Date.now()-FOLLOW.okAt<(followRemote(c)?30000:12000))return queueStatusOk(c);
 if(FOLLOW.busy)return !!force&&queueStatusOk(c);
 FOLLOW.busy=true;FOLLOW.last=Date.now();
 try{const r=await remote('agents',{session:S.session,target:c.agent.pane_id,identity:c.agent.identity});if(S.chat!==c)return false;
  if(!r||!r.follow){FOLLOW.supported=false;return queueStatusOk(c);}
  const before=c.record?.id;followApply(c,r);const a=r.agents?.[0];
  const ok=S.chat===c&&!!a&&a.identity===c.agent.identity&&!c.stale&&!c.following&&!c.unsure&&!c.exited&&!c.followPending&&c.record?.id===before&&(!a.agent_status||queueSendable(a));
  if(ok)FOLLOW.okAt=Date.now();return ok;}
 // A slow or failed check: "现在发" (the person is looking at this chat) settles for the status check.
 catch(_){return !!force&&queueStatusOk(c);}
 finally{FOLLOW.busy=false;}}
async function queueRun(c,key,q,force){
 const it=q.items[0];q.inflight=true;it.state='checking';it.stage='';paintTimeline();
 let ok=false;try{ok=await queueVerify(c,force);}finally{if(!ok){it.state='queued';q.inflight=false;q.retryAt=Date.now()+3000;q.checkFails=(q.checkFails||0)+1;paintTimeline();if(force)toast('没能确认窗格状态，先没发。等它停下再试');}}
 q.checkFails=0;
 if(!ok)return;
 const a=c.agent;
 if(S.chat!==c||!S.active||draftKey()!==key||it.identity!==a.identity||it.dev&&it.dev!==S.device?.id){it.state='queued';q.inflight=false;paintTimeline();return;}
 it.state='sending';paintTimeline();
 try{
  const images=it.pics.length?await imgUpload(it.pics,stage=>{it.stage=stage;paintTimeline();}):null;
  const files=it.docs?.length?await fileUpload(it.docs,a,stage=>{it.stage=stage;paintTimeline();}):null;it.stage='';
  // Never to another computer: if the screen moved on meanwhile, it stays queued (nothing was sent).
  if(it.dev&&it.dev!==S.device?.id){it.state='queued';return;}
  // A fresh request id for every attempt; the bridge refuses a reused one.
  const sent=await remote('prompt',{session:S.session,target:a.pane_id,identity:a.identity,...(it.dev?{device:it.dev}:{}),text:!it.pics.length&&!it.docs?.length&&slashIs(it.text,a)?it.text.trim():it.text,id:uuid(),...(images?{images,remote:!!a.history_ref?.remote}:{}),...(files?{files,remote:!!a.history_ref?.remote}:{})});
  it.state='sent';q.items=q.items.filter(x=>x!==it);q.tries=0;q.retryAt=0;if(sentNote(sent))toast(sentNote(sent));
  const card=!it.pics.length&&!it.docs?.length&&slashIs(it.text,a)?slashCard(key,it.text):null;
  if(card)card.state='sent';else S.outbox.push({key,text:it.text,images:it.pics.map(p=>({url:p.thumb})),files:(it.docs||[]).map(f=>({file:f.name,size:f.size})),at:Date.now(),state:'sent',qid:it.qid,row:it.row});
  if(it.pics.length)rpc('dropImages',{ids:it.pics.map(p=>p.id)}).catch(()=>{});if(it.docs?.length)rpc('dropFiles',{ids:it.docs.map(f=>f.id)}).catch(()=>{});
  if(S.chat===c){c.sentAt=Date.now();c.doneAt=0;if(!card)c.agent={...c.agent,agent_status:'working'};renderComposer();updateChatMeta();}
  S.stick=true;paintTimeline();if(card)slashCapture(card);setTimeout(()=>{if(S.chat===c)fetchHistory();},900);}
 catch(e){const msg=e.message||String(e);it.stage='';
  if(queueNotSent(msg)){it.state='queued';it.reason=msg;it.tries=(it.tries||0)+1;q.tries++;
   if(queueTransient(msg)&&q.tries<3)q.retryAt=Date.now()+6000;
   else queuePause(q,queueTransient(msg)?'连着几次没发出去，先停一下。看一眼再点继续':'上一条没发出去，队列先停下。处理好再点继续',true);
   setTimeout(()=>refreshStatus(),300);}
  else{it.state='unknown';it.reason=msg;queuePause(q,'上一条发送结果未知，没有自动重发',true);}}
 finally{q.inflight=false;queueTidy(key);paintTimeline();renderComposer();
  // Its bubble (with the reason) and the paused queue bar say it in this chat; elsewhere a toast does.
  if(it.state==='unknown'&&(S.chat!==c||!document.querySelector('.queue-bar')))toast('发送未确认：'+it.reason+'。不会自动重发，队列先停下。');}}

// ─── Views ──────────────────────────────────────────────────────────────────
function queueLabel(c,q,it,i){
 if(it.state==='interrupting')return '正在中断当前工作…';
 if(it.state==='checking')return '排队中 · 正在确认窗格…';
 if(it.state==='sending')return it.stage||'发送中…';
 if(it.state==='unknown')return '结果未知 · 不会自动重发';
 if(c?.exited)return '不会再发';
 if(i>0)return '排队中 · 第 '+(i+1)+' 条';
 if(q.paused)return '排队中 · 已暂停';
 if(q.checkFails>=2)return '排队中 · 窗格确认有点慢，可以点「立即发送」';
 if(q.why==='wait')return '排队中 · 等上一条被接收';
 if(q.why==='hold')return '排队中 · 正在确认窗格';
 const st=agentState(c?.agent);return st==='kids'?'排队中 · 马上发':st==='blocked'?(qaPicker(c.agent)?'排队中 · 选完再发':'排队中 · 处理完确认再发'):st==='working'?'排队中 · 等它停下再发':'排队中 · 马上发';}
function queueTimeline(list){
 const key=draftKey(),q=Q.get(key);if(!q?.items.length)return;const c=S.chat;
 // The section and its rows are kept across repaints (timeline.js tlSendRow): a waiting message
 // enters once, and its row is the same node that later shows it sent.
 let box=TL_KEEP.queueBox;if(!box){box=el('section','queue');box.setAttribute('aria-label','排队的消息');TL_KEEP.queueBox=box;}
 const kids=[];
 if(q.paused&&q.items[0].state==='queued'){let bar=box.querySelector(':scope>.queue-bar');const sig=q.paused+'|'+(q.resumable&&!c?.exited?1:0);
  if(!bar||bar.dataset.sig!==sig){bar=el('div','queue-bar');bar.dataset.sig=sig;bar.setAttribute('role','status');bar.append(icon('pause'));bar.append(el('span','grow',q.paused));
   if(q.resumable&&!c?.exited)bar.append(btn('继续','queue-go',()=>queueGo(key,true)));}
  kids.push(bar);}
 const live=!!(c?.agent&&!c.stale&&!c.exited);
 q.items.forEach((it,i)=>{
  const busy=it.state==='checking'||it.state==='sending'||it.state==='interrupting',ready=queueSendable(c?.agent);
  const can=it.state==='queued'||it.state==='unknown',now=it.state==='queued'&&live&&!q.inflight;
  kids.push(tlSendRow(it.row||it.qid,{cls:'queued'+(it.state==='unknown'?' unknown':busy?' busy':''),label:queueLabel(c,q,it,i),spin:busy,text:it.text,
   images:it.pics.map(p=>({url:p.thumb})),files:(it.docs||[]).map(f=>({file:f.name,size:f.size})),at:it.at,
   reason:it.reason&&it.state!=='sending'?(it.state==='unknown'?it.reason:'上次'+it.reason):'',
   acts:can?{sig:[it.state,live?1:0,now?1:0,now&&ready?1:0].join('|'),build:()=>{const acts=el('div','queue-actions');
    acts.append(btn('删掉','',()=>queueDrop(key,it.qid)));acts.append(btn(live?'修改':'复制','',()=>queueEdit(key,it.qid)));
    // 立即发送: interrupts a busy agent first (see queueNow); an idle one (or a parent held by
    // its sub-agents) just gets it now.
    if(now){const b=btn('立即发送','now',()=>queueNowAsk(key,it.qid));b.title=ready?'现在就发':c?.agent?.agent_status==='blocked'?'先按 Esc 取消它在等的问题，再发这条':'先中断它正在做的事，再发这条';acts.append(b);}
    return acts;}}:null}));});
 // Patch in place: rows that stay are never detached.
 const want=new Set(kids);[...box.childNodes].forEach(n=>{if(!want.has(n))n.remove();});
 kids.forEach((n,i)=>{const at=box.childNodes[i];if(at!==n)box.insertBefore(n,at||null);});
 list.append(box);}
// "排队 2" in the agent list.
function queueBadge(meta,a){const n=queueItems(agentKey(a)).length;if(!n)return;const b=el('span','sep queue-count','排队 '+n);b.title='回到对话后，它停下就依次发';meta.append(b);}
// follow.js: the same conversation under a new identity keeps its queue; a different
// conversation keeps it too but paused, so nothing goes there unseen.
function queueRekey(from,how){
 const to=draftKey();
 if(from!==to&&Q.has(from)){const q=Q.get(from);Q.delete(from);
  const a=S.chat?.agent;if(a)q.items.forEach(x=>{x.identity=a.identity;x.pane=a.pane_id;});
  const into=Q.get(to);if(into){into.items.push(...q.items);if(q.paused&&!into.paused)queuePause(into,q.paused,q.resumable);}else Q.set(to,q);}
 const q=Q.get(to);if(how==='switch'&&q?.items.length)queuePause(q,'窗格里换了一段对话，排队的先不发。看一眼再点继续',true);}
function queueClear(){for(const q of Q.values())q.items.forEach(it=>{if(it.pics.length)rpc('dropImages',{ids:it.pics.map(p=>p.id)}).catch(()=>{});if(it.docs?.length)rpc('dropFiles',{ids:it.docs.map(f=>f.id)}).catch(()=>{});});Q.clear();}
setInterval(()=>queuePump(),2500);
