'use strict';
// The chat footer as one panel with one hierarchy (design QA): instead of every module stacking its
// own full-width row above the input, the footer shows
//   · one thin line, the rail (#foot-rail): the most important one-line state, expanded with its
//     action, and everything else as compact chips (「排队 2」「执行中 2:05」「计划模式」, tap to open),
//   · at most one block (#live-state: the question / approval card, or the slash list),
//   · the composer, which stays on screen in every state and size. Only the question card may take
//     its place on a short screen (landscape, keyboard open); the card then offers 「写消息」, which
//     folds it into the rail so the input comes back.
// Priority, highest first: question / approval > slash list > queue > working > mode.
// Loaded after mode.js and before app.js: declarations, listeners and one timer only.
const FOOT={pin:'',write:'',primary:'',el:null};
const FOOT_MODE={permission:{default:'手动确认',acceptEdits:'自动编辑',plan:'计划模式',auto:'自动模式',bypassPermissions:'跳过确认',dontAsk:'不询问'},collaboration:{default:'默认模式',plan:'计划模式'}};
function footShort(){return innerHeight<=560;}
// The person is writing while a question waits: the card folds into the rail (per wait).
function footWriting(a){return !!a&&!!FOOT.write&&FOOT.write===qaWaitKey(a);}
function footWrite(){const a=S.chat?.agent;if(!a)return;FOOT.write=qaWaitKey(a);renderComposer();
 requestAnimationFrame(()=>{const t=document.querySelector('#composer textarea');if(t&&document.activeElement!==t)t.focus();});}
function footUnwrite(){FOOT.write='';renderComposer();}
// Compact mode chip: the main mode in a few characters, in its own hue; null while still unknown.
function footModeItem(a){
 if(!modeAgent(a)||S.chat?.stale)return null;const m=modeOf(a);const chips=modeChips(m);if(!chips.length&&!m?.known)return null;
 const f=a.agent==='claude'?'permission':'collaboration',tone=(a.agent==='claude'?MODE_PERM:MODE_COLLAB)[m?.[f]]?.[1]||'';
 return {text:FOOT_MODE[f][m?.[f]]||chips[0]?.[0]||'模式',tone};}
function footQueueText(a,key){
 const q=Q.get(key),head=q?.items[0];if(!head)return '';
 if(head.state==='unknown')return '结果未知';if(head.state==='sending'||head.state==='checking')return '发送中…';if(head.state==='interrupting')return '正在中断…';
 if(S.chat?.exited)return '不会再发';if(q.paused)return '已暂停';
 return a.agent_status==='blocked'?'确认完再发':a.agent_status==='working'?'它停下就发':'马上发';}
function footQueueShow(){const box=document.querySelector('#chat-scroll .queue');if(!box)return;S.stick=false;
 box.scrollIntoView({block:'nearest',behavior:tlCalm()?'auto':'smooth'});if(typeof updateJump==='function')updateJump();}

// Repaints the rail and marks which part of the footer leads. Cheap when nothing changed.
function footPaint(footer,a){
 const live=footer.querySelector('#live-state');if(!live||!a)return;
 if(FOOT.el!==footer){FOOT.el=footer;FOOT.primary='';FOOT.pin='';}
 let rail=footer.querySelector(':scope>#foot-rail');
 if(!rail){rail=el('div','foot-rail');rail.id='foot-rail';rail.setAttribute('role','group');rail.setAttribute('aria-label','对话状态');footer.prepend(rail);}
 modeBar(rail,a);const bar=rail.querySelector('#mode-bar');
 const key=draftKey(),st=a.agent_status,blocked=st==='blocked';
 const ask=live.querySelector('.qa-card,.confirm-panel'),mini=live.querySelector('.qa-mini');
 const slash=footer.querySelector('.slash-pop');
 // The slash list opening under a card means the person is writing: fold the card.
 if(ask&&slash&&!footWriting(a))FOOT.write=qaWaitKey(a);
 const writing=!!ask&&footWriting(a);if(!ask&&FOOT.write&&!footWriting(a))FOOT.write='';
 const block=ask&&!writing?'ask':mini?'ask':slash?'slash':'';
 const done=!!S.chat.doneAt&&Date.now()-S.chat.doneAt<8000;
 // Connecting with a cached chat: nothing live to show (the composer says so).
 const items=[],offline=!S.device&&!S.demo;
 if(!offline){if(writing)items.push('ask');
  if(queueItems(key).length&&!S.chat.stale)items.push('queue');
  if(st==='working')items.push('work');else if(done&&!blocked)items.push('done');}
 // The mode never earns a line under the slash list by itself; it is not switchable while blocked.
 const mode=!blocked&&!offline&&footModeItem(a);if(mode&&(items.length||block!=='slash'))items.push('mode');
 if(FOOT.pin&&!items.includes(FOOT.pin))FOOT.pin='';
 const lead=block?'':items.includes(FOOT.pin)?FOOT.pin:items[0]||'';
 const chips=items.filter(x=>x!==lead);
 // What the rail shows; rebuilt only when this changes (the timers inside tick on their own).
 const q=Q.get(key);const sig=JSON.stringify([lead,chips,lead==='mode'?'':mode,items.includes('queue')?[q.items.length,footQueueText(a,key)]:0,
  st,lead==='work'?[!!S.chat.interruptAt&&Date.now()-S.chat.interruptAt<4000,statusSince(a)||S.chat.sentAt||0]:0,done?[S.chat.took,S.stick]:0,writing?ask.className:'']);
 if(bar)bar.classList.toggle('hidden',lead!=='mode');
 if(rail.dataset.sig!==sig){rail.dataset.sig=sig;
  rail.querySelectorAll(':scope>:not(#mode-bar)').forEach(n=>n.remove());
  if(lead&&lead!=='mode')rail.append(footLead(lead,a,key,ask));
  if(chips.length){const box=el('div','foot-chips');chips.forEach(c=>box.append(footChip(c,a,key,mode,ask)));rail.append(box);}
  if(lead==='work')rail.append(interruptButton(a));}
 rail.classList.toggle('hidden',!lead&&!chips.length);
 rail.classList.toggle('compact',!lead);
 footer.classList.toggle('writing',writing);footer.classList.toggle('asking',!!ask&&!writing);
 const primary=block||lead||'none';footer.dataset.primary=primary;
 // A light swap when what leads changes from one thing to another (not on repaints of the same state,
 // nor when the footer first fills in, e.g. once the mode has been read).
 if(FOOT.primary&&FOOT.primary!=='none'&&primary!=='none'&&FOOT.primary!==primary&&!tlCalm()){const n=block==='ask'?live:block==='slash'?slash:rail;n.classList.remove('foot-swap');void n.offsetWidth;n.classList.add('foot-swap');}
 FOOT.primary=primary;}
function footRefresh(){const f=document.getElementById('composer'),a=S.chat?.agent;if(f&&a&&!S.chat.stale)footPaint(f,a);}

// The expanded line: what leads, in words, with its one action.
function footLead(kind,a,key,ask){
 if(kind==='work'){const n=el('div','foot-lead t-work');n.setAttribute('role','status');n.append(el('span','pulse'));
  const t=el('strong','','执行中');const at=statusSince(a)||S.chat.sentAt;if(at)t.append(' ',since(at));
  const line=el('span','foot-detail mono',S.activity||'正在读取终端…');line.id='activity-line';n.append(t,line);return n;}
 if(kind==='done'){const n=el('div','foot-lead t-done');n.setAttribute('role','status');n.append(icon('check'),el('strong','','做完了'));
  if(S.chat.took>=5000)n.append(el('span','foot-detail','用时 '+dur(S.chat.took)));
  if(!S.stick)n.append(btn('看结果','link-btn',()=>{S.stick=true;S.unseen=0;scrollBottom();updateJump();footRefresh();}));return n;}
 if(kind==='queue'){const n=btn('','foot-lead t-queue',footQueueShow,'history');n.setAttribute('aria-label','排队的消息：'+queueItems(key).length+' 条，'+footQueueText(a,key));
  n.append(el('strong','','排队 '+queueItems(key).length+' 条'),el('span','foot-detail',footQueueText(a,key)));return n;}
 // ask: the folded question card, and the way back to it.
 const approval=ask.classList.contains('approval')||ask.classList.contains('confirm-panel');
 const n=btn('','foot-lead t-ask'+(approval?' approval':''),footUnwrite,approval?'alert':'chat');n.setAttribute('aria-label','展开问题');
 n.append(el('strong','',providerName(a.agent)+(approval?' 等你确认':' 在问你')),el('span','foot-detail','展开'));return n;}
// A compact chip; tapping it opens what it stands for.
function footChip(kind,a,key,mode,ask){
 let c;
 if(kind==='work'){c=btn('','foot-chip t-work',()=>{FOOT.pin='work';footRefresh();});c.append(el('span','pulse'),document.createTextNode('执行中'));const at=statusSince(a)||S.chat.sentAt;if(at)c.append(' ',since(at));c.setAttribute('aria-label','执行中，点开看进度和中断');}
 else if(kind==='done'){c=btn('做完了','foot-chip t-done',()=>{FOOT.pin='done';footRefresh();},'check');}
 else if(kind==='queue'){c=btn('排队 '+queueItems(key).length,'foot-chip t-queue',footQueueShow,'history');c.setAttribute('aria-label','排队 '+queueItems(key).length+' 条，'+footQueueText(a,key));}
 else if(kind==='ask'){const approval=ask?.classList.contains('approval')||ask?.classList.contains('confirm-panel');c=btn(approval?'等你确认':'在问你','foot-chip t-ask'+(approval?' approval':''),footUnwrite,approval?'alert':'chat');c.setAttribute('aria-label','展开问题');}
 else{c=btn(mode.text,'foot-chip mode-chip '+(mode.tone||''),modeSheet);c.setAttribute('aria-label','模式：'+mode.text+'，点开切换');}
 return c;}

// Focusing the input while a question card leads, on a touch screen or a short one (the keyboard is
// coming): fold the card so the input stays; the card is one tap away in the rail.
document.addEventListener('focusin',e=>{
 const t=e.target;if(!(t instanceof HTMLTextAreaElement)||!t.closest('#composer .composer'))return;
 const f=document.getElementById('composer');if(f?.dataset.primary!=='ask'||!f.querySelector('#live-state .qa-card,#live-state .confirm-panel'))return;
 if(footShort()||matchMedia('(pointer:coarse)').matches){const a=S.chat?.agent;if(a){FOOT.write=qaWaitKey(a);renderComposer();}}});
addEventListener('resize',()=>{const f=document.getElementById('composer'),t=f?.querySelector('.composer textarea');
 if(f?.dataset.primary==='ask'&&t&&document.activeElement===t&&footShort()){const a=S.chat?.agent;if(a){FOOT.write=qaWaitKey(a);renderComposer();}}});
// Queue pauses, the 「做完了」 line running out and similar changes that do not re-render the composer.
setInterval(()=>{if(S.active&&S.chat)footRefresh();},1000);
