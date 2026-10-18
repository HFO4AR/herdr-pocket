'use strict';
// Herdr on the computer: is its server up, 「启动 Herdr」 and the opt-in 「Herdr 守护」.
//  · State comes from the read-only bridge op `herdrHealth` (server running / stopped / mismatch /
//    busy, how the last run ended: a memory kill, a crash, a clean stop, a reboot; the guard). It is
//    read when the computer's 设备 card is drawn, when 会话 finds no running Herdr session, and after
//    a restart was noticed (`sessions` names the pid and start time of the server that is up).
//  · 「启动 Herdr」 is one explicit tap behind a sheet that says what will run (`herdrStart`, a UUID
//    receipt like every mutation; the bridge refuses when Herdr already runs and never stops one).
//  · 「Herdr 守护」 (sheet from the 设备 card) shows exactly what would be written and run
//    (`guardPlan`: file paths and contents, crontab lines, commands) and installs or removes it with
//    `guardSet`, bound to what was shown by its digest. Nothing is installed without that tap.
//  · After a restart the 会话 page says so once: which agents came back (Herdr resumes Claude / Codex
//    panes it has a session for) and which did not, with a way to 历史 (hook: resumeLost()).
// Snapshot of the agents on screen per computer: the encrypted native cache ('herdr'), titles only.
// Loaded after tmux.js; only declarations and wrappers at top level.
const HG={by:new Map()};
// Herdr's default server is known to be stopped (a health read said so): the 会话 card can offer the start.
function hgKnownDown(st){return !!st?.down&&st.health?.server?.state==='stopped';}
function hgDev(){return S.device&&!S.demo?S.device.id:'';}
function hgState(dev=hgDev()){if(!dev)return null;let st=HG.by.get(dev);
 if(!st){st={health:null,at:0,loading:null,down:false,restart:null,check:null,plan:null};HG.by.set(dev,st);}return st;}
function hgClock(epoch){if(!epoch)return '';const d=new Date(epoch*1000),now=new Date();const p=n=>String(n).padStart(2,'0');
 const t=p(d.getHours())+':'+p(d.getMinutes());return d.toDateString()===now.toDateString()?t:(d.getMonth()+1)+' 月 '+d.getDate()+' 日 '+t;}
// How a server run ended, in words (bridge ended_info).
function hgEndText(e){if(!e)return '';
 if(e.boot)return '电脑重启过，Herdr 还没起来';
 if(e.how==='oom')return '内存不够，被系统结束了'+({kernel:'（OOM killer）','systemd-oomd':'（systemd-oomd）',earlyoom:'（earlyoom）'}[e.oom]||'');
 if(e.how==='crash')return '意外退出了：被强制结束或崩溃，日志里没有正常关闭';
 return '是正常关掉的（herdr server stop、退出登录或收到结束信号）';}
function hgEnded(e){return '上次'+(e.at&&!e.boot?' '+hgClock(e.at)+' ':'')+hgEndText(e);}
function hgServerText(h){const s=h?.server;if(!h)return '读取中…';if(h.installed===false)return '没找到';if(!s)return '读不到';
 return {running:'运行中'+(s.version?' · '+s.version:''),mismatch:'版本不配套',stopped:'没在运行',busy:'没回应',error:'读不到'}[s.state]||'读不到';}
function hgGuardText(g){if(!g)return '读取中…';if(!g.installed)return g.supported?'没开':'不支持';
 if(g.kind==='systemd'&&g.active===false)return '装了，但没在运行';return '开着'+(g.outdated?' · 有新版本':'');}
async function hgHealth(dev=hgDev()){const st=hgState(dev);if(!st)return null;if(st.loading)return st.loading;
 st.loading=(async()=>{try{const h=await remote('herdrHealth',{device:dev});st.health=h;st.at=Date.now();st.down=h.server?.state==='stopped';hgIssue(h);return h;}
  catch(e){st.failed=Date.now();if(/Unknown operation|不支持的操作/.test(e.message||''))st.unsupported=true;return null;}
  finally{st.loading=null;if(hgDev()===dev&&!S.chat&&!overlay.childElementCount)render();}})();
 return st.loading;}
// The banner under the top bar (onboard.js hostCheck / connectionBanner) from a health read.
function hgIssue(h){if(!h||h.installed===false||hgDev()==='')return;const s=h.server?.state;
 if(s==='stopped')S.hostIssue={title:'Herdr 没在运行',text:h.server.ended?hgEnded(h.server.ended)+'。点「启动 Herdr」在电脑后台启动它。':'点「启动 Herdr」在电脑后台启动它，或者在电脑上打开 Herdr。',start:true};
 else if(s==='mismatch')S.hostIssue={title:'Herdr 版本不配套',text:'电脑上的 Herdr 更新过，正在运行的还是 '+(h.server.version||'旧版本')+'。在电脑上重启 Herdr 就好（会结束里面的 Agent，所以手机不替你做）。'};
 else if(S.hostIssue?.start)S.hostIssue=null;}

// ─── 启动 Herdr ───────────────────────────────────────────────────────────────
function hgStartSheet(){const st=hgState();if(!st)return;const h=st.health;const box=sheet('启动 Herdr');
 box.append(el('p','muted close-sub',h?.server?.ended?'Herdr 没在运行：'+hgEnded(h.server.ended)+'。':'Herdr 没在运行。'));
 const start=h?.start||{};const list=el('ul','ob-facts hg-facts');const fact=(t,warn)=>{const li=el('li',warn?'warn':'');li.append(icon(warn?'alert':'check'),el('span','',t));list.append(li);};
 fact('在电脑后台运行 herdr server，不打开 Herdr 界面，也不会开第二个');
 fact(start.method==='systemd'?'作为你的 systemd 用户服务（herdr-pocket-server）运行，SSH 断开、手机断开都不影响':'SSH 断开以后它照样运行');
 if(start.method!=='systemd'&&start.kill_user_processes===true)fact('这台电脑会在你完全退出登录后结束你的程序（KillUserProcesses=yes），那时 Herdr 也会停。在电脑上运行 loginctl enable-linger 可以避免',true);
 fact('工作区和标签按 Herdr 上次保存的样子回来；窗格里原来的 Agent 已经随旧的 Herdr 结束了。装了 Herdr 集成的 Claude / Codex，Herdr 会试着接回原来的对话，别的可以到「历史」里找');
 box.append(list);
 const actions=el('div','sheet-actions');const go=btn('启动 Herdr','primary',()=>hgStart(go));
 actions.append(btn('取消','secondary',closeSheet),go);box.append(actions);}
async function hgStart(b){const dev=hgDev();if(!dev)return;if(b)b.disabled=true;
 try{const r=await remote('herdrStart',{id:uuid(),device:dev});closeSheet();
  toast(r.running?'Herdr 启动了':'已经在启动了，过几秒刷新一下');S.hostIssue=null;const st=hgState(dev);st.down=false;st.health=null;
  if(hgDev()===dev){hgHealth(dev);if(S.tab==='live')loadLive();else render();}}
 catch(e){if(b)b.disabled=false;error(e);}}

// ─── Herdr 守护 ───────────────────────────────────────────────────────────────
function hgEventText(e){if(!e)return '';const why={oom:'内存不够被结束',crash:'意外退出',unknown:'没在运行',before:'开机或登录后',stopped:'正常关掉后'}[e.reason]||e.reason;
 const at=e.at?hgClock(e.at)+' ':'';
 if(e.what==='started')return at+'拉起过 Herdr（'+why+'）';if(e.what==='left')return at+'Herdr 正常关掉了，没去拉起';if(e.what==='failed')return at+'想拉起 Herdr，没成功（'+why+'）';return '';}
async function hgGuardSheet(opts){const dev=hgDev(),st=hgState(dev);if(!st)return;
 const box=sheet('Herdr 守护');box.classList.add('hg-sheet');const body=el('div','hg-body');box.append(body);
 body.append(el('p','muted close-sub','Herdr 被系统杀掉（比如内存不够）或崩溃退出后，自动把它重新启动，手机就能接着连上。你自己用 herdr server stop 关掉的，它不去拉起。'));
 const wait=el('div','hg-wait');wait.setAttribute('role','status');wait.append(el('span','spinner'),el('span','','正在看这台电脑能装什么…'));body.append(wait);
 const g=st.health?.guard;const o=opts||{boot:g?.installed?!!g.boot:true,always:g?.installed?!!g.always:false};
 let plan;try{[plan]=await Promise.all([remote('guardPlan',{...o,device:dev}),st.health?null:hgHealth(dev)]);}
 catch(e){wait.remove();body.append(el('p','hg-error',e.message||String(e)));return;}
 if(!box.isConnected||hgDev()!==dev)return;wait.remove();st.plan=plan;hgGuardFill(box,body,plan,hgState(dev).health?.guard,o);}
function hgGuardFill(box,body,plan,g,o){
 if(g?.installed){const s=el('div','hg-now');s.append(el('strong','',hgGuardText(g)+' · '+(g.kind==='cron'?'crontab':'systemd 用户服务')));
  const ev=(g.events||[]).filter(e=>e.what!=='already').slice(-3).reverse().map(hgEventText).filter(Boolean);
  s.append(el('span','fine',ev.length?ev.join('；'):'还没拉起过 Herdr'));body.append(s);}
 if(!plan.supported){body.append(el('p','hg-note',plan.reason||'这台电脑装不了守护。'));
  if(g?.installed)body.append(hgActions(box,plan,g,o));else{const a=el('div','sheet-actions');a.append(btn('知道了','secondary',closeSheet));body.append(a);}return;}
 const redo=next=>{box.querySelectorAll('.hg-body').forEach(n=>n.remove());const nb=el('div','hg-body');box.append(nb);
  const w=el('div','hg-wait');w.append(el('span','spinner'),el('span','','重新生成要装的内容…'));nb.append(w);
  remote('guardPlan',{...next,device:hgDev()}).then(p=>{if(!box.isConnected)return;w.remove();hgGuardFill(box,nb,p,g,next);}).catch(e=>{w.remove();nb.append(el('p','hg-error',e.message||String(e)));});};
 body.append(toggle('登录或开机后也启动 Herdr','电脑开机或你登录后，Herdr 没在运行就启动它（你自己关掉的除外）',o.boot,v=>{redo({...o,boot:v});}),
  toggle('正常关掉的也拉起','连 herdr server stop 关掉的也马上重新启动；那样要停 Herdr 得先关守护',o.always,v=>{redo({...o,always:v});}));
 const notes=el('ul','ob-facts hg-facts');const note=(t,warn)=>{const li=el('li',warn?'warn':'');li.append(icon(warn?'alert':'check'),el('span','',t));notes.append(li);};
 note('只在 Herdr 不在时启动它；Herdr 在运行就什么都不做，从不停止、重启或结束 Herdr，也不碰窗格和 Agent');
 if(plan.kind==='cron')note('这台电脑没有 systemd 用户服务，改用 crontab：每分钟看一次'+(o.boot?'，开机时（@reboot）也看一次':''));
 if(plan.kind==='systemd'){
  if(plan.oom?.set!=null)note('守护启动的 Herdr 把 OOM 分数调到 '+plan.oom.set+'（你的其他程序默认 '+plan.oom.default+'），内存不够时系统先挑别的程序。再往下调（比如 -500）要 root，没做；窗格里的 Agent 也会用这个分数');
  else note('这台电脑不让普通用户调低 OOM 分数，守护只负责重启');
  if(plan.linger===false){const li=el('li','warn');li.append(icon('alert'));const t=el('span','');t.append(document.createTextNode('这台电脑没开 linger：重启以后要先登录一次（桌面或 SSH 都行）守护才开始工作，退出全部登录时它和 Herdr 也会停。想不登录也运行，在电脑终端里运行（可能要输密码，手机不替你运行）：'));
   const row=el('div','ob-cmd');row.append(el('code','','loginctl enable-linger'),ib('copy','复制命令',()=>copyText('loginctl enable-linger')));t.append(row);li.append(t);notes.append(li);}}
 body.append(notes);
 // Exactly what 开启守护 writes and runs (guardPlan), folded.
 const d=el('details','ob-how hg-plan');d.append(el('summary','','会装哪些东西'));
 (plan.files||[]).forEach(f=>{const head=el('p','hg-path');head.append(el('span','',(f.what||'文件')+'：'),el('code','',f.path));d.append(head);
  if(f.what==='守护脚本'){const s=el('details','hg-script');s.append(el('summary','','看脚本内容（'+f.content.split('\n').length+' 行 · SHA-256 '+String(f.sha256||'').slice(0,12)+'…）'));s.append(el('pre','hg-pre',f.content));d.append(s);}
  else d.append(el('pre','hg-pre',f.content));});
 if(plan.cron?.length){d.append(el('p','hg-path','crontab 里加上：'));d.append(el('pre','hg-pre',plan.cron.join('\n')));}
 d.append(el('p','hg-path','然后运行：'));d.append(el('pre','hg-pre',(plan.commands||[]).join('\n')));
 d.append(el('p','hg-path','「关闭守护」会：'));d.append(el('pre','hg-pre',(plan.remove||[]).join('\n')));
 body.append(d);body.append(hgActions(box,plan,g,o));}
function hgActions(box,plan,g,o){const a=el('div','sheet-actions');
 if(g?.installed){const off=btn('关闭守护','secondary hg-off',()=>hgSet(off,false,o,plan));a.append(off);
  const same=!!g.boot===o.boot&&!!g.always===o.always&&!g.outdated&&g.kind===plan.kind;
  if(plan.supported&&!same){const up=btn('更新守护','primary',()=>hgSet(up,true,o,plan));a.append(up);}
  else a.append(btn('好的','secondary',closeSheet));}
 else{a.append(btn('取消','secondary',closeSheet));if(plan.supported){const on=btn('开启守护','primary',()=>hgSet(on,true,o,plan));a.append(on);}}
 return a;}
async function hgSet(b,enable,o,plan){const dev=hgDev();if(!dev)return;b.disabled=true;
 try{const r=await remote('guardSet',enable?{id:uuid(),enable:true,boot:o.boot,always:o.always,digest:plan.digest,device:dev}:{id:uuid(),enable:false,device:dev});
  closeSheet();toast(enable?(r.active===false?'装好了，但守护没在运行，打开看看':'守护开好了'):'守护关了，Herdr 照常运行');
  const st=hgState(dev);st.health=null;hgHealth(dev);}
 catch(e){b.disabled=false;error(e);}}

// ─── After a restart: which agents came back ─────────────────────────────────
// `sessions` (app.js loadLive) names the server run that is up; the last list seen on this phone is
// kept with the start time of the run it came from.
function guardSessions(r){const dev=hgDev(),st=hgState(dev);if(!st||!r||r.herdr===false)return;
 const up=(r.sessions||[]).some(x=>x.running);st.server=r.server||null;
 if(!up){st.down=true;if(!st.health||Date.now()-st.at>8000||st.health.server?.state!=='stopped')hgHealth(dev);
  st.check=cacheGet('herdr',dev).then(v=>{st.before=v?.agents||[];if(hgDev()===dev&&!S.chat)render();}).catch(()=>{});return;}
 st.down=false;if(S.hostIssue?.start)S.hostIssue=null;
 if(!r.server?.started){st.check=null;return;}
 st.check=cacheGet('herdr',dev).then(v=>{if(v?.started&&r.server.started>v.started+1&&v.agents?.length&&!(st.restart&&st.restart.at===r.server.started))
  {st.restart={at:r.server.started,before:v.agents,back:[],lost:[],dismissed:false};hgHealth(dev);}}).catch(()=>{});}
function hgSnap(a){return {agent:a.agent||'',title:titleOf(a),session:a.agent_session?.value||null};}
async function guardAfterLive(){const dev=hgDev(),st=hgState(dev);if(!st||!st.server?.started||S.liveError)return;
 try{await st.check;}catch(_){}
 if(hgDev()!==dev||!st.server)return;
 if(st.restart&&!st.restart.done){const now=new Set(S.agents.map(a=>a.agent_session?.value).filter(Boolean));
  st.restart.back=st.restart.before.filter(a=>a.session&&now.has(a.session));st.restart.lost=st.restart.before.filter(a=>!a.session||!now.has(a.session));st.restart.done=true;}
 cachePut('herdr',{started:st.server.started,agents:S.agents.slice(0,60).map(hgSnap)},dev);
 if(st.restart&&S.tab==='live'&&!S.chat)render();}
function hgHistory(lost){if(typeof resumeLost==='function'){resumeLost(lost);return;}setTab('history');}
function hgLostList(card,items){if(!items?.length)return;const ul=el('ul','hg-lost');items.slice(0,4).forEach(a=>{const li=el('li');li.append(el('span','hg-kind',providerName?providerName(a.agent):a.agent),el('span','truncate',a.title||'（无标题）'));ul.append(li);});
 if(items.length>4)ul.append(el('li','fine','还有 '+(items.length-4)+' 个'));card.append(ul);}
function hgRestartCard(main,st){const r=st.restart;if(!r||r.dismissed||!r.done)return;
 const card=el('section','hg-card hg-restart');card.setAttribute('role','status');const top=el('div','row');top.append(icon('refresh'));const t=el('div','grow');
 t.append(el('strong','','Herdr 在 '+hgClock(r.at)+' 重新启动过'));
 const prev=st.health?.server?.previous;const ev=(st.health?.guard?.events||[]).slice().reverse().find(e=>e.what==='started'&&e.at>=r.at-60&&e.at<=r.at+60);
 const why=[];if(prev&&!prev.boot)why.push('上次'+hgEndText(prev));else if(prev?.boot)why.push('电脑重启过');if(ev)why.push('守护自动拉起了它');
 if(why.length)t.append(el('span','fine',why.join('，')+'。'));top.append(t,ib('close','知道了',()=>{r.dismissed=true;render();}));card.append(top);
 if(r.back.length)card.append(el('p','hg-line','接回了 '+r.back.length+' 个：Herdr 用原来的对话重新打开了它们'));
 if(r.lost.length){card.append(el('p','hg-line','没回来 '+r.lost.length+' 个，它们随旧的 Herdr 结束了：'));hgLostList(card,r.lost);
  const a=el('div','hg-actions');a.append(btn('去历史找回对话','secondary small',()=>hgHistory(r.lost),'history'));card.append(a);}
 main.prepend(card);}
function hgDownCard(main,st){const h=st.health;const card=el('section','hg-card hg-down');card.setAttribute('role','status');
 const top=el('div','row');top.append(icon('alert'));const t=el('div','grow');t.append(el('strong','','Herdr 没在运行'));
 const e=h?.server?.ended;t.append(el('span','fine',e?hgEnded(e)+'。':h?'它的窗格和 Agent 现在都不在。':'正在看它怎么了…'));top.append(t);card.append(top);
 if(st.before?.length){card.append(el('p','hg-line','之前在跑的 '+st.before.length+' 个 Agent 随它结束了：'));hgLostList(card,st.before);}
 const a=el('div','hg-actions');
 if(h?.server?.state==='stopped')a.append(btn('启动 Herdr','primary small',hgStartSheet,'refresh'));
 if(h?.guard&&(h.guard.supported||h.guard.installed))a.append(btn(h.guard.installed?'守护：'+hgGuardText(h.guard):'开启 Herdr 守护','secondary small',()=>hgGuardSheet()));
 if(st.before?.length)a.append(btn('去历史','link-btn',()=>hgHistory(st.before)));
 card.append(a);main.prepend(card);}

(function(){
 const baseCard=currentCard,baseLive=livePage,baseLoad=loadLive,baseHost=hostCheck,baseBanner=connectionBanner;
 // 设备 card of the computer on screen: Herdr's server and the guard, each with its one action.
 currentCard=function(d){const card=baseCard(d);const st=hgState();if(!st||S.herdr===false||st.unsupported)return card;
  const facts=card.querySelector('.dev-facts');if(!facts)return card;
  if(!st.health&&!st.loading&&Date.now()-(st.failed||0)>8000)hgHealth();
  const h=st.health;const row=(k,v,action)=>{const n=el('div','setting-row dev-fact');n.append(el('span','',k));const val=el('span','dev-value',v);n.append(val);if(action)n.append(action);facts.append(n);};
  const stopped=h?.server?.state==='stopped';
  const go=stopped?btn('启动','link-btn dev-action',hgStartSheet):null;if(go)go.setAttribute('aria-label','启动 Herdr');
  row('Herdr',hgServerText(h),go);
  if(h&&h.installed!==false){const set=btn('设置','link-btn dev-action',()=>hgGuardSheet());set.setAttribute('aria-label','Herdr 守护设置');row('Herdr 守护',hgGuardText(h.guard),set);}
  return card;};
 livePage=function(main){baseLive(main);const st=hgState();if(!st||!S.device||S.herdr===false)return;
  if(hgKnownDown(st)&&!S.sessions.length&&!S.liveLoading&&!S.liveError)hgDownCard(main,st);else hgRestartCard(main,st);};
 loadLive=async function(...args){const r=await baseLoad(...args);guardAfterLive();return r;};
 // doctor (on connect) names the server state: a stopped server gets 「启动 Herdr」 in the banner.
 hostCheck=function(h){baseHost(h);if(!h||h.herdr===false||h.error)return;const s=h.server?.state;if(!S.hostIssue&&s!=='mismatch')return;
  if(s==='mismatch')S.hostIssue={title:'Herdr 版本不配套',text:'电脑上的 Herdr 更新过，正在运行的还是 '+(h.server.version||'旧版本')+'。在电脑上重启 Herdr 就好（会结束里面的 Agent，所以手机不替你做）。'};
  else if(h.running===0||s==='stopped')S.hostIssue={title:'Herdr 没在运行',text:'点「启动 Herdr」在电脑后台启动它，或者在电脑上打开 Herdr。',start:true};};
 connectionBanner=function(root){const issue=S.hostIssue,st=hgState();
  // On 会话 the page itself says it (hgDownCard) with the same button.
  if(issue?.start&&S.tab==='live'&&!S.chat&&hgKnownDown(st)&&!S.sessions.length){S.hostIssue=null;try{return baseBanner(root);}finally{S.hostIssue=issue;}}
  const r=baseBanner(root);
  if(issue?.start&&S.device&&!S.demo&&!st?.unsupported){const acts=root.querySelector('.connection-status.warn .ob-banner-actions');if(acts&&!acts.querySelector('.hg-start'))acts.prepend(btn('启动 Herdr','secondary small hg-start',()=>{if(!hgState()?.health)hgHealth().then(()=>hgStartSheet());else hgStartSheet();}));}
  return r;};
})();
