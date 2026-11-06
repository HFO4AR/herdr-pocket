'use strict';
// ch 控制台: the approvals, temporary ports / persistent rules and bridge pause controls of
// ch-cli's `ch control`, from the phone.
//  · Read-only summaries ride along with `sessions`, `agents` and `status` (bridge field `ch`),
//    so the badge, banner and background alert never need a running phone console.
//  · The full view asks the bridge's `chConsole` op, which forwards to `ch __control-serve` on
//    the computer; that process owns the ports lock and re-checks every target. If the computer's
//    ch is too old, the bridge falls back to `chApprovals`, a read-only queue view.
//  · Nothing here approves on its own: each decision is one tap on one request, after its full
//    text has been shown, with the console's 700 ms reading pause and a second step for rules.
const CH={view:null,tab:'approvals',data:null,summary:null,error:'',loading:false,polling:false,
  epoch:0,expanded:'',shownAt:0,busy:false,lastPoll:0,readOnly:'',readOnlyReason:''};

function chDevice(){return S.device&&!S.demo?S.device.id||'':'';}
function chSummaryData(){const s=CH.summary;return s&&s.device===chDevice()?s:null;}
function chPendingCount(){
  const s=chSummaryData();if(s)return Number(s.count)||0;
  return CH.view&&CH.data?((CH.data.pending||[]).length):0;
}
// Called by app.js for every sessions/agents/status answer. `summary` is the bridge's `ch` field.
function chNoteStatus(summary){
  if(!summary||!S.device||S.demo)return;
  const before=chPendingCount();
  CH.summary={device:S.device.id||'',available:!!summary.available,paused:summary.paused||'running',
    count:Number(summary.count)||0,expires_at:summary.expires_at||null,server:!!summary.server,
    truncated:!!summary.truncated};
  if(before!==chPendingCount()&&S.tab==='live'&&!S.chat&&!(typeof T!=='undefined'&&T.view)&&
     !(typeof FX!=='undefined'&&FX.view)&&!CH.view&&!overlay.childElementCount)render();
}

function chConsoleOpen(tab='approvals'){
  if(S.demo){toast('演示模式不连电脑，不能打开 ch 控制台');return;}
  if(!S.device){toast('先连上电脑');return;}
  const backChat=S.chat,backTerminal=(typeof T!=='undefined'&&T.view)?T.view:null;
  if(typeof leaveTerminal==='function')leaveTerminal();
  closeSheet();S.chat=null;
  CH.view={device:S.device.id||'',backChat,backTerminal,seq:(CH.seq=(CH.seq||0)+1)};
  CH.polling=false;
  CH.tab=tab;CH.data=null;CH.error='';CH.loading=true;CH.expanded='';CH.shownAt=0;
  CH.readOnly='';CH.readOnlyReason='';CH.lastPoll=0;
  renderChConsole();chPoll(true);
}
function chConsoleLeave(){CH.view=null;}
function chConsoleReturn(){
  const v=CH.view;if(!v)return false;const chat=v.backChat,term=v.backTerminal;CH.view=null;
  if(chat){S.chat=chat;S.epoch++;renderChat();return true;}
  if(term&&typeof T!=='undefined'){
    if(term.kind==='attach'&&typeof attachOpen==='function'){attachOpen(term.pane,term.readOnly);return true;}
    if(!term.disposed){T.view=term;renderTerminal();if(typeof pollTerminal==='function')pollTerminal();return true;}
  }
  render();return true;
}
function chConsoleBack(){
  if(!CH.view)return false;
  if(CH.expanded){CH.expanded='';CH.shownAt=0;paintChConsole();return true;}
  CH.view=null;render();return true;
}
function chConsoleWideSolo(){
  if(typeof LAYOUT==='undefined'||!LAYOUT.wide||!LAYOUT.frame)return;
  const f=LAYOUT.frame;f.root.dataset.mode='solo';f.detail.replaceChildren();
  const de=document.documentElement;de.classList.add('wide-on');de.classList.remove('wide-split','wide-focus');
}
function chEntryButton(){
  if(S.demo||!S.device)return null;
  const count=chPendingCount();if(!count)return null;
  const b=btn('','pill ch-entry',()=>chConsoleOpen('approvals'),'alert');
  b.append(el('span','','审批 '+count));
  b.setAttribute('aria-label','ch 审批，'+count+' 条等待');
  return b;
}

function renderChConsole(){
  const v=CH.view;if(!v)return;
  const old=document.getElementById('ch-main');const top=old?old.scrollTop:null;
  chConsoleWideSolo();
  const root=shell();root.classList.add('ch-shell');
  const head=el('header','chat-head ch-head');
  head.append(ib('back','返回',chConsoleReturn));
  const t=el('div','grow');
  t.append(el('h1','ch-title','ch 控制台'));
  const sub=el('p','ch-sub');
  sub.append(el('span','',S.device&&S.device.name?S.device.name:'这台电脑'));
  const s=chSummaryData();if(s&&s.count)sub.append(el('span','ch-head-count',s.count+' 条等待'));
  t.append(sub);
  head.append(t,ib('refresh','刷新',()=>chPoll(true)));
  root.append(head);
  const tabs=el('div','chat-tabs ch-tabs');tabs.setAttribute('role','tablist');
  [['approvals','审批'],['ports','端口与 SSH'],['bridges','桥']].forEach(([id,label])=>{
    const b=btn(label,CH.tab===id?'active':'',()=>{if(CH.tab===id){chPoll(true);return;}CH.tab=id;CH.expanded='';CH.shownAt=0;chPoll(true);});
    b.setAttribute('role','tab');b.setAttribute('aria-selected',String(CH.tab===id));
    tabs.append(b);
  });
  root.append(tabs);
  const main=el('main','main ch-main');main.id='ch-main';root.append(main);
  paintChConsole();
  if(top!==null)main.scrollTop=top;
}
function paintChConsole(){
  const main=document.getElementById('ch-main');if(!main||!CH.view)return;
  const data=CH.data;main.replaceChildren();
  if(CH.loading&&!data){loadingCard(main,'正在读取 ch 控制台','读取这台电脑上的审批、端口和 bridge…');return;}
  if(CH.error){empty(main,'读取失败',CH.error,btn('重试','primary',()=>chPoll(true)));return;}
  if(!data)return;
  if(CH.readOnly){
    const n=el('div','ch-readonly');n.append(icon('alert'),el('span','grow',CH.readOnlyReason||'这台电脑上的 ch 还没有手机控制台；现在只能查看。更新 ch 后可以批准和操作。'));
    n.append(btn('重试','link-btn',()=>{CH.readOnly='';CH.readOnlyReason='';CH.error='';chPoll(true);}));
    main.append(n);
  }
  if(data.paused==='paused'){
    const n=el('div','ch-paused');n.append(icon('pause'),el('span','grow','已暂停：不能批准，等待中的请求会被拒绝。'));
    if(!CH.readOnly)n.append(btn('恢复','link-btn',chResumeAll));
    main.append(n);
  }else if(data.paused==='unknown')main.append(el('div','ch-warn','读不到暂停状态，按已暂停处理。'));
  const guardian=data.guardian;
  if(guardian&&guardian.active){
    const n=el('div','ch-guardian');
    n.append(icon('lock'),el('span','grow','看护模式进行中：这些会话的命令不再逐条批准'+(guardian.targets&&guardian.targets.length?'（'+guardian.targets.length+' 个会话）':'')));
    if(guardian.expires_at_ms){const left=el('span','ch-left');left.dataset.mexp=guardian.expires_at_ms;n.append(left);}
    main.append(n);
  }
  if(data.pending_truncated&&CH.tab==='approvals')main.append(el('p','ch-warn','还有更多等待中的请求没有列出；请到电脑上的 ch control 处理。'));
  if(CH.tab==='approvals')paintApprovals(main,data);
  else if(CH.tab==='ports')paintPorts(main,data);
  else paintBridges(main,data);
  chUpdateTimes();
}

function shortChId(id){const s=String(id||'');return s.slice(0,8);}
function chProjectName(item){return item.project_name||(item.project?String(item.project).split('/').filter(Boolean).pop():'');}
function paintApprovals(main,data){
  const list=data.pending||[];
  if(!list.length){empty(main,'没有等待审批的请求','远端 Agent 申请沙箱外命令、端口或常开规则时会出现在这里。');return;}
  main.append(el('p','ch-note','最早的在前。每一条只代表一条命令；没有全部批准。'));
  const card=el('div','card ch-list');
  list.forEach(item=>{
    const row=btn('','ch-row'+(item.standing?' standing':'')+(item.id===CH.expanded?' open':''),()=>chExpand(item));
    row.setAttribute('aria-expanded',String(item.id===CH.expanded));
    const top=el('div','ch-row-top');
    const ic=el('span','ch-row-ic');ic.append(icon(item.standing?'lock':(item.ports&&item.ports.length?'plug':'alert')));
    const body=el('div','grow');
    body.append(el('div','ch-row-title',item.asks||'命令审批'));
    const meta=el('div','ch-row-meta');
    meta.append(el('span','ch-tag ch-session',shortChId(item.session)));
    if(item.account)meta.append(el('span','ch-tag',item.account));
    if(chProjectName(item))meta.append(el('span','ch-tag',chProjectName(item)));
    if(item.ports&&item.ports.length)meta.append(el('span','ch-tag ch-tag-port','端口 '+item.ports.join(', ')));
    if(item.standing)meta.append(el('span','ch-tag ch-tag-danger','常开规则'));
    body.append(meta);
    const side=el('span','ch-left');side.dataset.exp=item.expires_at;
    top.append(ic,body,side);row.append(top);card.append(row);
    if(item.id===CH.expanded)card.append(chDetail(item));
  });
  main.append(card);
}
function chDetail(item){
  const box=el('div','ch-detail');
  box.append(el('pre','ch-text',item.text||''));
  if(item.truncated)box.append(el('p','ch-warn','内容太长，手机上不能批准；请到电脑上的 ch control 查看。'));
  if(item.standing)box.append(el('p','ch-warn','这是常开规则，不是一次性授权：批准后只要这个会话连着就一直有效，直到在「端口与 SSH」里删除。'));
  if(item.ports&&item.ports.length&&!item.standing)box.append(el('p','ch-note','「批准」只允许这一条命令；「放行端口 15 分钟」还会为这个会话开放这些端口。'));
  if(item.approve_reason&&!CH.readOnly)box.append(el('p','ch-warn',item.approve_reason));
  if(CH.readOnly)box.append(el('p','ch-warn','更新电脑上的 ch 后才能在这里批准。'));
  const actions=el('div','ch-actions');
  if(!CH.readOnly){
    const can=!!item.approvable&&!item.truncated&&!CH.busy;
    const approve=btn(item.standing?'批准常开规则':'批准','primary small',()=>chApprove(item));
    const open=item.ports&&item.ports.length&&!item.standing?btn('放行端口 15 分钟','secondary small',()=>chApprove(item,true)):null;
    const deny=btn('拒绝','link-btn danger',()=>chDeny(item));
    [approve,open].filter(Boolean).forEach(b=>{if(!can||Date.now()-CH.shownAt<700){b.disabled=true;b.dataset.guard='1';}});
    actions.append(...[approve,open,deny].filter(Boolean));
  }
  box.append(actions);
  setTimeout(()=>chArmDetail(item),0);
  return box;
}
function chArmDetail(item){
  if(!CH.view||CH.tab!=='approvals'||CH.expanded!==item.id)return;
  const left=700-(Date.now()-CH.shownAt);
  if(left>0){setTimeout(()=>chArmDetail(item),left);return;}
  document.querySelectorAll('.ch-detail [data-guard]').forEach(b=>{b.disabled=false;delete b.dataset.guard;});
}
function chExpand(item){
  if(CH.expanded===item.id){CH.expanded='';CH.shownAt=0;paintChConsole();return;}
  CH.expanded=item.id;CH.shownAt=Date.now();paintChConsole();
  const main=document.getElementById('ch-main');const d=main&&main.querySelector('.ch-detail');if(d)d.scrollIntoView({block:'nearest'});
}
async function chDecideRun(item,action,extra={}){
  if(CH.readOnly){toast(CH.readOnlyReason||'更新电脑上的 ch 后才能批准');return;}
  if(CH.busy)return;CH.busy=true;
  try{
    const reply=await remote('chConsole',{action,approval_id:item.id,request_id:uuid(),...extra});
    if(reply&&reply.ok){
      const r=reply.result||{};
      toast(r.won===false?'该请求已在另一个控制台处理':(r.decision==='allow'?'已批准这一条':'已拒绝这一条'));
      CH.expanded='';CH.shownAt=0;
      if(!chApplyState(reply))await chPoll(true);
      else{
        if(r.approval_id)CH.data.pending=(CH.data.pending||[]).filter(x=>x.id!==r.approval_id);
        paintChConsole();
      }
      setTimeout(()=>{if(CH.view)chPoll(true);},700);
    }else{
      toast((reply&&reply.error)||'没有完成');
      if(reply&&reply.result&&reply.result.state)CH.data=reply.result.state;
      paintChConsole();chPoll(true);
    }
  }catch(e){toast(e.message||String(e));chPoll(true);}
  finally{CH.busy=false;}
}
function chApprove(item,openPorts){
  if(item.standing){chStandingSheet(item);return;}
  chDecideRun(item,openPorts?'decide_and_open':'decide',openPorts?{}:{decision:'allow'});
}
function chDeny(item){chDecideRun(item,'decide',{decision:'deny'});}
function chStandingSheet(item){
  const box=sheet('批准常开规则？');
  box.append(el('p','ch-warn','这是常开规则，不是一次性授权。确认后它一直有效，直到你在「端口与 SSH」页删除。'));
  box.append(el('pre','ch-text',item.text||''));
  const row=el('div','sheet-actions');
  const ok=btn('确认批准','primary danger-fill',()=>{closeSheet();chDecideRun(item,'decide_standing');});
  ok.disabled=true;setTimeout(()=>{ok.disabled=false;},720);
  row.append(btn('取消','secondary',closeSheet),ok);box.append(row);
}
function chApplyState(reply){
  const state=reply&&reply.ok&&reply.result?reply.result.state:null;
  if(state&&typeof state==='object'){CH.data=state;return true;}
  return false;
}

async function chRun(action,extra,message){
  if(CH.readOnly){toast(CH.readOnlyReason||'更新电脑上的 ch 后才能操作');return false;}
  if(CH.busy)return false;CH.busy=true;
  try{
    const reply=await remote('chConsole',{action,request_id:uuid(),...extra});
    if(reply&&reply.ok){
      const outcome=reply.result&&reply.result.result;
      if(!chApplyState(reply))await chPoll(true);
      else paintChConsole();
      toast(chOutcomeText(outcome,message));
      return true;
    }
    toast((reply&&reply.error)||'没有完成');
    if(reply&&reply.result&&reply.result.state)CH.data=reply.result.state;
    paintChConsole();return false;
  }catch(e){toast(e.message||String(e));chPoll(true);return false;}
  finally{CH.busy=false;}
}

function chOutcomeText(outcome,fallback){
  if(outcome==='already_open')return '这个桥已经是打开状态';
  if(outcome==='already_paused')return '这个桥现在是暂停状态';
  if(outcome==='already_closed')return '这个桥已经是关闭状态';
  if(outcome==='already_running')return '这个桥已经在运行';
  if(outcome==='unknown')return '读不到这个 bridge 的状态；刷新后再试';
  return fallback;
}
async function chPoll(force=false){
  if(!CH.view||CH.polling)return;
  if(!force&&Date.now()-CH.lastPoll<1200)return;
  CH.polling=true;CH.lastPoll=Date.now();const epoch=++CH.epoch;const dev=CH.view.device;const seq=CH.view.seq;
  if(!CH.data)CH.loading=true;
  try{
    const reply=await remote('chConsole',{action:'list',request_id:uuid()});
    if(epoch!==CH.epoch||!CH.view||CH.view.device!==dev||CH.view.seq!==seq)return;
    if(reply&&reply.ok){CH.data=reply.result;CH.error='';CH.readOnly='';CH.readOnlyReason='';CH.loading=false;}
    else{
      CH.readOnlyReason=(reply&&reply.error)||'这台电脑上的 ch 还没有手机控制台。';
      await chReadOnly(epoch,dev,seq);
      return;
    }
    chKeepExpanded();paintChConsole();
  }catch(e){
    if(epoch!==CH.epoch)return;
    CH.readOnlyReason=e.message||String(e);
    await chReadOnly(epoch,dev,seq);
  }finally{if(epoch===CH.epoch)CH.polling=false;}
}
async function chReadOnly(epoch,dev,seq){
  try{
    const ro=await remote('chApprovals',{});
    if(epoch!==CH.epoch||!CH.view||CH.view.device!==dev||CH.view.seq!==seq)return;
    CH.data=chReadOnlyData(ro);CH.error='';CH.loading=false;CH.readOnly=CH.readOnlyReason||'read_only';
    chKeepExpanded();paintChConsole();
  }catch(e){
    if(epoch!==CH.epoch)return;
    CH.error=e.message||String(e);CH.loading=false;paintChConsole();
  }
}
function chReadOnlyData(ro){
  return {paused:ro&&ro.paused||'running',pending:(ro&&ro.approvals)||[],
    pending_total:ro&&ro.count||0,pending_truncated:!!(ro&&ro.truncated),
    ports:{held_by_us:false,held_elsewhere:false,state:'closed',sessions:[]},
    standing:{rules:[],error:null},bridges:[],candidates:[],now:ro&&ro.now,read_only:true};
}
function chKeepExpanded(){
  const ids=new Set(((CH.data&&CH.data.pending)||[]).map(x=>x.id));
  if(CH.expanded&&!ids.has(CH.expanded)){CH.expanded='';CH.shownAt=0;toast('这条请求已经处理或过期');}
}
function chResumeAll(){confirmAction('恢复全部 bridge？','恢复后新的命令和审批会重新被接受。','恢复',()=>chRun('resume',{},'已恢复全部 bridge'));}
function chConfirmBridge(b,action){
  const text=action==='close'?'关闭这个 bridge？运行中的命令会被终止；在重新打开之前它不会启动。':
    action==='reopen'?'重新打开这个 bridge？有会话的终端连着就马上启动，否则下次连接时启动。':'恢复这个 bridge？';
  confirmAction(action==='close'?'关闭 bridge？':action==='reopen'?'重新打开？':'恢复 bridge？',text,
    action==='close'?'关闭':action==='reopen'?'重新打开':'恢复',
    ()=>chRun('bridge_action',{bridge:b.key,bridge_do:action},action==='close'?'已关闭这个 bridge':action==='reopen'?'已重新打开这个 bridge':'已恢复这个 bridge'),action==='close');
}
function chBridgeState(state){return state==='open'?'打开':state==='paused'?'已暂停':state==='closed'?'已关闭':'状态未知';}

function paintPorts(main,data){
  const ports=data.ports||{};const sessions=ports.sessions||[];const held=!!ports.held_by_us;
  if(ports.held_elsewhere&&!held)main.append(el('div','ch-warn','另一个控制台（电脑上的 ch control）开放着端口；到那里操作，这里只显示。'));
  else if(ports.state==='closed'&&ports.reason&&!sessions.length)main.append(el('p','ch-fine',ports.reason));
  const total=sessions.reduce((n,s)=>n+((s.ports||[]).length),0);
  const head=el('div','section-label group-label');head.append(el('span','','临时开放的端口'),el('span','group-count',String(total)));main.append(head);
  if(!sessions.length)main.append(el('p','ch-fine','没有临时开放的端口。'));
  else{
    const card=el('div','card ch-card');
    sessions.forEach(entry=>{
      const boxEl=el('div','ch-port-session');
      const title=el('div','ch-port-head');
      title.append(el('strong','grow',entry.project||'—'));
      if(entry.account)title.append(el('span','ch-tag',entry.account));
      title.append(el('span','ch-tag ch-session',shortChId(entry.session)));
      boxEl.append(title);
      (entry.ports||[]).forEach(open=>{
        const row=el('div','ch-port-row');
        const text=el('div','grow');
        text.append(el('span','ch-port','端口 '+open.port),el('span','ch-fine',open.origin==='request'?'批准申请时放行':'你开放的'));
        const left=el('span','ch-port-left');left.dataset.mexp=open.expires_at_ms;text.append(left);
        row.append(text);
        if(held&&!CH.readOnly)row.append(btn('+1 小时','link-btn',()=>chRun('ports_extend',{id:open.id},'已加 1 小时')),btn('关闭','link-btn danger',()=>chRun('ports_close',{id:open.id},'已关闭')));
        boxEl.append(row);
      });
      if(held&&!CH.readOnly){
        const acts=el('div','ch-actions ch-actions-end');
        acts.append(btn('此会话 +1 小时','secondary small',()=>chRun('ports_extend_session',{id:entry.id},'已加 1 小时')),
          btn('关闭此会话','secondary small',()=>chRun('ports_close_session',{id:entry.id},'已关闭这个会话的端口')));
        boxEl.append(acts);
      }
      card.append(boxEl);
    });
    main.append(card);
  }
  if(held&&sessions.length&&!CH.readOnly)main.append(btn('全部关闭临时端口','secondary wide',()=>confirmAction('关闭全部临时端口？','依赖这些端口运行中的命令会被终止。常开规则不受影响。','全部关闭',()=>chRun('ports_close_all',{},'已关闭全部临时端口'),true)));
  if(!CH.readOnly){
    const acts=el('div','ch-actions ch-actions-wrap');
    acts.append(btn('开放端口…','primary small',()=>chOpenPortsSheet(data)),
      btn('添加常开端口…','secondary small',()=>chStandingAddSheet('port',data)),
      btn('添加常开 SSH…','secondary small',()=>chStandingAddSheet('ssh',data)));
    main.append(acts);
  }
  const standing=data.standing||{};const rules=standing.rules||[];
  if(standing.error)main.append(el('div','ch-warn','常开规则文件异常：'+standing.error));
  [['port','常开端口'],['ssh','常开 SSH'],['folder','常开文件夹']].forEach(([kind,label])=>{
    const list=rules.filter(r=>r.kind===kind);if(!list.length)return;
    const h=el('div','section-label group-label');h.append(el('span','',label),el('span','group-count',String(list.length)));main.append(h);
    const card=el('div','card ch-card');
    list.forEach(rule=>{
      const row=el('div','ch-rule-row');
      const t=el('div','grow');
      let title='端口 '+rule.port;
      if(kind==='ssh')title='SSH '+rule.host;
      if(kind==='folder')title=(rule.write?'读写 ':'只读 ')+rule.path;
      t.append(el('div','ch-row-title',title));
      const meta=el('div','ch-row-meta');
      if(rule.account)meta.append(el('span','ch-tag',rule.account));
      if(rule.project)meta.append(el('span','ch-tag',String(rule.project).split('/').filter(Boolean).pop()||rule.project));
      meta.append(el('span','ch-tag ch-session',shortChId(rule.session)));
      if(rule.requested_by)meta.append(el('span','ch-fine',rule.requested_by));
      t.append(meta);
      if(kind==='ssh'&&rule.resolved)t.append(el('p','ch-fine','实际目标：'+rule.resolved));
      if(rule.reason)t.append(el('p','ch-fine','理由（来自远端，不可信）：'+rule.reason));
      row.append(t);
      if(!CH.readOnly)row.append(btn('删除','link-btn danger',()=>chRun('standing_remove',{id:rule.id},'已删除这条规则')));
      card.append(row);
    });
    main.append(card);
  });
  if(!rules.length&&!standing.error)main.append(el('p','ch-fine','没有常开规则。'));
}
function parseChPorts(text){
  const parts=String(text||'').split(/[\s,，]+/).filter(Boolean);
  if(!parts.length||parts.length>16)return null;
  const ports=[];
  for(const part of parts){
    if(!/^\d{1,5}$/.test(part))return null;
    const port=Number(part);
    if(port<1024||port>65535||port===2375||port===2376)return null;
    if(!ports.includes(port))ports.push(port);
  }
  return ports.length?ports:null;
}
function chOpenPortsSheet(data){
  const box=sheet('开放临时端口');
  box.append(el('p','muted','为一个会话开放本机回环端口 15 分钟：这个会话的所有命令都能连 localhost:端口。每个会话最多 16 个。'));
  const candidates=data.candidates||[];
  if(!candidates.length){box.append(el('p','ch-warn','没有可操作的会话：会话的本机 ch 要连着。'));box.append(btn('关闭','secondary wide',closeSheet));return;}
  let chosen=candidates[0].key;
  const pick=el('div','ch-pick');
  const draw=()=>{pick.replaceChildren();candidates.forEach(c=>{const b=btn('','ch-pick-row'+(c.key===chosen?' on':''),()=>{chosen=c.key;draw();});b.append(el('strong','grow',c.project||'—'),el('span','ch-tag',c.account||'local'),el('span','ch-tag ch-session',shortChId(c.session)));pick.append(b);});};
  draw();box.append(el('div','section-label','会话'),pick,el('div','section-label','端口'));
  const input=el('input','ch-input');input.type='text';input.placeholder='例如 3333, 5432';input.inputMode='numeric';box.append(input);
  box.append(el('p','ch-fine','端口范围 1024–65535；不接受 2375 / 2376（Docker）。'));
  const row=el('div','sheet-actions');
  const ok=btn('开放','primary',()=>{
    const ports=parseChPorts(input.value);if(!ports){toast('端口要写 1024–65535 的数字，用空格或逗号分开');return;}
    closeSheet();chRun('ports_open',{candidate:chosen,ports},'已为这个会话开放端口');
  });
  ok.disabled=true;setTimeout(()=>{ok.disabled=false;},720);
  row.append(btn('取消','secondary',closeSheet),ok);box.append(row);
}
function chStandingAddSheet(kind,data){
  const box=sheet(kind==='port'?'添加常开端口':'添加常开 SSH');
  box.append(el('p','muted',kind==='port'
    ?'只要这个会话连着，这个端口就一直开放，没有期限。要结束它，到「端口与 SSH」页删除。'
    :'只要这个会话连着，它就能随时用你本机的 SSH 身份在这台主机上运行任何命令，不再询问；没有期限。实际目标由电脑上的 ssh -G 确定，添加后可在列表查看。'));
  const candidates=data.candidates||[];
  if(!candidates.length){box.append(el('p','ch-warn','没有可操作的会话：会话的本机 ch 要连着。'));box.append(btn('关闭','secondary wide',closeSheet));return;}
  let chosen=candidates[0].key;
  const pick=el('div','ch-pick');
  const draw=()=>{pick.replaceChildren();candidates.forEach(c=>{const b=btn('','ch-pick-row'+(c.key===chosen?' on':''),()=>{chosen=c.key;draw();});b.append(el('strong','grow',c.project||'—'),el('span','ch-tag',c.account||'local'),el('span','ch-tag ch-session',shortChId(c.session)));pick.append(b);});};
  draw();box.append(el('div','section-label','会话'),pick,el('div','section-label',kind==='port'?'端口':'主机'));
  const input=el('input','ch-input');input.type='text';input.placeholder=kind==='port'?'例如 3333':'例如 build 或 user@build';
  if(kind==='port')input.inputMode='numeric';
  box.append(input);
  const row=el('div','sheet-actions');
  const ok=btn('添加','primary',()=>{
    if(kind==='port'){
      const ports=parseChPorts(input.value);if(!ports||ports.length!==1){toast('一次添加一个常开端口');return;}
      closeSheet();chRun('standing_add',{candidate:chosen,kind:'port',port:ports[0]},'已添加常开端口');
    }else{
      const host=input.value.trim();if(!host){toast('写一个主机名');return;}
      closeSheet();chRun('standing_add',{candidate:chosen,kind:'ssh',host},'已添加常开 SSH');
    }
  });
  ok.disabled=true;setTimeout(()=>{ok.disabled=false;},720);
  row.append(btn('取消','secondary',closeSheet),ok);box.append(row);
}
function paintBridges(main,data){
  const paused=data.paused==='paused';
  const head=el('div','ch-pause-row');
  if(paused){head.append(el('span','grow ch-warn','所有 bridge 已暂停：新的命令和审批会被拒绝。'));if(!CH.readOnly)head.append(btn('恢复全部','primary small',chResumeAll));}
  else if(!CH.readOnly){head.append(el('span','grow','暂停会立即停止所有 bridge 上运行中的命令。'),btn('暂停全部','secondary small',()=>chRun('pause',{},'已暂停全部 bridge')));}
  if(head.childElementCount)main.append(head);
  const bridges=data.bridges||[];
  if(!bridges.length){empty(main,'没有 bridge','这台电脑上还没有 ch 的 bridge。');return;}
  const card=el('div','card ch-card');
  bridges.forEach(b=>{
    const row=el('div','ch-bridge-row');
    const t=el('div','grow');
    t.append(el('div','ch-row-title',(b.project||'—')+(b.fetch_only?' · 取图通道':'')));
    const meta=el('div','ch-row-meta');
    if(b.account)meta.append(el('span','ch-tag',b.account));
    meta.append(el('span','ch-tag '+(b.state==='open'?'ch-ok':b.state==='closed'?'ch-bad':'ch-warn'),chBridgeState(b.state)));
    meta.append(el('span','ch-tag',b.running?'运行中':'未运行'));
    t.append(meta);row.append(t);
    if(!CH.readOnly){
      const acts=[];
      if(b.state==='open')acts.push(btn('暂停','link-btn',()=>chRun('bridge_action',{bridge:b.key,bridge_do:'pause'},'已暂停这个 bridge')),btn('关闭','link-btn danger',()=>chConfirmBridge(b,'close')));
      else if(b.state==='closed')acts.push(btn('重新打开','link-btn',()=>chConfirmBridge(b,'reopen')));
      else{acts.push(btn('恢复','link-btn',()=>chConfirmBridge(b,'resume')));if(b.state==='paused')acts.push(btn('关闭','link-btn danger',()=>chConfirmBridge(b,'close')));}
      row.append(...acts);
    }
    card.append(row);
  });
  main.append(card);
}

function chLeftText(expires){const s=Math.max(0,Math.ceil(Number(expires)-Date.now()/1000));return s>0?'还剩 '+s+' 秒':'已过期';}
function chDurText(ms){
  const s=Math.max(0,Math.ceil(ms/1000));const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;
  return h?h+':'+String(m).padStart(2,'0')+':'+String(x).padStart(2,'0'):m+':'+String(x).padStart(2,'0');
}
function chUpdateTimes(){
  document.querySelectorAll('[data-exp]').forEach(n=>{n.textContent=chLeftText(n.dataset.exp);});
  document.querySelectorAll('[data-mexp]').forEach(n=>{n.textContent=chDurText(Number(n.dataset.mexp)-Date.now());});
}
setInterval(chUpdateTimes,1000);
setInterval(()=>{if(!S.active||S.demo||!CH.view||CH.polling)return;if(Date.now()-CH.lastPoll>=1500)chPoll();},800);

// The 会话 page: a banner while requests wait; its toolbar entry is added in app.js.
(function(){
  const baseLive=livePage;
  livePage=function(main){
    baseLive(main);
    if(S.demo||!S.device)return;
    const s=chSummaryData();if(!s||!s.count)return;
    const card=el('section','card ch-banner');
    const row=el('div','row');
    const ic=el('span','ch-banner-ic');ic.append(icon('alert'));
    const t=el('div','grow');
    t.append(el('strong','','ch 审批'),el('span','ch-banner-line',s.count+' 条等待'));
    if(s.expires_at){const left=el('span','ch-left');left.dataset.exp=s.expires_at;t.append(left);}
    row.append(ic,t,btn('查看','primary small',()=>chConsoleOpen('approvals'),'lock'));
    card.append(row);main.prepend(card);
  };
})();
