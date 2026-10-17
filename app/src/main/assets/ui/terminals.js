'use strict';
// Terminal destinations are captured objects. A late response never changes the selected target.
const T={view:null,shell:null,panes:[],loading:false,generation:0};
// Key bar, most used first, in groups. Ctrl (SSH only) latches: the next letter goes out as Ctrl+letter.
const terminalKeys=[['Esc','\x1b','esc'],['Tab','\t','tab'],['Ctrl','','ctrl'],['↑','\x1b[A','up'],['↓','\x1b[B','down'],['←','\x1b[D','left'],['→','\x1b[C','right'],['Enter','\r','enter'],['Ctrl+C','\x03','ctrl+c'],['Ctrl+D','\x04','ctrl+d'],['⌫','\x7f','backspace']];
// Characters that are awkward on a phone keyboard. SSH only (Herdr panes accept named keys only).
const TERM_CHARS=['~','/','|','-'];
const TERM_KEY_NAMES={'↑':'上','↓':'下','←':'左','→':'右','⌫':'退格'};
const TERM_FONTS=[11,12,13,15,17];
Object.assign(paths,{keyboard:'M3 7a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM7 10h.01M11 10h.01M15 10h.01M8 14h8',enterKey:'M19 6v5a3 3 0 0 1-3 3H6M9 10l-4 4 4 4',textCursor:'M9 4h6M9 20h6M12 4v16M7 9H4v6h3M17 9h3v6h-3'});
function leaveTerminal(){T.view=null;T.generation++;}
function clearTerminals(){leaveTerminal();if(T.shell){T.shell.observer?.disconnect();T.shell.term.dispose();}T.shell=null;T.panes=[];}
// What a plain pane is running. Shells set titles like "<dir>: <command>"; a bare shell is idle.
const SHELLS=/^(bash|zsh|sh|fish|dash|ksh|tmux|login|-?bash|-?zsh)$/i;
function paneInfo(p){
 const raw=cleanTitle(p.terminal_title_stripped||p.terminal_title||p.title||'');const dir=String(p.foreground_cwd||p.cwd||'').split('/').filter(Boolean).pop()||'~';
 const m=raw.match(/^([^:]{1,80}):\s*(.+)$/);const cmd=(m?m[2]:raw).trim();const idle=!cmd||SHELLS.test(cmd)||cmd===dir;
 return {title:idle?'空闲 shell':cmd,idle,dir,cmd};}
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
 if(T.shell){T.view=T.shell;renderTerminal();return;}
 if(T.opening)return;T.opening=true;const device=S.device,epoch=S.epoch;
 try{
 const response=S.demo?{id:'demo-shell'}:await rpc('shellOpen',{cols:80,rows:24});
 if(S.device!==device)return;
 termPrefs();termFontVar();
 const term=new Terminal({fontSize:termFontSize(),fontFamily:termToken('--term-font')||'monospace',lineHeight:1.15,fontWeightBold:'600',cursorBlink:true,cursorStyle:'bar',cursorWidth:2,cursorInactiveStyle:'outline',
  scrollback:5000,minimumContrastRatio:4.5,theme:termTheme(),allowProposedApi:false});
 // Remote terminal escapes must never read/write the phone clipboard.
 term.parser.registerOscHandler(52,()=>true);
 const fit=new FitAddon.FitAddon();term.loadAddon(fit);
 const entry={kind:'ssh',id:response.id,title:'SSH · '+device.name,term,fit,host:el('div','pty-host'),cursor:0,sequence:0,queue:Promise.resolve(),ended:false,paused:false,busy:false,draft:'',demo:S.demo};
 T.shell=entry;term.open(entry.host);
 term.onData(data=>{if(T.view!==entry||overlay.childElementCount)return;if(entry.ctrl&&data.length===1){const c=ctrlCode(data);termCtrl(entry,false);if(c){sendShell(entry,c);return;}}sendShell(entry,data);});
 term.onResize(({cols,rows})=>{if(entry.demo||entry.ended)return;rpc('shellResize',{terminalId:entry.id,cols,rows}).catch(e=>{if(T.shell===entry)toast(e.message);});});
 // Refit on every size change (keyboard up/down, rotation); stay at the latest line if you were there.
 entry.observer=new ResizeObserver(()=>{if(T.view!==entry)return;requestAnimationFrame(()=>{if(entry.disposed)return;const b=term.buffer.active,stick=b.viewportY>=b.baseY;fit.fit();if(stick)term.scrollToBottom();termJump(entry);});});entry.observer.observe(entry.host);
 term.onScroll(()=>termJump(entry));term.onWriteParsed(()=>termJump(entry,true));
 termTouchScroll(entry);
 if(entry.demo)term.write('\x1b[32m离线 SSH 终端演示\x1b[0m\r\n不连接主机，不执行输入。\r\n$ ');
 if(epoch===S.epoch){T.view=entry;renderTerminal();}
 }finally{T.opening=false;}
}
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
// Live state in words, for the header: connected, read-only, paused or ended.
function termState(entry){
 if(entry.ended)return ['off','已结束'];if(entry.paused)return ['warn','已暂停'];if(entry.demo)return ['demo','演示'];
 return entry.kind==='ssh'?['ok','已连接']:['ok','实时'];}
function renderTerminal(){
 const entry=T.view;if(!entry)return;S.chat=null;termFontVar();const root=shell();root.classList.add('terminal-shell');
 const head=el('header','chat-head term-head');head.append(ib('back',entry.kind==='tmux'?'返回列表':'返回终端列表',()=>{leaveTerminal();render();}));
 const [st,stLabel]=termState(entry);
 const av=el('div','avatar term-av'+(entry.kind==='ssh'?' ssh':''));av.append(icon(entry.kind==='ssh'?'globe':'terminal'),el('span','status-dot '+(st==='ok'?'ok':st==='warn'?'work':'')));head.append(av);
 const name=el('div','grow chat-id');const sub=el('small','term-sub');const chip=el('span','term-state '+st,stLabel);chip.id='term-state';
 sub.append(chip,el('span','term-where',entry.kind==='ssh'?'独立 SSH · '+S.device.user+'@'+S.device.host:entry.kind==='tmux'?tmuxSub(entry):'Herdr 窗格 · '+(entry.pane.workspace_label?entry.pane.workspace_label+' · ':'')+entry.pane.pane_id));
 const h=el('h2','',entry.title);h.id='term-title';name.append(h,sub);
 head.append(name,ib('copy','复制屏幕内容',()=>terminalCopy(entry)),ib('more','终端选项',terminalMenu));root.append(head);
 // The screen: a dark card on the warm page in light theme, a deeper well in dark theme.
 const stage=el('div','term-stage');const surface=el('div','term-surface');surface.id='term-surface';surface.classList.toggle('is-off',!!entry.ended);
 if(entry.kind==='ssh'){surface.append(entry.host);requestAnimationFrame(()=>{if(!entry.disposed){entry.fit.fit();termJump(entry);}});}
 else{const output=el('pre','pane-screen',paneText(entry.text));output.id='pane-screen';output.tabIndex=0;output.setAttribute('aria-label',entry.kind==='tmux'?'tmux 窗格输出':'Herdr 窗格输出');if(entry.ansi)screenPaint(output,paneText(entry.text),entry.ansi);
  output.addEventListener('scroll',()=>{entry.stick=output.scrollHeight-output.scrollTop-output.clientHeight<24;termJump(entry);},{passive:true});
  surface.append(output);requestAnimationFrame(()=>{output.scrollTop=output.scrollHeight;});}
 const jump=btn('','jump-btn term-jump',()=>termBottom(entry),'down');jump.id='term-jump';jump.setAttribute('aria-label','跳到最新输出');jump.hidden=true;surface.append(jump);
 stage.append(surface);root.append(stage);
 // Dock: status, keys and the line input, all within thumb reach and above the soft keyboard.
 const footer=el('footer','composer-wrap term-dock');
 const status=el('div','terminal-status');status.id='pty-status';status.setAttribute('role','status');footer.append(status);
 const keys=el('div','terminal-keys');keys.setAttribute('role','toolbar');keys.setAttribute('aria-label','终端按键');
 const group=cls=>{const g=el('div','key-group'+(cls?' '+cls:''));keys.append(g);return g;};
 const key=(g,label,cls,fn,aria)=>{const b=btn(label,'key'+(cls?' '+cls:''),()=>{if(typeof haptic==='function')haptic('tick');fn();});if(aria)b.setAttribute('aria-label',aria);
  // Keep the focus (and the soft keyboard) where it is while tapping keys.
  b.addEventListener('mousedown',e=>e.preventDefault());g.append(b);return b;};
 let g=group();
 if(entry.kind==='ssh'){const k=key(g,'','kbd-key',()=>entry.term.focus(),'直接键盘');k.append(icon('keyboard'));k.title='直接键盘：按键直接发给 shell';}
 for(const [label,data,name] of terminalKeys){if(name==='ctrl'&&entry.kind!=='ssh')continue;
  if(name==='up')g=group('key-arrows');if(name==='enter')g=group();
  const cls=name==='ctrl'?'ctrl-key':name==='enter'?'enter-key':label.length===1?'arrow-key':'';
  const b=key(g,label,cls,()=>name==='ctrl'?termCtrl(entry,!entry.ctrl):terminalKey(entry,data,name),TERM_KEY_NAMES[label]);
  if(name==='ctrl'){b.id='ctrl-key';b.setAttribute('aria-pressed',String(!!entry.ctrl));b.classList.toggle('on',!!entry.ctrl);}}
 if(entry.kind==='ssh'){g=group('key-chars');for(const ch of TERM_CHARS)key(g,ch,'char-key',()=>terminalKey(entry,ch,'char'));}
 footer.append(keys);
 const compose=el('div','composer term-compose');
 // 「发送后回车」 as a compact toggle at the start of the line.
 const toggle=el('label','term-enter');const enter=el('input');enter.type='checkbox';enter.checked=entry.enter!==false;enter.id='terminal-enter';enter.setAttribute('aria-label','发送后回车');
 enter.onchange=()=>{entry.enter=enter.checked;};toggle.title='发送后回车';toggle.append(enter,icon('enterKey'),el('span','','回车'));
 const input=el('textarea');input.rows=1;input.placeholder=entry.kind==='ssh'?'输入命令…':'输入命令或文字…';input.setAttribute('aria-label','终端输入');input.setAttribute('autocapitalize','off');input.setAttribute('autocomplete','off');input.setAttribute('autocorrect','off');input.setAttribute('enterkeyhint','send');input.spellcheck=false;input.value=entry.draft;
 const send=btn('执行','primary term-run',()=>{if(typeof haptic==='function')haptic('confirm');sendTerminalLine(entry,input);});send.addEventListener('mousedown',e=>e.preventDefault());
 const grow=()=>{input.style.height='auto';input.style.height=Math.min(input.scrollHeight,innerHeight<560?60:96)+'px';send.disabled=!input.value;};
 input.oninput=()=>{entry.draft=input.value;grow();};
 // Enter on the soft keyboard runs the line (Shift+Enter keeps a newline). IME composition is left alone.
 input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();sendTerminalLine(entry,input);}});
 input.addEventListener('beforeinput',e=>{if((e.inputType==='insertLineBreak'||e.inputType==='insertParagraph')&&!e.isComposing){e.preventDefault();sendTerminalLine(entry,input);}});
 compose.append(toggle,input,send);footer.append(compose);root.append(footer);
 requestAnimationFrame(grow);
 // The toast sits above the dock, not on top of the keys.
 const dockSize=new ResizeObserver(()=>document.documentElement.style.setProperty('--term-dock-h',footer.offsetHeight+'px'));dockSize.observe(footer);
 paintStatus(entry);
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
 else if(entry.kind!=='ssh'&&entry.paused)n.append(btn('恢复读取','link-btn',()=>{entry.paused=false;entry.notice='';paintStatus(entry);pollTerminal();}));}
async function reopenShell(entry){
 if(T.shell!==entry)return;try{if(!entry.demo)await rpc('shellClose',{terminalId:entry.id});}catch(_){/* already gone */}
 if(T.shell!==entry)return;entry.disposed=true;entry.observer.disconnect();entry.term.dispose();T.shell=null;T.view=null;openShell().catch(error);}
// Jump-to-latest: shown while you read back; a dot when new output arrived below.
function termAtBottom(entry){
 if(entry.kind==='ssh'){if(entry.disposed)return true;const b=entry.term.buffer.active;return b.viewportY>=b.baseY;}
 const n=document.getElementById('pane-screen');return !n||n.scrollHeight-n.scrollTop-n.clientHeight<24;}
function termJump(entry,output){
 if(T.view!==entry)return;const j=document.getElementById('term-jump');if(!j)return;const bottom=termAtBottom(entry);
 if(bottom)j.classList.remove('has-new');else if(output&&!j.hidden)j.classList.add('has-new');j.hidden=bottom;}
function termBottom(entry){
 entry.stopGlide?.();if(entry.kind==='ssh')entry.term.scrollToBottom();else{const n=document.getElementById('pane-screen');if(n)termGlideBottom(n);entry.stick=true;}
 termJump(entry);}
// Short distances glide, long ones jump (a long smooth scroll through a log feels slow).
function termGlideBottom(n){const far=n.scrollHeight-n.scrollTop-n.clientHeight>n.clientHeight*2;n.scrollTo({top:n.scrollHeight,behavior:termMotion()&&!far?'smooth':'auto'});}
function termMotion(){return !document.documentElement.classList.contains('reduce-motion')&&!matchMedia('(prefers-reduced-motion: reduce)').matches;}
// Ctrl latch (SSH): the next key from the keyboard or a one-letter line goes out as Ctrl+key.
function ctrlCode(ch){const c=ch.toUpperCase().charCodeAt(0);if(c>=64&&c<=95)return String.fromCharCode(c-64);if(ch==='?')return '\x7f';if(ch===' ')return '\x00';return '';}
function termCtrl(entry,on){entry.ctrl=on;const b=document.getElementById('ctrl-key');if(b){b.classList.toggle('on',on);b.setAttribute('aria-pressed',String(on));}if(on){toast('Ctrl 已按下：再按一个字母');if(entry.kind==='ssh')entry.term.focus();}}
// Font size and the screen copy are per phone (kept in the per-device cache when connected).
async function termPrefs(){if(T.prefsLoaded)return;T.prefsLoaded=true;const v=await cacheGet('term:prefs');if(v?.font&&TERM_FONTS.includes(v.font)&&!T.fontSet)termFont(v.font,false);}
function termFont(n,save=true){T.font=n;T.fontSet=save||T.fontSet;termFontVar();
 if(T.shell&&!T.shell.disposed){T.shell.term.options.fontSize=n;if(T.view===T.shell)requestAnimationFrame(()=>{if(!T.shell||T.shell.disposed)return;const b=T.shell.term.buffer.active,stick=b.viewportY>=b.baseY;T.shell.fit.fit();if(stick)T.shell.term.scrollToBottom();});}
 if(save)cachePut('term:prefs',{font:n});}
function terminalText(entry){
 if(entry.kind!=='ssh')return paneText(entry.text);
 const sel=entry.term.getSelection();if(sel)return sel;const b=entry.term.buffer.active,out=[];
 for(let i=b.viewportY;i<b.viewportY+entry.term.rows&&i<b.length;i++)out.push(b.getLine(i)?.translateToString(true)||'');
 return out.join('\n').replace(/\s+$/,'');}
// Everything the shell still holds (scrollback included), for touch selection.
function terminalAllText(entry){
 if(entry.kind!=='ssh')return paneText(entry.text);const b=entry.term.buffer.active,out=[];
 for(let i=Math.max(0,b.length-2000);i<b.length;i++){const l=b.getLine(i);if(!l)continue;if(l.isWrapped&&out.length)out[out.length-1]+=l.translateToString(true);else out.push(l.translateToString(true));}
 return out.join('\n').replace(/\s+$/,'');}
function terminalCopy(entry){const t=terminalText(entry);if(!t.trim()){toast('屏幕上没有可复制的内容');return;}copyText(t);}
// Touch selection: the text in a plain, selectable view (long-press, drag the handles, copy).
function terminalSelect(entry){
 const t=terminalAllText(entry);const box=sheet('选择文字');box.classList.add('select-sheet');box.append(el('p','fine','长按拖动选择需要的部分。'));
 const pre=el('pre','select-text term-select',t||'屏幕上没有文字');box.append(pre);
 const row=el('div','sheet-actions');row.append(btn('复制全部','secondary',()=>{copyText(t);closeSheet();}));box.append(row);
 requestAnimationFrame(()=>{pre.scrollTop=pre.scrollHeight;});}
function terminalKey(entry,data,key){if(entry.ended||entry.paused){toast('终端不可输入，请查看状态或刷新');return;}if(entry.ctrl)termCtrl(entry,false);if(entry.kind==='ssh')sendShell(entry,data);else sendPane(entry,'paneKey',{key}).catch(error);}
function sendShell(entry,text){
 if(entry.demo){toast('终端演示：未发送');return Promise.resolve(false);}
 if(entry.ended||entry.paused){toast('终端不可输入，请重新打开终端');return Promise.resolve(false);}
 // Serialize to preserve key order. Failure freezes this stream rather than replaying unknown writes.
 entry.queue=entry.queue.then(async()=>{if(entry.ended||entry.paused)return false;try{await rpc('shellWrite',{terminalId:entry.id,sequence:++entry.sequence,text});return true;}catch(e){entry.paused=true;terminalStatus(entry,'输入结果未知，已停止后续输入；请检查终端。'+e.message);return false;}});
 return entry.queue;
}
async function sendPane(entry,op,args){if(entry.demo){toast('终端演示：未发送');return false;}if(entry.paused||entry.ended)throw Error('终端已暂停，请刷新检查');try{if(entry.kind==='tmux')await tmuxSend(entry,op,args);else await remote(op,{session:entry.session,target:entry.pane.pane_id,identity:entry.pane.identity,id:uuid(),...args});return true;}catch(e){entry.paused=true;terminalStatus(entry,'输入未确认，已暂停；不会重发。'+e.message);throw e;}}
async function sendTerminalLine(entry,input){
 const text=input.value;if(!text)return;const enter=document.getElementById('terminal-enter').checked;
 if(entry.ctrl&&entry.kind==='ssh'&&text.length===1&&ctrlCode(text)){termCtrl(entry,false);if(await sendShell(entry,ctrlCode(text))){entry.draft='';input.value='';input.oninput?.();}return;}
 if(entry.sending)return;entry.sending=true;
 try{const sent=entry.kind==='ssh'?await sendShell(entry,text+(enter?'\r':'')):await sendPane(entry,enter?'paneRun':'paneText',{text});if(sent&&entry.draft===text){entry.draft='';if(input.value===text){input.value='';input.oninput?.();}}if(sent&&T.view===entry){entry.stopGlide?.();if(entry.kind==='ssh')entry.term.scrollToBottom();else entry.stick=true;pollTerminal();}}catch(e){error(e);}finally{entry.sending=false;}
}
function terminalStatus(entry,text){entry.notice=text;paintStatus(entry);}
async function pollTerminal(){
 const entry=T.view;if(!entry||entry.busy||!S.active||entry.demo||entry.paused||entry.ended)return;entry.busy=true;
 try{
 if(entry.kind==='ssh'){
 const r=await rpc('shellRead',{terminalId:entry.id,cursor:entry.cursor});if(T.shell!==entry)return;
 if(r.lost){entry.term.reset();terminalStatus(entry,'离开期间输出超过缓存，显示最近内容。');}
 const bytes=Uint8Array.from(atob(r.data),c=>c.charCodeAt(0));await new Promise(resolve=>entry.term.write(bytes,resolve));entry.cursor=r.next;
 if(r.ended&&bytes.length===0){entry.ended=true;terminalStatus(entry,r.error||'SSH shell 已结束，可以重新打开。');}
 }else if(entry.kind==='tmux'){await tmuxPoll(entry);
 }else{
 const r=await remote('paneRead',{session:entry.session,target:entry.pane.pane_id,identity:entry.pane.identity});const changed=r.text!==entry.text;entry.text=r.text;
 if(T.view===entry&&changed){const n=document.getElementById('pane-screen');if(n){n.textContent=paneText(r.text);if(entry.stick!==false)n.scrollTop=n.scrollHeight;termJump(entry,true);}}
 }
 }catch(e){entry.paused=true;terminalStatus(entry,'读取失败，已暂停：'+e.message);}finally{entry.busy=false;}
}
function terminalMenu(){const entry=T.view;const box=sheet('终端选项');
 const size=el('div','term-size');const cur=el('span','grow','字号 · '+termFontSize());
 const step=d=>{const at=TERM_FONTS.indexOf(termFontSize());const i=Math.max(0,Math.min(TERM_FONTS.length-1,(at<0?2:at)+d));termFont(TERM_FONTS[i]);cur.textContent='字号 · '+TERM_FONTS[i];};
 size.append(cur,btn('A−','secondary small',()=>step(-1)),btn('A+','secondary small',()=>step(1)));size.querySelectorAll('button')[0].setAttribute('aria-label','字号小一点');size.querySelectorAll('button')[1].setAttribute('aria-label','字号大一点');box.append(size);
 menuItem(box,entry.kind==='ssh'&&entry.term.hasSelection()?'复制选中内容':'复制屏幕内容',()=>terminalCopy(entry),'copy');
 menuItem(box,'选择文字',()=>terminalSelect(entry),'textCursor','长按选择任意一段，含往上的历史');
 menuItem(box,'刷新 / 恢复读取',()=>{if(entry.kind!=='ssh'){entry.readAt=0;entry.paused=false;entry.notice='';paintStatus(entry);}else if(entry.paused){toast('SSH 输入异常后需关闭并重新打开；不自动恢复输入');return;}pollTerminal();},'refresh');
 menuItem(box,'回到底部',()=>termBottom(entry),'down');
 if(typeof filesTermItem==='function')filesTermItem(box,entry);
 if(entry.kind==='tmux')tmuxMenu(box);
 if(entry.kind==='ssh')menuItem(box,'关闭 SSH shell',()=>confirmAction('关闭 SSH shell？','这会关闭独立 SSH 通道，里面运行的程序可能随之结束。Herdr 窗格不受影响。','关闭 shell',async()=>{try{if(!entry.demo)await rpc('shellClose',{terminalId:entry.id});entry.disposed=true;entry.observer.disconnect();entry.term.dispose();if(T.shell===entry)T.shell=null;leaveTerminal();render();}catch(e){error(e);}},true),'x','里面运行的程序可能随之结束');
 else box.append(el('p','fine','返回列表只退出手机查看，不关闭电脑上的窗格。'));
}
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
setInterval(pollTerminal,500);
