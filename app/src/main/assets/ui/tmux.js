'use strict';
// tmux sessions on the connected computer (bridge op `tmux`): every tmux server of the SSH user,
// the default one and named ones (`tmux -L work`, found as sockets in the user's tmux directories).
// A pane of a named server has the id %N@<server key> and a `server` name, shown as 「服务器 work」.
//  · With Herdr they are a section under the Herdr agents in 会话. Without Herdr (S.herdr===false,
//    from `doctor` / `sessions`) they are the whole 会话 page: a quiet note, no Herdr-only parts.
//  · A plain pane opens straight on a terminal screen. Its screen and input reuse the 终端 view
//    (terminals.js renderTerminal, kind 'tmux'): colored screen (tmuxRead → ansi.js), key bar and
//    line input (tmuxSend, one UUID per press, never resent; an unconfirmed send pauses input).
//  · A pane running Claude Code or Codex (found by the bridge in the pane's process tree) is listed
//    as that agent and opens as a chat: 对话 from its transcript when the bridge could match it with
//    evidence (else the usual "pick a record / see the terminal" note), 终端, sending. The chat's
//    ops carry the tmux pane id as target and the agent's identity; the bridge serves them with
//    tmux, so everything a Herdr agent has works the same: the send queue and 立即发送 (queue.js),
//    question cards (answer.js; keys via tmux send-keys, verified like Herdr's), pictures and files
//    (local paths), 中断 (Esc), mode chips and Shift+Tab, the preview line on its row (glance.js),
//    the 切换 Agent sheet and background alerts (WatchService polls `status` with tmux: true).
//    Its state comes from its screen (bridge tmux_state): blocked (a menu), working ("esc to
//    interrupt", Claude's spinner, or a reply still streaming under its prompt) or idle.
//  · 新建 tmux 会话 (tmuxNew) and 关闭 a pane or a whole session (tmuxKill), both behind a sheet.
// Local panes only: tmux on another computer is not listed (add that computer as a device). An
// empty list says where the bridge looked (`looked`), what it refused (`skipped`) and which
// server did not answer (`servers`), and the list follows new sessions within a few seconds.
const TX={by:new Map(),live:'',liveSet:false,liveLoaded:false,liveDev:null};
// 快照 / 实时 as last chosen on this phone and computer (tmuxModeSheet); another computer reloads its own.
function tmuxLivePref(){if(S.demo)return;const dev=tmuxDevice();if(TX.liveLoaded&&TX.liveDev===dev)return;
 TX.liveLoaded=true;TX.liveDev=dev;TX.liveSet=false;TX.live='';
 if(!dev)return;
 cacheGet('term:tmuxLive',dev).then(v=>{if(TX.liveDev===dev&&!TX.liveSet&&v&&['','rw','ro'].includes(v.mode))TX.live=v.mode;}).catch(()=>{});}
function tmuxDevice(){return S.device&&!S.demo?S.device.id:'';}
// Per computer (several can be connected): the last list, whether the bridge knows tmux, transcript refs.
function tmuxState(dev=tmuxDevice()){if(!dev)return null;let st=TX.by.get(dev);
 if(!st){st={panes:[],available:null,supported:true,loading:false,loaded:false,sig:'',refs:new Map(),resolveAt:0,looked:[],skipped:[],servers:[]};TX.by.set(dev,st);}return st;}
function tmuxPanes(){return tmuxState()?.panes||[];}
function noHerdr(){return !S.demo&&!!S.device&&S.herdr===false;}
// tmux can be offered (新建): not known to be missing, and the bridge knows the op.
function tmuxCan(){const st=tmuxState();return !!st&&st.supported&&st.available!==false&&S.hostTmux!==false;}
function tmuxSig(list){return list.map(p=>{const a=p.agent;return [p.pane_id,p.identity,p.active,p.command,p.session,p.window_name,p.window_panes,a?a.identity+a.agent_status+(a.history_ref?.status||''):''].join('/');}).join(',');}
// %N on the default server, %N@<12 hex> on a named one (every tmux server counts from %0).
const TMUX_PANE_RE=/^%\d{1,9}(@[0-9a-f]{12})?$/;
// Same tmux session = same name on the same server.
function tmuxSameSession(a,b){return !!a&&!!b&&a.session===b.session&&(a.server||'')===(b.server||'');}
function tmuxRawId(p){return String(p?.pane_id||'').split('@')[0];}
function tmuxServer(p){return typeof p?.server==='string'&&p.server?p.server.slice(0,40):'';}
function tmuxAgent(p){if(!p?.agent)return null;const st=tmuxState();const ref=p.agent.history_ref||st?.refs.get(p.agent.identity);
 const pane={...p};delete pane.agent;return {...p.agent,...(ref?{history_ref:ref}:{}),tmux_pane:pane};}
function tmuxAgents(){return tmuxPanes().map(tmuxAgent).filter(Boolean);}
async function tmuxLoad(resolve=false){
 tmuxLivePref();
 const dev=tmuxDevice(),st=tmuxState(dev);if(!st||!st.supported||st.loading)return;st.loading=true;
 try{const r=await remote('tmux',resolve?{resolve:true}:{});
  st.available=r?.available!==false;
  st.looked=Array.isArray(r?.looked)?r.looked.filter(x=>typeof x==='string').slice(0,6):[];
  st.skipped=Array.isArray(r?.skipped)?r.skipped.filter(x=>typeof x?.path==='string'&&typeof x.reason==='string').slice(0,4):[];
  st.servers=Array.isArray(r?.servers)?r.servers.filter(x=>typeof x?.name==='string'):[];
  st.panes=Array.isArray(r?.panes)?r.panes.filter(p=>TMUX_PANE_RE.test(p?.pane_id)&&typeof p.identity==='string').map(p=>p.agent&&(typeof p.agent.identity!=='string'||!p.agent.agent)?{...p,agent:undefined}:p):[];
  st.loaded=true;st.failed='';if(resolve)st.resolveAt=Date.now();
  for(const p of st.panes)if(p.agent?.history_ref)st.refs.set(p.agent.identity,p.agent.history_ref);
  const agents=st.panes.map(tmuxAgent).filter(Boolean);
  if(dev===tmuxDevice()&&agents.length){noteStatus(agents);syncWatch();if(typeof glanceRefresh==='function')glanceRefresh();}
  // A notification tapped for a tmux agent waits for this list (app.js openPending).
  if(dev===tmuxDevice()&&/^%/.test(S.pendingPane||''))openPending();
  // A new agent in a pane: find its transcript (the scan costs more, so not on every poll).
  if(!resolve&&agents.some(a=>!a.history_ref||a.history_ref.status==='pending')&&Date.now()-st.resolveAt>15000){st.resolveAt=Date.now();setTimeout(()=>tmuxLoad(true),0);}}
 // An older bridge does not know the op: stop asking until the next device. Other failures
 // (tmux hung, a slow link) keep the last list; tmux is a side dish here, never an error card.
 catch(e){const was=st.failed+'|'+st.supported+'|'+st.loaded;
  if(/Unknown operation|不支持的操作|unexpected remote op/.test(e?.message||''))st.supported=false;else st.failed=String(e?.message||e).slice(0,120);
  st.loaded=true;
  // Repaint only when the failure is news: a failing poll every 4 s must not rebuild the list
  // (that closed a swiped row and reset scroll under the person's finger).
  if(was!==st.failed+'|'+st.supported+'|'+st.loaded&&dev===tmuxDevice()&&(noHerdr()||!st.panes.length))tmuxRepaint();return;}
 finally{st.loading=false;}
 if(dev!==tmuxDevice())return;
 const sig=tmuxSig(st.panes)+'|'+st.available+'|'+st.looked.join(':')+'|'+st.skipped.length+'|'+st.servers.map(x=>x.name+x.state).join(':');if(sig===st.sig)return;st.sig=sig;tmuxRepaint();}
// Repaint the list only when nothing is in the way: a sheet, a chat, a terminal, or typing in search.
function tmuxRepaint(){
 if(S.tab!=='live'||S.chat||(typeof T!=='undefined'&&T.view)||overlay.childElementCount)return;
 // A row swiped open (关闭 / 更多 showing) stays as it is; the next change repaints.
 if(app.querySelector('.swipe.open')){const st=tmuxState();if(st)st.sig='';return;}
 const a=document.activeElement;if(a&&/^(INPUT|TEXTAREA)$/.test(a.tagName)&&app.contains(a))return;
 const main=app.querySelector('.main'),top=main?main.scrollTop:0;render();
 const next=app.querySelector('.main');if(next){next.classList.remove('pane-enter');next.scrollTop=top;}}
function tmuxTitle(p){return (p.session||'tmux')+':'+(p.window_name||p.window_index);}
function tmuxWhere(p){return shortPath(p.cwd||'');}
function tmuxPlace(p){const sv=tmuxServer(p);return 'tmux '+p.session+':'+p.window_index+'.'+p.pane_index+(sv?' · 服务器 '+sv:'');}
// An empty list in plain words: where the bridge looked, what it skipped, which server did not answer.
function tmuxNoneText(st){
 // The last read failed (tmux hung, a slow link): say that, not "nothing is running".
 if(st?.failed)return '这次没读到 tmux（'+st.failed+'），下拉刷新再试一次。';
 const dirs=(st?.looked||[]).slice(0,4),bad=st?.skipped||[],down=(st?.servers||[]).filter(x=>x.state==='error');
 let t='没找到正在运行的 tmux'+(dirs.length?'（看过 '+dirs.join('、')+'）':'')+'。';
 if(down.length)t+='有 tmux 服务器读不了：'+down.slice(0,3).map(x=>x.default?'默认':x.name.slice(0,40)).join('、')+'。';
 if(bad.length)t+='跳过了 '+bad.slice(0,2).map(x=>x.path+'（'+x.reason+'）').join('、')+'。';
 return t;}
const TMUX_ELSEWHERE='tmux 开在别的电脑上的话，先在「设备」页把那台电脑加进来。';
function tmuxRow(p){
 const b=btn('','card-button term-row tmux-row',()=>tmuxOpen(p));b.setAttribute('aria-label','tmux '+tmuxTitle(p)+(p.command?' · '+p.command:'')+(p.active?' · 活动':''));
 const av=el('div','avatar term-av');av.append(icon('terminal'));
 const t=el('div','grow');t.append(el('div','card-title term-cmd',tmuxTitle(p)));
 const meta=el('div','card-meta');meta.append(el('span','tmux-cmd',p.command||'shell'));const where=tmuxWhere(p);if(where)meta.append(el('span','sep',where));
 if(p.window_panes>1)meta.append(el('span','sep','窗格 '+p.pane_index));const sv=tmuxServer(p);if(sv)meta.append(el('span','sep tmux-server','服务器 '+sv));t.append(meta);
 b.append(av,t);if(p.active){const side=el('div','row-side');side.append(el('span','badge ok','活动'));b.append(side);}
 closeHold(b,()=>tmuxActions(p));
 return closeSwipe(b,[['关闭','x','danger',()=>tmuxClose(p)],['更多','more','',()=>tmuxActions(p)]]);}
// An agent in a pane: the same row as a Herdr agent (agentRow), tagged tmux; its actions are tmux's.
function tmuxAgentRow(a){const row=agentRow(a);const meta=row.querySelector('.card-meta');if(meta){const tag=el('span','tag tmux-tag','tmux');const first=meta.firstChild;first?first.after(tag):meta.append(tag);
  const sv=tmuxServer(a.tmux_pane);if(sv)meta.append(el('span','sep tmux-server','服务器 '+sv));}return row;}
// 会话 list: a section after the agents (only when tmux has panes), or the whole page without Herdr.
function tmuxSection(main,only=false){
 const list=tmuxPanes();if(!list.length){if(!only)tmuxNoneNote(main);return;}
 const agents=list.filter(p=>p.agent),plain=list.filter(p=>!p.agent);
 // Their preview lines (glance.js); with Herdr agents on the page livePage already asked.
 if(agents.length&&!S.agents.length&&typeof glanceKick==='function')glanceKick();
 const label=el('div','section-label group-label tmux-label');label.append(el('span','',only?'tmux 会话':'tmux'),el('span','group-count',String(list.length)));main.append(label);
 if(agents.length){const card=el('div','card list-card tmux-list tmux-agents');agents.forEach(p=>card.append(tmuxAgentRow(tmuxAgent(p))));main.append(card);}
 if(plain.length){const card=el('div','card list-card tmux-list');plain.forEach(p=>card.append(tmuxRow(p)));main.append(card);}}
// With Herdr and no tmux pane: one quiet line, so a tmux the person expected here is not a mystery.
function tmuxNoneNote(main){const st=tmuxState();if(!st?.loaded||!st.supported||S.demo)return;
 const text=st.available===false||S.hostTmux===false?'tmux：这台电脑上没装。':'tmux：'+tmuxNoneText(st)+(st.failed?'':TMUX_ELSEWHERE);
 main.append(el('p','fine tmux-none-note',text));}
// No Herdr on this computer: tmux is the page.
function tmuxOnlyPage(main){
 const st=tmuxState(),list=tmuxPanes(),none=S.hostTmux===false||st?.available===false;
 const actions=el('div','row list-actions');const facts=el('div','grow live-status');const f=el('span','list-facts');
 if(!none)f.append(el('span','fact-count',!st?.loaded?'正在读取 tmux…':list.length+' 个 tmux 窗格'));facts.append(f);
 actions.append(facts,ib('refresh','刷新会话',loadLive));if(tmuxCan()&&list.length)actions.append(tmuxNewButton());main.append(actions);
 if(!none){const note=el('p','tmux-only-note');note.setAttribute('role','note');note.append(icon('terminal'),el('span','','这台电脑没装 Herdr，只显示 tmux'));main.append(note);}
 if(st&&!st.supported){empty(main,'桥接程序太旧','电脑上的桥接程序还不认识 tmux，到「设备」页重新安装（桥接程序那一行的「…」）。',btn('去设备页','primary',()=>setTab('devices')),'terminal');return;}
 if(none){
  const box=el('div','empty tmux-none');const ic=el('div','empty-icon');ic.append(icon('terminal'));
  box.append(ic,el('h2','','这台电脑上没有 Herdr，也没有 tmux'),el('p','','装其中一个，这里就有东西看了：'));
  const ul=el('ul','tmux-install');
  [['tmux','只想在手机上用终端：装 tmux（Ubuntu 用 sudo apt install tmux，Mac 用 brew install tmux），开个会话就行'],['Herdr','想看 Codex / Claude 的对话、收提醒：装 Herdr，用同一个 SSH 用户运行']]
   .forEach(([k,v])=>{const li=el('li');li.append(el('strong','',k),el('span','',v));ul.append(li);});
  box.append(ul);const again=btn('重新检查','primary',()=>recheckHost(again),'refresh');box.append(again);main.append(box);return;}
 if(!st?.loaded){skeleton(main,3);return;}
 if(!list.length){empty(main,'还没有 tmux 会话',tmuxNoneText(st)+(st.failed?'':'新建一个，或者在这台电脑上运行 tmux，几秒内会自动出现。'+TMUX_ELSEWHERE),tmuxCan()?tmuxNewButton('新建 tmux 会话','primary'):undefined,'terminal');pullRefresh(main,loadLive);return;}
 tmuxSection(main,true);
 closeHint(main,'左滑或长按一行：关闭、更多操作');
 pullRefresh(main,loadLive);}
function tmuxOpen(p){termPrefs();termFontVar();
 // 实时 is for plain panes: an agent's pane keeps the checked input path (chat, receipts, dialogs).
 if(TX.live&&!S.demo&&!p.agent&&typeof attachOpen==='function'){attachOpen(p,TX.live==='ro');return;}
 T.view={kind:'tmux',pane:p,title:tmuxTitle(p),text:'正在读取 tmux 窗格…',ansi:'',draft:'',paused:false,busy:false,demo:false,stick:true};
 renderTerminal();pollTerminal();}
function tmuxSub(entry){const p=entry.pane;return 'tmux · '+[p.command,tmuxWhere(p)].filter(Boolean).join(' · ');}
// One read of the pane (terminals.js snapLoop decides how often). The bridge answers {same: true}
// when the screen is what the phone already has (`known`: a short hash of the last screen).
async function tmuxPoll(entry){
 let r;try{r=await remote('tmuxRead',{target:entry.pane.pane_id,identity:entry.pane.identity,...(entry.known?{known:entry.known}:{})});}
 catch(e){if(/关了或换了/.test(e.message)&&T.view===entry){entry.ended=true;terminalStatus(entry,'这个 tmux 窗格已经关了，回到列表看看');tmuxLoad();return false;}throw e;}
 if(T.view!==entry)return false;
 // The window is renamed (tmux names a fresh window "tmux" for a moment, then after its command):
 // the header follows the pane.
 if(r.pane){entry.pane={...entry.pane,...r.pane};const title=tmuxTitle(entry.pane);
  if(title!==entry.title){entry.title=title;const h=document.getElementById('term-title');if(h)h.textContent=title;}
  const w=document.querySelector('.term-head .term-where');if(w&&w.textContent!==tmuxSub(entry))w.textContent=tmuxSub(entry);}
 if(typeof r.known==='string')entry.known=r.known;
 if(r.same||r.text===entry.text&&(r.ansi||'')===entry.ansi)return false;entry.text=r.text;entry.ansi=r.ansi||'';
 const n=document.getElementById('pane-screen');if(n)screenUpdate(n,entry);return true;}
// sendPane's ops, as tmuxSend actions: paneRun = text + Enter, paneText = text, paneKey = a key.
async function tmuxSend(entry,op,args){
 const action=op==='paneKey'?'key':op==='paneRun'?'run':'text';
 return remote('tmuxSend',{target:entry.pane.pane_id,identity:entry.pane.identity,id:uuid(),action,...(action==='key'?{key:args.key}:{text:args.text})});}
// 快照 ⇄ 实时 in the terminal header. The choice is remembered per phone (per-device cache):
// TX.live '' (snapshot), 'rw' (attach) or 'ro' (read-only attach).
function tmuxLiveButton(entry){
 if(S.demo||entry.pane?.agent)return null;const live=entry.kind==='attach';
 const b=btn(live?'实时':'快照','term-mode'+(live?' on':''),()=>tmuxModeSheet(entry),live?'terminal':'refresh');
 b.setAttribute('aria-label',live?'实时连接中，切换显示方式':'快照显示，切换到实时连接');b.title=live?'实时连接（tmux attach）':'快照：每隔一会儿读一次屏幕';return b;}
function tmuxModeSheet(entry){const p=entry.pane;const box=sheet('tmux 显示方式');
 box.append(el('p','fine','快照：每隔一会儿读一次屏幕，最省事，电脑上什么都不变。实时：手机开一个真正的 tmux 客户端（tmux attach），字一出来就看到，按键也直接到 tmux。'));
 const pick=v=>{TX.live=v;TX.liveSet=true;cachePut('term:tmuxLive',{mode:v});if(v){attachOpen(p,v==='ro');}else{leaveTerminal();tmuxOpen(p);}};
 menuItem(box,'快照',()=>pick(''),'refresh',entry.kind==='tmux'?'正在用':'每隔一会儿读一次屏幕');
 menuItem(box,'实时连接',()=>pick('rw'),'terminal',(entry.kind==='attach'&&!entry.readOnly?'正在用 · ':'')+'窗口大小可能跟着手机变（看电脑上 tmux 的 window-size 设置）');
 menuItem(box,'实时 · 只读',()=>pick('ro'),'lock',(entry.kind==='attach'&&entry.readOnly?'正在用 · ':'')+'只看不按，也不改窗口大小（tmux attach -r）');}
// 终端选项 extra: wrap or keep the desktop width (the same per-phone choice as the agent screens).
function tmuxMenu(box){const e=T.view;
 if(e&&!S.demo&&!e.pane?.agent)menuItem(box,'显示方式…',()=>tmuxModeSheet(e),'terminal',e.kind==='attach'?(e.readOnly?'实时 · 只读':'实时连接'):'快照');
 if(e?.kind==='tmux')menuItem(box,ANSI.raw?'自动换行':'原始宽度',()=>{ANSI.raw=!ANSI.raw;ANSI.set=true;cachePut('term:raw',{raw:ANSI.raw});const n=document.getElementById('pane-screen');if(n)n.classList.toggle('raw',ANSI.raw);toast(ANSI.raw?'原始宽度：左右滑动查看':'自动换行');},'terminal',ANSI.raw?'长行折到屏幕宽度':'按电脑上的宽度显示，左右滑动');
 const p=T.view?.pane;if(p&&!T.view.ended)menuItem(box,'关闭…',()=>tmuxClose(p),'x','关掉这个窗格，或者结束整个会话');}

// ─── Long press / 更多 ───────────────────────────────────────────────────────
function tmuxActions(p,a=tmuxAgent(p)){
 const box=sheet(a?titleOf(a):tmuxTitle(p));
 box.append(el('p','fine close-sub',[a?stateLabel(a):'',a?providerName(a.agent):p.command||'shell',tmuxPlace(p),tmuxWhere(p)].filter(Boolean).join(' · ')));
 if(a){menuItem(box,'打开对话',()=>openAgent(a),'chat');if(a.history_ref?.record)menuItem(box,'只读查看历史',()=>openRecord(a.history_ref.record),'history','只看记录');}
 menuItem(box,a?'只看终端':'打开终端',()=>tmuxOpen(p),'terminal');
 if(!a&&!S.demo&&typeof attachOpen==='function')menuItem(box,'实时连接',()=>attachOpen(p,false),'terminal','开一个真正的 tmux 客户端，字一出来就看到');
 menuItem(box,'复制位置',()=>copyText(p.session+':'+p.window_index+'.'+p.pane_index),'copy',p.session+':'+p.window_index+'.'+p.pane_index+' · '+tmuxRawId(p)+(tmuxServer(p)?' · 服务器 '+tmuxServer(p):''));
 menuItem(box,'关闭…',()=>tmuxClose(p),'x','关掉这个窗格，或者结束整个会话');}

// ─── Close a pane or a session ───────────────────────────────────────────────
const TX_CLOSE={busy:false};
function tmuxClose(p){
 if(!p?.pane_id||!p.identity){toast('这个窗格还没认出来，刷新一下');return;}
 if(TX_CLOSE.busy){toast('上一个还在关，稍等一下');return;}
 const fresh=tmuxPanes().find(x=>x.pane_id===p.pane_id&&x.identity===p.identity)||p;p=fresh;const a=tmuxAgent(p);
 const box=sheet('关闭 tmux');box.classList.add('close-sheet');
 const card=el('div','close-who');if(a)card.append(avatar(a.agent,stateTone(a)));else{const av=el('div','avatar term-av');av.append(icon('terminal'));card.append(av);}
 const t=el('div','grow');t.append(el('div','close-title',a?titleOf(a):tmuxTitle(p)));
 const meta=el('div','close-meta');meta.append(el('span','',a?providerName(a.agent):p.command||'shell'));const where=tmuxWhere(p);if(where)meta.append(el('span','sep',where));t.append(meta);
 t.append(el('div','close-place',tmuxPlace(p)+' · '+tmuxRawId(p)));card.append(t);box.append(card);
 const warns=el('div','close-warns');box.append(warns);
 const warn=(text,strong)=>{const w=el('div','close-warn'+(strong?' strong':''));w.append(icon('alert'),el('span','grow',text));warns.append(w);};
 if(a&&['working','blocked'].includes(a.agent_status))warn(providerName(a.agent)+(a.agent_status==='blocked'?' 在等你确认':' 还在干活')+'，关闭会直接结束它',true);
 else if(p.command&&!/^(bash|zsh|sh|fish|dash|ksh|tcsh|login)$/.test(p.command))warn('里面正在运行 '+p.command+'，关闭会结束它',!!a);
 if(p.attached)warn('电脑上有终端正连着这个会话');
 const others=tmuxPanes().filter(x=>tmuxSameSession(x,p)).length;
 box.append(el('div','section-label','怎么关'));
 const opts=el('div','close-opts');opts.setAttribute('role','radiogroup');opts.setAttribute('aria-label','关闭方式');box.append(opts);
 const foot=el('div','close-foot');const status=el('div','close-status hidden');status.setAttribute('role','status');status.setAttribute('aria-live','polite');foot.append(status);
 const actions=el('div','sheet-actions');const go=btn('选一种方式','primary danger-fill',()=>tmuxKillRun(p,choice,go,status,lock));go.disabled=true;
 actions.append(btn('取消','secondary',closeSheet),go);foot.append(actions);box.append(foot);
 let choice='',stuck=false;const lock=()=>{stuck=true;draw();};
 function option(id,label,detail){const on=choice===id;const b=btn('','close-opt'+(on?' on':''),()=>{if(stuck)return;choice=id;draw();});
  b.setAttribute('role','radio');b.setAttribute('aria-checked',String(on));b.setAttribute('aria-label',label);if(stuck)b.setAttribute('aria-disabled','true');
  const tx=el('span','grow');tx.append(el('strong','',label),el('small','',detail));b.append(el('span','close-radio'),tx);opts.append(b);}
 function draw(){opts.replaceChildren();
  option('pane',p.window_panes>1?'关闭这个窗格':'关闭这个窗口',p.window_panes>1?'只关这一个窗格，窗口「'+(p.window_name||p.window_index)+'」里的其他窗格留着':'窗口「'+(p.window_name||p.window_index)+'」只有这一个窗格，窗口跟着关掉'+(others<=1?'；它也是会话里最后一个，会话随之结束':''));
  option('session','结束整个会话「'+p.session+'」','会话里'+(others>1?'全部 '+others+' 个窗格':'所有窗口')+'和里面的程序都会结束');
  go.disabled=!choice||TX_CLOSE.busy||stuck;if(stuck)go.replaceChildren(document.createTextNode('结果未知'));else if(!TX_CLOSE.busy)go.replaceChildren(document.createTextNode(!choice?'选一种方式':choice==='pane'?(p.window_panes>1?'关闭窗格':'关闭窗口'):'结束会话'));}
 draw();}
async function tmuxKillRun(p,scope,go,status,lock){
 if(TX_CLOSE.busy||!scope)return;TX_CLOSE.busy=true;go.disabled=true;go.replaceChildren(el('span','spinner'),document.createTextNode('正在关闭…'));
 closeStatus(status,'busy',scope==='pane'?'正在关闭窗格…':'正在结束会话…');
 try{const r=await remote('tmuxKill',{target:p.pane_id,identity:p.identity,scope,id:uuid()});TX_CLOSE.busy=false;
  if(!r?.closed){closeStatus(status,'error','没关：tmux 没接受');go.disabled=false;go.replaceChildren(document.createTextNode('再试一次'));return;}
  if(status.isConnected)closeSheet();toast(scope==='pane'?'已关闭 '+tmuxTitle(p):'已结束 tmux 会话「'+p.session+'」');tmuxAfterClose(p,scope);}
 catch(e){TX_CLOSE.busy=false;const m=e.message||String(e);
  // Refused before anything happened: say why, choose again.
  if(/^(没关|这个 tmux 窗格已经关了|Unknown operation|不支持的操作)/.test(m)){const text=/^(Unknown|不支持)/.test(m)?'没关：电脑上的桥接程序太旧，到「设备」页重新安装（桥接程序那一行的「…」）':/^没关/.test(m)?m:'没关：'+m;
   if(status.isConnected){closeStatus(status,'error',text);go.disabled=false;go.replaceChildren(document.createTextNode('再试一次'));}else toast(text);if(!/^没关/.test(m))tmuxLoad();return;}
  // Unknown outcome: it may have happened. Never retry on its own.
  const look=btn('刷新看看','link-btn',()=>{closeSheet();tmuxLoad();});
  if(status.isConnected){closeStatus(status,'error','结果未知：'+m.replace(/^关闭结果未知：/,'')+'。刷新看看，别直接再点',look);lock();}
  else toast('关闭结果未知，刷新列表看看，别直接再点');}}
function tmuxAfterClose(p,scope){
 const st=tmuxState();if(st){st.panes=st.panes.filter(x=>scope==='session'?!tmuxSameSession(x,p):x.pane_id!==p.pane_id);st.sig='';}
 const gone=x=>x&&(scope==='session'?tmuxSameSession(x,p):x.pane_id===p.pane_id);
 if(typeof T!=='undefined'&&T.view?.kind==='tmux'&&gone(T.view.pane)){leaveTerminal();}
 if(S.chat?.agent?.tmux&&gone(S.chat.agent.tmux_pane)){S.chat=null;S.chatStack=[];S.epoch++;}
 render();setTimeout(()=>tmuxLoad(),400);}

// ─── New tmux session ────────────────────────────────────────────────────────
const TX_NEW={busy:false,info:null,infoFor:''};
const TMUX_NAME_RE=/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
function tmuxNewButton(label='新建',cls='new-btn'){const b=btn(label,cls,tmuxNewSheet,'plus');if(label==='新建')b.setAttribute('aria-label','新建 tmux 会话');return b;}
async function tmuxNewSheet(){
 if(!S.device){toast('先连接电脑');return;}if(S.demo){toast('演示模式：不会真的新建');return;}
 if(TX_NEW.busy){toast('上一个还在新建，稍等一下');return;}
 const dev=S.device.id;
 const box=sheet('新建 tmux 会话');box.classList.add('new-sheet','tmux-new');
 const body=el('div','new-body');box.append(body);
 body.append(el('p','fine tmux-new-lead','开一个新的 tmux 会话（后台运行，不会抢电脑屏幕），开好后直接打开它的终端。'));
 const f={name:'',dir:'',custom:false};
 // Name
 body.append(el('div','section-label','名字 · 可不填'));
 const name=el('input','field tmux-name');name.type='text';name.placeholder='不填就自动起名';name.autocomplete='off';name.spellcheck=false;name.maxLength=64;
 name.setAttribute('aria-label','会话名字');name.setAttribute('autocapitalize','off');name.setAttribute('enterkeyhint','done');
 name.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();name.blur();}};
 const nameNote=el('p','fine tmux-name-note','英文字母、数字、- 和 _');body.append(name,nameNote);
 // A new session goes on the default server: only its names are taken (a named server may have the same).
 const nameOk=()=>{const v=name.value.trim();const used=v&&tmuxPanes().some(p=>!p.server&&p.session===v);const bad=v&&!TMUX_NAME_RE.test(v);
  nameNote.textContent=bad?'只能用英文字母、数字、- 和 _，不能以 - 开头':used?'已经有叫 '+v+' 的会话了，换个名字':'英文字母、数字、- 和 _';nameNote.classList.toggle('bad',!!(bad||used));return !bad&&!used;};
 name.oninput=()=>{f.name=name.value.trim();nameOk();};
 // Directory: home first, then where tmux panes are and recent projects.
 body.append(el('div','section-label','在哪个目录'));
 const dirList=el('div','new-dirs');dirList.setAttribute('role','radiogroup');dirList.setAttribute('aria-label','起始目录');body.append(dirList);
 // The rows are redrawn when the directory list arrives; the path input and the note stay put, so
 // typing a path while the list loads keeps the focus (and the soft keyboard).
 const rows=el('div','tmux-dir-rows'),dirNote=el('p','fine tmux-dir-loading');
 const pathInput=el('input','field new-path');pathInput.type='text';pathInput.placeholder='~/projects/app';pathInput.autocomplete='off';pathInput.spellcheck=false;pathInput.setAttribute('aria-label','目录路径');pathInput.setAttribute('autocapitalize','off');pathInput.setAttribute('enterkeyhint','go');
 pathInput.oninput=()=>{f.dir=pathInput.value.trim();};
 pathInput.onkeydown=e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();go.click();}};
 dirList.append(rows,pathInput,dirNote);
 // Typed something: back / a tap outside ask for × instead of throwing it away.
 box.keepOpen=()=>!!(name.value.trim()||(f.custom&&pathInput.value.trim()));
 let info=TX_NEW.infoFor===dev?TX_NEW.info:null,showAll=false;
 const home=()=>info?.home||'~';
 const short=p=>{const h=info?.home;return h&&(p===h||p.startsWith(h+'/'))?'~'+p.slice(h.length):p;};
 const base=p=>info?.home&&p.replace(/\/+$/,'')===info.home?'家目录':p.split('/').filter(Boolean).pop()||'/';
 let picked=null;
 function dirs(){const list=[{path:home(),source:'home'}];for(const d of info?.dirs||[])if(d.path!==info.home)list.push(d);
  if(picked&&!list.some(d=>d.path.replace(/\/+$/,'')===picked.path))list.splice(1,0,picked);return list;}
 // 浏览目录…: the folder tree (dirpick.js) over this form; the folder picked becomes the choice.
 function browse(){const start=f.custom?pathInput.value.trim():f.dir;
  dirPickIn(body,{value:start&&start!=='~'?start:info?.home||'~',home:info?.home||'',title:'选起始目录',
   quick:dirs().slice(0,8).map(d=>({path:d.path,label:d.source==='home'?'家目录':base(d.path)})),
   onPick:path=>{const hit=dirs().find(d=>d.path.replace(/\/+$/,'')===path);if(!hit)picked={path,source:'picked'};
    f.custom=false;f.dir=hit?hit.path:path;if(dirs().findIndex(d=>d.path===f.dir)>=5)showAll=true;draw();
    requestAnimationFrame(()=>rows.querySelector('.new-dir.on')?.focus({preventScroll:false}));}});}
 function row(d){const on=!f.custom&&f.dir===d.path;const b=btn('','menu-item new-dir'+(on?' on':''),()=>{f.custom=false;f.dir=d.path;draw();},d.source==='home'?'account':'folder');
  b.setAttribute('role','radio');b.setAttribute('aria-checked',String(on));const t=el('span','grow');
  t.append(el('span','menu-label',d.source==='home'?'家目录':base(d.path)),el('small','truncate',d.source==='home'?short(d.path):short(d.path)+' · '+(d.source==='picked'?'刚在目录树里选的':d.source==='tmux'?'有 tmux 窗格在这':d.modified?newAgo(d.modified):'最近用过')));
  b.append(t);if(on)b.append(icon('check'));return b;}
 function draw(){rows.replaceChildren();const all=dirs();if(!f.dir&&!f.custom)f.dir=all[0].path;
  (showAll?all:all.slice(0,5)).forEach(d=>rows.append(row(d)));
  if(!showAll&&all.length>5)rows.append(btn('更多目录 · '+(all.length-5),'link-btn new-more',()=>{showAll=true;draw();}));
  rows.append(newBrowseRow(browse));
  const other=btn('','menu-item new-dir'+(f.custom?' on':''),()=>{f.custom=true;f.dir=pathInput.value.trim();draw();setTimeout(()=>pathInput.focus(),30);},'edit');
  other.setAttribute('role','radio');other.setAttribute('aria-checked',String(f.custom));const t=el('span','grow');t.append(el('span','menu-label','其他目录'),el('small','','手填路径，目录要已经存在'));other.append(t);rows.append(other);
  pathInput.classList.toggle('hidden',!f.custom);
  // The suggestions failed: say so, but 家目录 and a typed path still work (the bridge expands ~).
  dirNote.textContent=!info?'正在读取最近用过的目录…':info.error?'读不到最近用过的目录（'+info.error+'），家目录和手填的路径照样能用':'';
  dirNote.classList.toggle('bad',!!info?.error);dirNote.classList.toggle('hidden',!!info&&!info.error);
  // Rows arriving above a focused path push it down: keep it above the footer (app.js).
  requestAnimationFrame(sheetFieldClear);}
 draw();
 const foot=el('div','new-foot');body.append(foot);
 const status=el('div','new-status hidden');status.setAttribute('role','status');status.setAttribute('aria-live','polite');foot.append(status);
 const acts=el('div','sheet-actions');const go=btn('新建','primary',()=>tmuxNewSubmit(f,go,status,nameOk,name),'plus');go.setAttribute('aria-label','开始新建 tmux 会话');
 acts.append(btn('取消','secondary',closeSheet),go);foot.append(acts);
 // Always asked again (new panes and projects since last time); a list from before shows meanwhile.
 const cached=!!info;
 try{const r=await remote('tmuxInfo');if(!box.isConnected)return;info=r;TX_NEW.info=r;TX_NEW.infoFor=dev;newHome(r.home);
  if(f.dir==='~'&&r.home)f.dir=r.home;draw();
  if(r.available===false){newStatus(status,'error','这台电脑上没找到 tmux，先装上（sudo apt install tmux 或 brew install tmux）');go.disabled=true;}}
 catch(e){if(!box.isConnected)return;const m=e.message||String(e);
  if(/Unknown operation|不支持的操作/.test(m)){info={home:'',dirs:[]};draw();newStatus(status,'error','电脑上的桥接程序太旧，到「设备」页重新安装（桥接程序那一行的「…」）');go.disabled=true;return;}
  if(!cached){info={home:'',dirs:[],error:m.slice(0,120)};draw();}}}
async function tmuxNewSubmit(f,go,status,nameOk,nameInput){
 if(TX_NEW.busy)return;
 if(!nameOk()){nameInput.focus();return;}
 // "~" (家目录 before the directory list arrived, or when it could not be read) is fine: the bridge expands it.
 const dir=(f.dir||'').trim();if(!dir){if(f.custom)newStatus(status,'error','先填目录路径，比如 ~/projects/app');else toast('先选一个目录');return;}
 TX_NEW.busy=true;go.disabled=true;go.replaceChildren(el('span','spinner'),document.createTextNode('正在新建…'));newStatus(status,'busy','正在开 tmux 会话…');
 try{const r=await remote('tmuxNew',{id:uuid(),cwd:dir,...(f.name?{name:f.name}:{})});TX_NEW.busy=false;
  if(!r?.created){newStatus(status,'error','没创建：tmux 没接受，可以改一下再试');restoreGo(go);return;}
  if(status.isConnected)closeSheet();const named='tmux 会话「'+(r.session||f.name||'新会话')+'」';
  const st=tmuxState();if(st&&r.pane&&!st.panes.some(p=>p.pane_id===r.pane.pane_id)){st.panes=st.panes.concat(r.pane);st.available=true;st.sig='';}
  // Open its terminal; if the bridge could not name the pane, it shows up on the list instead.
  if(r.pane&&!S.chat){toast(named+'开好了');tmuxOpen(r.pane);}else{toast(named+'开好了'+(r.pane?'':'，在会话列表里'));if(S.tab!=='live'&&!S.chat)setTab('live');else render();}
  setTimeout(()=>tmuxLoad(),600);}
 catch(e){TX_NEW.busy=false;const m=e.message||String(e);
  if(/^没创建/.test(m)){if(status.isConnected){newStatus(status,'error',m);restoreGo(go);}else toast(m);return;}
  if(/Unknown operation|不支持的操作/.test(m)){newStatus(status,'error','电脑上的桥接程序太旧，到「设备」页重新安装（桥接程序那一行的「…」）');return;}
  // Unknown outcome: a session may exist now. Never retry on its own.
  const again=btn('刷新列表看看','link-btn',()=>{closeSheet();tmuxLoad();});
  if(status.isConnected){newStatus(status,'error','结果未知：'+m.replace(/^新建结果未知：/,''),again);go.replaceChildren(document.createTextNode('结果未知'));}
  else toast('新建结果未知，刷新列表看看，别直接再建');}}

// ─── A chat with an agent in tmux ────────────────────────────────────────────
// Herdr's status poll does not know tmux panes: this one reads the open chat's pane instead
// (bridge `status` with the pane as target: one process walk and one screen read), on the same
// beat as Herdr's (app.js pollBeat → refreshStatus). Anything else in the pane → follow.js decides.
// Returns the pane's agent row now (undefined: none there); a failed read throws.
async function tmuxStatusOne(a){
 let cur;const st=tmuxState();
 if(!st?.statusOld){let r;
  // An older bridge reads `status` as Herdr's (no tmux flag, or no Herdr at all): use the list then.
  try{r=await remote('status',{target:a.pane_id,identity:a.identity});}catch(e){if(!/没找到 Herdr|Unknown operation|不支持的操作/.test(e?.message||''))throw e;}
  if(r?.tmux)cur=r.agents?.find(x=>x.pane_id===a.pane_id);else if(st)st.statusOld=true;}
 if(st?.statusOld){const r=await remote('tmux');const p=(r?.panes||[]).find(x=>x.pane_id===a.pane_id);cur=p?.agent?tmuxAgent(p):undefined;}
 // Keep the list's copy in step, so the list, the queue's check and the watcher agree.
 if(st&&cur){const p=st.panes.find(x=>x.pane_id===cur.pane_id);if(p?.agent&&p.agent.identity===cur.identity&&p.agent.agent_status!==cur.agent_status){p.agent={...p.agent,agent_status:cur.agent_status};st.sig='';}}
 return cur?{...cur,tmux:true}:cur;}
async function tmuxChatPoll(){
 const c=S.chat,a=c?.agent;if(!a?.tmux||c.exited?.gone||TX.chatBusy||S.demo||!S.device)return;TX.chatBusy=true;
 try{const cur=await tmuxStatusOne(a);if(S.chat!==c)return;
  followHint(cur);
  if(!cur||cur.identity!==c.agent.identity||!cur.agent_status||cur.agent_status===c.agent.agent_status)return;
  const was=c.agent.agent_status,upd={...c.agent,agent_status:cur.agent_status};noteStatus([upd]);c.agent=upd;syncWatch();onAgentStatus(was,cur.agent_status);}
 catch(_){/* the next beat tries again */}
 finally{TX.chatBusy=false;}}

(function(){
 const baseLive=livePage,baseLoad=loadLive,baseActions=agentActions,baseClose=closeSession,baseOpenPane=followOpenPane,baseCreate=openCreate,baseStatus=refreshStatus;
 livePage=function(main){
  if(noHerdr()){if(requireDevice(main))tmuxOnlyPage(main);return;}
  baseLive(main);if(!S.device||S.liveLoading&&!S.agents.length)return;tmuxSection(main);
  // One row-gesture hint, after all the lists (tmux rows swipe too).
  if(tmuxPanes().length){const hint=main.querySelector(':scope>.close-hint');if(hint)main.append(hint);else closeHint(main);}};
 loadLive=function(...args){tmuxLoad();return baseLoad(...args);};
 // A tmux agent's row actions and 关闭 are tmux's (a Herdr pane close cannot reach it).
 agentActions=function(a){return a?.tmux?tmuxActions(a.tmux_pane,a):baseActions(a);};
 closeSession=function(a){return a?.tmux?tmuxClose(a.tmux_pane||a):baseClose(a);};
 followOpenPane=function(pane){if(pane?.tmux){S.chatStack=[];S.chat=null;tmuxOpen(pane);return;}return baseOpenPane(pane);};
 // The status beat (app.js pollBeat, sendKey, answers…) also reads an open tmux chat's pane.
 refreshStatus=function(...args){if(S.chat?.agent?.tmux)tmuxChatPoll();return baseStatus(...args);};
 // 新建 without Herdr (or before a Herdr session is known) is a tmux session.
 openCreate=function(){if(!S.demo&&S.device&&(noHerdr()||!S.session)&&tmuxCan()){tmuxNewSheet();return;}return baseCreate();};
})();
// The list follows tmux while it is on screen (a session started on the computer, windows renamed,
// commands changing): every 4 s, at once when the app comes back to the foreground, and on 刷新 /
// pull-to-refresh (loadLive). Nothing while the app is in the background (S.active false) or a chat
// or terminal covers the list; an open chat follows its pane on the status beat (refreshStatus above).
function tmuxListShown(){return S.active&&S.tab==='live'&&!S.chat&&!(typeof T!=='undefined'&&T.view)&&!S.demo&&!!S.device;}
setInterval(()=>{if(tmuxListShown())tmuxLoad();},4000);
(function(){const fg=window.setForeground;if(typeof fg!=='function')return;window.setForeground=v=>{fg(v);if(v&&tmuxListShown())tmuxLoad();};})();
