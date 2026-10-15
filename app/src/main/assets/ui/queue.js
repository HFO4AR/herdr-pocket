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
const Q=new Map();// agentKey → {items:[], paused:'', resumable, inflight, retryAt, ackAt}
let qSeq=0;
const QUEUE_SETTLE=15000;// after a send whose start Herdr did not report, wait this long before the next
function queueOf(key,make){let q=Q.get(key);if(!q&&make){q={items:[],paused:'',resumable:true,inflight:false,retryAt:0,ackAt:0,tries:0};Q.set(key,q);}return q;}
function queueItems(key=draftKey()){return Q.get(key)?.items||[];}
function queueTidy(key){const q=Q.get(key);if(q&&!q.items.length&&!q.inflight)Q.delete(key);}
// Errors that prove nothing reached the pane (bridge NOT_SENT codes, uploads, and the bridge's own
// status re-check, which runs before the request is recorded).
function queueNotSent(msg){return /^没发出去/.test(msg)||/^Agent is busy or waiting for confirmation/.test(msg);}
// Refusals that clear up on their own once the agent stops; anything else needs a look first.
function queueTransient(msg){return /停在一个提问或授权框|还没准备好|^Agent is busy/.test(msg);}
// New messages queue up while the agent is busy, and behind anything already waiting (order is kept).
function queueWants(a,key){return !!a&&(['working','blocked'].includes(a.agent_status)||queueItems(key).length>0);}
function queueAdd(key,a,text,pics,opts={}){
 const q=queueOf(key,true);const item={qid:'q'+(++qSeq),text,pics,docs:opts.docs||[],at:Date.now(),state:'queued',reason:opts.reason||'',record:S.chat?.record?.id||null,pane:a.pane_id,identity:a.identity};
 if(opts.front)q.items.unshift(item);else q.items.push(item);return item;}
// The composer's text and pictures move into the queue; the draft is cleared.
function queueCompose(input,key,a,text,pics,docs=[]){
 queueAdd(key,a,text,pics,{docs});queueTakeDraft(input,key,text,pics,docs);
 toast(S.demo?'演示：排好队了，不会真的发':a.agent_status==='blocked'?'排好队了，处理完确认就发':a.agent_status==='working'?'排好队了，它停下就发':'排在前面那条后面');
 S.stick=true;paintTimeline();renderComposer();}
function queueTakeDraft(input,key,text,pics,docs=[]){
 if(S.drafts.get(key)===text)S.drafts.delete(key);if(input&&input.value===text){input.value='';input.style.height='auto';}
 if(pics.length)imgSet(key,imgAttached(key).filter(p=>!pics.includes(p)));
 if(docs.length)fileSet(key,fileAttached(key).filter(f=>!docs.includes(f)));}
// A direct send refused before reaching the pane goes into the queue instead of only a toast.
function queueRejected(key,a,item,text,pics,input,msg,docs=[]){
 S.outbox=S.outbox.filter(o=>o!==item);
 const qi=queueAdd(key,a,text,pics,{front:true,reason:msg,docs});qi.tries=1;queueTakeDraft(input,key,text,pics,docs);
 const q=queueOf(key);if(queueTransient(msg))q.retryAt=Date.now()+5000;else queuePause(q,'上一条没发出去，队列先停下。处理好再点继续',true);
 toast('没发出去，放进队列了'+(queueTransient(msg)?'，它停下就再发':''));
 paintTimeline();renderComposer();setTimeout(()=>refreshStatus(),300);return true;}
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

// Why the head of the queue cannot go now ('' = it can). Pauses that need a person are set here.
function queueBlock(c,key,q,force){
 const head=q.items[0];if(!head)return 'empty';
 if(head.state==='unknown'){if(!q.paused)queuePause(q,'上一条发送结果未知，没有自动重发',true);return 'paused';}
 if(head.state!=='queued')return 'busy';
 if(c.exited){queuePause(q,providerName(c.agent.agent)+' 已退出，排队的消息不会再发',false);return 'paused';}
 if(c.stale||c.following||c.unsure)return 'hold';
 // The last slash command left a panel or picker open (slash.js): wait until it is closed.
 if(slashPanelOpen(key))return 'hold';
 const switched=c.switched&&c.switched.at>Math.max(head.at,q.ackAt);
 if(switched||(head.record&&c.record&&head.record!==c.record.id)){queuePause(q,'窗格里换了一段对话，排队的先不发。看一眼再点继续',true);return 'paused';}
 if(c.switched&&Date.now()-c.switched.at<FOLLOW_SETTLE)return 'hold';
 if(!force&&q.paused)return 'paused';
 if(!['idle','done'].includes(c.agent.agent_status))return 'busy';
 if(S.outbox.some(o=>o.key===key&&o.state==='sending'))return 'busy';
 if(force)return '';
 if(q.retryAt>Date.now())return 'wait';
 // The last message must have been taken up: Herdr saw it working after the send and stopped since,
 // or the transcript already shows it and a while has passed.
 const mine=S.outbox.filter(o=>o.key===key);
 const last=Math.max(c.sentAt||0,...mine.map(o=>o.at)),rec=S.since.get(key),seen=mine.some(o=>o.state==='sent');
 const ran=rec&&rec.at>last&&rec.prev==='working'&&['idle','done'].includes(rec.status);
 if(last||seen){if(!ran&&(seen||Date.now()-last<QUEUE_SETTLE))return 'wait';}
 return '';}
function queuePump(force){
 const c=S.chat;if(!c?.agent||S.demo||!S.active||!S.device)return;if(typeof T!=='undefined'&&T.view)return;
 const key=draftKey(),q=Q.get(key);if(!q||q.inflight||!q.items.length)return;
 const was=q.paused,why=queueBlock(c,key,q,force);if(q.paused!==was)paintTimeline();
 if(why){if(force&&why!=='paused')toast(why==='hold'?'窗格还在确认，稍后再发':why==='busy'?'它还没停下，停下后自动发':'稍等一下再发');return;}
 queueRun(c,key,q);}
// Read-only re-check of the pane (follow.js) right before sending.
async function queueVerify(c){
 if(!FOLLOW.supported){const cur=S.agents.find(x=>x.pane_id===c.agent.pane_id);return !!cur&&cur.identity===c.agent.identity&&['idle','done'].includes(cur.agent_status);}
 if(FOLLOW.busy)return false;FOLLOW.busy=true;FOLLOW.last=Date.now();
 try{const r=await remote('agents',{session:S.session,target:c.agent.pane_id,identity:c.agent.identity});if(S.chat!==c)return false;
  if(!r||!r.follow){FOLLOW.supported=false;return false;}
  const before=c.record?.id;followApply(c,r);const a=r.agents?.[0];
  return S.chat===c&&!!a&&a.identity===c.agent.identity&&!c.stale&&!c.following&&!c.unsure&&!c.exited&&!c.followPending&&c.record?.id===before&&(!a.agent_status||['idle','done'].includes(a.agent_status));}
 catch(_){return false;}
 finally{FOLLOW.busy=false;}}
async function queueRun(c,key,q){
 const it=q.items[0];q.inflight=true;it.state='checking';it.stage='';paintTimeline();
 let ok=false;try{ok=await queueVerify(c);}finally{if(!ok){it.state='queued';q.inflight=false;q.retryAt=Date.now()+3000;paintTimeline();}}
 if(!ok)return;
 const a=c.agent;
 if(S.chat!==c||!S.active||draftKey()!==key||it.identity!==a.identity){it.state='queued';q.inflight=false;paintTimeline();return;}
 it.state='sending';paintTimeline();
 try{
  const images=it.pics.length?await imgUpload(it.pics,stage=>{it.stage=stage;paintTimeline();}):null;
  const files=it.docs?.length?await fileUpload(it.docs,a,stage=>{it.stage=stage;paintTimeline();}):null;it.stage='';
  // A fresh request id for every attempt; the bridge refuses a reused one.
  await remote('prompt',{session:S.session,target:a.pane_id,identity:a.identity,text:!it.pics.length&&!it.docs?.length&&slashIs(it.text,a)?it.text.trim():it.text,id:uuid(),...(images?{images,remote:!!a.history_ref?.remote}:{}),...(files?{files,remote:!!a.history_ref?.remote}:{})});
  q.items=q.items.filter(x=>x!==it);q.tries=0;q.retryAt=0;
  const card=!it.pics.length&&!it.docs?.length&&slashIs(it.text,a)?slashCard(key,it.text):null;
  if(card)card.state='sent';else S.outbox.push({key,text:it.text,images:it.pics.map(p=>({url:p.thumb})),files:(it.docs||[]).map(f=>({file:f.name,size:f.size})),at:Date.now(),state:'sent',qid:it.qid});
  if(it.pics.length)rpc('dropImages',{ids:it.pics.map(p=>p.id)}).catch(()=>{});if(it.docs?.length)rpc('dropFiles',{ids:it.docs.map(f=>f.id)}).catch(()=>{});
  if(S.chat===c){c.sentAt=Date.now();c.doneAt=0;if(!card)c.agent={...c.agent,agent_status:'working'};renderComposer();updateChatMeta();}
  S.stick=true;paintTimeline();if(card)slashCapture(card);setTimeout(()=>{if(S.chat===c)fetchHistory();},900);}
 catch(e){const msg=e.message||String(e);it.stage='';
  if(queueNotSent(msg)){it.state='queued';it.reason=msg;it.tries=(it.tries||0)+1;q.tries++;
   if(queueTransient(msg)&&q.tries<3)q.retryAt=Date.now()+6000;
   else queuePause(q,queueTransient(msg)?'连着几次没发出去，先停一下。看一眼再点继续':'上一条没发出去，队列先停下。处理好再点继续',true);
   setTimeout(()=>refreshStatus(),300);}
  else{it.state='unknown';it.reason=msg;queuePause(q,'上一条发送结果未知，没有自动重发',true);toast('发送未确认：'+msg+'。不会自动重发，队列先停下。');}}
 finally{q.inflight=false;queueTidy(key);paintTimeline();renderComposer();}}

// ─── Views ──────────────────────────────────────────────────────────────────
function queueLabel(c,q,it,i){
 if(it.state==='checking')return '排队中 · 正在确认窗格…';
 if(it.state==='sending')return it.stage||'发送中…';
 if(it.state==='unknown')return '结果未知 · 不会自动重发';
 if(c?.exited)return '不会再发';
 if(i>0)return '排队中 · 第 '+(i+1)+' 条';
 if(q.paused)return '排队中 · 已暂停';
 const st=c?.agent?.agent_status;return st==='blocked'?'排队中 · 处理完确认再发':st==='working'?'排队中 · 等它停下再发':'排队中 · 马上发';}
function queueTimeline(list){
 const key=draftKey(),q=Q.get(key);if(!q?.items.length)return;const c=S.chat;
 const box=el('section','queue');box.setAttribute('aria-label','排队的消息');
 if(q.paused&&q.items[0].state==='queued'){const bar=el('div','queue-bar');bar.setAttribute('role','status');bar.append(icon('pause'));bar.append(el('span','grow',q.paused));
  if(q.resumable&&!c?.exited)bar.append(btn('继续','queue-go',()=>queueGo(key,true)));box.append(bar);}
 q.items.forEach((it,i)=>{
  const row=el('article','message user queued'+(it.state==='unknown'?' unknown':''));row.dataset.qid=it.qid;
  const meta=el('div','message-label');if(it.state==='checking'||it.state==='sending')meta.append(el('span','spinner mini'));meta.append(el('span','',queueLabel(c,q,it,i)));row.append(meta);
  if(it.text.trim()){const b=el('div','bubble');b.append(userText(it.text));row.append(b);}
  if(it.pics.length)row.append(imgStrip(it.pics.map(p=>({url:p.thumb}))));
  if(it.docs?.length)row.append(fileList(it.docs.map(f=>({file:f.name,size:f.size}))));
  if(it.reason&&it.state!=='sending')row.append(el('p','queue-reason',it.state==='unknown'?it.reason:'上次'+it.reason));
  if(it.state==='queued'||it.state==='unknown'){const acts=el('div','queue-actions');
   acts.append(btn('删掉','',()=>queueDrop(key,it.qid)));
   const live=c?.agent&&!c.stale&&!c.exited;acts.append(btn(live?'修改':'复制','',()=>queueEdit(key,it.qid)));
   if(i===0&&it.state==='queued'&&live&&['idle','done'].includes(c.agent.agent_status)&&!q.inflight)acts.append(btn('现在发','now',()=>queueGo(key,true)));
   row.append(acts);}
  box.append(row);});
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
