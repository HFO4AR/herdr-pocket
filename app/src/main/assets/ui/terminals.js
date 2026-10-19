'use strict';
// Terminal destinations are captured objects. A late response never changes the selected target.
// T.shell: the phone's own SSH shell (kept while you look elsewhere). T.view: what is on screen; a
// live tmux attach (kind 'attach') lives only while it is on screen: leaving detaches it.
const T={view:null,shell:null,panes:[],loading:false,generation:0};
// The key bar, modifiers and direct keyboard: termkeys.js.
const TERM_FONTS=[11,12,13,15,17];
Object.assign(paths,{keyboard:'M3 7a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM7 10h.01M11 10h.01M15 10h.01M8 14h8',enterKey:'M19 6v5a3 3 0 0 1-3 3H6M9 10l-4 4 4 4',textCursor:'M9 4h6M9 20h6M12 4v16M7 9H4v6h3M17 9h3v6h-3'});
function leaveTerminal(){const v=T.view;T.view=null;T.generation++;v?.stopGlide?.();if(v?.kind==='attach')attachClose(v);}
function clearTerminals(){leaveTerminal();if(T.shell){T.shell.observer?.disconnect();T.shell.term.dispose();}T.shell=null;T.panes=[];}
// The SSH session was rebuilt: PTY channels did not survive it.
function termReconnected(){for(const e of [T.shell,T.view])if(e&&(e.kind==='ssh'||e.kind==='attach')&&!e.ended&&!e.demo){e.ended=true;
 terminalStatus(e,e.kind==='ssh'?'连接中断过，这个 SSH 终端已结束；返回列表重新打开':'连接中断过，实时连接已断开；可以重新连上');}}
// What a plain pane is running. Shells set titles like "<dir>: <command>"; a bare shell is idle.
const SHELLS=/^(bash|zsh|sh|fish|dash|ksh|tmux|login|-?bash|-?zsh)$/i;
// A shell at its prompt titles itself with its directory ("~/proj", "/srv/app"). The 会话 list's panes
// also say what runs in front (bridge `kind`, `foreground`), which wins over the title.
function paneInfo(p){
 const raw=cleanTitle(p.terminal_title_stripped||p.terminal_title||p.title||'');const dir=String(p.foreground_cwd||p.cwd||'').split('/').filter(Boolean).pop()||'~';
 const m=raw.match(/^([^:]{1,80}):\s*(.+)$/);const cmd=(m?m[2]:raw).trim();const path=!m&&/^[~/]/.test(cmd);
 let idle=!cmd||SHELLS.test(cmd)||cmd===dir||path;if(p.kind==='shell')idle=true;else if(p.kind)idle=false;
 const fg=typeof p.foreground==='string'?p.foreground:'';
 return {title:idle?'空闲 shell':(path||!cmd||SHELLS.test(cmd))&&fg?fg:cmd||fg||'终端',idle,dir,cmd};}
function paneTitle(p){const i=paneInfo(p);return i.idle?'Shell · '+i.dir:i.title;}
// The home directory as the bridge last reported it for this computer (createInfo / tmuxInfo).
function shortPath(p){const home=NEW.info?.home||NEW.homes.get(S.device?.id||'')||'';p=String(p||'');return home&&(p===home||p.startsWith(home+'/'))?'~'+p.slice(home.length):p.replace(/^\/(home|Users)\/[^/]+(?=\/|$)/,'~');}

// ─── Look: colours come from the app tokens, so the terminal follows the light / dark theme ───
function termToken(name){return getComputedStyle(document.documentElement).getPropertyValue(name).trim();}
function termTheme(){
 const ansi=termToken('--term-ansi').split(/\s+/);const at=i=>ansi[i]||undefined;
 return {background:termToken('--terminal'),foreground:termToken('--terminal-ink'),cursor:termToken('--accent-raw'),cursorAccent:termToken('--terminal'),
  selectionBackground:termToken('--term-selection'),selectionInactiveBackground:termToken('--term-selection'),
  scrollbarSliderBackground:termToken('--term-scrollbar'),scrollbarSliderHoverBackground:termToken('--term-scrollbar'),scrollbarSliderActiveBackground:termToken('--term-scrollbar'),
  black:at(0),red:at(1),green:at(2),yellow:at(3),blue:at(4),magenta:at(5),cyan:at(6),white:at(7),
  brightBlack:at(8),brightRed:at(9),brightGreen:at(10),brightYellow:at(11),brightBlue:at(12),brightMagenta:at(13),brightCyan:at(14),brightWhite:at(15)};}
// Theme switches (settings, system dark mode via window.applyTheme) repaint the live shell.
new MutationObserver(()=>{if(T.shell&&!T.shell.disposed)T.shell.term.options.theme=termTheme();}).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
function termDefaultFont(){return innerWidth<360?12:13;}
function termFontSize(){return T.font||termDefaultFont();}
// Read-only screens (chat 「终端」, the confirm panel) use the same size, a step smaller.
function termFontVar(){document.documentElement.style.setProperty('--term-fs',termFontSize()+'px');}

function terminalsPage(main){
 if(!requireDevice(main))return;
 const head=el('div','row list-actions');
 if(S.sessions.length>1){const s=btn('','pill session-pill',chooseSession,'folder');s.append(el('span','truncate',S.session||'选择会话'),icon('down'));s.setAttribute('aria-label','切换 Herdr 会话 · 当前 '+(S.session||'未选'));head.append(s);}
 const facts=el('div','grow live-status');const f=el('span','list-facts');f.append(el('span','fact-count',T.loading&&!T.panes.length?'正在读取窗格…':T.panes.length+' 个普通窗格'));facts.append(f);
 head.append(facts,ib('refresh','刷新窗格',loadPanes));main.append(head);
 // 1. The phone's own SSH shell: separate from Herdr, survives leaving this screen.
 main.append(el('div','section-label','独立 SSH'));
 const live=T.shell&&!T.shell.ended;
 const sshCard=el('div','card list-card');const open=btn('','card-button term-row ssh-row',()=>openShell().catch(error));open.setAttribute('aria-label',T.shell?'返回 SSH 终端':'打开 SSH 终端');
 const av=el('div','avatar term-av ssh');av.append(icon('globe'));if(live)av.append(el('span','status-dot ok'));
 const info=el('div','grow');info.append(el('div','card-title','SSH 终端'),el('div','card-meta truncate',(S.device?.user||'')+'@'+(S.device?.host||'')));
 const side=el('div','row-side');side.append(el('span','badge '+(live?'ok':T.shell?'muted':'plain'),live?'已打开':T.shell?'已结束':'打开'));
 open.append(av,info,side);sshCard.append(open);if(typeof filesRow==='function')sshCard.append(filesRow());main.append(sshCard);
 // 2. Herdr's plain panes (not agents), grouped by workspace. No Herdr: tmux lives in 会话.
 if(S.herdr===false){main.append(el('p','fine','这台电脑没装 Herdr。tmux 会话在「会话」里打开；这里的 SSH 终端是手机自己开的 shell。'));pullRefresh(main,loadPanes);return;}
 const label=el('div','section-label group-label');label.append(el('span','','电脑上的 Herdr 窗格'),el('span','group-count',T.loading&&!T.panes.length?'…':String(T.panes.length)));main.append(label);
 if(!T.panes.length){if(T.loading)skeleton(main,2);else{const n=el('div','empty small');n.append(el('h2','','没有普通窗格'),el('p','','Agent 在「会话」里；这里只列出 Herdr 里没跑 Agent 的终端。'));main.append(n);}}
 const groups=new Map();for(const p of T.panes){const k=p.workspace_label||'工作区';if(!groups.has(k))groups.set(k,[]);groups.get(k).push(p);}
 for(const [ws,list] of groups){if(groups.size>1)main.append(el('div','ws-label','工作区 · '+ws));const card=el('div','card list-card');
  for(const pane of list){const i=paneInfo(pane);const b=btn('','card-button term-row',()=>openPane(pane));const a=el('div','avatar term-av'+(i.idle?' idle':''));a.append(icon('terminal'));
   const t=el('div','grow');const title=el('div','card-title term-cmd'+(i.idle?' idle':''),i.title);t.append(title);
   const meta=el('div','card-meta');meta.append(el('span','',shortPath(pane.foreground_cwd||pane.cwd||'')||i.dir));if(groups.size<=1&&pane.workspace_label)meta.append(el('span','sep',pane.workspace_label));t.append(meta);
   b.append(a,t);card.append(b);}
  main.append(card);}
 main.append(el('p','fine','SSH 终端是手机自己开的 shell，不影响 Herdr。窗格是电脑上的原终端：在手机上输入，等于在电脑上敲键盘。'));
 pullRefresh(main,loadPanes);
}
async function loadPanes(){
 if(!S.device||T.loading)return;T.loading=true;const epoch=S.epoch;if(S.tab==='terminals'&&!T.view&&!S.chat)render();
 try{const sessions=await remote('sessions');if(epoch!==S.epoch)return;S.herdr=sessions.herdr!==false;S.sessions=sessions.sessions.filter(x=>x.running).map(x=>x.name);if(!S.sessions.includes(S.session))S.session=S.sessions[0]||'';
 const result=S.session?await remote('panes',{session:S.session}):{panes:[]};if(epoch!==S.epoch)return;T.panes=result.panes;
 }catch(e){if(epoch===S.epoch){T.panes=[];error(e);}}finally{T.loading=false;if(epoch===S.epoch&&S.tab==='terminals'&&!T.view)render();}
}
async function openShell(){
 if(T.shell){T.view=T.shell;renderTerminal();ptyLoop(T.shell);return;}
 if(T.opening)return;T.opening=true;const device=S.device,epoch=S.epoch;
 try{
 const response=S.demo?{id:'demo-shell'}:await rpc('shellOpen',{cols:80,rows:24});
 if(S.device!==device)return;
 const entry=ptyEntry({kind:'ssh',id:response.id,title:'SSH · '+device.name,demo:S.demo});
 T.shell=entry;
 if(entry.demo)entry.term.write('\x1b[32m离线 SSH 终端演示\x1b[0m\r\n不连接主机，不执行输入。\r\n$ ');
 if(epoch===S.epoch){T.view=entry;renderTerminal();ptyLoop(entry);}
 }finally{T.opening=false;}
}
// One xterm over a native PTY (the SSH shell, a live tmux attach): output streams in as the native
// reader wakes the page (ptyLoop), keys go out in order with a sequence number (sendShell).
function ptyEntry(fields){
 termPrefs();termFontVar();
 const term=new Terminal({fontSize:termFontSize(),fontFamily:termToken('--term-font')||'monospace',lineHeight:1.15,fontWeightBold:'600',cursorBlink:true,cursorStyle:'bar',cursorWidth:2,cursorInactiveStyle:'outline',
  scrollback:5000,minimumContrastRatio:4.5,theme:termTheme(),allowProposedApi:false});
 // Remote terminal escapes must never read/write the phone clipboard.
 term.parser.registerOscHandler(52,()=>true);
 const fit=new FitAddon.FitAddon();term.loadAddon(fit);
 const entry={term,fit,host:el('div','pty-host'),cursor:0,sequence:0,queue:Promise.resolve(),ended:false,paused:false,busy:false,draft:'',...fields};
 term.open(entry.host);
 term.onData(data=>{if(T.view!==entry||overlay.childElementCount)return;const out=tkXtermData(entry,data);if(out)sendShell(entry,out);});
 term.textarea?.addEventListener('focus',()=>{entry.focused=true;tkKbdState(entry);});
 term.textarea?.addEventListener('blur',()=>{entry.focused=false;tkKbdState(entry);});
 term.onResize(({cols,rows})=>{if(entry.demo||entry.ended)return;rpc('shellResize',{terminalId:entry.id,cols,rows}).catch(e=>{if(T.view===entry)toast(e.message);});});
 // Refit on every size change (keyboard up/down, rotation); stay at the latest line if you were there.
 // One fit per frame at most, and only when the size really changed (no layout thrash while typing).
 let size='';entry.observer=new ResizeObserver(()=>{if(T.view!==entry)return;requestAnimationFrame(()=>{if(entry.disposed)return;const s=entry.host.clientWidth+'x'+entry.host.clientHeight;if(s===size)return;size=s;
  const b=term.buffer.active,stick=b.viewportY>=b.baseY;fit.fit();if(stick)term.scrollToBottom();termJump(entry);});});entry.observer.observe(entry.host);
 term.onScroll(()=>termJump(entry));term.onWriteParsed(()=>termJump(entry,true));
 termTouchScroll(entry);
 return entry;}
// One finger drag scrolls the shell's history on touch screens (xterm itself only follows a mouse
// wheel), with a short glide after a flick. A tap still focuses the shell (直接键盘).
function termTouchScroll(entry){
 const host=entry.host;let y=null,acc=0,moved=false,v=0,t=0;entry.stopGlide=()=>cancelAnimationFrame(entry.glide);
 const line=()=>Math.max(8,entry.term.options.fontSize*1.15);
 const step=d=>{acc+=d;const n=Math.trunc(acc/line());if(n){acc-=n*line();entry.term.scrollLines(n);}};
 host.addEventListener('touchstart',e=>{entry.stopGlide();if(e.touches.length!==1){y=null;return;}y=e.touches[0].clientY;acc=0;moved=false;v=0;t=e.timeStamp;},{passive:true});
 host.addEventListener('touchmove',e=>{if(y===null||e.touches.length!==1)return;const ny=e.touches[0].clientY,d=y-ny,dt=Math.max(1,e.timeStamp-t);y=ny;t=e.timeStamp;
  v=.8*(d/dt)+.2*v;if(Math.abs(d)>0)moved=true;step(d);if(moved&&e.cancelable)e.preventDefault();},{passive:false});
 host.addEventListener('touchend',()=>{y=null;if(!moved||Math.abs(v)<.3||!termMotion())return;let last=performance.now();
  const end=last+1500,run=now=>{const dt=now-last;last=now;v*=Math.pow(.994,dt);if(Math.abs(v)<.05||now>end)return;step(v*dt);entry.glide=requestAnimationFrame(run);};entry.glide=requestAnimationFrame(run);},{passive:true});}
function openPane(pane){termPrefs();termFontVar();T.view={kind:'pane',pane,session:S.session,title:paneTitle(pane),text:S.demo?'$ pwd\n~/projects/pocket\n$ npm test\nPASS: 离线普通窗格演示\n$ ':'正在读取终端…',draft:'',paused:false,busy:false,demo:S.demo,stick:true};renderTerminal();pollTerminal();}
const isPty=entry=>entry.kind==='ssh'||entry.kind==='attach';
// Live state in words, for the header: connected, read-only, paused or ended.
function termState(entry){
 if(entry.ended)return ['off','已结束'];if(entry.paused)return ['warn','已暂停'];if(entry.demo)return ['demo','演示'];
 if(entry.kind==='attach')return entry.readOnly?['ok','实时 · 只读']:['ok','实时连接'];
 return entry.kind==='ssh'?['ok','已连接']:entry.kind==='tmux'?['ok','快照']:['ok','实时'];}
function termWhere(entry){
 if(entry.kind==='ssh')return '独立 SSH · '+S.device.user+'@'+S.device.host;
 if(entry.kind==='tmux'||entry.kind==='attach')return tmuxSub(entry);
 return 'Herdr 窗格 · '+(entry.pane.workspace_label?entry.pane.workspace_label+' · ':'')+entry.pane.pane_id;}
function renderTerminal(){
 const entry=T.view;if(!entry)return;S.chat=null;termFontVar();const root=shell();root.classList.add('terminal-shell');
 const head=el('header','chat-head term-head');head.append(ib('back',entry.kind==='tmux'||entry.kind==='attach'||S.tab==='live'?'返回列表':'返回终端列表',()=>{leaveTerminal();render();}));
 const [st,stLabel]=termState(entry);
 const av=el('div','avatar term-av'+(entry.kind==='ssh'?' ssh':''));av.append(icon(entry.kind==='ssh'?'globe':'terminal'),el('span','status-dot '+(st==='ok'?'ok':st==='warn'?'work':'')));head.append(av);
 const name=el('div','grow chat-id');const sub=el('small','term-sub');const chip=el('span','term-state '+st,stLabel);chip.id='term-state';
 sub.append(chip,el('span','term-where',termWhere(entry)));
 const h=el('h2','',entry.title);h.id='term-title';name.append(h,sub);
 head.append(name);
 // tmux: snapshot ⇄ live attach, one tap in the header.
 if((entry.kind==='tmux'||entry.kind==='attach')&&typeof tmuxLiveButton==='function'){const b=tmuxLiveButton(entry);if(b)head.append(b);}
 head.append(ib('copy','复制屏幕内容',()=>terminalCopy(entry)),ib('more','终端选项',terminalMenu));root.append(head);
 // The screen: a dark card on the warm page in light theme, a deeper well in dark theme.
 const stage=el('div','term-stage');const surface=el('div','term-surface');surface.id='term-surface';surface.classList.toggle('is-off',!!entry.ended);
 if(isPty(entry)){surface.append(entry.host);requestAnimationFrame(()=>{if(!entry.disposed){entry.fit.fit();termJump(entry);}});}
 else{const output=el('pre','pane-screen');output.id='pane-screen';output.tabIndex=0;output.setAttribute('aria-label',entry.kind==='tmux'?'tmux 窗格输出':'Herdr 窗格输出');screenUpdate(output,entry);
  output.addEventListener('scroll',()=>{entry.stick=output.scrollHeight-output.scrollTop-output.clientHeight<24;termJump(entry);},{passive:true});
  surface.append(output,tkCatcher(entry,surface));requestAnimationFrame(()=>{output.scrollTop=output.scrollHeight;});
  // The screen changes size (keyboard, the key bar's rows, rotation): stay at the latest line if you were.
  let lastH=0;new ResizeObserver(()=>{const h=output.clientHeight;if(h!==lastH){lastH=h;if(entry.stick!==false)output.scrollTop=output.scrollHeight;termJump(entry);}}).observe(output);}
 const jump=btn('','jump-btn term-jump',()=>termBottom(entry),'down');jump.id='term-jump';jump.setAttribute('aria-label','跳到最新输出');jump.hidden=true;surface.append(jump);
 stage.append(surface);root.append(stage);
 // Dock: status, keys and the line input, all within thumb reach and above the soft keyboard.
 const footer=el('footer','composer-wrap term-dock');
 const status=el('div','terminal-status');status.id='pty-status';status.setAttribute('role','status');footer.append(status);
 footer.append(tkBar(entry));
 const compose=el('div','composer term-compose');
 // 直接键盘: keys go straight to the terminal (xterm, or the pane's catcher).
 const kbd=btn('','term-kbd',()=>{tkHaptic();tkKbdToggle(entry);},'keyboard');kbd.id='term-kbd';kbd.setAttribute('aria-label','直接键盘');kbd.title='直接键盘：按键直接发到终端';kbd.addEventListener('mousedown',e=>e.preventDefault());
 // 「发送后回车」 as a compact toggle at the start of the line.
 const toggle=el('label','term-enter');const enter=el('input');enter.type='checkbox';enter.checked=entry.enter!==false;enter.id='terminal-enter';enter.setAttribute('aria-label','发送后回车');
 enter.onchange=()=>{entry.enter=enter.checked;};toggle.title='发送后回车';toggle.append(enter,icon('enterKey'),el('span','','回车'));
 const input=el('textarea');input.rows=1;input.placeholder=isPty(entry)?'输入命令…':'输入命令或文字…';input.setAttribute('aria-label','终端输入');input.setAttribute('autocapitalize','off');input.setAttribute('autocomplete','off');input.setAttribute('autocorrect','off');input.setAttribute('enterkeyhint','send');input.spellcheck=false;input.value=entry.draft;
 const send=btn('执行','primary term-run',()=>{if(typeof haptic==='function')haptic('confirm');sendTerminalLine(entry,input);});send.addEventListener('mousedown',e=>e.preventDefault());
 const grow=()=>{input.style.height='auto';input.style.height=Math.min(input.scrollHeight,innerHeight<560?60:96)+'px';send.disabled=!input.value;};
 input.oninput=()=>{entry.draft=input.value;grow();};
 // Enter on the soft keyboard runs the line (Shift+Enter keeps a newline). IME composition is left alone.
 input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();sendTerminalLine(entry,input);}});
 input.addEventListener('beforeinput',e=>{if((e.inputType==='insertLineBreak'||e.inputType==='insertParagraph')&&!e.isComposing){e.preventDefault();sendTerminalLine(entry,input);}});
 compose.append(kbd,toggle,input,send);footer.append(compose);root.append(footer);
 requestAnimationFrame(grow);
 // The toast sits above the dock, not on top of the keys.
 const dockSize=new ResizeObserver(()=>document.documentElement.style.setProperty('--term-dock-h',footer.offsetHeight+'px'));dockSize.observe(footer);
 paintStatus(entry);tkKbdState(entry);
}
function paneText(text){return String(text||'').replace(/\s+$/,'');}
// Status notice above the keys, with the one action that gets you going again.
function paintStatus(entry){
 if(T.view!==entry)return;const n=document.getElementById('pty-status');if(!n)return;n.replaceChildren();
 const text=entry.notice||(entry.ended?'终端已结束':entry.paused?'刷新已暂停，输入已禁用':'');
 n.classList.toggle('show',!!text);n.classList.toggle('off',!!entry.ended);
 const chip=document.getElementById('term-state');if(chip){const [st,label]=termState(entry);chip.className='term-state '+st;chip.textContent=label;}
 const surface=document.getElementById('term-surface');if(surface)surface.classList.toggle('is-off',!!entry.ended);
 if(!text)return;n.append(icon(entry.ended?'x':'alert'),el('span','grow',text));
 if(entry.kind==='ssh'&&entry.ended)n.append(btn('重新打开','link-btn',()=>reopenShell(entry)));
 else if(entry.kind==='attach'&&entry.ended)n.append(btn('重新连接','link-btn',()=>attachReopen(entry)));
 else if(!isPty(entry)&&entry.paused)n.append(btn('恢复读取','link-btn',()=>{entry.paused=false;entry.notice='';paintStatus(entry);pollTerminal();}));}
async function reopenShell(entry){
 if(T.shell!==entry)return;try{if(!entry.demo)await rpc('shellClose',{terminalId:entry.id});}catch(_){/* already gone */}
 if(T.shell!==entry)return;entry.disposed=true;entry.observer.disconnect();entry.term.dispose();T.shell=null;T.view=null;openShell().catch(error);}
// Jump-to-latest: shown while you read back; a dot when new output arrived below.
function termAtBottom(entry){
 if(isPty(entry)){if(entry.disposed)return true;const b=entry.term.buffer.active;return b.viewportY>=b.baseY;}
 const n=document.getElementById('pane-screen');return !n||n.scrollHeight-n.scrollTop-n.clientHeight<24;}
function termJump(entry,output){
 if(T.view!==entry)return;const j=document.getElementById('term-jump');if(!j)return;const bottom=termAtBottom(entry);
 if(bottom)j.classList.remove('has-new');else if(output&&!j.hidden)j.classList.add('has-new');j.hidden=bottom;}
function termBottom(entry){
 entry.stopGlide?.();if(isPty(entry))entry.term.scrollToBottom();else{const n=document.getElementById('pane-screen');if(n)termGlideBottom(n);entry.stick=true;}
 termJump(entry);}
// Short distances glide, long ones jump (a long smooth scroll through a log feels slow).
function termGlideBottom(n){const far=n.scrollHeight-n.scrollTop-n.clientHeight>n.clientHeight*2;n.scrollTo({top:n.scrollHeight,behavior:termMotion()&&!far?'smooth':'auto'});}
function termMotion(){return !document.documentElement.classList.contains('reduce-motion')&&!matchMedia('(prefers-reduced-motion: reduce)').matches;}
// Font size and the screen copy are per phone (kept in the per-device cache when connected).
async function termPrefs(){if(T.prefsLoaded)return;T.prefsLoaded=true;const v=await cacheGet('term:prefs');if(v?.font&&TERM_FONTS.includes(v.font)&&!T.fontSet)termFont(v.font,false);}
function termFont(n,save=true){T.font=n;T.fontSet=save||T.fontSet;termFontVar();
 for(const e of new Set([T.shell,T.view]))if(e&&isPty(e)&&!e.disposed){e.term.options.fontSize=n;if(T.view===e)requestAnimationFrame(()=>{if(e.disposed)return;const b=e.term.buffer.active,stick=b.viewportY>=b.baseY;e.fit.fit();if(stick)e.term.scrollToBottom();});}
 if(save)cachePut('term:prefs',{font:n});}
function terminalText(entry){
 if(!isPty(entry))return paneText(entry.text);
 const sel=entry.term.getSelection();if(sel)return sel;const b=entry.term.buffer.active,out=[];
 for(let i=b.viewportY;i<b.viewportY+entry.term.rows&&i<b.length;i++)out.push(b.getLine(i)?.translateToString(true)||'');
 return out.join('\n').replace(/\s+$/,'');}
// Everything the shell still holds (scrollback included), for touch selection.
function terminalAllText(entry){
 if(!isPty(entry))return paneText(entry.text);const b=entry.term.buffer.active,out=[];
 for(let i=Math.max(0,b.length-2000);i<b.length;i++){const l=b.getLine(i);if(!l)continue;if(l.isWrapped&&out.length)out[out.length-1]+=l.translateToString(true);else out.push(l.translateToString(true));}
 return out.join('\n').replace(/\s+$/,'');}
function terminalCopy(entry){const t=terminalText(entry);if(!t.trim()){toast('屏幕上没有可复制的内容');return;}copyText(t);}
// Touch selection: the text in a plain, selectable view (long-press, drag the handles, copy).
function terminalSelect(entry){
 const t=terminalAllText(entry);const box=sheet('选择文字');box.classList.add('select-sheet');box.append(el('p','fine','长按拖动选择需要的部分。'));
 const pre=el('pre','select-text term-select',t||'屏幕上没有文字');box.append(pre);
 const row=el('div','sheet-actions');row.append(btn('复制全部','secondary',()=>{copyText(t);closeSheet();}));box.append(row);
 requestAnimationFrame(()=>{pre.scrollTop=pre.scrollHeight;});}
function sendShell(entry,text){
 if(entry.demo){toast('终端演示：未发送');return Promise.resolve(false);}
 if(entry.ended||entry.paused){toast('终端不可输入，请重新打开终端');return Promise.resolve(false);}
 if(entry.readOnly){toast('只读连接：按键不会发出');return Promise.resolve(false);}
 entry.inputAt=performance.now();
 // Serialize to preserve key order. Failure freezes this stream rather than replaying unknown writes.
 entry.queue=entry.queue.then(async()=>{if(entry.ended||entry.paused)return false;try{await rpc('shellWrite',{terminalId:entry.id,sequence:++entry.sequence,text});return true;}catch(e){entry.paused=true;terminalStatus(entry,'输入结果未知，已停止后续输入；请检查终端。'+e.message);return false;}});
 return entry.queue;
}
// A refusal the bridge made before writing anything ("没发出去：…") leaves input open; anything else
// may have reached the pane, so input pauses and nothing is resent.
async function sendPane(entry,op,args){if(entry.demo){toast('终端演示：未发送');return false;}if(entry.paused||entry.ended)throw Error('终端已暂停，请刷新检查');
 try{if(entry.kind==='tmux')await tmuxSend(entry,op,args);else await remote(op,{session:entry.session,target:entry.pane.pane_id,identity:entry.pane.identity,id:uuid(),...args});entry.fast=performance.now();pollSoon(entry);return true;}
 catch(e){if(/^没发出去/.test(e.message||''))throw e;entry.paused=true;terminalStatus(entry,'输入未确认，已暂停；不会重发。'+e.message);throw e;}}
async function sendTerminalLine(entry,input){
 const text=input.value;if(!text)return;const enter=document.getElementById('terminal-enter').checked;
 // A latched modifier and one character: that key with the modifier (Ctrl + c in the line = Ctrl+C).
 if(tkLatched(entry)&&[...text].length===1&&/^[!-~ ]$/.test(text)){const k=text===' '?'space':/[A-Z]/.test(text)?'shift+'+text.toLowerCase():text;
  if(tkPress(entry,k)){entry.draft='';input.value='';input.oninput?.();}return;}
 if(entry.sending)return;entry.sending=true;
 try{const sent=isPty(entry)?await sendShell(entry,text+(enter?'\r':'')):await sendPane(entry,enter?'paneRun':'paneText',{text});if(sent&&entry.draft===text){entry.draft='';if(input.value===text){input.value='';input.oninput?.();}}if(sent&&T.view===entry){entry.stopGlide?.();if(isPty(entry))entry.term.scrollToBottom();else entry.stick=true;}}catch(e){error(e);}finally{entry.sending=false;}
}
function terminalStatus(entry,text){entry.notice=text;paintStatus(entry);}

// ─── Reading ────────────────────────────────────────────────────────────────
// PTY terminals: the native reader wakes the page when bytes arrive (window.ptyWake); the loop reads
// until the ring is drained, then waits for the next wake (a slow fallback read covers a missed one).
// Pane snapshots (Herdr pane read, tmux capture-pane) have no stream: they are read fast right after
// input and while the screen keeps changing, and back off to a slow read when nothing happens.
const PTY_WAKE=new Map();
window.ptyWake=id=>{const f=PTY_WAKE.get(id);if(f){PTY_WAKE.delete(id);f();}};
async function ptyLoop(entry){
 if(entry.looping||entry.demo)return;entry.looping=true;
 try{while(T.view===entry&&S.active&&!entry.ended&&!entry.disposed){
  // Register the wake before the read: bytes can arrive between the native read and this page's
  // continuation, and a wake delivered in that window must not be lost (it used to wait 3 s).
  let wake;const woke=new Promise(resolve=>{wake=resolve;PTY_WAKE.set(entry.id,wake);});
  let r;try{r=await rpc('shellRead',{terminalId:entry.id,cursor:entry.cursor,wait:true});}
  catch(e){if(T.view===entry&&!entry.ended){entry.ended=true;terminalStatus(entry,'读取失败：'+e.message);}break;}
  if(r.lost){entry.term.reset();terminalStatus(entry,'离开期间输出超过缓存，显示最近内容。');}
  const bytes=Uint8Array.from(atob(r.data),c=>c.charCodeAt(0));
  if(bytes.length){const t0=performance.now();await new Promise(resolve=>entry.term.write(bytes,resolve));termMark(entry,'pty',t0,bytes.length);}
  entry.cursor=r.next;
  if(r.ended&&bytes.length===0){entry.ended=true;terminalStatus(entry,r.error||(entry.kind==='attach'?'tmux 连接已断开（会话还在电脑上）。':'SSH shell 已结束，可以重新打开。'));break;}
  if(bytes.length){PTY_WAKE.delete(entry.id);continue;}
  // Nothing new: wait for the native wake, or a fallback read now and then.
  await new Promise(resolve=>{const timer=setTimeout(resolve,r.armed?3000:250);woke.then(()=>{clearTimeout(timer);resolve();});});
  PTY_WAKE.delete(entry.id);}}
 finally{PTY_WAKE.delete(entry.id);entry.looping=false;}}
// Performance marks (chrome://inspect → Performance): key press → bytes on screen.
function termMark(entry,what,t0,n){try{performance.measure('term:'+what,{start:t0,end:performance.now(),detail:{bytes:n}});
 if(entry.inputAt){performance.measure('term:key-to-screen',{start:entry.inputAt,end:performance.now()});entry.inputAt=0;}}catch(_){/* old WebView */}}
function pollSoon(entry){entry.fast=performance.now();if(T.view===entry&&!isPty(entry)){clearTimeout(entry.timer);entry.timer=setTimeout(()=>snapLoop(entry),20);}}
// Delay before the next snapshot read.
function snapDelay(entry){const now=performance.now();
 if(entry.fast&&now-entry.fast<2500)return 180;
 if(entry.changedAt&&now-entry.changedAt<3000)return 250;
 const idle=now-Math.max(entry.changedAt||0,entry.fast||0);return idle<10000?600:idle<60000?1200:2000;}
async function snapLoop(entry){
 clearTimeout(entry.timer);if(entry.busy){entry.again=true;return;}
 if(T.view!==entry||!S.active||entry.demo||entry.paused||entry.ended)return;
 entry.busy=true;entry.loopAt=performance.now();let changed=false;
 try{changed=entry.kind==='tmux'?await tmuxPoll(entry):await panePoll(entry);}
 catch(e){entry.paused=true;terminalStatus(entry,'读取失败，已暂停：'+e.message);}
 finally{entry.busy=false;}
 if(changed)entry.changedAt=performance.now();
 if(T.view!==entry||entry.paused||entry.ended)return;
 const wait=entry.again?20:snapDelay(entry);entry.again=false;entry.timer=setTimeout(()=>snapLoop(entry),wait);}
// Herdr: the bridge answers {same: true} when the pane's revision did not move since the last read.
async function panePoll(entry){
 const r=await remote('paneRead',{session:entry.session,target:entry.pane.pane_id,identity:entry.pane.identity,...(entry.revision!==undefined?{revision:entry.revision}:{})});
 if(T.view!==entry)return false;if(typeof r.revision==='number')entry.revision=r.revision;
 if(r.same||r.text===entry.text&&(r.ansi||'')===(entry.ansi||''))return false;
 entry.text=r.text;entry.ansi=r.ansi||'';const n=document.getElementById('pane-screen');if(n)screenUpdate(n,entry);return true;}
function pollTerminal(){const entry=T.view;if(!entry||!S.active)return;if(isPty(entry)){ptyLoop(entry);return;}
 if(!entry.busy&&performance.now()-(entry.loopAt||0)>snapDelay(entry)+1500)snapLoop(entry);}

// ─── Painting a snapshot: only the lines that changed ──────────────────────────
// A pane snapshot is the last few hundred lines. New output scrolls them up, so the new screen is the
// old one shifted by k lines plus a changed tail: the shift drops k rows at the top, the rest is
// compared line by line and only differing rows are rebuilt. Unchanged rows keep their nodes, so a
// selection, the scroll position and the layout of everything above stay put.
function screenUpdate(box,entry){
 const t0=performance.now();const text=paneText(entry.text),ansi=entry.ansi||'';
 let keys,make;
 if(ansi){let lines=ansiLines(ansi);while(lines.length&&!lines[lines.length-1].some(r=>r.t.trim()||(r.s.bg!==undefined)))lines.pop();
  const P=ansiPalette();keys=lines.map(l=>JSON.stringify(l));make=i=>ansiLine(lines[i],P);box.classList.add('ansi');box.classList.toggle('raw',!!ANSI.raw);}
 else{const lines=text.split('\n');keys=lines;make=i=>el('div','pl',lines[i]);box.classList.remove('ansi');box.classList.toggle('raw',false);}
 const sig=(ansi?'a':'t')+(ansi?ansiPalette().bg:'');if(box._sig!==sig){box._sig=sig;box._keys=null;}
 const old=box._keys;const stick=entry.stick!==false;
 if(!old||!old.length||box.childElementCount!==old.length){box.replaceChildren(...keys.map((_,i)=>make(i)));}
 else{let shift=0;
  // Find how far the old screen scrolled: the old line that is now the first one.
  if(keys.length&&old[0]!==keys[0]){const at=old.indexOf(keys[0]);if(at>0){let ok=true;for(let j=1;j<Math.min(24,old.length-at);j++)if(old[at+j]!==keys[j]){ok=j>=old.length-at-2;break;}if(ok)shift=at;}}
  for(let i=0;i<shift;i++)box.firstElementChild.remove();
  const base=old.slice(shift),kids=box.children;let i=0;
  for(;i<keys.length&&i<base.length;i++)if(base[i]!==keys[i])kids[i].replaceWith(make(i));
  for(let j=kids.length-1;j>=keys.length;j--)kids[j].remove();
  if(i<keys.length){const frag=document.createDocumentFragment();for(;i<keys.length;i++)frag.append(make(i));box.append(frag);}}
 box._keys=keys;
 if(stick)box.scrollTop=box.scrollHeight;termJump(entry,true);
 try{performance.measure('term:paint',{start:t0,end:performance.now(),detail:{lines:keys.length}});}catch(_){/* old WebView */}}

function terminalMenu(){const entry=T.view;const box=sheet('终端选项');
 const size=el('div','term-size');const cur=el('span','grow','字号 · '+termFontSize());
 const step=d=>{const at=TERM_FONTS.indexOf(termFontSize());const i=Math.max(0,Math.min(TERM_FONTS.length-1,(at<0?2:at)+d));termFont(TERM_FONTS[i]);cur.textContent='字号 · '+TERM_FONTS[i];};
 size.append(cur,btn('A−','secondary small',()=>step(-1)),btn('A+','secondary small',()=>step(1)));size.querySelectorAll('button')[0].setAttribute('aria-label','字号小一点');size.querySelectorAll('button')[1].setAttribute('aria-label','字号大一点');box.append(size);
 menuItem(box,isPty(entry)&&entry.term.hasSelection()?'复制选中内容':'复制屏幕内容',()=>terminalCopy(entry),'copy');
 menuItem(box,'选择文字',()=>terminalSelect(entry),'textCursor','长按选择任意一段，含往上的历史');
 menuItem(box,'自定义按键…',()=>tkEditSheet(),'edit','选哪些键显示、怎么排');
 menuItem(box,'刷新 / 恢复读取',()=>{if(!isPty(entry)){entry.paused=false;entry.notice='';paintStatus(entry);pollSoon(entry);}else if(entry.paused){toast('输入异常后需关闭并重新打开；不自动恢复输入');return;}else pollTerminal();},'refresh');
 menuItem(box,'回到底部',()=>termBottom(entry),'down');
 if(typeof filesTermItem==='function'&&entry.kind!=='attach')filesTermItem(box,entry);
 if(entry.kind==='tmux'||entry.kind==='attach')tmuxMenu(box);
 if(entry.kind==='pane'&&!entry.demo&&typeof hpMenu==='function')hpMenu(box,entry);
 if(entry.kind==='ssh')menuItem(box,'关闭 SSH shell',()=>confirmAction('关闭 SSH shell？','这会关闭独立 SSH 通道，里面运行的程序可能随之结束。Herdr 窗格不受影响。','关闭 shell',async()=>{try{if(!entry.demo)await rpc('shellClose',{terminalId:entry.id});entry.disposed=true;entry.observer.disconnect();entry.term.dispose();if(T.shell===entry)T.shell=null;leaveTerminal();render();}catch(e){error(e);}},true),'x','里面运行的程序可能随之结束');
 else if(entry.kind==='attach')box.append(el('p','fine','返回列表会断开这个实时连接（tmux detach），会话照样在电脑上跑。'));
 else box.append(el('p','fine','返回列表只退出手机查看，不关闭电脑上的窗格。'));
}
// ─── Live tmux attach ─────────────────────────────────────────────────────────
// A real tmux client on a PTY of its own (native shellOpen with `attach`): the bridge re-checks the
// pane's identity, then execs `tmux attach-session -t <session>` (-r: read-only, which also leaves the
// window size alone). Output streams like the SSH shell. Leaving detaches; nothing is resent.
async function attachOpen(p,readOnly){
 if(S.demo){toast('演示模式：不会真的连上 tmux');return;}
 if(T.attaching)return;T.attaching=true;const device=S.device,epoch=S.epoch;
 try{
  // Size it the way the screen will show it, so tmux draws the right size from the first frame.
  const r=await rpc('shellOpen',{cols:Math.max(20,Math.floor((innerWidth-30)/(termFontSize()*0.6))),rows:Math.max(8,Math.floor((innerHeight-260)/(termFontSize()*1.15))),attach:{target:p.pane_id,identity:p.identity,readOnly:!!readOnly}});
  if(S.device!==device||epoch!==S.epoch){rpc('shellClose',{terminalId:r.id}).catch(()=>{});return;}
  if(T.view)leaveTerminal();
  const entry=ptyEntry({kind:'attach',id:r.id,pane:p,title:tmuxTitle(p),readOnly:!!readOnly,demo:false});
  T.view=entry;renderTerminal();ptyLoop(entry);
  if(!p.active)terminalStatus(entry,'电脑上这个会话正显示别的窗口：实时连接看到的是它当前的窗口。用 ^B 加数字切换（电脑上也会跟着切）。');
 }catch(e){toast(/不支持的终端操作|Unknown/.test(e.message||'')?'这版 App 的原生层不支持实时连接':'没连上：'+(e.message||e));}
 finally{T.attaching=false;}}
function attachClose(entry){if(entry.disposed)return;entry.disposed=true;entry.stopGlide?.();entry.observer?.disconnect();try{entry.term.dispose();}catch(_){/* gone */}
 if(!entry.demo&&!entry.closed){entry.closed=true;rpc('shellClose',{terminalId:entry.id}).catch(()=>{});}}
function attachReopen(entry){const p=entry.pane,ro=entry.readOnly;leaveTerminal();attachOpen(p,ro);}
// Read-only agent screen (chat 「终端」 tab): a terminal card that keeps the latest lines in view
// while you are at the bottom, and offers a way back when you scrolled up to read.
function termAgentView(text,refresh,ansi){
 termPrefs();termFontVar();
 const card=el('section','term-card');card.setAttribute('aria-label','终端画面');
 const head=el('div','term-card-head');const live=!!S.chat?.agent;
 head.append(el('span','term-led'+(live?' on':'')),el('span','term-card-title','终端画面'),el('span','term-card-note grow',live?'只读 · 自动刷新':'只读'));
 const pre=el('pre','agent-terminal');pre.id='terminal-output';pre.tabIndex=0;screenPaint(pre,text,ansi);
 if(live)head.append(ansiRawToggle(()=>pre));
 if(refresh){refresh.classList.add('term-card-refresh');head.append(refresh);}card.append(head,pre);
 const jump=btn('','jump-btn term-jump',()=>{termGlideBottom(pre);},'down');jump.setAttribute('aria-label','跳到最新输出');jump.hidden=true;card.append(jump);
 let stick=true;const check=()=>{const bottom=pre.scrollHeight-pre.scrollTop-pre.clientHeight<24;stick=bottom;jump.hidden=bottom;};
 pre.addEventListener('scroll',check,{passive:true});
 new MutationObserver(()=>{if(stick)pre.scrollTop=pre.scrollHeight;else jump.classList.add('has-new');}).observe(pre,{childList:true,characterData:true,subtree:true});
 requestAnimationFrame(()=>{pre.scrollTop=pre.scrollHeight;check();});
 return card;}
// A safety net: restarts a read loop that stopped (back from the background, a resumed read).
setInterval(()=>{if(T.view&&S.active)pollTerminal();},2000);
