'use strict';
// Background work ("bg"): shells, monitors and terminals an agent left running after its turn.
// The bridge reads them from the agent's own transcript (glance on the list poll, history while a
// chat is open, ch panes through the remote helper, same as sub-agents in kids.js):
//   {total, running, hold, items:[{id, kind: shell|monitor|terminal, title, command, started,
//    state: running|completed|failed|killed|ended|unknown, exit?, ended?, persistent?, output}]}
// Here that becomes
//  · 后台运行中 · N: an idle/done Claude whose background shells (or timed monitors) still run is
//    not done — it wakes again when they finish. `hold` counts those; Codex terminals and
//    persistent monitors are shown but never hold (Codex does not resume on its own, a persistent
//    monitor may run for hours). The background watcher applies the same rule (WatchService).
//  · a 「后台 N」 chip next to the sub-agent chip under a list row, and in the chat's footer rail;
//  · the 「后台任务」 sheet (running first) and a read-only output viewer (`bgOutput`, one tap =
//    one read of the task's own output file; see SECURITY.md).
// Read-only: nothing here stops, kills or writes to a task. Text nodes only.
const BG={map:new Map(),rec:new Map(),ttl:300000,pending:false,changed:new Set(),view:null};
const BG_STATE={running:['运行中','work'],completed:['完成','ok'],failed:['失败','alert'],killed:['已停止','muted'],ended:['已结束','muted'],unknown:['状态未知','muted']};
const BG_KIND={shell:'后台命令',monitor:'监视器',terminal:'后台终端'};

function bgOf(a){const r=a?BG.map.get(kidsKey(a)):null;return r&&Date.now()-r.seen<BG.ttl?r:null;}
function bgRunning(a){return bgOf(a)?.running|0;}
// Running work that will wake the agent again: holds 已完成 back as 后台运行中.
function bgHold(a){return bgOf(a)?.hold|0;}
function bgLabel(a){return '后台运行中 · '+bgHold(a);}

// Glance items ask for it too (kids.js kidsGlance); an unchanged report comes back as "same".
function bgGlance(a,item){item.bg=true;const r=BG.map.get(kidsKey(a));if(r?.stamp)item.bg_stamp=r.stamp;return item;}
function bgTake(key,report){
 if(!report||typeof report!=='object')return;const old=BG.map.get(key);
 if(report.same){if(old){old.seen=Date.now();if((report.running|0)!==old.running||(report.hold|0)!==old.hold){old.running=report.running|0;old.hold=report.hold|0;bgChanged(key);}}return;}
 if(!Array.isArray(report.items))return;
 const next={total:report.total|0,running:report.running|0,hold:report.hold|0,items:report.items.filter(x=>x&&typeof x==='object'&&x.id),stamp:report.stamp||'',seen:Date.now()};
 BG.map.set(key,next);if(!old||bgSig(old)!==bgSig(next))bgChanged(key);}
function bgSig(r){return r.running+'/'+r.hold+'/'+r.total+'/'+r.items.map(x=>x.id+':'+x.state).join(',');}
function bgChanged(key){BG.changed.add(key);if(!BG.pending){BG.pending=true;queueMicrotask(bgApply);}}
function bgApply(){
 BG.pending=false;if(!BG.changed.size)return;
 // Same bookkeeping as sub-agents: the effective state, the watcher, the open screen.
 for(const k of BG.changed)K.changed.add(k);BG.changed.clear();kidsApply();
 if(S.chat&&typeof footRefresh==='function')footRefresh();
 bgPaintSheet();}
function bgFromHistory(record,r){
 const c=S.chat;if(!c||!r?.bg||c.record?.id!==record?.id&&c.record!==record)return;
 BG.rec.set(record.id,{...r.bg,items:(r.bg.items||[]).filter(x=>x&&x.id),seen:Date.now()});
 if(c.agent&&!c.stale)bgTake(kidsKey(c.agent),r.bg);else{if(typeof footRefresh==='function')footRefresh();bgPaintSheet();}}
function bgChat(){const c=S.chat;if(!c)return null;return (c.agent&&!c.stale?bgOf(c.agent):null)||BG.rec.get(c.record?.id)||null;}
function bgForget(){BG.map.clear();BG.rec.clear();}

// ─── Where a task's output is read: the agent's record (local or a ch route) ────────────────
function bgRef(a){
 if(a){const ref=a.history_ref,rec=ref?.record;if(!ref||ref.status!=='matched')return null;
  return {provider:a.agent==='codex'?'codex':'claude',thread:rec?.thread||ref.thread,record_id:rec?.id||ref.record_id,cwd:rec?.cwd||a.foreground_cwd||a.cwd||'',remote:rec?.remote||ref.remote||null};}
 const c=S.chat,rec=c?.record;if(!rec)return null;
 return {provider:rec.provider==='codex'?'codex':'claude',thread:rec.thread,record_id:rec.id,cwd:rec.cwd||'',remote:rec.remote||null};}
function bgArgs(ref,task){const args={provider:ref.provider,thread:ref.thread,record_id:ref.record_id,task};if(ref.cwd)args.cwd=ref.cwd;if(ref.remote)args.remote=ref.remote;return args;}

// ─── Words ──────────────────────────────────────────────────────────────────────────────
function bgTitle(x){return String(x.title||x.command||x.id);}
function bgWhen(x){
 const st=BG_STATE[x.state]||BG_STATE.unknown,start=(Number(x.started)||0)*1000,end=(Number(x.ended)||0)*1000;
 if(x.state==='running')return start?'运行中 · '+ago(Date.now()-start):'运行中';
 const bits=[st[0]];if(x.exit!==undefined&&x.exit!==null&&!(x.state==='completed'&&x.exit===0))bits.push('退出码 '+x.exit);
 if(start&&end>start)bits.push('用时 '+dur(end-start));
 const t=end||start;if(t)bits.push(relative(t/1000));return bits.join(' · ');}
function bgKindIcon(x){if(!paths.eye)paths.eye='M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6';return x.kind==='monitor'?'eye':'terminal';}
function bgSorted(items){return [...items].sort((x,y)=>(y.running?1:0)-(x.running?1:0)||(Number(y.started)||0)-(Number(x.started)||0));}

// ─── The chip under a list row (next to the sub-agent chip) ─────────────────────────────
// Shown while something runs; finished work stays one tap away in the chat.
function bgChip(a){
 const r=bgOf(a);if(!r||!r.running)return null;
 const c=btn('','kids-chip bg-chip',()=>bgSheet(a),'terminal');c.append(el('span','kids-pulse'),el('span','kids-chip-text','后台 '+r.running));
 c.setAttribute('aria-label','后台任务 '+r.running+' 个运行中，点开查看');return c;}

// ─── 「后台任务」 sheet ─────────────────────────────────────────────────────────────────
// `a` = an agent from the list; without it, the open chat's record.
function bgSheet(a){
 const box=sheet('后台任务');box.classList.add('bg-sheet');box.id='bg-sheet';BG.view={agent:a||null,all:false};
 bgFillSheet(box);}
function bgReport(){const v=BG.view;if(!v)return null;return v.agent?bgOf(v.agent)||BG.map.get(kidsKey(v.agent)):bgChat();}
function bgFillSheet(box){
 const r=bgReport(),items=bgSorted(r?.items||[]),running=items.filter(x=>x.running),rest=items.filter(x=>!x.running);
 const keep=[...box.children].slice(0,2);box.replaceChildren(...keep);
 const lead=el('p','fine bg-lead',running.length?running.length+' 个还在跑'+(r.hold?'，跑完 Agent 会接着处理':'')+'。只读，这里不能停止它们。':'现在没有后台任务在跑。只读，这里不能停止它们。');
 box.append(lead);
 if(!items.length){box.append(el('p','bg-empty','这段对话还没有后台任务。'));return;}
 const add=(label,list,cls)=>{if(!list.length)return;const h=el('div','section-label bg-head');h.append(el('span','',label),el('span','group-count',String(list.length)));
  const g=el('div','bg-list'+(cls?' '+cls:''));list.forEach(x=>g.append(bgRow(x)));box.append(h,g);};
 add('运行中',running);
 const shown=BG.view.all||rest.length<=6?rest:rest.slice(0,5);add('已结束',shown,'done');
 if(shown.length<rest.length){const more=btn('显示全部 '+rest.length+' 个','link-btn bg-more',()=>{BG.view.all=true;bgFillSheet(box);});box.append(more);}
 if(r.total>items.length)box.append(el('p','fine','更早的 '+(r.total-items.length)+' 个没有列出。'));}
function bgRow(x){
 const st=BG_STATE[x.state]||BG_STATE.unknown;
 const b=btn('','menu-item bg-row t-'+st[1]+(x.running?' running':''),()=>bgView(x));
 const mark=el('span','bg-mark');mark.append(icon(bgKindIcon(x)));if(x.running)mark.append(el('span','bg-live'));b.append(mark);
 const t=el('span','grow bg-text');t.append(el('span','bg-title',bgTitle(x)));
 if(x.command&&x.command!==bgTitle(x))t.append(el('code','bg-cmd',x.command));
 t.append(el('small','bg-sub',[BG_KIND[x.kind]||'后台任务',bgWhen(x)].join(' · ')));b.append(t);
 b.append(icon('chevron'));
 b.setAttribute('aria-label',bgTitle(x)+'，'+(BG_KIND[x.kind]||'后台任务')+'，'+bgWhen(x)+'，查看输出');return b;}
function bgPaintSheet(){const box=document.getElementById('bg-sheet');if(box&&box.isConnected)bgFillSheet(box);}

// ─── Read-only output viewer ───────────────────────────────────────────────────────────
// One bgOutput per open and per 刷新; while the task runs and the sheet stays open, again every
// 5 s (only while the app is in front). Sticks to the end unless the person scrolled up.
function bgView(x){
 const a=BG.view?.agent||null,ref=bgRef(a);
 const box=sheet(bgTitle(x));box.classList.add('fv-sheet','bg-view');box.id='bg-view';
 const head=box.querySelector('.sheet-head');const back=ib('back','返回后台任务',()=>bgSheet(a));head.prepend(back);
 if(x.command)box.append(el('p','fv-path bg-view-cmd',x.command));
 const status=el('div','fv-status');box.append(status);
 const tools=el('div','fv-tools');box.append(tools);
 const code=el('div','fv-code bg-out');code.setAttribute('role','region');code.setAttribute('aria-label','输出：'+bgTitle(x));code.tabIndex=0;
 const pre=el('pre','bg-pre');code.append(pre);box.append(code);
 let text='',timer=0,busy=false,stick=true,live=x;
 code.addEventListener('scroll',()=>{stick=code.scrollHeight-code.scrollTop-code.clientHeight<24;});
 const refresh=btn('刷新','secondary small',()=>load(true),'refresh');
 const copy=btn('复制','secondary small',()=>{if(text)copyText(text);else toast('还没有输出');},'copy');
 const end=btn('到底部','secondary small',()=>{stick=true;code.scrollTop=code.scrollHeight;},'down');
 tools.append(refresh,copy,end);
 function paintStatus(r,err){
  status.replaceChildren();const st=BG_STATE[r?.state||live.state]||BG_STATE.unknown;
  status.append(el('span','badge '+st[1],st[0]));
  if(err){status.append(el('span','fv-error',err));return;}
  const bits=[];
  if(r?.source==='events')bits.push('监视器最近的事件');else if(r?.source==='transcript')bits.push('Agent 最近看到的输出');
  if(r?.size)bits.push(fileSize(r.size)+(r.truncated?'，只显示最后 64 KB':''));else if(r?.truncated)bits.push('只显示最后一部分');
  if(r?.mtime){const rt=relative(r.mtime);bits.push(rt==='刚刚'?'刚刚写入':rt+' 写入');}
  if(bits.length)status.append(el('span','',bits.join(' · ')));}
 async function load(manual){
  if(busy||!box.isConnected)return;busy=true;if(manual)refresh.disabled=true;
  if(!text){status.replaceChildren(el('span','spinner mini'),el('span','','正在读取…'));}
  try{
   const r=S.demo?await bgDemoOutput(x):ref?await remote('bgOutput',bgArgs(ref,x.id)):null;
   if(!box.isConnected)return;if(!r)throw Error('找不到这段对话的记录，刷新列表后再试');
   text=String(r.text||'');if(r.state)live={...live,state:r.state};
   pre.textContent=text||'';pre.classList.toggle('empty',!text);
   if(!text)pre.textContent=r.source==='none'?'这个任务没有可读的输出。':'还没有输出。';
   paintStatus(r);if(stick)code.scrollTop=code.scrollHeight;
  }catch(e){if(box.isConnected)paintStatus(null,e?.message||String(e));}
  finally{busy=false;refresh.disabled=false;
   clearTimeout(timer);if(box.isConnected&&live.state==='running')timer=setTimeout(()=>{if(box.isConnected){if(S.active!==false)load(false);else timer=setTimeout(()=>load(false),5000);}},5000);}}
 load(false);}

// ─── The chat's footer rail (foot.js): 后台 N while something runs ─────────────────────────
function bgChatRunning(){const r=bgChat();return r?.running|0;}
function bgFootLead(a){
 const r=bgChat(),n=r?.running|0,top=bgSorted(r?.items||[]).find(x=>x.running);
 const b=btn('','foot-lead t-bg',()=>bgSheet(null),'terminal');b.append(el('strong','','后台运行中 · '+n));
 if(top)b.append(el('span','foot-detail',bgTitle(top)));b.append(icon('chevron'));
 b.setAttribute('aria-label','后台任务 '+n+' 个运行中，点开查看');return b;}
function bgFootChip(){
 const n=bgChatRunning();const c=btn('','foot-chip t-bg',()=>bgSheet(null));c.append(el('span','pulse'),document.createTextNode('后台 '+n));
 c.setAttribute('aria-label','后台任务 '+n+' 个运行中，点开查看');return c;}

// ─── Offline demo ───────────────────────────────────────────────────────────────────────
function bgDemoReport(){
 const now=Date.now()/1000;
 return {total:4,running:2,hold:2,stamp:'demo-bg',items:[
  {id:'bdemo1',kind:'shell',title:'跑完整测试',command:'python3 -m unittest discover -s tests -v',started:now-200,state:'running',running:true,output:true},
  {id:'bdemo2',kind:'monitor',title:'等 CI 结果',command:'until gh run view --exit-status; do sleep 30; done',started:now-900,state:'running',running:true,timeout:1800,events:2,output:true},
  {id:'bdemo3',kind:'shell',title:'构建 Android 包',command:'./gradlew assembleDebug',started:now-3000,ended:now-2700,state:'completed',exit:0,running:false,output:true},
  {id:'bdemo4',kind:'shell',title:'检查代码风格',command:'npm run lint',started:now-4000,ended:now-3950,state:'failed',exit:1,running:false,output:true}]};}
async function bgDemoOutput(x){
 await new Promise(r=>setTimeout(r,140));
 const lines=x.id==='bdemo2'?['[09:41] CI 排队中','[09:44] CI 运行中：3/7 步']:x.id==='bdemo4'?['> lint','src/app.js:12:5  error  缺少分号','✖ 1 个问题']:
  x.id==='bdemo3'?['> Task :app:assembleDebug','BUILD SUCCESSFUL in 41s']:Array.from({length:60},(_,i)=>'test_case_'+String(i+1).padStart(2,'0')+' ... ok');
 return {task:x.id,state:x.state,source:x.kind==='monitor'?'events':'file',text:lines.join('\n')+'\n',size:lines.join('\n').length+1,truncated:false,mtime:Date.now()/1000-5};}
