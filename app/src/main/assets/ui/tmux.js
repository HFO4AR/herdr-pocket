'use strict';
// tmux sessions on the connected computer (the SSH user's default tmux server, bridge op `tmux`).
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
// Local panes only: tmux on another computer behind a ch-cli route is not listed.
const TX={by:new Map()};
function tmuxDevice(){return S.device&&!S.demo?S.device.id:'';}
// Per computer (several can be connected): the last list, whether the bridge knows tmux, transcript refs.
function tmuxState(dev=tmuxDevice()){if(!dev)return null;let st=TX.by.get(dev);
 if(!st){st={panes:[],available:null,supported:true,loading:false,loaded:false,sig:'',refs:new Map(),resolveAt:0};TX.by.set(dev,st);}return st;}
function tmuxPanes(){return tmuxState()?.panes||[];}
function noHerdr(){return !S.demo&&!!S.device&&S.herdr===false;}
// tmux can be offered (新建): not known to be missing, and the bridge knows the op.
function tmuxCan(){const st=tmuxState();return !!st&&st.supported&&st.available!==false&&S.hostTmux!==false;}
function tmuxSig(list){return list.map(p=>{const a=p.agent;return [p.pane_id,p.identity,p.active,p.command,p.session,p.window_name,p.window_panes,a?a.identity+a.agent_status+(a.history_ref?.status||''):''].join('/');}).join(',');}
function tmuxAgent(p){if(!p?.agent)return null;const st=tmuxState();const ref=p.agent.history_ref||st?.refs.get(p.agent.identity);
 const pane={...p};delete pane.agent;return {...p.agent,...(ref?{history_ref:ref}:{}),tmux_pane:pane};}
function tmuxAgents(){return tmuxPanes().map(tmuxAgent).filter(Boolean);}
async function tmuxLoad(resolve=false){
 const dev=tmuxDevice(),st=tmuxState(dev);if(!st||!st.supported||st.loading)return;st.loading=true;
 try{const r=await remote('tmux',resolve?{resolve:true}:{});
  st.available=r?.available!==false;
  st.panes=Array.isArray(r?.panes)?r.panes.filter(p=>/^%\d+$/.test(p?.pane_id)&&typeof p.identity==='string').map(p=>p.agent&&(typeof p.agent.identity!=='string'||!p.agent.agent)?{...p,agent:undefined}:p):[];
  st.loaded=true;if(resolve)st.resolveAt=Date.now();
  for(const p of st.panes)if(p.agent?.history_ref)st.refs.set(p.agent.identity,p.agent.history_ref);
  const agents=st.panes.map(tmuxAgent).filter(Boolean);
  if(dev===tmuxDevice()&&agents.length){noteStatus(agents);syncWatch();if(typeof glanceRefresh==='function')glanceRefresh();}
  // A notification tapped for a tmux agent waits for this list (app.js openPending).
  if(dev===tmuxDevice()&&/^%/.test(S.pendingPane||''))openPending();
  // A new agent in a pane: find its transcript (the scan costs more, so not on every poll).
  if(!resolve&&agents.some(a=>!a.history_ref||a.history_ref.status==='pending')&&Date.now()-st.resolveAt>15000){st.resolveAt=Date.now();setTimeout(()=>tmuxLoad(true),0);}}
 // An older bridge does not know the op: stop asking until the next device. Other failures
 // (tmux hung, a slow link) keep the last list; tmux is a side dish here, never an error card.
 catch(e){if(/Unknown operation|不支持的操作|unexpected remote op/.test(e?.message||''))st.supported=false;st.loaded=true;if(dev===tmuxDevice()&&noHerdr())tmuxRepaint();return;}
 finally{st.loading=false;}
 if(dev!==tmuxDevice())return;
 const sig=tmuxSig(st.panes)+'|'+st.available;if(sig===st.sig)return;st.sig=sig;tmuxRepaint();}
// Repaint the list only when nothing is in the way: a sheet, a chat, a terminal, or typing in search.
function tmuxRepaint(){
 if(S.tab!=='live'||S.chat||(typeof T!=='undefined'&&T.view)||overlay.childElementCount)return;
 const a=document.activeElement;if(a&&/^(INPUT|TEXTAREA)$/.test(a.tagName)&&app.contains(a))return;
 const main=app.querySelector('.main'),top=main?main.scrollTop:0;render();
 const next=app.querySelector('.main');if(next){next.classList.remove('pane-enter');next.scrollTop=top;}}
function tmuxTitle(p){return (p.session||'tmux')+':'+(p.window_name||p.window_index);}
function tmuxWhere(p){return shortPath(p.cwd||'');}
function tmuxPlace(p){return 'tmux '+p.session+':'+p.window_index+'.'+p.pane_index;}
function tmuxRow(p){
 const b=btn('','card-button term-row tmux-row',()=>tmuxOpen(p));b.setAttribute('aria-label','tmux '+tmuxTitle(p)+(p.command?' · '+p.command:'')+(p.active?' · 活动':''));
 const av=el('div','avatar term-av');av.append(icon('terminal'));
 const t=el('div','grow');t.append(el('div','card-title term-cmd',tmuxTitle(p)));
 const meta=el('div','card-meta');meta.append(el('span','tmux-cmd',p.command||'shell'));const where=tmuxWhere(p);if(where)meta.append(el('span','sep',where));
 if(p.window_panes>1)meta.append(el('span','sep','窗格 '+p.pane_index));t.append(meta);
 b.append(av,t);if(p.active){const side=el('div','row-side');side.append(el('span','badge ok','活动'));b.append(side);}
 closeHold(b,()=>tmuxActions(p));
 return closeSwipe(b,[['关闭','x','danger',()=>tmuxClose(p)],['更多','more','',()=>tmuxActions(p)]]);}
// An agent in a pane: the same row as a Herdr agent (agentRow), tagged tmux; its actions are tmux's.
function tmuxAgentRow(a){const row=agentRow(a);const meta=row.querySelector('.card-meta');if(meta){const tag=el('span','tag tmux-tag','tmux');const first=meta.firstChild;first?first.after(tag):meta.append(tag);}return row;}
// 会话 list: a section after the agents (only when tmux has panes), or the whole page without Herdr.
function tmuxSection(main,only=false){
 const list=tmuxPanes();if(!list.length)return;
 const agents=list.filter(p=>p.agent),plain=list.filter(p=>!p.agent);
 // Their preview lines (glance.js); with Herdr agents on the page livePage already asked.
 if(agents.length&&!S.agents.length&&typeof glanceKick==='function')glanceKick();
 const label=el('div','section-label group-label tmux-label');label.append(el('span','',only?'tmux 会话':'tmux'),el('span','group-count',String(list.length)));main.append(label);
 if(agents.length){const card=el('div','card list-card tmux-list tmux-agents');agents.forEach(p=>card.append(tmuxAgentRow(tmuxAgent(p))));main.append(card);}
 if(plain.length){const card=el('div','card list-card tmux-list');plain.forEach(p=>card.append(tmuxRow(p)));main.append(card);}}
// No Herdr on this computer: tmux is the page.
function tmuxOnlyPage(main){
 const st=tmuxState(),list=tmuxPanes(),none=S.hostTmux===false||st?.available===false;
 const actions=el('div','row list-actions');const facts=el('div','grow live-status');const f=el('span','list-facts');
 if(!none)f.append(el('span','fact-count',!st?.loaded?'正在读取 tmux…':list.length+' 个 tmux 窗格'));facts.append(f);
 actions.append(facts,ib('refresh','刷新会话',loadLive));if(tmuxCan()&&list.length)actions.append(tmuxNewButton());main.append(actions);
 if(!none){const note=el('p','tmux-only-note');note.setAttribute('role','note');note.append(icon('terminal'),el('span','','这台电脑没装 Herdr，只显示 tmux'));main.append(note);}
 if(st&&!st.supported){empty(main,'桥接程序太旧','电脑上的桥接程序还不认识 tmux，先到「设备」里更新桥接程序。',btn('去设备页','primary',()=>setTab('devices')),'terminal');return;}
 if(none){
  const box=el('div','empty tmux-none');const ic=el('div','empty-icon');ic.append(icon('terminal'));
  box.append(ic,el('h2','','这台电脑上没有 Herdr，也没有 tmux'),el('p','','装其中一个，这里就有东西看了：'));
  const ul=el('ul','tmux-install');
  [['tmux','只想在手机上用终端：装 tmux（Ubuntu 用 sudo apt install tmux，Mac 用 brew install tmux），开个会话就行'],['Herdr','想看 Codex / Claude 的对话、收提醒：装 Herdr，用同一个 SSH 用户运行']]
   .forEach(([k,v])=>{const li=el('li');li.append(el('strong','',k),el('span','',v));ul.append(li);});
  box.append(ul);const again=btn('重新检查','primary',()=>recheckHost(again),'refresh');box.append(again);main.append(box);return;}
 if(!st?.loaded){skeleton(main,3);return;}
 if(!list.length){empty(main,'还没有 tmux 会话','新建一个，或者在电脑上运行 tmux，这里会自动出现。',tmuxCan()?tmuxNewButton('新建 tmux 会话','primary'):undefined,'terminal');pullRefresh(main,loadLive);return;}
 tmuxSection(main,true);
 closeHint(main,'左滑或长按一行：关闭、更多操作');
 pullRefresh(main,loadLive);}
function tmuxOpen(p){termPrefs();termFontVar();
 T.view={kind:'tmux',pane:p,title:tmuxTitle(p),text:'正在读取 tmux 窗格…',ansi:'',draft:'',paused:false,busy:false,demo:false,stick:true,readAt:0};
 renderTerminal();pollTerminal();}
function tmuxSub(entry){const p=entry.pane;return 'tmux · '+[p.command,tmuxWhere(p)].filter(Boolean).join(' · ');}
// Read the pane (called from pollTerminal, which runs every 500 ms): about once a second.
async function tmuxPoll(entry){
 if(Date.now()-entry.readAt<900)return;entry.readAt=Date.now();
 let r;try{r=await remote('tmuxRead',{target:entry.pane.pane_id,identity:entry.pane.identity});}
 catch(e){if(/关了或换了/.test(e.message)&&T.view===entry){entry.ended=true;terminalStatus(entry,'这个 tmux 窗格已经关了，回到列表看看');tmuxLoad();return;}throw e;}
 if(T.view!==entry)return;if(r.pane)entry.pane={...entry.pane,...r.pane};
 if(r.text===entry.text&&(r.ansi||'')===entry.ansi)return;entry.text=r.text;entry.ansi=r.ansi||'';
 const n=document.getElementById('pane-screen');if(!n)return;screenPaint(n,paneText(entry.text),entry.ansi);
 if(entry.stick!==false)n.scrollTop=n.scrollHeight;termJump(entry,true);}
// sendPane's ops, as tmuxSend actions: paneRun = text + Enter, paneText = text, paneKey = a key.
async function tmuxSend(entry,op,args){
 const action=op==='paneKey'?'key':op==='paneRun'?'run':'text';
 const r=await remote('tmuxSend',{target:entry.pane.pane_id,identity:entry.pane.identity,id:uuid(),action,...(action==='key'?{key:args.key}:{text:args.text})});
 entry.readAt=0;return r;}
// 终端选项 extra: wrap or keep the desktop width (the same per-phone choice as the agent screens).
function tmuxMenu(box){
 menuItem(box,ANSI.raw?'自动换行':'原始宽度',()=>{ANSI.raw=!ANSI.raw;ANSI.set=true;cachePut('term:raw',{raw:ANSI.raw});const n=document.getElementById('pane-screen');if(n)n.classList.toggle('raw',ANSI.raw);toast(ANSI.raw?'原始宽度：左右滑动查看':'自动换行');},'terminal',ANSI.raw?'长行折到屏幕宽度':'按电脑上的宽度显示，左右滑动');
 const p=T.view?.pane;if(p&&!T.view.ended)menuItem(box,'关闭…',()=>tmuxClose(p),'x','关掉这个窗格，或者结束整个会话');}

// ─── Long press / 更多 ───────────────────────────────────────────────────────
function tmuxActions(p,a=tmuxAgent(p)){
 const box=sheet(a?titleOf(a):tmuxTitle(p));
 box.append(el('p','fine close-sub',[a?stateLabel(a):'',a?providerName(a.agent):p.command||'shell',tmuxPlace(p),tmuxWhere(p)].filter(Boolean).join(' · ')));
 if(a){menuItem(box,'打开对话',()=>openAgent(a),'chat');if(a.history_ref?.record)menuItem(box,'只读查看历史',()=>openRecord(a.history_ref.record),'history','只看记录');}
 menuItem(box,a?'只看终端':'打开终端',()=>tmuxOpen(p),'terminal');
 menuItem(box,'复制位置',()=>copyText(p.session+':'+p.window_index+'.'+p.pane_index),'copy',p.session+':'+p.window_index+'.'+p.pane_index+' · '+p.pane_id);
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
 t.append(el('div','close-place',tmuxPlace(p)+' · '+p.pane_id));card.append(t);box.append(card);
 const warns=el('div','close-warns');box.append(warns);
 const warn=(text,strong)=>{const w=el('div','close-warn'+(strong?' strong':''));w.append(icon('alert'),el('span','grow',text));warns.append(w);};
 if(a&&['working','blocked'].includes(a.agent_status))warn(providerName(a.agent)+(a.agent_status==='blocked'?' 在等你确认':' 还在干活')+'，关闭会直接结束它',true);
 else if(p.command&&!/^(bash|zsh|sh|fish|dash|ksh|tcsh|login)$/.test(p.command))warn('里面正在运行 '+p.command+'，关闭会结束它',!!a);
 if(p.attached)warn('电脑上有终端正连着这个会话');
 const others=tmuxPanes().filter(x=>x.session===p.session).length;
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
  if(/^(没关|这个 tmux 窗格已经关了|Unknown operation|不支持的操作)/.test(m)){const text=/^(Unknown|不支持)/.test(m)?'没关：电脑上的桥接程序太旧，先到「设备」里更新桥接程序':/^没关/.test(m)?m:'没关：'+m;
   if(status.isConnected){closeStatus(status,'error',text);go.disabled=false;go.replaceChildren(document.createTextNode('再试一次'));}else toast(text);if(!/^没关/.test(m))tmuxLoad();return;}
  // Unknown outcome: it may have happened. Never retry on its own.
  const look=btn('刷新看看','link-btn',()=>{closeSheet();tmuxLoad();});
  if(status.isConnected){closeStatus(status,'error','结果未知：'+m.replace(/^关闭结果未知：/,'')+'。刷新看看，别直接再点',look);lock();}
  else toast('关闭结果未知，刷新列表看看，别直接再点');}}
function tmuxAfterClose(p,scope){
 const st=tmuxState();if(st){st.panes=st.panes.filter(x=>scope==='session'?x.session!==p.session:x.pane_id!==p.pane_id);st.sig='';}
 const gone=x=>x&&(scope==='session'?x.session===p.session:x.pane_id===p.pane_id);
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
 const box=sheet('新建 tmux 会话');box.classList.add('new-sheet','tmux-new');
 const body=el('div','new-body');box.append(body);
 body.append(el('p','fine tmux-new-lead','开一个新的 tmux 会话（后台运行，不会抢电脑屏幕），开好后直接打开它的终端。'));
 const f={name:'',dir:'',custom:false};
 // Name
 body.append(el('div','section-label','名字 · 可不填'));
 const name=el('input','field tmux-name');name.type='text';name.placeholder='不填就自动起名';name.autocomplete='off';name.spellcheck=false;name.maxLength=64;
 name.setAttribute('aria-label','会话名字');name.setAttribute('autocapitalize','off');name.setAttribute('enterkeyhint','done');
 const nameNote=el('p','fine tmux-name-note','英文字母、数字、- 和 _');body.append(name,nameNote);
 const nameOk=()=>{const v=name.value.trim();const used=v&&tmuxPanes().some(p=>p.session===v);const bad=v&&!TMUX_NAME_RE.test(v);
  nameNote.textContent=bad?'只能用英文字母、数字、- 和 _，不能以 - 开头':used?'已经有叫 '+v+' 的会话了，换个名字':'英文字母、数字、- 和 _';nameNote.classList.toggle('bad',!!(bad||used));return !bad&&!used;};
 name.oninput=()=>{f.name=name.value.trim();nameOk();};
 // Directory: home first, then where tmux panes are and recent projects.
 body.append(el('div','section-label','在哪个目录'));
 const dirList=el('div','new-dirs');dirList.setAttribute('role','radiogroup');dirList.setAttribute('aria-label','起始目录');body.append(dirList);
 const pathInput=el('input','field new-path');pathInput.type='text';pathInput.placeholder='~/projects/app';pathInput.autocomplete='off';pathInput.spellcheck=false;pathInput.setAttribute('aria-label','目录路径');pathInput.setAttribute('autocapitalize','off');
 pathInput.oninput=()=>{f.dir=pathInput.value.trim();};
 let info=TX_NEW.infoFor===S.device.id?TX_NEW.info:null,showAll=false;
 const home=()=>info?.home||'~';
 const short=p=>{const h=info?.home;return h&&(p===h||p.startsWith(h+'/'))?'~'+p.slice(h.length):p;};
 const base=p=>info?.home&&p.replace(/\/+$/,'')===info.home?'家目录':p.split('/').filter(Boolean).pop()||'/';
 function dirs(){const list=[{path:home(),source:'home'}];for(const d of info?.dirs||[])if(d.path!==info.home)list.push(d);return list;}
 function row(d){const on=!f.custom&&f.dir===d.path;const b=btn('','menu-item new-dir'+(on?' on':''),()=>{f.custom=false;f.dir=d.path;draw();},d.source==='home'?'account':'folder');
  b.setAttribute('role','radio');b.setAttribute('aria-checked',String(on));const t=el('span','grow');
  t.append(el('span','menu-label',d.source==='home'?'家目录':base(d.path)),el('small','truncate',d.source==='home'?short(d.path):short(d.path)+' · '+(d.source==='tmux'?'有 tmux 窗格在这':d.modified?newAgo(d.modified):'最近用过')));
  b.append(t);if(on)b.append(icon('check'));return b;}
 function draw(){dirList.replaceChildren();const all=dirs();if(!f.dir&&!f.custom)f.dir=all[0].path;
  (showAll?all:all.slice(0,5)).forEach(d=>dirList.append(row(d)));
  if(!showAll&&all.length>5)dirList.append(btn('更多目录 · '+(all.length-5),'link-btn new-more',()=>{showAll=true;draw();}));
  const other=btn('','menu-item new-dir'+(f.custom?' on':''),()=>{f.custom=true;f.dir=pathInput.value.trim();draw();setTimeout(()=>pathInput.focus(),30);},'edit');
  other.setAttribute('role','radio');other.setAttribute('aria-checked',String(f.custom));const t=el('span','grow');t.append(el('span','menu-label','其他目录'),el('small','','家目录下的路径，要已经存在'));other.append(t);dirList.append(other);
  if(f.custom)dirList.append(pathInput);
  if(!info)dirList.append(el('p','fine tmux-dir-loading','正在读取最近用过的目录…'));
  // The suggestions failed: say so, but 家目录 and a typed path still work (the bridge expands ~).
  else if(info.error)dirList.append(el('p','fine tmux-dir-loading bad','读不到最近用过的目录（'+info.error+'），家目录和手填的路径照样能用'));}
 draw();
 const foot=el('div','new-foot');body.append(foot);
 const status=el('div','new-status hidden');status.setAttribute('role','status');status.setAttribute('aria-live','polite');foot.append(status);
 const acts=el('div','sheet-actions');const go=btn('新建','primary',()=>tmuxNewSubmit(f,go,status,nameOk,name),'plus');go.setAttribute('aria-label','开始新建 tmux 会话');
 acts.append(btn('取消','secondary',closeSheet),go);foot.append(acts);
 if(!info){try{const r=await remote('tmuxInfo');if(!box.isConnected)return;info=r;TX_NEW.info=r;TX_NEW.infoFor=S.device?.id||'';
   if(f.dir==='~')f.dir=r.home;draw();
   if(r.available===false){newStatus(status,'error','这台电脑上没找到 tmux，先装上（sudo apt install tmux 或 brew install tmux）');go.disabled=true;}}
  catch(e){if(!box.isConnected)return;const m=e.message||String(e);
   if(/Unknown operation|不支持的操作/.test(m)){info={home:'',dirs:[]};draw();newStatus(status,'error','电脑上的桥接程序太旧，先到「设备」里更新桥接程序');go.disabled=true;return;}
   info={home:'',dirs:[],error:m.slice(0,120)};draw();}}}
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
  if(/Unknown operation|不支持的操作/.test(m)){newStatus(status,'error','电脑上的桥接程序太旧，先到「设备」里更新桥接程序');return;}
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
  baseLive(main);if(S.device&&!(S.liveLoading&&!S.agents.length))tmuxSection(main);};
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
// The list follows tmux while it is on screen (new sessions, windows renamed, commands changing):
// every 4 s while a tmux agent works or waits, else every 8 s. An open chat follows its pane on the
// status beat (refreshStatus above).
TX.tick=0;
setInterval(()=>{if(!S.active||(typeof T!=='undefined'&&T.view)||S.chat)return;const hot=tmuxAgents().some(a=>['working','blocked'].includes(a.agent_status));
 if((hot||++TX.tick%2===0)&&S.tab==='live')tmuxLoad();},4000);
