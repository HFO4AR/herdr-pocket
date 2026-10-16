'use strict';
// Answering agent questions with real buttons instead of raw arrow keys.
//  · Blocked on a TUI menu (Claude AskUserQuestion, permission dialogs, Codex approvals and
//    request_user_input): the bridge parses the screen (`read` → menu) and the `answer` op walks
//    the cursor, re-checks the screen and only then presses Enter. The transcript's tool call
//    supplies full labels and descriptions when it matches the screen.
//  · Codex request_user_input_async ends the turn (agent idle): the reply is sent as a normal
//    prompt in Codex's <send_user_message_question_reply> format.
// Closing never answers: 「暂不回答」/「先收起」 only hide the card on the phone (the agent keeps
// waiting, the card comes back from the history row or the bar above the input), and the one
// thing that changes the agent, Esc, goes out only after a confirmation that says what Esc means
// on that dialog (the bridge reads the screen's own hint: menu.esc).
// Remote strings are text nodes only. Per-card state (qaStates) survives polling and re-renders.
const QA_TOOL=/^(AskUserQuestion|request_user_input(_async)?)$/;
function qaIsTool(m){return !!m&&m.kind==='tool'&&QA_TOOL.test(m.title||'');}
function qaNorm(t){return String(t||'').replace(/\s+/g,'').toLowerCase().replace(/[….]+$/,'');}
function qaLoose(a,b){a=qaNorm(a);b=qaNorm(b);if(!a||!b)return false;const n=Math.min(a.length,b.length,12);return a.slice(0,n)===b.slice(0,n);}
// Tool call → {async, call_id, questions:[{header,question,id,multi,options:[{label,description}]}]}
function qaParse(m){
 let v;try{v=JSON.parse(m.text);}catch(_){return null;}
 const list=Array.isArray(v?.questions)?v.questions:[];
 const questions=list.filter(q=>q&&typeof q==='object').map(q=>({header:String(q.header||''),question:String(q.question||q.title||''),id:String(q.id||''),multi:!!q.multiSelect,
  options:(Array.isArray(q.options)?q.options:[]).map(o=>typeof o==='string'?{label:o,description:''}:{label:String(o?.label||''),description:String(o?.description||'')}).filter(o=>o.label)}))
  .filter(q=>q.question||q.options.length);
 return questions.length?{async:m.title==='request_user_input_async',call_id:m.call_id||'',questions}:null;}
// What happened to a question call: waiting / answered (with per-question answers) / cancelled.
// Codex async: answered only by a <send_user_message_question_reply> that names this call (or, in
// older replies without ids, its questions). A plain message after it means the person moved on:
// 'replied', still answerable later with the same format.
function qaOutcome(m,p,messages){
 if(p?.async){const i=messages.indexOf(m);const later=i<0?[]:messages.slice(i+1).filter(x=>x.kind==='user');
  for(const reply of later){const t=String(reply.text||'').trim();if(!t.startsWith('<send_user_message_question_reply>'))continue;
   let rows=[];try{const v=JSON.parse(tlTag(t,'send_user_message_question_reply'));rows=(Array.isArray(v)?v:[v]).filter(x=>x&&typeof x==='object');}catch(_){continue;}
   const ids=rows.map(x=>{try{return JSON.parse(x.questionItemId)[1];}catch(_){return null;}});
   const mine=ids.some(Boolean)?ids.includes(p.call_id):rows.some(x=>p.questions.some(q=>q.question===x.question));if(!mine)continue;
   return {state:'answered',answers:p.questions.map(q=>{const hit=rows.find(x=>x.question===q.question);return hit?String(hit.answer??''):null;}),separate:true};}
  return later.length?{state:'replied',text:tlFirstLine(String(later[0].text||''))}:{state:'waiting'};}
 const result=messages.find(x=>x.kind==='result'&&x.call_id&&x.call_id===m.call_id);if(!result)return {state:'waiting'};
 const text=String(result.text||'');
 if(result.title==='执行失败'||/doesn't want to proceed|rejected|declined/i.test(text))return {state:'cancelled'};
 try{const v=JSON.parse(text);if(v&&v.answers&&typeof v.answers==='object')return {state:'answered',answers:(p?.questions||[]).map(q=>{const list=Array.isArray(v.answers[q.id]?.answers)?v.answers[q.id].answers.map(String):[];const parts=list.map(x=>x.replace(/^user_note:\s*/,'')).filter(x=>x&&x!=='None of the above');return parts.join('；')||(list.length?'都不是':null);})};}catch(_){}
 // Claude: Your questions have been answered: "Q"="A" selected preview: …, "Q2"="A2". You can …
 const answers=(p?.questions||[]).map(q=>{const key='"'+q.question+'"="';const at=text.indexOf(key);if(at<0)return null;const rest=text.slice(at+key.length);const end=rest.search(/"(?=\s+selected preview|, "|\. You can|\s*$)/);return (end<0?rest:rest.slice(0,end)).trim()||null;});
 return {state:'answered',answers,fallback:answers.some(Boolean)?'':tlFirstLine(text)};}
// The question is a one-line notice inside 「工作过程」 (timeline.js buildTurns).
function qaNotice(m){const p=qaParse(m);const q=p?.questions[0];const more=p&&p.questions.length>1?' 等 '+p.questions.length+' 个问题':'';return {label:'Agent 提问',text:q?(q.header?q.header+' · ':'')+tlFirstLine(q.question)+more:'问了你一个问题',icon:'chat',tone:'answer'};}
// Selection state per card, so polling and re-renders never lose a choice or typed text.
const qaStates=new Map();
function qaState(key){let st=qaStates.get(key);if(!st){st={sel:[],multi:[],other:[],text:[],busy:false,sent:0,error:'',focus:null};qaStates.set(key,st);}return st;}
// Questions put aside with 「暂不回答」 (async call ids), kept in the device cache so the card does
// not pop up again on the next launch. Menus hidden with 「先收起」 are per wait (S.qaHidden).
const QA_ASIDE={ids:new Set(),dev:null};
function qaAsideLoad(){const dev=cacheDevice();if(QA_ASIDE.dev===dev)return;QA_ASIDE.dev=dev;QA_ASIDE.ids=new Set();
 if(dev)cacheGet('qa-aside',dev).then(v=>{if(QA_ASIDE.dev!==dev||!Array.isArray(v?.ids))return;const before=QA_ASIDE.ids.size;v.ids.forEach(x=>QA_ASIDE.ids.add(String(x)));if(QA_ASIDE.ids.size!==before&&S.chat){paintTimeline();renderComposer();}});}
function qaAside(key){qaAsideLoad();return QA_ASIDE.ids.has(key);}
function qaSetAside(key,on){qaAsideLoad();if(on)QA_ASIDE.ids.add(key);else QA_ASIDE.ids.delete(key);cachePut('qa-aside',{ids:[...QA_ASIDE.ids].slice(-100)});syncWatch();}
// "Answered" holds for a few seconds; if the same menu is still there afterwards, it can be retried.
function qaSent(st){return !!st.sent&&Date.now()-st.sent<8000;}
function qaLine(t){return String(t||'').replace(/[\r\n\t]+/g,' ').replace(/[\x00-\x1f\x7f]/g,'').trim();}

// ─── History rows: "Agent 问 … / 你的回答：…" under each turn's work block ───────
function qaTurnRows(sec,turn){
 for(const e of turn.entries){if(!e.question)continue;const p=qaParse(e.m);const out=qaOutcome(e.m,p,S.messages);sec.append(qaLogRow(e.m,p,out));}}
function qaLogRow(m,p,out){
 const row=el('div','qa-log '+out.state);row.dataset.id=m.id;
 const head=el('div','qa-log-head');const ic=el('span','notice-icon');ic.append(icon('chat'));
 head.append(ic,el('span','qa-log-title',(p&&p.questions.length>1?'问了你 '+p.questions.length+' 个问题':'问你')),el('span','notice-time',clock(m.timestamp)));row.append(head);
 const qs=p?.questions||[];if(!qs.length)row.append(el('p','qa-log-q','（问题内容太长，没能完整读出）'));
 qs.forEach((q,i)=>{const item=el('div','qa-log-item');const t=el('p','qa-log-q');if(q.header)t.append(el('span','qa-log-tag',q.header));t.append(document.createTextNode(q.question));item.append(t);
  const a=out.answers?.[i];
  if(out.state==='answered'&&!out.separate&&(a||out.fallback)){const ans=el('p','qa-log-a');ans.append(el('span','qa-log-k','你的回答：'),document.createTextNode(a||out.fallback));item.append(ans);}
  row.append(item);});
 const live=S.chat?.agent&&!S.chat.stale?S.chat.agent:null;const idle=live&&['idle','done'].includes(live.agent_status);
 const key=p?.async?'async:'+(p.call_id||m.id):'';const sent=p?.async&&qaStates.get(key)?.sent;
 const opts=()=>qs.forEach(q=>{if(q.options.length)row.append(el('p','qa-log-opts','可选：'+q.options.map(o=>o.label).join(' / ')));});
 if(out.state==='waiting'){
  if(sent)row.append(el('p','qa-log-state done','回答已发出，等它接着做…'));
  else if(p?.async&&idle&&!qaAside(key))row.append(qaAsyncCard(m,p));
  else if(p?.async&&idle){opts();row.append(qaReopen('还没回答','点开回答',()=>qaSetAside(key,false),row));}
  else if(!p?.async&&live?.agent_status==='blocked'&&qaHiddenNow()){row.append(qaReopen('等你回答 · 已收起','展开',()=>{S.qaHidden='';renderComposer();}));}
  else{if(p?.async)opts();
   row.append(el('p','qa-log-state',live&&live.agent_status==='blocked'&&!p?.async?'等你回答 · 在下面选':p?.async&&live&&live.agent_status==='working'?'还没回答 · 它停下后可以在这里回答':'还没回答'));}}
 else if(out.state==='replied'){
  // Moved on with a normal message. The newest such question can still be answered with the card.
  const latest=[...S.messages].reverse().find(x=>qaIsTool(x)&&x.title==='request_user_input_async')===m;
  if(sent)row.append(el('p','qa-log-state done','回答已发出，等它接着做…'));
  else if(latest&&idle&&qaStates.get(key)?.reopen)row.append(qaAsyncCard(m,p,true));
  else if(latest&&idle)row.append(qaReopen('没在这里回答 · 你接着发了消息','现在回答',()=>{qaState(key).reopen=true;},row));
  else row.append(el('p','qa-log-state muted','没在这里回答 · 你接着发了消息'));}
 else if(out.state==='cancelled')row.append(el('p','qa-log-state muted','没有回答（已取消）'));
 else if(out.separate)row.append(el('p','qa-log-state done','已回答'));
 return row;}
// "还没回答 · 点开回答": the state and the way back in one line.
function qaReopen(text,label,fn,row){
 const line=el('p','qa-log-state qa-reopen');line.append(el('span','',text+' · '));
 line.append(btn(label,'link-btn',()=>{fn();paintTimeline();renderComposer();if(row){const id=row.dataset.id;requestAnimationFrame(()=>document.querySelector('.qa-log[data-id="'+CSS.escape(id)+'"] .qa-card')?.scrollIntoView({block:'nearest',behavior:tlCalm()?'auto':'smooth'}));}}));
 return line;}

// ─── The card ───────────────────────────────────────────────────────────────
// model: {key, kind, title, step, context, questions:[{header,question,multi,options:[{n,label,description,screen}],textRow}], submitText, onSubmit, onRaw}
function qaCard(model){
 const st=qaState(model.key);const card=el('section','qa-card '+(model.kind||'question'));card.setAttribute('role','group');card.setAttribute('aria-label',model.kind==='approval'?'等你确认':'Agent 的提问');
 // Redraw in place, keeping the option list where the reader scrolled it.
 const redraw=()=>{const top=card.querySelector('.qa-body')?.scrollTop||0;const next=qaCard(model);card.replaceWith(next);const body=next.querySelector('.qa-body');if(body)body.scrollTop=top;return next;};
 const head=el('div','qa-head');head.append(icon(model.kind==='approval'?'alert':'chat'));const t=el('strong','grow',model.title);if(model.step)t.append(el('span','qa-step',model.step));head.append(t);
 if(model.onRaw)head.append(btn('用按键操作','link-btn',model.onRaw));card.append(head);
 const body=el('div','qa-body');
 if(model.context){const pre=el('pre','qa-context',model.context);body.append(pre);}
 const locked=st.busy||qaSent(st);
 model.questions.forEach((q,i)=>{
  const box=el('div','qa-q');if(q.header)box.append(el('div','qa-header',q.header));if(q.question)box.append(el('p','qa-question',q.question));
  const list=el('div','qa-options');list.setAttribute('role',q.multi?'group':'radiogroup');list.setAttribute('aria-label',q.question||model.title);
  const chosen=q.multi?(st.multi[i]||(st.multi[i]=new Set())):null;
  q.options.forEach(o=>{const on=q.multi?chosen.has(o.n):st.sel[i]===o.n&&!st.other[i];
   const b=btn('','qa-opt'+(on?' on':''),()=>{if(q.multi){if(chosen.has(o.n))chosen.delete(o.n);else chosen.add(o.n);}else{st.sel[i]=o.n;st.other[i]=false;}st.error='';redraw();});
   b.setAttribute('role',q.multi?'checkbox':'radio');b.setAttribute('aria-checked',String(on));b.disabled=locked;
   const mark=el('span','qa-mark'+(q.multi?' box':''));if(on)mark.append(icon('check'));const txt=el('span','qa-opt-text');txt.append(el('span','qa-label',o.label));if(o.description)txt.append(el('small','qa-desc',o.description));b.append(mark,txt);list.append(b);});
  if(q.textRow!==null&&q.textRow!==undefined){const on=!!st.other[i];
   const b=btn('','qa-opt other'+(on?' on':''),()=>{st.other[i]=q.multi?!on:true;if(!q.multi&&st.other[i])st.sel[i]=null;st.error='';const next=redraw();if(st.other[i])next.querySelector('.qa-text')?.focus();});
   b.setAttribute('role',q.multi?'checkbox':'radio');b.setAttribute('aria-checked',String(on));b.disabled=locked;
   const mark=el('span','qa-mark'+(q.multi?' box':''));if(on)mark.append(icon('check'));const txt=el('span','qa-opt-text');txt.append(el('span','qa-label','其他…'),el('small','qa-desc','自己写一个回答'));b.append(mark,txt);list.append(b);
   if(on){const ta=el('textarea','qa-text');ta.rows=2;ta.placeholder=model.multiline?'写你的回答':'写你的回答（会作为一行发出）';ta.setAttribute('aria-label','自己写的回答');ta.value=st.text[i]||'';ta.disabled=locked;
    ta.oninput=()=>{st.text[i]=ta.value;sync();};ta.onfocus=()=>{st.focus=i;};ta.onblur=()=>{if(st.focus===i)st.focus=null;};list.append(ta);
    if(st.focus===i)requestAnimationFrame(()=>{if(document.activeElement!==ta){ta.focus();ta.selectionStart=ta.selectionEnd=ta.value.length;}});}}
  box.append(list);body.append(box);});
 card.append(body);
 const foot=el('div','qa-foot');foot.setAttribute('aria-live','polite');
 if(st.error){const n=el('p','qa-error',st.error);n.setAttribute('role','alert');foot.append(n);}
 const submit=btn(model.submitText||'发送回答','primary qa-submit',()=>{if(qaReady(model,st))model.onSubmit(st);});
 // Closing never answers (see the top of this file). Hidden while an answer is on its way.
 const close=model.onClose&&!st.busy&&!qaSent(st)?btn(model.closeText||'暂不回答','secondary qa-close',()=>model.onClose(st)):null;
 // While working or after answering, the button itself says what is happening.
 if(qaSent(st)||st.busy){submit.replaceChildren(el('span','spinner mini'),document.createTextNode(st.busy?'正在操作，先核对屏幕再确认…':model.kind==='approval'?'已确认，等它继续…':'已回答，等它继续…'));submit.classList.add('pending');}
 // 「写消息」: on a short screen the card takes the input's place; this folds it (foot.js, CSS shows it there).
 const row=el('div','qa-actions');if(model.onWrite)row.append(btn('写消息','secondary qa-write foot-write',model.onWrite,'pen'));if(close)row.append(close);row.append(submit);foot.append(row);card.append(foot);
 function sync(){submit.disabled=locked||!qaReady(model,st);}
 sync();return card;}
function qaReady(model,st){return model.questions.some((q,i)=>(q.multi?st.multi[i]?.size>0:st.sel[i]!=null&&!st.other[i])||(st.other[i]&&qaLine(st.text[i]).length>0));}

// ─── Blocked on a TUI menu ──────────────────────────────────────────────────
// fetchTerminal hands every read here; the card only redraws when the menu itself changed.
// Compare with what the composer shows (S.qaShown), not with the previous read: the menu is often on
// screen before Herdr reports "blocked" (the read after the switch returns that same menu), and the
// transcript's question call, which supplies full labels, can land after the card was first drawn.
function qaScreen(r){
 const a=S.chat?.agent;if(!a)return;const key=agentKey(a);const menu=r&&r.menu||null;
 S.qaMenu={key,menu,at:Date.now()};qaRefresh();}
// Redraw the composer only when the card it would show differs from the one on screen.
function qaRefresh(){const a=S.chat?.agent;if(!a||S.chat.stale)return;
 if(a.agent_status==='blocked'){if(qaExpect(qaFresh(a))!==(S.qaShown||''))renderComposer();return;}
 const q=qaAsyncPending();if((q?.aside?q.key:'')!==(S.qaBar||''))renderComposer();}
function qaFresh(a){const cur=S.qaMenu;const since=statusSince(a);return cur&&cur.key===agentKey(a)&&(!since||cur.at>=since)?cur.menu:null;}
function qaCallSig(){const call=[...S.messages].reverse().find(m=>qaIsTool(m));return call?call.id+':'+qaOutcome(call,qaParse(call),S.messages).state:'';}
function qaExpect(menu){return menu?(S.chat?.qaRaw?'raw:':'')+(qaHiddenNow()?'hidden:':'')+menu.fingerprint+'|'+qaCallSig():'';}
// 「先收起」 holds for this wait only: the next time it stops on a question, the card shows again.
function qaWaitKey(a){return a?agentKey(a)+'@'+(statusSince(a)||0):'';}
function qaHiddenNow(){const a=S.chat?.agent;return !!a&&!!S.qaHidden&&S.qaHidden===qaWaitKey(a);}
// Called first in the blocked branch of renderLiveState. Returns true when the card replaces the key panel.
function qaLive(live,a){
 const since=statusSince(a);const menu=qaFresh(a);
 // No screen read since it started waiting: read now instead of on the next poll tick.
 if(!menu&&S.qaAsked!==agentKey(a)+'@'+since){S.qaAsked=agentKey(a)+'@'+since;setTimeout(()=>fetchTerminal(true),0);}
 S.qaShown=qaExpect(menu);if(!menu)return false;
 if(S.chat.qaRaw){const bar=el('div','qa-raw-bar');bar.append(btn('用选项回答','link-btn',()=>{S.chat.qaRaw=false;renderComposer();},'chat'));live.append(bar);return false;}
 if(qaHiddenNow()){live.append(qaMini(menu.kind==='approval'?providerName(a.agent)+' 在等你确认 · 已收起':providerName(a.agent)+' 在等你回答 · 已收起',
  queueItems().length?'它会一直等着，排队的消息在你回答后才发':'它会一直等着，没有替你回答',menu.kind==='approval'?'alert':'chat',()=>{S.qaHidden='';renderComposer();},menu.kind==='approval'?'approval':''));return true;}
 live.append(qaCard(qaMenuModel(menu,a)));return true;}
// The collapsed card: one line above the input that says what still waits, and 展开.
function qaMini(title,note,ic,open,tone){
 const bar=el('div','qa-mini'+(tone?' '+tone:''));bar.setAttribute('role','status');const i=el('span','qa-mini-icon');i.append(icon(ic));
 const t=el('div','grow');t.append(el('strong','',title),el('small','',note));
 const b=btn('展开','secondary small',open);b.setAttribute('aria-label','展开问题');bar.append(i,t,b);return bar;}
function qaMenuModel(menu,a){
 const who=providerName(a.agent);
 // Full labels/descriptions from the transcript's pending question call, when it matches the screen.
 let q=null,step='';const call=[...S.messages].reverse().find(m=>qaIsTool(m));const p=call?qaParse(call):null;
 if(p&&!p.async&&menu.kind==='question'&&qaOutcome(call,p,S.messages).state==='waiting'){
  const i=p.questions.findIndex(x=>qaLoose(x.question,menu.question)||(menu.question&&qaNorm(x.question).includes(qaNorm(menu.question))));
  const k=i>=0?i:p.questions.length===1?0:-1;if(k>=0){q=p.questions[k];if(p.questions.length>1)step=(k+1)+'/'+p.questions.length;}}
 if(!step&&menu.tabs?.length>1)step=menu.tabs.filter(t=>t.done).length+'/'+menu.tabs.length+' 已答';
 const rows=menu.options.filter(o=>!o.chat);const input=rows.find(o=>o.input);
 const options=rows.filter(o=>!o.input).map(o=>{const t=q?.options[o.n-1];const use=t&&qaLoose(t.label,o.label);return {n:o.n,label:use?t.label:o.label,description:use?t.description||o.description:o.description,screen:o.label};});
 // Claude's list scrolls: options outside the visible window come from the transcript (same numbering,
 // the text row right after them). The bridge checks each label once the cursor reaches it.
 let textRow=input?input.n:null;
 if(q&&a.agent==='claude'&&menu.kind==='question'){q.options.forEach((t,i)=>{if(!menu.options.some(o=>o.n===i+1))options.push({n:i+1,label:t.label,description:t.description,screen:t.label});});
  options.sort((x,y)=>x.n-y.n);if(textRow===null&&!menu.options.some(o=>o.n===q.options.length+1&&!o.input))textRow=q.options.length+1;}
 const title=menu.kind==='approval'?who+' 等你确认':menu.kind==='review'?'检查一下答案再提交':who+' 在问你';
 const question=q?.question||(menu.kind==='approval'?'':menu.question);
 const context=menu.kind==='question'&&q?'':menu.kind==='review'?(menu.context||[]).join('\n'):menu.kind==='approval'?(menu.context||[]).join('\n'):'';
 // A new wait (even on an identical menu) starts with a clean selection.
 return {key:'menu:'+agentKey(a)+':'+(statusSince(a)||0)+':'+menu.fingerprint,fp:menu.fingerprint,kind:menu.kind,title,step,context,
  questions:[{header:q?.header||'',question:menu.kind==='approval'?'':question,multi:!!menu.multi,options,textRow}],
  submitText:menu.kind==='approval'?'确认这个选择':menu.kind==='review'?'确定':'发送回答',closeText:'关闭',
  onSubmit:st=>qaSendMenu(menu,st,options,textRow),onWrite:footWrite,onRaw:()=>{S.chat.qaRaw=true;renderComposer();},onClose:()=>qaCloseMenu(menu,a)};}
// 关闭 on a menu: put it aside (nothing reaches the agent) or cancel it with Esc after a confirmation.
function qaCloseMenu(menu,a){
 const who=providerName(a.agent),approval=menu.kind==='approval';
 const box=sheet(approval?'先不确认？':'先不回答？');
 box.append(el('p','muted qa-close-note',who+' 现在停在这个'+(approval?'确认框':'问题')+'上。收起只在手机上先不显示，不会替你选任何一项。'));
 menuItem(box,'先收起',()=>{S.qaHidden=qaWaitKey(a);renderComposer();paintTimeline();toast('收起了，'+who+' 还在等你');},'down','它继续等着，随时可以展开再'+(approval?'确认':'回答'));
 const esc=menuItem(box,approval?'拒绝并取消（按 Esc）':'取消这个问题（按 Esc）',()=>confirmAction('按 Esc 取消？',qaEscText(menu,a),'按 Esc',()=>qaEsc(menu,a),true),'x',qaEscText(menu,a));
 esc.classList.add('danger');}
// What Esc does here, from the screen's own hint (menu.esc), else from the kind of dialog.
function qaEscText(menu,a){
 const who=providerName(a?.agent),esc=menu?.esc||null,approval=menu?.kind==='approval';
 if(esc?.action==='interrupt')return '会中断 '+who+' 这一轮：问题连同它正在做的事一起停下，然后等你发新消息。';
 const row=esc?.option?menu.options.find(o=>o.n===esc.option):null;
 const as=row?'等于选「'+row.label.replace(/\s*\((esc|escape)\)\s*$/i,'')+'」：':'';
 if(approval)return (as||'等于拒绝：')+'这一步不会执行，'+who+' 停下来等你说怎么做。';
 return as+who+' 会收到「没有回答」，这一轮停下，等你发新消息。';}
// Esc goes out only if the same dialog is still on screen; never Enter, never a default option.
async function qaEsc(menu,a){
 if(S.demo){toast('演示：没有真的按 Esc');return;}
 const cur=S.chat?.agent;if(!cur||cur.pane_id!==a.pane_id||cur.identity!==a.identity){toast('窗格变了，没有按 Esc');return;}
 try{const r=await remote('read',{session:S.session,target:a.pane_id,identity:a.identity});
  if(!r?.menu||r.menu.fingerprint!==menu.fingerprint){toast('问题已经变了，没有按 Esc');qaScreen(r);return;}
  await remote('key',{session:S.session,target:a.pane_id,identity:a.identity,key:'esc',id:uuid()});toast('已按 Esc，问题取消了');S.qaHidden='';}
 catch(e){toast('没按成：'+(e.message||e)+'。不会自动重试。');}
 finally{setTimeout(()=>{refreshStatus();fetchTerminal(true);fetchHistory();},600);}}
async function qaSendMenu(menu,st,options,textRow){
 const a=S.chat?.agent;if(!a||st.busy||qaSent(st))return;
 const text=st.other[0]&&textRow!==null?qaLine(st.text[0]):'';
 const args={session:S.session,target:a.pane_id,identity:a.identity,id:uuid(),fingerprint:menu.fingerprint};
 // Labels as the screen shows them, so the bridge can check the row under the cursor before Enter.
 if(menu.multi){args.action='multi';args.options=[...(st.multi[0]||[])].sort((x,y)=>x-y);args.labels=Object.fromEntries(args.options.map(n=>[String(n),options.find(o=>o.n===n)?.screen||'']));if(text){args.option=textRow;args.text=text;}}
 else if(text){args.action='text';args.option=textRow;args.text=text;}
 else{const row=options.find(o=>o.n===st.sel[0]);if(!row)return;args.action='select';args.option=row.n;args.label=row.screen;}
 st.busy=true;st.error='';renderComposer();
 try{await remote('answer',args);if(S.demo){toast('演示：没有真的回答');}else{st.sent=Date.now();toast(menu.kind==='approval'?'已选好':'已回答');setTimeout(()=>{if(S.chat?.agent?.agent_status==='blocked')renderComposer();},8200);}}
 catch(e){st.error='没完成：'+e.message+'。不会自动重试。';toast(st.error);}
 finally{st.busy=false;renderComposer();if(!S.demo)setTimeout(()=>{refreshStatus();fetchTerminal(true);fetchHistory();},700);}}

// ─── Codex async questions (agent idle) ─────────────────────────────────────
function qaAsyncCard(m,p,late){
 const key='async:'+(p.call_id||m.id);
 const model={key,kind:'question',title:providerName(S.chat.provider)+(late?' 之前问你的':' 在等你回答'),step:'',context:'',multiline:true,
  questions:p.questions.map(q=>({header:q.header,question:p.questions.length>1?q.question:'',multi:false,options:q.options.map((o,i)=>({n:i+1,label:o.label,description:o.description})),textRow:0})),
  submitText:'发送回答',onSubmit:st=>qaSendAsync(m,p,st,model),closeText:late?'收起':'暂不回答',
  // Nothing is sent: Codex already ended its turn, so the input is free and a later reply still counts.
  onClose:st=>{if(late)st.reopen=false;else{qaSetAside(key,true);toast('先不答，问题留着，随时可以点开回答');}paintTimeline();renderComposer();}};
 return qaCard(model);}
// The newest Codex async question still waiting, for the bar above the input when it was put aside.
function qaAsyncPending(){
 const m=[...S.messages].reverse().find(x=>qaIsTool(x)&&x.title==='request_user_input_async');const p=m?qaParse(m):null;
 if(!p||qaOutcome(m,p,S.messages).state!=='waiting')return null;const key='async:'+(p.call_id||m.id);
 return qaStates.get(key)?.sent?null:{m,p,key,aside:qaAside(key)};}
function qaAsyncBar(live){
 const q=qaAsyncPending();S.qaBar=q?.aside?q.key:'';if(!S.qaBar)return;const n=q.p.questions.length;
 live.append(qaMini(providerName(S.chat.provider)+' 有'+(n>1?' '+n+' 个':'个')+'问题还没回答','先放着也行，正常发消息不影响之后再回答','chat',()=>{qaSetAside(q.key,false);paintTimeline();renderComposer();
  requestAnimationFrame(()=>document.querySelector('.qa-log[data-id="'+CSS.escape(q.m.id)+'"] .qa-card')?.scrollIntoView({block:'nearest',behavior:tlCalm()?'auto':'smooth'}));}));}
function qaAsyncReply(p,answers){
 const items=p.questions.map((q,i)=>({answer:answers[i],question:q.question,questionItemId:JSON.stringify(['request_user_input_async',p.call_id,i])})).filter(x=>x.answer);
 return '<send_user_message_question_reply>\n'+JSON.stringify(items)+'\n</send_user_message_question_reply>';}
async function qaSendAsync(m,p,st,model){
 const a=S.chat?.agent;if(!a||st.busy||qaSent(st))return;
 if(!['idle','done'].includes(a.agent_status)&&!S.demo){toast('它还在忙，等停下再回答');return;}
 const answers=p.questions.map((q,i)=>st.other[i]&&String(st.text[i]||'').trim()?String(st.text[i]).trim():q.options[(st.sel[i]||0)-1]?.label||'');
 const text=qaAsyncReply(p,answers);st.busy=true;st.error='';paintTimeline();
 try{await remote('prompt',{session:S.session,target:a.pane_id,identity:a.identity,text,id:uuid()});
  if(S.demo)toast('演示：没有真的发送');else{st.sent=Date.now();toast('已回答');S.chat.sentAt=Date.now();S.chat.doneAt=0;S.chat.agent={...S.chat.agent,agent_status:'working'};renderComposer();updateChatMeta();setTimeout(()=>fetchHistory(),900);}}
 catch(e){st.error=/^没发出去/.test(e.message)?e.message+'。可以再选一次。':'发送未确认：'+e.message+'。不会自动重发。';toast(st.error);}
 finally{st.busy=false;S.stick=true;paintTimeline();}}
