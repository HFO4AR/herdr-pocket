'use strict';
// Agent modes: what the agent's own footer says right now (bridge `read` → `modes`), shown as chips
// above the composer, plus 「切换模式」, which presses Shift+Tab in the agent's pane and reads the
// screen again to show where it landed. Loaded before app.js: declarations and one timer only.
//
// Native semantics (checked against Claude Code 2.1.x and Codex 0.16x):
//  · Claude: one permission mode, cycled by Shift+Tab: 手动确认 → 自动接受编辑 → 计划模式 →
//    [跳过权限确认, when started with it] → [自动模式, when available] → 手动确认.
//    A /goal is separate and stays on whatever the mode is.
//  · Codex: Shift+Tab cycles only the collaboration mode (默认 ↔ 计划). Approval presets (/approvals)
//    are not on screen and not cycled; they come from the transcript (glance) when it is local.
//    A /goal is separate too.
// The chip always shows what the screen said; nothing is predicted from the key press.
const MD={screen:new Map(),busy:'',demo:new Map()};
const MODE_PERM={default:['手动确认',''],acceptEdits:['自动接受编辑','m-edit'],plan:['计划模式','m-plan'],auto:['自动模式','m-auto'],bypassPermissions:['跳过权限确认','m-danger'],dontAsk:['不询问','m-danger']};
const MODE_COLLAB={default:['默认模式',''],plan:['计划模式','m-plan']};
const MODE_GOAL={active:['目标进行中','m-goal'],paused:['目标已暂停',''],blocked:['目标卡住了','m-auto'],usage_limited:['目标：用量到上限','m-auto'],budget_limited:['目标：预算用完','m-auto'],unmet:['目标未达成','m-auto'],complete:['目标已达成','m-done']};
// Compact list tags: only modes worth noticing at a glance (the usual mode stays quiet).
const MODE_TAG={plan:'计划',acceptEdits:'自动编辑',auto:'自动'};
const MODE_CYCLE={claude:'手动确认 → 自动接受编辑 → 计划模式 → 跳过权限确认（用它启动时才有）→ 自动模式（可用时才有）→ 回到手动确认',
 codex:'默认模式 ↔ 计划模式。审批权限（/approvals）不受 Shift+Tab 影响。'};
function modeIcons(){if(paths.shiftTab)return;Object.assign(paths,{shiftTab:'M7 3L2 9h3v7h4V9h3zM14 12h7M18 8.5l3.5 3.5-3.5 3.5M22 7v10'});}
function modeAgent(a){return !!a&&['claude','codex'].includes(a.agent);}
// Other agents have no mode bar; Shift+Tab is offered as a plain key only while their own footer
// names it (bridge screen_modes {generic, cycle}), as of the latest screen read.
function modeShiftTab(a){if(!a||modeAgent(a)||S.chat?.stale)return false;const m=MD.screen.get(agentKey(a))?.modes;return !!(m&&m.generic&&m.cycle);}

// Called with every screen read of the open chat. `modes: null` means the footer is not on screen
// (a menu or a dialog covers it): keep what was last seen, only note when.
function modeScreen(r){
 const a=S.chat?.agent;if(!a||S.chat.stale||!r||!('modes' in r))return;const k=agentKey(a),old=MD.screen.get(k);
 if(!modeAgent(a)){MD.screen.set(k,{modes:r.modes&&typeof r.modes==='object'?r.modes:null,at:Date.now(),read:Date.now()});return;}
 if(r.modes&&typeof r.modes==='object')MD.screen.set(k,{modes:r.modes,at:Date.now(),read:Date.now()});
 else if(old)old.read=Date.now();else MD.screen.set(k,{modes:null,at:0,read:Date.now()});
 modePaint();}
// One view of an agent's modes: the screen when it says something, else the transcript (local only).
function modeOf(a){
 if(!modeAgent(a))return null;const k=agentKey(a);
 if(S.demo){if(!MD.demo.has(k))MD.demo.set(k,a.agent==='claude'?{agent:'claude',permission:'acceptEdits',goal:{state:'active',elapsed:'12m'}}:{agent:'codex',collaboration:'default',goal:null});return {...MD.demo.get(k),from:'screen'};}
 const s=MD.screen.get(k)?.modes,g=typeof glanceOf==='function'?glanceOf(a):null,t=g?.modes||null;
 const main=a.agent==='claude'?'permission':'collaboration';const out={agent:a.agent,from:'',goal:null};
 if(s&&s[main]){out[main]=s[main];out.from='screen';}
 else if(t&&t[main]){out[main]=t[main];out.from='transcript';}
 // A goal shows only when the footer shows it; the transcript adds the objective (Codex) when its state agrees.
 if(s)out.goal=s.goal||null;else if(t?.goal&&['active','paused','blocked','usage_limited','budget_limited'].includes(t.goal.state))out.goal={state:t.goal.state,elapsed:''};
 if(out.goal&&t?.goal?.objective&&(t.goal.state===out.goal.state||(out.goal.state==='active'&&t.goal.state==='active')))out.goal.objective=t.goal.objective;
 if(a.agent==='codex'&&t){out.approval=t.approval||'';out.sandbox=t.sandbox||'';}
 out.known=!!s||!!t;out.seen=!!s;return out;}
// Chips for one agent: [text, tone, title].
function modeChips(m){
 if(!m)return [];const chips=[];
 const main=m.agent==='claude'?MODE_PERM[m.permission]:MODE_COLLAB[m.collaboration];
 if(main)chips.push([main[0],main[1],m.from==='transcript'?'上一轮记录里的模式，屏幕上暂时没看到':'']);
 else if(m.agent==='codex'&&m.collaboration)chips.push([m.collaboration+' 模式','','']);
 if(m.agent==='codex'){
  if(m.sandbox==='danger-full-access'&&m.approval==='never')chips.push(['完全访问','m-danger','审批：不询问；沙箱：完全访问（来自上一轮记录）']);
  else if(m.sandbox==='read-only')chips.push(['只读','','沙箱：只读（来自上一轮记录）']);}
 if(m.goal){const g=MODE_GOAL[m.goal.state]||['目标：'+m.goal.state,''];chips.push([m.goal.objective?'目标：'+m.goal.objective:g[0]+(m.goal.elapsed?' · '+m.goal.elapsed:''),g[1],g[0]]);}
 return chips;}
function modeChip(text,tone,title){const c=el('span','mode-chip'+(tone?' '+tone:''),text);if(title)c.title=title;return c;}

// Why 「切换模式」 is not available right now, or ''.
function modeBlockedWhy(a){
 if(!a||S.chat?.stale)return '这个窗格的 Agent 已变化';if(!S.device&&!S.demo)return '还在连接';
 if(a.agent_status==='blocked')return '它在等你确认，这时按 Shift+Tab 可能直接批准';
 if(MD.busy)return '正在切换';
 const key=draftKey();if(typeof slashPanelCard==='function'&&slashPanelCard(key))return '命令面板还开着，先处理它';
 if(S.outbox?.some(o=>o.key===key&&o.state==='sending')||(typeof Q!=='undefined'&&Q.get(key)?.inflight))return '消息正在发送';
 return '';}

// The mode line in the footer rail (foot.js): chips (tap for details) and 「切换模式」. When something
// else leads the footer it is hidden and the rail shows a compact mode chip instead.
function modeBar(footer,a){
 let bar=document.getElementById('mode-bar');
 if(!footer||!modeAgent(a)||S.chat?.stale||(!S.device&&!S.demo)){bar?.remove();return;}
 if(!bar||bar.parentNode!==footer){bar?.remove();modeIcons();bar=el('div','mode-bar');bar.id='mode-bar';bar.setAttribute('role','group');bar.setAttribute('aria-label','Agent 模式');
  const info=btn('','mode-info',modeSheet);info.setAttribute('aria-label','模式详情');info.append(el('span','mode-chips'));
  const sw=btn('切换模式','secondary small mode-switch',()=>modeCycle(),'shiftTab');sw.setAttribute('aria-label','切换模式（Shift+Tab）');
  bar.append(info,sw);footer.prepend(bar);}
 modePaintBar(bar,a);}
function modePaintBar(bar,a){
 const m=modeOf(a),chips=modeChips(m),box=bar.querySelector('.mode-chips'),info=bar.querySelector('.mode-info'),sw=bar.querySelector('.mode-switch');
 const sig=JSON.stringify(chips)+(m?.known?'':'?');
 if(box.dataset.sig!==sig){const changed=box.dataset.sig!==undefined&&box.dataset.sig!=='';box.dataset.sig=sig;
  box.replaceChildren(...(chips.length?chips.map(c=>modeChip(...c)):[modeChip(m?.known?'模式看不到':'正在读取模式…','m-quiet')]));
  if(changed&&chips.length){box.classList.remove('mode-flip');void box.offsetWidth;box.classList.add('mode-flip');}}
 bar.classList.toggle('mode-unknown',!chips.length&&!m?.known);
 info.setAttribute('aria-label','模式详情：'+(chips.map(c=>c[0]).join('，')||'还没读到'));
 const why=modeBlockedWhy(a);sw.disabled=!!why;sw.title=why||'按一次 Shift+Tab，切到下一个模式';
 sw.classList.toggle('busy',!!MD.busy);sw.lastChild.textContent=MD.busy?'切换中…':'切换模式';}
function modePaint(){const a=S.chat?.agent,bar=document.getElementById('mode-bar');if(bar&&a)modePaintBar(bar,a);if(typeof footRefresh==='function')footRefresh();}

// Press Shift+Tab once (fresh request id; ch panes get it at the pane level in the bridge), then read
// the screen until the footer shows a different mode, or give up quietly after a few reads.
async function modeCycle(){
 const a=S.chat?.agent;if(!modeAgent(a))return;const why=modeBlockedWhy(a);if(why){toast(why);return;}
 const k=agentKey(a),epoch=S.epoch,before=JSON.stringify(modeChips(modeOf(a)));MD.busy=k;modePaint();
 if(typeof haptic==='function')haptic('tick');
 try{
  if(S.demo){const d=MD.demo.get(k)||{};const order=a.agent==='claude'?['default','acceptEdits','plan','auto']:['default','plan'],f=a.agent==='claude'?'permission':'collaboration';
   d[f]=order[(order.indexOf(d[f])+1)%order.length];MD.demo.set(k,d);toast('演示：没有真的发送按键');return;}
  await remote('key',{session:S.session,target:a.pane_id,identity:a.identity,key:'shift+tab',id:uuid()});
  for(const wait of [350,700,1400]){
   await new Promise(r=>setTimeout(r,wait));if(epoch!==S.epoch||S.chat?.agent?.identity!==a.identity)return;
   if(S.reading===epoch){await new Promise(r=>setTimeout(r,400));if(S.reading===epoch)continue;}
   await fetchTerminal(true);if(JSON.stringify(modeChips(modeOf(a)))!==before)return;}
  toast('已按 Shift+Tab，模式还没变，等一下会再读');}
 catch(e){toast((/^没发出去/.test(e.message)?e.message:'按键未确认：'+e.message+'。不会自动重发')+'');}
 finally{if(MD.busy===k)MD.busy='';modePaint();}}

// Details: each mode in words, what Shift+Tab does for this agent, and the goal.
function modeSheet(){
 const a=S.chat?.agent;if(!modeAgent(a))return;const m=modeOf(a);const box=sheet('Agent 模式');box.classList.add('mode-sheet');
 const rows=el('div','mode-rows');
 const row=(label,value,tone,note)=>{const r=el('div','mode-row');r.append(el('span','mode-row-label',label));const v=el('span','mode-row-value');v.append(modeChip(value,tone));if(note)v.append(el('small','',note));r.append(v);rows.append(r);};
 const main=a.agent==='claude'?MODE_PERM[m?.permission]:MODE_COLLAB[m?.collaboration];
 row(a.agent==='claude'?'权限模式':'协作模式',main?main[0]:'没看到',main?main[1]:'m-quiet',m?.from==='transcript'?'上一轮记录里的；屏幕上暂时没看到':!m?.seen?'屏幕上暂时没看到它的状态栏':'');
 if(a.agent==='codex'&&m?.approval){const full=m.sandbox==='danger-full-access'&&m.approval==='never';row('审批权限',full?'完全访问':m.sandbox==='read-only'?'只读':'按需审批',full?'m-danger':'','上一轮记录里的；用 /approvals 修改');}
 if(m?.goal){const g=MODE_GOAL[m.goal.state]||[m.goal.state,''];row('目标',g[0]+(m.goal.elapsed?' · '+m.goal.elapsed:''),g[1],m.goal.objective||'');}
 else row('目标','没有','m-quiet','');
 box.append(rows);
 box.append(el('p','fine mode-cycle','Shift+Tab 的切换顺序：'+MODE_CYCLE[a.agent]));
 const why=modeBlockedWhy(a);const actions=el('div','sheet-actions');
 const go=btn('切换模式','primary',()=>{closeSheet();modeCycle();},'shiftTab');go.disabled=!!why;
 actions.append(btn('知道了','secondary',closeSheet),go);box.append(actions);if(why)box.append(el('p','fine',why));}

// A compact tag on the 会话 list row: only plan / auto-accept / auto and an active goal.
function modeRowTags(meta,a){
 if(!modeAgent(a))return;const m=modeOf(a);if(!m)return;
 const t=MODE_TAG[a.agent==='claude'?m.permission:m.collaboration];if(t)meta.append(el('span','tag mode-tag'+(t==='计划'?' m-plan':''),t));
 if(m.goal&&['active','paused','blocked'].includes(m.goal.state))meta.append(el('span','tag mode-tag m-goal',m.goal.state==='active'?'目标':'目标暂停'));}

// An open, idle chat reads the screen now and then so the chips stay true (busy chats are read anyway).
setInterval(()=>{
 if(!S.active||S.demo||!S.device)return;const a=S.chat?.agent;if(!modeAgent(a)||S.chat.stale||MD.busy)return;
 if(['working','blocked'].includes(a.agent_status)&&S.chatMode!=='commands')return;
 const s=MD.screen.get(agentKey(a));if(s&&Date.now()-s.read<12000)return;if(S.reading===S.epoch)return;
 fetchTerminal(true);},2500);
