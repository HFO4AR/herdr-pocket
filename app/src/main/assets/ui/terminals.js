'use strict';
// Terminal destinations are captured objects. A late response never changes the selected target.
const T={view:null,shell:null,panes:[],loading:false,generation:0};
// Key bar, most used first. Ctrl (SSH only) latches: the next letter goes out as Ctrl+letter.
const terminalKeys=[['Esc','\x1b','esc'],['Tab','\t','tab'],['Ctrl','','ctrl'],['↑','\x1b[A','up'],['↓','\x1b[B','down'],['←','\x1b[D','left'],['→','\x1b[C','right'],['Enter','\r','enter'],['Ctrl+C','\x03','ctrl+c'],['Ctrl+D','\x04','ctrl+d'],['⌫','\x7f','backspace']];
const TERM_KEY_NAMES={'↑':'上','↓':'下','←':'左','→':'右','⌫':'退格'};
const TERM_FONTS=[11,12,13,15,17];
function leaveTerminal(){T.view=null;T.generation++;}
function clearTerminals(){leaveTerminal();if(T.shell){T.shell.observer?.disconnect();T.shell.term.dispose();}T.shell=null;T.panes=[];}
// What a plain pane is running. Shells set titles like "<dir>: <command>"; a bare shell is idle.
const SHELLS=/^(bash|zsh|sh|fish|dash|ksh|tmux|login|-?bash|-?zsh)$/i;
function paneInfo(p){
 const raw=cleanTitle(p.terminal_title_stripped||p.terminal_title||p.title||'');const dir=String(p.foreground_cwd||p.cwd||'').split('/').filter(Boolean).pop()||'~';
 const m=raw.match(/^([^:]{1,80}):\s*(.+)$/);const cmd=(m?m[2]:raw).trim();const idle=!cmd||SHELLS.test(cmd)||cmd===dir;
 return {title:idle?'空闲 shell':cmd,idle,dir,cmd};}
function paneTitle(p){const i=paneInfo(p);return i.idle?'Shell · '+i.dir:i.title;}
function shortPath(p){const home=NEW.info?.home||'';p=String(p||'');return home&&(p===home||p.startsWith(home+'/'))?'~'+p.slice(home.length):p.replace(/^\/home\/[^/]+/,'~');}
function terminalsPage(main){
 if(!requireDevice(main))return;
 const head=el('div','row list-actions');
 if(S.sessions.length>1){const s=btn('','pill session-pill',chooseSession,'folder');s.append(el('span','truncate',S.session||'选择会话'),icon('down'));s.setAttribute('aria-label','切换 Herdr 会话 · 当前 '+(S.session||'未选'));head.append(s);}
 head.append(el('span','grow'),ib('refresh','刷新分屏',loadPanes));main.append(head);
 // 1. The phone's own SSH shell: separate from Herdr, survives leaving this screen.
 main.append(el('div','section-label','独立 SSH'));
 const live=T.shell&&!T.shell.ended;
 const sshCard=el('div','card list-card');const open=btn('','card-button term-row ssh-row',()=>openShell().catch(error));open.setAttribute('aria-label',T.shell?'返回 SSH 终端':'打开 SSH 终端');
 const av=el('div','avatar term-av ssh');av.append(icon('globe'));if(live)av.append(el('span','status-dot ok'));
 const info=el('div','grow');info.append(el('div','card-title','SSH 终端'),el('div','card-meta truncate',(S.device?.user||'')+'@'+(S.device?.host||'')));
 const side=el('div','row-side');side.append(el('span','badge '+(live?'ok':T.shell?'muted':'plain'),live?'已打开':T.shell?'已结束':'打开'));
 open.append(av,info,side);sshCard.append(open);main.append(sshCard);
 // 2. Herdr's plain panes (not agents), grouped by workspace.
 const label=el('div','section-label group-label');label.append(el('span','','电脑上的 Herdr 分屏'),el('span','group-count',T.loading&&!T.panes.length?'…':String(T.panes.length)));main.append(label);
 if(!T.panes.length){if(T.loading)skeleton(main,2);else{const n=el('div','empty small');n.append(el('h2','','没有普通终端分屏'),el('p','','Agent 在「会话」里；这里只列出 Herdr 里没跑 Agent 的终端。'));main.append(n);}}
 const groups=new Map();for(const p of T.panes){const k=p.workspace_label||'工作区';if(!groups.has(k))groups.set(k,[]);groups.get(k).push(p);}
 for(const [ws,list] of groups){if(groups.size>1)main.append(el('div','ws-label','工作区 · '+ws));const card=el('div','card list-card');
  for(const pane of list){const i=paneInfo(pane);const b=btn('','card-button term-row',()=>openPane(pane));const a=el('div','avatar term-av'+(i.idle?' idle':''));a.append(icon('terminal'));
   const t=el('div','grow');const title=el('div','card-title term-cmd'+(i.idle?' idle':''),i.title);t.append(title);
   const meta=el('div','card-meta');meta.append(el('span','',shortPath(pane.foreground_cwd||pane.cwd||'')||i.dir));if(groups.size<=1&&pane.workspace_label)meta.append(el('span','sep',pane.workspace_label));t.append(meta);
   b.append(a,t);card.append(b);}
  main.append(card);}
 main.append(el('p','fine','SSH 终端是手机自己开的 shell，不影响 Herdr。分屏是电脑上的原终端：在手机上输入，等于在电脑上敲键盘。'));
 pullRefresh(main,loadPanes);
}
async function loadPanes(){
 if(!S.device||T.loading)return;T.loading=true;const epoch=S.epoch;if(S.tab==='terminals'&&!T.view&&!S.chat)render();
 try{const sessions=await remote('sessions');if(epoch!==S.epoch)return;S.sessions=sessions.sessions.filter(x=>x.running).map(x=>x.name);if(!S.sessions.includes(S.session))S.session=S.sessions[0]||'';
 const result=S.session?await remote('panes',{session:S.session}):{panes:[]};if(epoch!==S.epoch)return;T.panes=result.panes;
 }catch(e){if(epoch===S.epoch){T.panes=[];error(e);}}finally{T.loading=false;if(epoch===S.epoch&&S.tab==='terminals'&&!T.view)render();}
}
async function openShell(){
 if(T.shell){T.view=T.shell;renderTerminal();return;}
 if(T.opening)return;T.opening=true;const device=S.device,epoch=S.epoch;
 try{
 const response=S.demo?{id:'demo-shell'}:await rpc('shellOpen',{cols:80,rows:24});
 if(S.device!==device)return;
 termPrefs();const term=new Terminal({fontSize:T.font||13,fontFamily:'monospace',cursorBlink:true,scrollback:3000,theme:{background:'#171717',foreground:'#ececec',cursor:'#f57b4a',selectionBackground:'#f57b4a66'},allowProposedApi:false});
 // Remote terminal escapes must never read/write the phone clipboard.
 term.parser.registerOscHandler(52,()=>true);
 const fit=new FitAddon.FitAddon();term.loadAddon(fit);
 const entry={kind:'ssh',id:response.id,title:'SSH · '+device.name,term,fit,host:el('div','pty-host'),cursor:0,sequence:0,queue:Promise.resolve(),ended:false,paused:false,busy:false,draft:'',demo:S.demo};
 T.shell=entry;term.open(entry.host);
 term.onData(data=>{if(T.view!==entry||overlay.childElementCount)return;if(entry.ctrl&&data.length===1){const c=ctrlCode(data);termCtrl(entry,false);if(c){sendShell(entry,c);return;}}sendShell(entry,data);});
 term.onResize(({cols,rows})=>{if(entry.demo||entry.ended)return;rpc('shellResize',{terminalId:entry.id,cols,rows}).catch(e=>{if(T.shell===entry)toast(e.message);});});
 entry.observer=new ResizeObserver(()=>{if(T.view===entry)requestAnimationFrame(()=>fit.fit());});entry.observer.observe(entry.host);
 if(entry.demo)term.write('\x1b[32m离线 SSH 终端演示\x1b[0m\r\n不连接主机，不执行输入。\r\n$ ');
 if(epoch===S.epoch){T.view=entry;renderTerminal();}
 }finally{T.opening=false;}
}
function openPane(pane){termPrefs();T.view={kind:'pane',pane,session:S.session,title:paneTitle(pane),text:S.demo?'$ pwd\n~/projects/pocket\n$ npm test\nPASS: 离线普通分屏演示\n$ ':'正在读取终端…',draft:'',paused:false,busy:false,demo:S.demo};renderTerminal();pollTerminal();}
function renderTerminal(){
 const entry=T.view;if(!entry)return;S.chat=null;const root=shell();root.classList.add('terminal-shell');
 const head=el('header','chat-head term-head');head.append(ib('back','返回终端列表',()=>{leaveTerminal();render();}));
 const av=el('div','avatar term-av'+(entry.kind==='ssh'?' ssh':''));av.append(icon(entry.kind==='ssh'?'globe':'terminal'));head.append(av);
 const name=el('div','grow chat-id');name.append(el('h2','',entry.title),el('small','',entry.kind==='ssh'?'独立 SSH · '+S.device.user+'@'+S.device.host:'Herdr 分屏 · '+(entry.pane.workspace_label?entry.pane.workspace_label+' · ':'')+entry.pane.pane_id));
 head.append(name,ib('copy','复制屏幕内容',()=>terminalCopy(entry)),ib('more','终端选项',terminalMenu));root.append(head);
 const status=el('div','terminal-status',entry.ended?'终端已结束':entry.paused?'刷新已暂停，输入已禁用':'');status.id='pty-status';root.append(status);
 if(entry.kind==='ssh'){root.append(entry.host);requestAnimationFrame(()=>entry.fit.fit());}
 else{const output=el('pre','pane-screen',entry.text);output.id='pane-screen';output.tabIndex=0;output.setAttribute('aria-label','Herdr 分屏输出');output.style.fontSize=(T.font||13)-.5+'px';root.append(output);}
 const keys=el('div','terminal-keys');keys.setAttribute('role','toolbar');keys.setAttribute('aria-label','终端按键');
 for(const [label,data,key] of terminalKeys){if(key==='ctrl'&&entry.kind!=='ssh')continue;
  const b=btn(label,'secondary key'+(key==='ctrl'?' ctrl-key':key==='enter'?' enter-key':label.length===1?' arrow-key':''),()=>key==='ctrl'?termCtrl(entry,!entry.ctrl):terminalKey(entry,data,key));
  if(TERM_KEY_NAMES[label])b.setAttribute('aria-label',TERM_KEY_NAMES[label]);if(key==='ctrl'){b.id='ctrl-key';b.setAttribute('aria-pressed',String(!!entry.ctrl));b.classList.toggle('on',!!entry.ctrl);}keys.append(b);}
 root.append(keys);
 const footer=el('footer','composer-wrap');const compose=el('div','composer');const input=el('textarea');input.rows=1;input.placeholder=entry.kind==='ssh'?'输入命令，或点「直接键盘」…':'输入命令或文本…';input.setAttribute('aria-label','终端输入');input.setAttribute('autocapitalize','off');input.spellcheck=false;input.value=entry.draft;input.oninput=()=>{entry.draft=input.value;};const send=btn('执行','primary',()=>sendTerminalLine(entry,input));compose.append(input,send);footer.append(compose);
 const options=el('div','terminal-input-options');const label=el('label','check');const enter=el('input');enter.type='checkbox';enter.checked=true;enter.id='terminal-enter';label.append(enter,document.createTextNode('发送后回车'));options.append(label);
 if(entry.kind==='ssh')options.append(btn('直接键盘','link-btn',()=>entry.term.focus()));footer.append(options);root.append(footer);
}
// Ctrl latch (SSH): the next key from the keyboard or a one-letter line goes out as Ctrl+key.
function ctrlCode(ch){const c=ch.toUpperCase().charCodeAt(0);if(c>=64&&c<=95)return String.fromCharCode(c-64);if(ch==='?')return '\x7f';if(ch===' ')return '\x00';return '';}
function termCtrl(entry,on){entry.ctrl=on;const b=document.getElementById('ctrl-key');if(b){b.classList.toggle('on',on);b.setAttribute('aria-pressed',String(on));}if(on){toast('Ctrl 已按下：再按一个字母');if(entry.kind==='ssh')entry.term.focus();}}
// Font size and the screen copy are per phone (kept in the per-device cache when connected).
async function termPrefs(){if(T.prefsLoaded)return;T.prefsLoaded=true;const v=await cacheGet('term:prefs');if(v?.font&&TERM_FONTS.includes(v.font)&&!T.fontSet)termFont(v.font,false);}
function termFont(n,save=true){T.font=n;T.fontSet=save||T.fontSet;if(T.shell){T.shell.term.options.fontSize=n;if(T.view===T.shell)requestAnimationFrame(()=>T.shell.fit.fit());}const p=document.getElementById('pane-screen');if(p)p.style.fontSize=n-.5+'px';if(save)cachePut('term:prefs',{font:n});}
function terminalText(entry){
 if(entry.kind!=='ssh')return entry.text||'';
 const sel=entry.term.getSelection();if(sel)return sel;const b=entry.term.buffer.active,out=[];
 for(let i=b.viewportY;i<b.viewportY+entry.term.rows&&i<b.length;i++)out.push(b.getLine(i)?.translateToString(true)||'');
 return out.join('\n').replace(/\s+$/,'');}
function terminalCopy(entry){const t=terminalText(entry);if(!t.trim()){toast('屏幕上没有可复制的内容');return;}copyText(t);}
function terminalKey(entry,data,key){if(entry.ended||entry.paused){toast('终端不可输入，请查看状态或刷新');return;}if(entry.ctrl)termCtrl(entry,false);if(entry.kind==='ssh')sendShell(entry,data);else sendPane(entry,'paneKey',{key}).catch(error);}
function sendShell(entry,text){
 if(entry.demo){toast('终端演示：未发送');return Promise.resolve(false);}
 if(entry.ended||entry.paused){toast('终端不可输入，请重新打开终端');return Promise.resolve(false);}
 // Serialize to preserve key order. Failure freezes this stream rather than replaying unknown writes.
 entry.queue=entry.queue.then(async()=>{if(entry.ended||entry.paused)return false;try{await rpc('shellWrite',{terminalId:entry.id,sequence:++entry.sequence,text});return true;}catch(e){entry.paused=true;terminalStatus(entry,'输入结果未知，已停止后续输入；请检查终端。'+e.message);return false;}});
 return entry.queue;
}
async function sendPane(entry,op,args){if(entry.demo){toast('终端演示：未发送');return false;}if(entry.paused||entry.ended)throw Error('终端已暂停，请刷新检查');try{await remote(op,{session:entry.session,target:entry.pane.pane_id,identity:entry.pane.identity,id:uuid(),...args});return true;}catch(e){entry.paused=true;terminalStatus(entry,'输入未确认，已暂停；不会重发。'+e.message);throw e;}}
async function sendTerminalLine(entry,input){
 const text=input.value;if(!text)return;const enter=document.getElementById('terminal-enter').checked;
 if(entry.ctrl&&entry.kind==='ssh'&&text.length===1&&ctrlCode(text)){termCtrl(entry,false);if(await sendShell(entry,ctrlCode(text))){entry.draft='';input.value='';}return;}
 if(entry.sending)return;entry.sending=true;
 try{const sent=entry.kind==='ssh'?await sendShell(entry,text+(enter?'\r':'')):await sendPane(entry,enter?'paneRun':'paneText',{text});if(sent&&entry.draft===text){entry.draft='';if(input.value===text)input.value='';}if(sent&&T.view===entry)pollTerminal();}catch(e){error(e);}finally{entry.sending=false;}
}
function terminalStatus(entry,text){if(T.view===entry){const n=document.getElementById('pty-status');if(n)n.textContent=text;}}
async function pollTerminal(){
 const entry=T.view;if(!entry||entry.busy||!S.active||entry.demo||entry.paused||entry.ended)return;entry.busy=true;
 try{
 if(entry.kind==='ssh'){
 const r=await rpc('shellRead',{terminalId:entry.id,cursor:entry.cursor});if(T.shell!==entry)return;
 if(r.lost){entry.term.reset();terminalStatus(entry,'离开期间输出超过缓存，显示最近内容。');}
 const bytes=Uint8Array.from(atob(r.data),c=>c.charCodeAt(0));await new Promise(resolve=>entry.term.write(bytes,resolve));entry.cursor=r.next;
 if(r.ended&&bytes.length===0){entry.ended=true;terminalStatus(entry,r.error||'SSH shell 已结束；可在选项中关闭后重新打开。');}
 }else{
 const r=await remote('paneRead',{session:entry.session,target:entry.pane.pane_id,identity:entry.pane.identity});entry.text=r.text;
 if(T.view===entry){const n=document.getElementById('pane-screen');if(n){const atBottom=n.scrollHeight-n.scrollTop-n.clientHeight<60;n.textContent=r.text;if(atBottom)n.scrollTop=n.scrollHeight;}}
 }
 }catch(e){entry.paused=true;terminalStatus(entry,'读取失败，已暂停：'+e.message);}finally{entry.busy=false;}
}
function terminalMenu(){const entry=T.view;const box=sheet('终端选项');
 const size=el('div','term-size');const cur=el('span','grow','字号 · '+(T.font||13));
 const step=d=>{const i=Math.max(0,Math.min(TERM_FONTS.length-1,TERM_FONTS.indexOf(T.font||13)+d));termFont(TERM_FONTS[i]);cur.textContent='字号 · '+TERM_FONTS[i];};
 size.append(cur,btn('A−','secondary small',()=>step(-1)),btn('A+','secondary small',()=>step(1)));size.querySelectorAll('button')[0].setAttribute('aria-label','字号小一点');size.querySelectorAll('button')[1].setAttribute('aria-label','字号大一点');box.append(size);
 menuItem(box,entry.kind==='ssh'&&entry.term.hasSelection()?'复制选中内容':'复制屏幕内容',()=>terminalCopy(entry),'copy');
 menuItem(box,'刷新 / 恢复读取',()=>{if(entry.kind==='pane')entry.paused=false;else if(entry.paused){toast('SSH 输入异常后需关闭并重新打开；不自动恢复输入');return;}pollTerminal();},'refresh');
 menuItem(box,'回到底部',()=>{if(entry.kind==='ssh')entry.term.scrollToBottom();else{const n=document.getElementById('pane-screen');n.scrollTop=n.scrollHeight;}},'down');
 if(entry.kind==='ssh')menuItem(box,'关闭 SSH shell',()=>confirmAction('关闭 SSH shell？','这会关闭独立 SSH 通道，里面运行的程序可能随之结束。Herdr 分屏不受影响。','关闭 shell',async()=>{try{if(!entry.demo)await rpc('shellClose',{terminalId:entry.id});entry.observer.disconnect();entry.term.dispose();if(T.shell===entry)T.shell=null;leaveTerminal();render();}catch(e){error(e);}},true),'x','里面运行的程序可能随之结束');
 else box.append(el('p','fine','返回列表只退出手机查看，不关闭电脑上的分屏。'));
}
setInterval(pollTerminal,500);
