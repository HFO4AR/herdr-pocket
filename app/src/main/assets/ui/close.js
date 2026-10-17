'use strict';
// Closing a session from the phone. It ends running processes, so it always goes through a sheet
// that names the agent, the pane and the project, and says what is still running or queued.
//  · 结束 Agent，保留终端 → bridge `exitAgent`: the agent quits its own way (the bridge picks
//    Claude Code `/exit` or Codex `/quit`), only while it is idle. The pane stays a plain shell;
//    an open chat shows follow.js's "已退出" state.
//  · 关闭整个窗格 → bridge `closePane`: `herdr pane close` on exactly that pane.
// Both carry a fresh request id (bridge receipt) and are never retried on their own.
// A ch-cli pane only holds the SSH attach: exiting ends the remote Claude session, closing the local
// pane detaches and leaves it running on the other computer (`ch resume` picks it up again).
// History records are never deleted: 「从列表移除」 only hides the record ID (bridge-side list).
const CLOSE={busy:false,hidden:null,hiddenFor:'',hiddenLoading:false};
// Exit commands the bridge knows (bridge EXIT_COMMANDS); the bridge's own answer (closeInfo) wins.
// Other kinds get no 「结束 Agent」, only closing the pane: typing a guessed command could do anything.
const CLOSE_EXIT={claude:'/exit',codex:'/quit',opencode:'/exit'};

// ─── Long press (agent rows, history rows) ─────────────────────────────────
// Long press or the context-menu key opens the row's actions; the click that ends a long press is eaten.
function closeHold(n,open){
 let timer=0,x=0,y=0,fired=0;
 const cancel=()=>{clearTimeout(timer);timer=0;n.classList.remove('holding');};
 const fire=()=>{cancel();fired=Date.now();closeHintLearned();open();};
 n.addEventListener('pointerdown',e=>{if(e.button)return;x=e.clientX;y=e.clientY;cancel();n.classList.add('holding');timer=setTimeout(fire,520);});
 n.addEventListener('pointermove',e=>{if(timer&&Math.hypot(e.clientX-x,e.clientY-y)>10)cancel();});
 ['pointerup','pointercancel','pointerleave'].forEach(t=>n.addEventListener(t,cancel));
 n.addEventListener('contextmenu',e=>{e.preventDefault();if(Date.now()-fired>800)fire();});
 n.addEventListener('click',e=>{if(Date.now()-fired<800){e.preventDefault();e.stopImmediatePropagation();}},true);
 n.classList.add('holdable');n.setAttribute('aria-haspopup','dialog');}
// Swipe a row left to reveal its actions (the same ones long press offers). Only one row stays
// open; a tap on an open row or anywhere else closes it. The revealed buttons are hidden from
// assistive tech while closed, so they never shadow the sheet's own 「关闭」.
const SWIPE={open:null};
function swipeShut(except){const w=SWIPE.open;if(!w||w===except)return;SWIPE.open=null;w.classList.remove('open');w.querySelector('.swipe-acts')?.setAttribute('aria-hidden','true');w.querySelectorAll('.swipe-act').forEach(b=>{b.tabIndex=-1;});const row=w.querySelector('.swipe-row');if(row)row.style.transform='';}
document.addEventListener('pointerdown',e=>{if(SWIPE.open&&!SWIPE.open.contains(e.target))swipeShut();},true);
function closeSwipe(row,actions){
 const wrap=el('div','swipe');const acts=el('div','swipe-acts');acts.setAttribute('aria-hidden','true');
 for(const [label,name,tone,fn] of actions){const b=btn(label,'swipe-act'+(tone?' '+tone:''),e=>{e.stopPropagation();swipeShut();closeHintLearned();fn();},name);b.tabIndex=-1;acts.append(b);}
 row.classList.add('swipe-row');wrap.append(acts,row);
 const width=()=>acts.offsetWidth||actions.length*72;
 let x0=0,y0=0,dx=0,mode='',moved=0,base=0;
 row.addEventListener('pointerdown',e=>{if(e.button||e.pointerType==='mouse')return;x0=e.clientX;y0=e.clientY;dx=0;mode='';base=wrap.classList.contains('open')?-width():0;});
 row.addEventListener('pointermove',e=>{if(!x0&&!y0)return;const mx=e.clientX-x0,my=e.clientY-y0;
  if(!mode){if(Math.abs(mx)>12&&Math.abs(mx)>Math.abs(my)*1.4){mode='swipe';swipeShut(wrap);wrap.classList.add('dragging');try{row.setPointerCapture(e.pointerId);}catch(_){}}else if(Math.abs(my)>12)mode='scroll';}
  if(mode!=='swipe')return;dx=Math.max(-width()-24,Math.min(0,base+mx));row.style.transform='translateX('+dx+'px)';});
 const end=()=>{if(mode==='swipe'){moved=Date.now();wrap.classList.remove('dragging');const open=dx<-width()/2;wrap.classList.toggle('open',open);row.style.transform=open?'translateX('+-width()+'px)':'';
   if(open){SWIPE.open=wrap;acts.removeAttribute('aria-hidden');acts.querySelectorAll('.swipe-act').forEach(b=>{b.tabIndex=0;});}else if(SWIPE.open===wrap)swipeShut();}
  x0=y0=0;mode='';};
 row.addEventListener('pointerup',end);row.addEventListener('pointercancel',end);
 // The click that ends a swipe, or a tap on an open row, only closes it.
 row.addEventListener('click',e=>{if(Date.now()-moved<400||wrap.classList.contains('open')){e.preventDefault();e.stopImmediatePropagation();if(Date.now()-moved>=400)swipeShut();}},true);
 return wrap;}
// The row-gesture hint is for finding the gesture: once a swipe action or a long press has been
// used it retires (kept in this WebView's storage, so it stays gone).
const CLOSE_HINT={done:(()=>{try{return localStorage.getItem('hp.hint.rows')==='1';}catch(_){return false;}})()};
function closeHintLearned(){if(CLOSE_HINT.done)return;CLOSE_HINT.done=true;try{localStorage.setItem('hp.hint.rows','1');}catch(_){}}
function closeHint(list){if(!CLOSE_HINT.done)list.append(el('p','fine center close-hint','左滑或长按一行：关闭会话、更多操作'));}
function agentActions(a){
 const box=sheet(titleOf(a));
 box.append(el('p','fine close-sub',[stateLabel(a),providerName(a.agent),projectOf(a),closeIsCh(a)?'通过 ch 连到远端':''].filter(Boolean).join(' · ')));
 menuItem(box,'打开对话',()=>openAgent(a),'chat');
 if(a.history_ref?.record)menuItem(box,'只读查看历史',()=>openRecord(a.history_ref.record),'history','不连在线窗格，只看记录');
 menuItem(box,'复制窗格位置',()=>copyText(S.session+' / '+a.pane_id),'copy',S.session+' / '+a.pane_id);
 menuItem(box,'关闭会话',()=>closeSession(a),'x','结束 Agent，或者关掉整个窗格');}

// ─── Close sheet ───────────────────────────────────────────────────────────
function closeIsCh(a,info){if(info&&'ch' in info)return !!info.ch;return !!a.history_ref?.remote||/^[^:]{1,60}:\s*ch$/.test(String(a.terminal_title_stripped||a.terminal_title||''));}
// `a` is a live agent row, or a plain pane ({pane_id, identity, agent:null}) after the agent exited.
async function closeSession(a){
 if(!a?.pane_id||!a.identity){toast('这个窗格还没认出来，刷新一下');return;}
 if(CLOSE.busy){toast('上一个还在关，稍等一下');return;}
 const box=sheet('关闭会话');box.classList.add('close-sheet');
 const who=a.agent?providerName(a.agent):'终端',st=a.agent_status,busy=!!a.agent&&!['idle','done'].includes(st);
 const queued=a.agent?queueItems(agentKey(a)).length:0;
 const card=el('div','close-who');card.append(avatar(a.agent||'',a.agent?stateTone(a):''));
 const t=el('div','grow');t.append(el('div','close-title',a.agent?titleOf(a):(a.terminal_title_stripped||a.terminal_title||'普通终端')));
 const meta=el('div','close-meta');meta.append(a.agent?el('span','close-state '+stateTone(a),stateLabel(a)):el('span','',who));const project=a.agent?projectOf(a):(String(a.cwd||'').split('/').filter(Boolean).pop()||'');if(project)meta.append(el('span','sep',project));
 t.append(meta);const place=el('div','close-place');t.append(place);card.append(t);
 box.append(card);
 const warns=el('div','close-warns');box.append(warns);
 const warn=(text,strong,action)=>{const w=el('div','close-warn'+(strong?' strong':''));w.append(icon('alert'),el('span','grow',text));if(action)w.append(action);warns.append(w);};
 // Busy: the agent cannot quit on its own yet; interrupting first is one tap away.
 const stop=()=>btn('先中断','close-stop',()=>closeInterrupt(a));
 if(st==='working')warn('还在干活，关闭会中断当前任务',true,stop());
 else if(st==='blocked')warn('它在等你确认，关闭会中断当前任务',true,stop());
 if(queued)warn('还有 '+queued+' 条排队的消息，关闭后不会再发',true);
 box.append(el('div','section-label','怎么关'));
 const opts=el('div','close-opts');opts.setAttribute('role','radiogroup');opts.setAttribute('aria-label','关闭方式');box.append(opts);
 const foot=el('div','close-foot');const status=el('div','close-status hidden');status.setAttribute('role','status');status.setAttribute('aria-live','polite');foot.append(status);
 const actions=el('div','sheet-actions');const go=btn('选一种方式','primary danger-fill',()=>closeRun(a,choice,go,status,info,ui));go.disabled=true;
 actions.append(btn('取消','secondary',closeSheet),go);foot.append(actions);box.append(foot);
 let choice='',info=null;
 // After an unknown outcome the sheet stays locked: nothing can be chosen or sent again.
 let stuck=false;const ui={redraw:()=>draw(),lock:()=>{stuck=true;draw();}};
 function option(id,label,detail,disabled){
  const on=choice===id,locked=disabled||stuck;const b=btn('','close-opt'+(on?' on':''),()=>{if(locked)return;choice=id;draw();});
  b.setAttribute('role','radio');b.setAttribute('aria-checked',String(on));b.setAttribute('aria-label',label);if(locked)b.setAttribute('aria-disabled','true');if(disabled)b.classList.add('off');
  const mark=el('span','close-radio');b.append(mark);const tx=el('span','grow');tx.append(el('strong','',label),el('small','',detail));b.append(tx);
  opts.append(b);}
 function draw(){
  opts.replaceChildren();const ch=closeIsCh(a,info),cmd=info?info.exit_command||'':CLOSE_EXIT[a.agent]||'';
  if(!cmd&&choice==='exit')choice='';
  if(a.agent&&cmd){
   const label=ch?'结束远端会话':'结束 '+who+'，保留终端';
   const detail=busy?'它'+(st==='blocked'?'在等你确认':'还在干活')+'：先点上面的「先中断」（Ctrl+C），停下后再结束':ch?'让 Claude 自己退出（发送 '+cmd+'），电脑那边的 ch 会话跟着结束；这个窗格回到普通终端':'让 '+who+' 自己退出（发送 '+cmd+'），窗格留着，回到普通终端';
   option('exit',label,detail,busy);}
  const last=info&&info.tab_panes===1?'。它是「'+(info.tab_label||'这个')+'」标签页里最后一个窗格':'';
  option('pane',ch?'只关本机窗格':'关闭整个窗格',ch?'断开这台电脑上的连接，远端的 Claude 会话继续运行，之后可以用 ch resume 接回'+last:a.agent?'直接关掉窗格，里面的 '+who+' 和其他进程都会结束'+last:'直接关掉这个窗格，里面还在跑的进程都会结束'+last,false);
  if(choice==='exit'&&busy)choice='';
  go.disabled=!choice||CLOSE.busy||stuck;if(stuck)go.replaceChildren(document.createTextNode('结果未知'));else if(!CLOSE.busy)go.replaceChildren(document.createTextNode(!choice?'选一种方式':choice==='exit'?(ch?'结束远端会话':'结束 '+who):'关闭窗格'));
  const parts=['窗格 '+a.pane_id];if(info?.workspace_label&&info.workspace_label!==project)parts.push(info.workspace_label);if(info?.tab_label)parts.push('标签页「'+info.tab_label+'」');place.replaceChildren(el('span','',parts.join(' · ')));
  if(info?.focused&&!warns.querySelector('.close-focused')){const w=el('div','close-warn close-focused');w.append(icon('device'),el('span','grow','电脑屏幕上现在正显示这个窗格'));warns.append(w);}}
 draw();
 if(S.demo){info={ch:closeIsCh(a,null),focused:false,workspace_label:'演示项目',tab_label:'1',tab_panes:2};draw();return;}
 place.append(el('span','close-loading',' · 正在读取位置…'));
 try{const r=await remote('closeInfo',{session:S.session,target:a.pane_id,identity:a.identity});if(!box.isConnected)return;info=r;draw();}
 catch(e){if(!box.isConnected)return;place.querySelector('.close-loading')?.remove();const m=e.message||String(e);
  if(/Unknown operation|不支持的操作/.test(m)){closeStatus(status,'error','电脑上的桥接程序太旧，先到「设备」里点「更新桥接程序」');go.disabled=true;opts.querySelectorAll('button').forEach(b=>b.disabled=true);}
  else closeStatus(status,'error',/^没关/.test(m)?m:'读不到窗格信息：'+m);}}
function closeStatus(status,kind,text,extra){status.className='close-status '+kind;status.replaceChildren();status.append(kind==='busy'?el('span','spinner'):icon('alert'));const t=el('div','grow');t.append(el('div','',text));if(extra)t.append(extra);status.append(t);}
async function closeInterrupt(a){
 closeSheet();if(S.demo){toast('演示：未发送按键');return;}
 try{await remote('key',{session:S.session,target:a.pane_id,identity:a.identity,key:'ctrl+c',id:uuid()});toast('已发送 Ctrl+C，等它停下再来结束');setTimeout(()=>refreshStatus(),700);}
 catch(e){toast('按键未确认：'+e.message+'。不会自动重发。');}}
async function closeRun(a,how,go,status,info,ui){
 if(CLOSE.busy||!how)return;
 if(S.demo){closeSheet();toast('演示：不会真的关闭');return;}
 CLOSE.busy=true;go.disabled=true;go.replaceChildren(el('span','spinner'),document.createTextNode(how==='exit'?'正在发送…':'正在关闭…'));
 closeStatus(status,'busy',how==='exit'?'正在让 '+providerName(a.agent)+' 退出…':'正在关闭窗格…');
 const args={session:S.session,target:a.pane_id,identity:a.identity,id:uuid()};
 try{
  const r=await remote(how==='exit'?'exitAgent':'closePane',args);CLOSE.busy=false;
  if(how==='pane'&&!r?.closed){closeStatus(status,'error','没关：'+(r?.refused||r?.code||'Herdr 没接受'));ui.redraw();return;}
  if(status.isConnected)closeSheet();
  if(how==='exit')closeAfterExit(a,r,info);else closeAfterPane(a,r,info);}
 catch(e){CLOSE.busy=false;const m=e.message||String(e);
  // Refused before anything happened: say why, the person can choose again.
  // Bridge checks that run before anything is written or closed are definite refusals too.
  const old=/^(Unknown operation|不支持的操作)/.test(m),changed=/^Agent changed or disappeared/.test(m),offline=/^Session is offline/.test(m);
  if(old||changed||offline||/^(没关|没发出去)/.test(m)){const text=old?'没关：电脑上的桥接程序太旧，先到「设备」里点「更新桥接程序」':changed?'没关：这个窗格里的 Agent 变了，刷新列表再看':offline?'没关：Herdr 会话不在了，刷新一下':m;if(status.isConnected){closeStatus(status,'error',text);ui.redraw();}else toast(text);return;}
  // Unknown outcome: it may have happened. Never retry on its own.
  const look=btn('刷新看看','link-btn',()=>{closeSheet();closeRefresh(a);});
  if(status.isConnected){closeStatus(status,'error',/^关闭结果未知：/.test(m)?m.replace(/^关闭/,''):'结果未知：'+m+'。刷新看看，别直接再点',look);ui.lock();}
  else toast('关闭结果未知，刷新列表看看，别直接再点');}}
// The agent's queue and unread mark go with it (pictures/files staged on the phone are dropped).
function closeForget(a){
 if(!a.agent)return;const key=agentKey(a),q=Q.get(key);
 if(q){q.items.forEach(it=>{if(it.pics.length)rpc('dropImages',{ids:it.pics.map(p=>p.id)}).catch(()=>{});if(it.docs?.length)rpc('dropFiles',{ids:it.docs.map(f=>f.id)}).catch(()=>{});});Q.delete(key);}
 S.unread.delete(key);}
function closeRefresh(a){if(S.chat?.agent?.pane_id===a.pane_id){followNow(0);return;}if(S.tab==='live'&&!S.chat)loadLive();}
function closeAfterPane(a,r,info){
 closeForget(a);S.agents=S.agents.filter(x=>x.pane_id!==a.pane_id);
 if(S.chat?.agent?.pane_id===a.pane_id){S.chat=null;S.chatStack=[];S.epoch++;}
 toast(closeIsCh(a,info)?'本机窗格关了，远端会话还在，之后可以 ch resume 接回':r.verified?'窗格关掉了':'关闭命令发出去了，刷新确认一下');
 syncWatch();if(!S.chat){render();if(S.tab==='live')loadLive();}}
function closeAfterExit(a,r,info){
 closeForget(a);
 toast(closeIsCh(a,info)?'Claude 收到 '+(r?.command||'/exit')+'，远端会话正在结束':providerName(a.agent)+' 收到 '+(r?.command||'退出命令')+'，正在退出');
 const c=S.chat;
 if(c?.agent&&c.agent.pane_id===a.pane_id&&c.agent.identity===a.identity){
  // Stop sending at once; follow.js confirms the exit and shows the pane as a plain terminal.
  c.stale=true;c.following=true;c.sentAt=0;renderComposer();updateChatMeta();
  let n=0;const look=()=>{if(S.chat!==c||c.exited)return;if(++n>6){if(c.following){c.following=false;renderComposer();updateChatMeta();}return;}followRun();setTimeout(look,1800);};setTimeout(look,1200);}
 else if(S.tab==='live'&&!S.chat)setTimeout(()=>{if(S.tab==='live'&&!S.chat)loadLive();},1500);}

// ─── History: 从列表移除 (hidden, never deleted) ────────────────────────────
function closeHiddenIds(){return CLOSE.hiddenFor===(S.device?.id||'')&&CLOSE.hidden?CLOSE.hidden:[];}
function closeLoadHidden(){
 const dev=S.device?.id||'';if(!dev||CLOSE.hiddenLoading||(CLOSE.hiddenFor===dev&&CLOSE.hidden))return;
 if(S.demo){CLOSE.hidden=[];CLOSE.hiddenFor=dev;return;}
 CLOSE.hiddenLoading=true;
 remote('hidden').then(r=>{if((S.device?.id||'')!==dev)return;CLOSE.hidden=r.ids||[];CLOSE.hiddenFor=dev;if(CLOSE.hidden.length&&S.tab==='history'&&!S.chat)render();})
  .catch(()=>{/* older bridge: nothing hidden */if((S.device?.id||'')===dev){CLOSE.hidden=[];CLOSE.hiddenFor=dev;}})
  .finally(()=>{CLOSE.hiddenLoading=false;});}
// historyPage / renderHistoryList hooks.
function closeHiddenFilter(){const n=closeHiddenIds().length;if(!n&&S.filter==='hidden')S.filter='all';return n?[['hidden','已隐藏 · '+n]]:[];}
function closeVisible(records){const hidden=new Set(closeHiddenIds());return S.filter==='hidden'?records.filter(r=>hidden.has(r.id)):records.filter(r=>!hidden.has(r.id));}
function closeHiddenNote(list){if(S.filter!=='hidden')return;const n=closeHiddenIds().length,shown=S.records.filter(r=>closeHiddenIds().includes(r.id)).length;
 list.prepend(el('p','fine close-hidden-note','只在 App 里不显示，电脑上的记录没动。长按可以放回。'+(shown<n?'还有 '+(n-shown)+' 条在更早的记录里，加载更多后会出现。':'')));}
function historyActions(r){
 const hidden=closeHiddenIds().includes(r.id);const box=sheet(r.title||'历史记录');
 box.append(el('p','fine close-sub',providerName(r.provider)+(r.cwd?' · '+r.cwd.split('/').filter(Boolean).pop():'')+(r.modified?' · '+relative(r.modified):'')));
 menuItem(box,'打开',()=>openRecord(r),'chat');
 menuItem(box,hidden?'放回列表':'从列表移除',()=>closeSetHidden(r,!hidden),hidden?'history':'x',hidden?'重新出现在历史列表里':'只是不在 App 里显示，电脑上的记录不删');}
async function closeSetHidden(r,hide){
 const dev=S.device?.id||'';if(!dev)return;const before=closeHiddenIds().slice();
 CLOSE.hidden=hide?before.filter(x=>x!==r.id).concat(r.id):before.filter(x=>x!==r.id);CLOSE.hiddenFor=dev;closeHistoryRedraw();
 if(S.demo){toast(hide?'已从列表移除（演示，只在这次）':'放回列表了');return true;}
 try{const res=await remote('hidden',hide?{add:[r.id]}:{remove:[r.id]});if((S.device?.id||'')===dev){CLOSE.hidden=res.ids||[];closeHistoryRedraw();}
  toast(hide?'已从列表移除，在「已隐藏」里能找回':'放回列表了');return true;}
 catch(e){if((S.device?.id||'')===dev){CLOSE.hidden=before;closeHistoryRedraw();}toast((hide?'没移除：':'没放回：')+(e.message||e));return false;}}
function closeHistoryRedraw(){if(!S.chat&&!(typeof T!=='undefined'&&T.view)&&S.tab==='history')render();}
// 「更多操作」 in a chat: close the live session (or the plain pane left after an exit); hide a history record.
function closeChatMenu(box){
 const c=S.chat;if(!c)return;
 if(c.agent&&!c.exited)menuItem(box,'关闭会话',()=>closeSession(c.agent),'x','结束 Agent，或者关掉整个窗格');
 else if(c.agent&&c.exited?.pane&&!c.exited.gone&&!c.newAgent)menuItem(box,'关闭这个窗格',()=>closeSession({...c.exited.pane,agent:null}),'x','Agent 已退出，窗格还开着');
 else if(!c.agent&&c.record&&S.tab==='history'){const r=c.record,hidden=closeHiddenIds().includes(r.id);
  menuItem(box,hidden?'放回列表':'从列表移除',async()=>{const ok=await closeSetHidden(r,!hidden);if(ok&&!hidden&&S.chat?.record===r&&!S.chatStack.length){S.chat=null;S.epoch++;render();}},hidden?'history':'x',hidden?'重新出现在历史列表里':'只是不在 App 里显示，电脑上的记录不删');}}
