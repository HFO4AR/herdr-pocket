'use strict';
// Terminal destinations are captured objects. A late response never changes the selected target.
const T={view:null,shell:null,panes:[],loading:false,generation:0};
const terminalKeys=[['Tab','\t','tab'],['Esc','\x1b','esc'],['Ctrl+C','\x03','ctrl+c'],['Ctrl+D','\x04','ctrl+d'],['↑','\x1b[A','up'],['↓','\x1b[B','down'],['←','\x1b[D','left'],['→','\x1b[C','right'],['Enter','\r','enter']];
function leaveTerminal(){T.view=null;T.generation++;}
function clearTerminals(){leaveTerminal();if(T.shell){T.shell.observer?.disconnect();T.shell.term.dispose();}T.shell=null;T.panes=[];}
function terminalsPage(main){
 pageHead(main,'TERMINALS','终端','连接独立 SSH shell，或接着操作电脑上的分屏。',ib('refresh','刷新分屏',loadPanes));
 if(!requireDevice(main))return;
 const card=el('section','card');card.append(el('h2','','SSH 终端'),el('p','muted','独立交互 shell，支持彩色输出、Tab、方向键和 Ctrl+C。返回列表不会关闭；断开设备后结束。'));
 const open=btn(T.shell?'返回 SSH 终端':'打开 SSH 终端','primary',()=>openShell().catch(error),'terminal');open.style.marginTop='16px';card.append(open);main.append(card);
 main.append(el('div','section-label','HERDR 普通分屏'));
 const choose=btn('Herdr 会话 · '+(S.session||'选择'),'pill',()=>{const box=sheet('选择终端所在会话');S.sessions.forEach(name=>box.append(btn(name,'card card-button',()=>{S.session=name;T.panes=[];closeSheet();loadPanes();})));});main.append(choose);
 if(!T.panes.length)empty(main,T.loading?'正在读取分屏…':'没有普通终端分屏','刷新后显示各工作区里未被识别为 Agent 的现有终端。');
 for(const pane of T.panes){const b=btn('','card card-button',()=>openPane(pane));const av=el('div','avatar');av.append(icon('terminal'));const info=el('div','grow');info.append(el('div','card-title',titleOf(pane)),el('div','card-meta',pane.workspace_label+' · '+pane.tab_id+' · '+pane.pane_id),el('div','card-meta truncate',pane.foreground_cwd||pane.cwd||''));b.append(av,info,icon('chevron'));main.append(b);}
 main.append(el('p','muted','这些是电脑上的原终端。手机输入会作用于同一进程，输出以近期屏幕快照刷新。'));
}
async function loadPanes(){
 if(!S.device||T.loading)return;T.loading=true;const epoch=S.epoch;
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
 const term=new Terminal({fontSize:13,fontFamily:'monospace',cursorBlink:true,scrollback:3000,theme:{background:'#171717',foreground:'#ececec',cursor:'#f57b4a',selectionBackground:'#f57b4a66'},allowProposedApi:false});
 // Remote terminal escapes must never read/write the phone clipboard.
 term.parser.registerOscHandler(52,()=>true);
 const fit=new FitAddon.FitAddon();term.loadAddon(fit);
 const entry={kind:'ssh',id:response.id,title:'SSH · '+device.name,term,fit,host:el('div','pty-host'),cursor:0,sequence:0,queue:Promise.resolve(),ended:false,paused:false,busy:false,draft:'',demo:S.demo};
 T.shell=entry;term.open(entry.host);
 term.onData(data=>{if(T.view===entry&&!overlay.childElementCount)sendShell(entry,data);});
 term.onResize(({cols,rows})=>{if(entry.demo||entry.ended)return;rpc('shellResize',{terminalId:entry.id,cols,rows}).catch(e=>{if(T.shell===entry)toast(e.message);});});
 entry.observer=new ResizeObserver(()=>{if(T.view===entry)requestAnimationFrame(()=>fit.fit());});entry.observer.observe(entry.host);
 if(entry.demo)term.write('\x1b[32m离线 SSH 终端演示\x1b[0m\r\n不连接主机，不执行输入。\r\n$ ');
 if(epoch===S.epoch){T.view=entry;renderTerminal();}
 }finally{T.opening=false;}
}
function openPane(pane){T.view={kind:'pane',pane,session:S.session,title:titleOf(pane),text:S.demo?'$ pwd\n~/projects/pocket\n$ npm test\nPASS: 离线普通分屏演示\n$ ':'正在读取终端…',draft:'',paused:false,busy:false,demo:S.demo};renderTerminal();pollTerminal();}
function renderTerminal(){
 const entry=T.view;if(!entry)return;S.chat=null;const root=shell();root.classList.add('terminal-shell');
 const head=el('header','chat-head');head.append(ib('back','返回终端列表',()=>{leaveTerminal();render();}));const name=el('div','grow');name.append(el('h2','',entry.title),el('small','',entry.kind==='ssh'?'SSH PTY · '+S.device.user+'@'+S.device.host:'共享分屏 · '+entry.session+' / '+entry.pane.pane_id));head.append(name,ib('more','终端选项',terminalMenu));root.append(head);
 const status=el('div','terminal-status',entry.ended?'终端已结束':entry.paused?'刷新已暂停，输入已禁用':'');status.id='pty-status';root.append(status);
 if(entry.kind==='ssh'){root.append(entry.host);requestAnimationFrame(()=>entry.fit.fit());}
 else{const output=el('pre','pane-screen',entry.text);output.id='pane-screen';output.tabIndex=0;output.setAttribute('aria-label','Herdr 分屏输出');root.append(output);}
 const keys=el('div','terminal-keys');for(const [label,data,key] of terminalKeys)keys.append(btn(label,'secondary',()=>terminalKey(entry,data,key)));root.append(keys);
 const footer=el('footer','composer-wrap');const compose=el('div','composer');const input=el('textarea');input.rows=1;input.placeholder='输入命令或文本…';input.setAttribute('aria-label','终端输入');input.value=entry.draft;input.oninput=()=>{entry.draft=input.value;};const send=btn('执行','primary',()=>sendTerminalLine(entry,input));compose.append(input,send);footer.append(compose);
 const options=el('div','terminal-input-options');const label=el('label','check');const enter=el('input');enter.type='checkbox';enter.checked=true;enter.id='terminal-enter';label.append(enter,document.createTextNode('发送后回车'));options.append(label);
 if(entry.kind==='ssh')options.append(btn('直接键盘','link-btn',()=>entry.term.focus()));footer.append(options);root.append(footer);
}
function terminalKey(entry,data,key){if(entry.ended||entry.paused){toast('终端不可输入，请查看状态或刷新');return;}if(entry.kind==='ssh')sendShell(entry,data);else sendPane(entry,'paneKey',{key}).catch(error);}
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
function terminalMenu(){const entry=T.view;const box=sheet('终端选项');box.append(btn('刷新 / 恢复读取','card card-button',()=>{closeSheet();if(entry.kind==='pane')entry.paused=false;else if(entry.paused){toast('SSH 输入异常后需关闭并重新打开；不自动恢复输入');return;}pollTerminal();}),btn('回到底部','card card-button',()=>{closeSheet();if(entry.kind==='ssh')entry.term.scrollToBottom();else{const n=document.getElementById('pane-screen');n.scrollTop=n.scrollHeight;}}));
 if(entry.kind==='ssh')box.append(btn('关闭 SSH shell','card card-button danger',()=>confirmAction('关闭 SSH shell？','这会关闭独立 SSH 通道，里面运行的程序可能随之结束。Herdr 分屏不受影响。','关闭 shell',async()=>{try{if(!entry.demo)await rpc('shellClose',{terminalId:entry.id});entry.observer.disconnect();entry.term.dispose();if(T.shell===entry)T.shell=null;leaveTerminal();render();}catch(e){error(e);}})));
 else box.append(el('p','note','返回列表只退出手机查看，不关闭电脑上的分屏。'));
}
setInterval(pollTerminal,500);
