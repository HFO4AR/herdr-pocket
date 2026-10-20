'use strict';
// 模型 · CC Switch: the Claude/Codex providers configured by the desktop CC Switch app.
// Read-only list (names, model slots, current marker) plus a guarded switch. Secrets never leave
// the computer: the bridge only sends whitelisted fields and this page renders only those.
// A switch is written to the computer's config; it applies to NEW sessions, never restarts an
// agent that is already running.
const CCS={data:null,app:'claude',loading:false,error:'',busy:false};
const CCS_APPS=[['claude','Claude'],['codex','Codex']];

function ccswitchOpen(){
 if(S.demo){toast('演示模式不会切换电脑上的模型');return;}
 const box=sheet('模型 · CC Switch');
 const body=el('div','ccs-body');box.append(body);
 CCS.error='';ccsRender(body);ccsLoad(body);
}

async function ccsLoad(body){
 if(CCS.loading)return;
 CCS.loading=true;CCS.error='';ccsRender(body);
 try{CCS.data=await remote('ccswitch');}
 catch(e){CCS.error='读不到 CC Switch：'+(e.message||e);}
 finally{CCS.loading=false;if(overlay.contains(body))ccsRender(body);}
}

function ccsRender(body){
 body.replaceChildren();
 const intro=el('p','ccs-note');intro.append(icon('lock'),el('span','','密钥只留在电脑上，不会发送到手机，也不会写进日志。'));
 body.append(intro);

 const tabs=el('div','ccs-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','模型供应商');
 CCS_APPS.forEach(([id,label])=>{
  const b=btn(label,'ccs-tab'+(CCS.app===id?' on':''),()=>{CCS.app=id;ccsRender(body);});
  b.setAttribute('role','tab');b.setAttribute('aria-selected',String(CCS.app===id));tabs.append(b);});
 const head=el('div','ccs-head');head.append(tabs,btn('刷新','secondary small',()=>ccsLoad(body),'refresh'));
 body.append(head);

 if(CCS.loading&&!CCS.data){body.append(el('div','loading','读取中…'));return;}
 if(CCS.error){
  const note=el('p','note error',CCS.error);note.setAttribute('role','alert');body.append(note);
  body.append(btn('重试','secondary small',()=>ccsLoad(body)));
  return;}
 const data=CCS.data;
 if(!data){body.append(el('p','fine','还没读取。'),btn('读取','secondary small',()=>ccsLoad(body)));return;}
 if(data.available===false){
  const note=el('div','ccs-empty');note.append(el('strong','',data.reason||'电脑上没有 CC Switch'),
   el('p','fine','在这台电脑上安装并配置 CC Switch 后，点「刷新」。'));
  body.append(note);return;}
 const list=(data.providers||[]).filter(p=>p.app_type===CCS.app);
 if(!list.length){body.append(el('p','fine','这台电脑的 CC Switch 里还没有 '+CCS_APPS.find(a=>a[0]===CCS.app)[1]+' 供应商。'));}
 const wrap=el('div','ccs-list');
 list.forEach(p=>{
  const row=el('button','ccs-provider'+(p.is_current?' current':'')+(p.switchable?'':' locked'));
  row.type='button';row.disabled=!p.switchable;
  if(p.is_current)row.setAttribute('aria-current','true');
  if(!p.switchable)row.title=p.reason||'这个供应商不能在手机上切换';
  const top=el('div','ccs-provider-top');
  top.append(el('span','ccs-provider-name',p.name||p.id));
  if(p.is_current)top.append(el('span','ccs-badge current','当前'));
  if(p.official)top.append(el('span','ccs-badge','官方 · 仅显示'));
  else if(!p.switchable)top.append(el('span','ccs-badge','不可切换'));
  row.append(top);
  const models=el('div','ccs-models');
  (p.models||[]).forEach(m=>{
   const chip=el('span','ccs-model');
   chip.append(el('span','ccs-slot',m.slot||'模型'),document.createTextNode(' · '+(m.name?m.name+' ('+m.model+')':m.model)));
   models.append(chip);});
  if(!(p.models||[]).length)models.append(el('span','ccs-model muted','没有模型信息'));
  row.append(models);
  if(p.model_provider)row.append(el('div','ccs-meta','接口 · '+p.model_provider));
  if(p.reason)row.append(el('div','ccs-reason',p.reason));
  row.onclick=()=>{if(p.is_current){toast('已经是当前供应商');return;}ccsConfirm(p);};
  wrap.append(row);});
 body.append(wrap);
 body.append(el('p','fine ccs-foot','显示当前电脑上的供应商和模型槽位。切换只影响新打开的会话；正在运行的 Agent 不会重启，也不会丢消息。'));
}

function ccsConfirm(provider){
 const appLabel=CCS_APPS.find(a=>a[0]===CCS.app)[1];
 const box=sheet('切换模型供应商');
 box.append(el('p','muted','新打开的 '+appLabel+' 会话会使用「'+(provider.name||provider.id)+'」。'));
 const card=el('div','ccs-confirm-card');
 card.append(el('div','ccs-provider-name',provider.name||provider.id));
 const models=el('div','ccs-models');
 (provider.models||[]).forEach(m=>models.append(el('span','ccs-model',(m.slot||'模型')+' · '+(m.name?m.name+' ('+m.model+')':m.model))));
 if((provider.models||[]).length)card.append(models);
 box.append(card);
 box.append(el('p','fine','正在运行的 Agent 不会重启，当前对话继续用原来的模型。配置和备份都留在电脑上，密钥不会发到手机。'));
 const err=el('p','note error');err.setAttribute('role','alert');err.hidden=true;box.append(err);
 const actions=el('div','sheet-actions');
 const cancel=btn('取消','secondary',closeSheet);
 const go=btn('切换','primary',async()=>{
  if(CCS.busy)return;CCS.busy=true;go.disabled=cancel.disabled=true;go.textContent='正在切换…';err.hidden=true;
  try{
   const r=await remote('ccswitchSwitch',{app:CCS.app,provider:provider.id});
   CCS.busy=false;closeSheet();
   toast((r.message||('已切换到「'+(provider.name||provider.id)+'」；新会话生效'))+(r.warning?' '+r.warning:''));
   ccswitchOpen();
  }catch(e){CCS.busy=false;go.disabled=cancel.disabled=false;go.textContent='切换';err.textContent=e.message||String(e);err.hidden=false;}
 });
 actions.append(cancel,go);box.append(actions);
}
