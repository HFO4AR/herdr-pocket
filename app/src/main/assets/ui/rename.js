'use strict';
// Quick rename from the chat header. Tapping the title opens a small sheet with the current name;
// 保存 sends exactly "/rename <name>" through the normal send path (app.js sendMessage with its own
// text): queued while the agent is busy or something already waits, refused before anything is typed
// while a question or menu is up, text left in the agent's box replaced by the bridge, the usual
// 「命令输出」 card, and an unknown outcome is never sent again. The composer's draft is not touched.
// Checked live on throwaway agents (2026-10-18):
//  · Claude Code 2.1.268: "/rename <name>" prints "Session renamed to: <name>" (it reaches the
//    transcript) and sets the terminal title to "✳ <name>".
//  · Codex 0.163: "/rename <name>" sets the terminal title to "<name> | <dir>" and prints nothing.
//    Without an active thread it prints "No active thread is available." and nothing changes.
//  · OpenCode's /rename opens its own dialog instead of taking a name: not offered, nor for any
//    other agent, a history record, a sub-agent record or the demo.
// The header shows the new name at once with a quiet 「改名已发出」 and keeps it once the terminal
// title (or Claude's transcript) shows it; if neither does within RN.wait (25 s) it goes back and says so.
const RN_KINDS=['claude','codex'];
const RN_MAX=80,RN_DONE=3000;
// agentKey → {name, prev, chat, state:'sending'|'queued'|'sent'|'unknown'|'done', at, sentAt, item}
const RN={pending:new Map(),wait:25000,statusAt:0,hint:(()=>{try{return localStorage.getItem('hp.hint.rename')!=='1';}catch(_){return true;}})()};

function renameKind(c){const a=c?.agent;return !!a&&!S.demo&&!c.record?.parent&&RN_KINDS.includes(a.agent)&&slashList(a).some(x=>x.name==='rename');}
// Why a rename cannot go out right now ('' = it can). The title stays a button; a tap says this.
function renameWhyNot(c){
 if(!c?.agent)return '历史记录改不了标题';
 if(S.demo)return '演示里不能改标题';
 if(c.exited)return providerName(c.agent.agent)+' 已退出，改不了标题';
 if(c.stale||c.following||c.unsure)return '窗格还在确认，稍后再改';
 if(!S.device)return '还在连接，连上后再改';
 return '';}
// One line, no control characters, runs of spaces folded, at most RN_MAX characters.
function renameClean(v){return Array.from(String(v||'').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g,' ').replace(/\s+/g,' ').trim()).slice(0,RN_MAX).join('').trim();}

// ─── Header ─────────────────────────────────────────────────────────────────
// The h2 keeps exactly the title as its text; the pencil is decoration. The button's hit area covers
// the subtitle too (rename.css), so it is a comfortable target on a phone.
function chatTitleFill(h){
 const c=S.chat,t=c?.title||'对话';h.replaceChildren();
 if(!renameKind(c)){h.textContent=t;return;}
 const b=btn('','chat-title-btn'+(RN.hint?' hint':''),renameOpen);b.setAttribute('aria-label','改标题：'+t);b.setAttribute('aria-haspopup','dialog');
 const pen=icon('pen');pen.classList.add('chat-title-pen');b.append(el('span','chat-title-text',t),pen);h.append(b);}
function chatTitle(){const h=el('h2','chat-title');h.id='chat-title';chatTitleFill(h);return h;}
function renamePaint(){const h=document.getElementById('chat-title');if(h)chatTitleFill(h);if(typeof updateChatMeta==='function')updateChatMeta();}
// The subtitle starts with the rename's state while one is on its way.
const RN_STATE={sending:'改名发送中',queued:'改名排队中',sent:'改名已发出',unknown:'改名结果未知',done:'已改名'};
function renameMeta(n){const p=S.chat?.agent?RN.pending.get(draftKey()):null;if(!p||!n)return;
 const s=el('span','meta-rename'+(p.state==='done'?' ok':p.state==='unknown'?' warn':''),RN_STATE[p.state]||'');n.prepend(s,' · ');}
// A name the agent set from elsewhere (typed on the computer) reaches the header too (follow.js).
function renameFollowTitle(c,was){const p=RN.pending.get(draftKey());if(S.chat!==c||p&&p.state!=='done')return;const t=titleOf(c.agent);if(t&&t!==was&&t!==c.title){c.title=t;renamePaint();}}

// ─── Sheet ──────────────────────────────────────────────────────────────────
function renameOpen(){
 const c=S.chat,why=renameWhyNot(c);if(why){toast(why);return;}
 if(RN.hint){RN.hint=false;try{localStorage.setItem('hp.hint.rename','1');}catch(_){}document.querySelector('.chat-title-btn')?.classList.remove('hint');}
 const a=c.agent,cur=renameClean(c.title),box=sheet('改标题');box.classList.add('rename-sheet');
 const input=el('input','field rename-input');input.type='text';input.value=cur;input.maxLength=RN_MAX*2;input.autocomplete='off';input.spellcheck=false;
 input.setAttribute('aria-label','新标题');input.setAttribute('enterkeyhint','done');input.setAttribute('autocapitalize','off');
 const hint=el('p','field-hint rename-hint');hint.id='rename-hint';input.setAttribute('aria-describedby',hint.id);
 const save=btn('保存','primary',()=>renameSave(input.value,cur));
 const sync=()=>{const v=renameClean(input.value);save.disabled=!v||v===cur;
  const cmd=el('code','rename-cmd','/rename '+(v||'…'));const n=Array.from(input.value.trim()).length;
  hint.replaceChildren('保存就是给 '+providerName(a.agent)+' 发 ',cmd,n>RN_MAX?' · 只保留前 '+RN_MAX+' 个字':'');};
 // Pasted line breaks become spaces (a one-line field would just drop them, gluing the lines);
 // Enter (outside an IME composition) saves.
 input.addEventListener('paste',e=>{const t=e.clipboardData?.getData('text');if(!t||!/[\r\n]/.test(t))return;e.preventDefault();
  input.setRangeText(t.replace(/\s*(\r\n|[\r\n])\s*/g,' '),input.selectionStart,input.selectionEnd,'end');sync();});
 input.oninput=sync;
 input.onkeydown=e=>{if(e.key==='Enter'&&!e.isComposing&&e.keyCode!==229){e.preventDefault();if(!save.disabled)save.click();}};
 const st=a.agent_status,later=st==='working'||st==='blocked'||queueItems(draftKey()).length>0;
 const row=el('div','sheet-actions');row.append(btn('取消','secondary',closeSheet),save);
 box.append(input,hint);if(later)box.append(el('p','fine rename-later',st==='blocked'?'它在等你确认，保存后先排队，处理完再发':st==='working'?'它正在忙，保存后先排队，停下就发':'前面还有排队的消息，改名排在它们后面'));
 box.append(row);sync();
 setTimeout(()=>{if(!input.isConnected)return;input.focus();input.select();},80);}

async function renameSave(raw,cur){
 const c=S.chat,name=renameClean(raw),why=renameWhyNot(c);if(why){toast(why);return;}
 if(!name||name===cur)return;
 closeSheet();
 const key=draftKey(),old=RN.pending.get(key);
 const p={name,prev:old&&old.state!=='done'?old.prev:c.title,chat:c,state:'sending',at:Date.now(),sentAt:0,item:null};
 RN.pending.set(key,p);c.title=name;renamePaint();
 const own={text:'/rename '+name};let r;
 try{r=await sendMessage(null,own);}catch(_){r='failed';}
 if(RN.pending.get(key)!==p)return;
 if(r==='sent'){p.state='sent';p.sentAt=Date.now();}
 else if(r==='queued'&&own.item){p.state='queued';p.item=own.item;}
 // The send's own toast said what happened; an unknown outcome is still watched, never resent.
 else if(r==='failed'){p.state='unknown';p.sentAt=Date.now();}
 else{renameBack(key,p,'');return;}
 renamePaint();}
// The chat the rename was made in, or the same agent's chat opened again since.
function renameChats(key,p){return [p.chat,S.chat?.agent&&draftKey()===key?S.chat:null].filter((c,i,l)=>c&&l.indexOf(c)===i);}
function renameBack(key,p,msg){
 if(RN.pending.get(key)===p)RN.pending.delete(key);
 for(const c of renameChats(key,p))if(c.title===p.name)c.title=p.prev;
 renamePaint();if(msg)toast(msg);}
function renameDone(key,p){p.state='done';p.doneAt=Date.now();for(const c of renameChats(key,p))c.title=p.name;renamePaint();}

// ─── Confirmation ───────────────────────────────────────────────────────────
function renameTitleIs(raw,name){const t=String(raw||'').replace(/^[\s✳✻✽✶⠀-⣿·•*]+/,'').trim();return t===name||t.startsWith(name+' | ');}
function renameSeen(key,p){
 const here=!!S.chat?.agent&&draftKey()===key;
 const rows=[S.agents.find(x=>agentKey(x)===key),here?S.chat.agent:null].filter(Boolean);
 if(rows.some(a=>[a.title,a.terminal_title_stripped,a.terminal_title].some(t=>renameTitleIs(t,p.name))))return true;
 // Claude records the command and its answer in the transcript.
 if(!here)return false;
 const said='<local-command-stdout>Session renamed to: '+p.name+'</local-command-stdout>';
 return S.messages.some(m=>String(m.text||'').trim()===said&&(toDate(m.timestamp)?.getTime()||0)>=p.at-120000);}
// Codex answers a rename it cannot do on screen (the command card captures it).
function renameRefused(key,p){const card=slashCards(key).filter(x=>x.text==='/rename '+p.name&&x.at>=p.at-1000).at(-1);return !!card&&/No active thread/i.test(card.screen||'');}
function renameTick(){
 const now=Date.now(),gap=now-(RN.lastTick||now);RN.lastTick=now;if(!RN.pending.size)return;let poll=false;
 // The wait only runs while the app is on screen (timers are throttled in the background).
 if(!S.active||gap>3000)for(const p of RN.pending.values())if(p.sentAt)p.sentAt+=gap;
 for(const [key,p] of [...RN.pending]){
  if(p.state==='done'){if(now-p.doneAt>RN_DONE){RN.pending.delete(key);renamePaint();}continue;}
  if(p.state==='queued'){const it=p.item;
   if(it.state==='sent'){p.state='sent';p.sentAt=now;renamePaint();}
   else if(it.state==='unknown'){p.state='unknown';p.sentAt=now;renamePaint();}
   else if(![...Q.values()].some(q=>q.items.includes(it))){renameBack(key,p,'改名那条没发，标题还是原来的');continue;}
   else continue;}
  if(p.state!=='sent'&&p.state!=='unknown')continue;
  if(renameSeen(key,p)){renameDone(key,p);continue;}
  if(p.state==='sent'&&renameRefused(key,p)){renameBack(key,p,'没改成：Codex 说现在还没有可改名的对话，先跟它说句话再改');continue;}
  if(now-p.sentAt>RN.wait){renameBack(key,p,p.state==='unknown'?'改名发送结果未知，也没看到标题变成「'+p.name+'」。不会自动重发，看一眼终端':'等了一会儿没看到标题变成「'+p.name+'」，先改回原来的。可能没改成，看一眼终端');continue;}
  if(S.chat?.agent&&draftKey()===key)poll=true;}
 // Herdr's status (or the tmux pane's) carries the terminal title: read it while a rename is out.
 if(poll&&now-RN.statusAt>2500&&!S.demo){RN.statusAt=now;refreshStatus();}}
setInterval(renameTick,1000);
