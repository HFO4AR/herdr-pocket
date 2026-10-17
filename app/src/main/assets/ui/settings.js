'use strict';
// 设置: appearance, connection, alerts, screen protection, cache and updates.
// Preferences live natively (SharedPreferences), so the theme and text size apply before the
// page draws and survive reinstalling the UI bundle. Update checks and downloads run natively
// too: the WebView itself never reaches the network.
const SET={prefs:null,checking:false,download:null,needPermission:false,cache:null,error:''};
const THEMES=[['system','跟随系统'],['light','浅色'],['dark','深色']];
const ZOOMS=[[90,'小'],[100,'标准'],[115,'大'],[130,'特大']];
// 后台保持连接: minutes the background service keeps the SSH session (0 = until 断开).
const KEEPS=[[15,'15 分钟'],[60,'1 小时'],[240,'4 小时'],[0,'一直保持']];
function keepText(m){return (KEEPS.find(k=>k[0]===m)||KEEPS[1])[1];}
// 断开 on the keep-alive notification ended the session natively: show the devices page.
// (Function declarations are hoisted across the bundle, so this wraps onboard.js's netEvent.)
{const base=netEvent;netEvent=function(e){if(e&&e.type==='disconnected'){if(S.device&&!S.demo)disconnect().then(()=>toast('已断开和电脑的连接')).catch(()=>{});return;}return base(e);};}

window.applyTheme=t=>{document.documentElement.dataset.theme=t==='dark'?'dark':'light';};
async function settingsLoad(){try{const p=await rpc('settings');SET.prefs=p;S.alerts=p.alerts!==false;if(S.version!==p.version&&p.version)S.version=p.version;return p;}catch(_){return null;}}
async function settingsSet(key,value){try{const p=await rpc('setSetting',{key,value});SET.prefs=p;window.applyTheme(p.dark?'dark':'light');return p;}catch(e){error(e);return null;}}
function updateInfo(){return SET.prefs?.update||null;}
function updateAvailable(){const u=updateInfo();return !!(u&&u.available&&u.latest&&u.latest.code>(SET.prefs?.versionCode||0));}
function settingsBadge(){return updateAvailable();}
function bytesText(n){if(!(n>0))return '0 B';const u=['B','KB','MB','GB'];let i=0;while(n>=1024&&i<u.length-1){n/=1024;i++;}return (i?n.toFixed(n<10?1:0):n)+' '+u[i];}

// Once per launch, at most every 12 hours (the native side caches the answer).
async function updateAutoCheck(){
 if(!SET.prefs?.autoUpdate)return;
 try{const r=await rpc('checkUpdate',{force:false});SET.prefs.update=r;
  if(updateAvailable()){const tag=r.latest.tag;if(SET.prefs.seenUpdate!==tag){settingsSet('seenUpdate',tag);toast('有新版本 '+tag+'，在「设置」里可以直接更新');}
   if(!S.chat)render();}}
 catch(_){}}
async function updateCheck(){
 if(SET.checking)return;SET.checking=true;SET.error='';paintSettings();
 try{const r=await rpc('checkUpdate',{force:true});SET.prefs.update=r;if(!updateAvailable())toast('已经是最新版本');}
 catch(e){SET.error='检查失败：'+(e.message||e);}
 finally{SET.checking=false;paintSettings();}}
async function updateDownload(){
 const u=updateInfo();if(!u?.latest||SET.download)return;const tag=u.latest.tag;SET.needPermission=false;SET.error='';
 SET.download={tag,pct:0};paintSettings();
 try{await rpc('downloadUpdate',{tag},pct=>{SET.download={tag,pct:Number(pct)||0};const bar=document.getElementById('update-bar');if(bar){bar.style.width=SET.download.pct+'%';bar.parentElement.setAttribute('aria-valuenow',String(SET.download.pct));}const t=document.getElementById('update-pct');if(t)t.textContent=SET.download.pct+'%';});
  SET.download=null;SET.ready=tag;await updateInstall();}
 catch(e){SET.download=null;SET.error=e.message||String(e);}
 finally{paintSettings();}}
async function updateInstall(){
 const tag=SET.ready;if(!tag)return;
 try{const r=await rpc('installUpdate',{tag});SET.needPermission=!!r.needPermission;if(r.needPermission)toast('打开「允许安装未知应用」后，回来点「安装」');}
 catch(e){SET.error=e.message||String(e);}
 paintSettings();}

function seg(label,options,value,change,stack=false){
 const row=el('div','set-row set-seg-row'+(stack?' stack':''));row.append(el('span','set-label',label));
 const g=el('div','seg');g.setAttribute('role','radiogroup');g.setAttribute('aria-label',label);
 options.forEach(([v,t])=>{const on=v===value;const b=btn(t,'seg-opt'+(on?' on':''),async()=>{if(b.classList.contains('on'))return;g.querySelectorAll('.seg-opt').forEach(n=>{n.classList.remove('on');n.setAttribute('aria-checked','false');});b.classList.add('on');b.setAttribute('aria-checked','true');await change(v);});b.setAttribute('role','radio');b.setAttribute('aria-checked',String(on));g.append(b);});
 row.append(g);return row;}
function toggle(title,detail,checked,change){
 const row=el('label','switch-row set-switch');const box=el('input');box.type='checkbox';box.checked=checked;box.setAttribute('aria-label',title);
 box.onchange=async()=>{box.disabled=true;try{const ok=await change(box.checked);if(ok===false)box.checked=!box.checked;}finally{box.disabled=false;}};
 const t=el('span','grow');t.append(el('strong','',title),el('small','',detail));row.append(t,box,el('span','switch'));return row;}
function linkRow(label,value,fn,name){const b=btn('','set-link',fn);b.append(el('span','grow set-label',label));if(value)b.append(el('span','set-value',value));b.append(icon(name||'chevron'));return b;}
function group(main,label){main.append(el('span','section-label',label));const card=el('section','card set-card');main.append(card);return card;}

function settingsPage(main){
 main.classList.add('settings');
 if(!SET.prefs){skeleton(main,3);settingsLoad().then(()=>{if(S.tab==='settings'&&!S.chat)render();});return;}
 const p=SET.prefs;
 if(updateAvailable())main.append(updateBanner());
 // Two columns of groups (layout.css puts them side by side on wide screens; phones stack them in order).
 const cols=el('div','set-cols'),left=el('div','set-col'),right=el('div','set-col');cols.append(left,right);main.append(cols);

 const look=group(left,'外观');
 look.append(seg('主题',THEMES,p.theme,v=>settingsSet('theme',v)));
 look.append(seg('文字大小',ZOOMS,p.textZoom,v=>settingsSet('textZoom',v)));

 const conn=group(left,'连接');
 conn.append(toggle('启动时自动重连','打开 App 时自动连上关掉前连着的电脑',p.autoResume!==false,async on=>{const r=await settingsSet('autoResume',on);if(!r)return false;if(!on)resumeStop();toast(on?'下次打开会自动连上这次连着的电脑':'下次打开不再自动连接');return true;}));
 const keepOn=p.keepAlive!==false,minutes=KEEPS.some(k=>k[0]===p.keepAliveMinutes)?p.keepAliveMinutes:60;
 conn.append(toggle('后台保持连接','切到后台或划掉 App 后继续连着，回来不用重新登录',keepOn,async on=>{const r=await settingsSet('keepAlive',on);if(!r)return false;toast(on?'切到后台时会保持连接 '+keepText(r.keepAliveMinutes):'切到后台后不再保持连接');paintSettings();return true;}));
 if(keepOn){
  conn.append(seg('保持多久',KEEPS,minutes,async v=>{const r=await settingsSet('keepAliveMinutes',v);if(r){toast(v?'后台保持 '+keepText(v)+'，到时自动断开':'会一直保持连接，不用了在通知里点「断开」');paintSettings();}},true));
  conn.append(el('p','set-note',(minutes?'到时间自动断开省电，回来时自动重连。':'一直保持会多耗一点电，不用了在通知里点「断开」。')+(p.notifications===false?'系统通知关着也照样保持，只是通知栏里看不到它。':'保持期间通知栏有一条安静的常驻通知。')));}
 const privacy=group(left,'提醒与隐私');
 privacy.append(toggle('后台提醒','切到后台后，Agent 做完或等你确认时发通知',S.alerts!==false,async on=>{try{S.alerts=(await rpc('setAlerts',{enabled:on})).alerts;toast(S.alerts?'切到后台时会继续关注 Agent':'已关闭后台提醒');return true;}catch(e){error(e);return false;}}));
 if(S.alerts!==false&&p.notifications===false){privacy.append(el('p','set-note error','系统通知被关掉了，后台提醒弹不出来。'));const go=btn('打开系统通知','secondary small',()=>rpc('openNotificationSettings').catch(error));go.classList.add('set-action');privacy.append(go);}
 privacy.append(toggle('防截图','打开后不能截图、录屏，最近任务里也看不到画面',!!p.secureScreen,async on=>{const r=await settingsSet('secureScreen',on);if(r)toast(on?'已禁止截图':'现在可以截图了');return !!r;}));

 const store=group(right,'缓存');
 const info=el('div','set-row');info.append(el('span','set-label','对话缓存'));const size=el('span','set-value',SET.cache?bytesText(SET.cache.bytes||0)+' · '+(SET.cache.entries||0)+' 项':'读取中…');size.id='cache-size';info.append(size);store.append(info);
 store.append(el('p','set-note','打开过的会话列表和对话会加密存在这台手机上，下次打开先显示，再在后台刷新。'));
 const clear=btn('清除缓存','secondary small',()=>confirmAction('清除缓存？','只删除手机上的缓存，电脑上的会话和历史不受影响。','清除',async()=>{try{await rpc('cacheClear');if(typeof cacheForget==='function')cacheForget();SET.cache={bytes:0,entries:0};toast('缓存已清除');paintSettings();}catch(e){error(e);}},true));
 clear.classList.add('set-action');store.append(clear);
 rpc('cacheInfo').then(c=>{SET.cache=c;const n=document.getElementById('cache-size');if(n)n.textContent=bytesText(c.bytes||0)+' · '+(c.entries||0)+' 项';}).catch(()=>{const n=document.getElementById('cache-size');if(n)n.textContent='—';});

 const upd=group(right,'更新');
 const ver=el('div','set-row');ver.append(el('span','set-label','当前版本'),el('span','set-value mono',(p.version||'—')));upd.append(ver);
 upd.append(updateStatus());
 upd.append(toggle('自动检查更新','打开 App 时最多每 12 小时查一次 GitHub，不发送任何设备信息',p.autoUpdate!==false,async on=>!!(await settingsSet('autoUpdate',on))));

 const help=group(right,'帮助与反馈');
 help.append(linkRow('使用帮助','',()=>helpOpen()),linkRow('反馈问题','',()=>helpFeedback()));

 const about=group(right,'关于');
 about.append(linkRow('项目主页','GitHub',()=>rpc('openUrl',{url:'https://github.com/HFO4AR/herdr-pocket'}).catch(error),'globe'));
 about.append(linkRow('全部版本','',()=>rpc('openUrl',{url:'https://github.com/HFO4AR/herdr-pocket/releases'}).catch(error),'globe'));
 const lic=el('div','set-row');lic.append(el('span','set-label','开源许可'),el('span','set-value','MIT'));about.append(lic);
 main.append(el('p','fine center','Herdr Pocket · 在手机上和电脑里的 Codex、Claude 等 Agent 对话'));}

function updateBanner(){
 const u=updateInfo().latest;const b=el('section','update-banner');b.setAttribute('role','status');
 const ic=el('span','update-icon');ic.append(icon('download'));const t=el('div','grow');t.append(el('strong','','新版本 '+u.tag),el('small','',[relative(u.published),u.size?bytesText(u.size):''].filter(Boolean).join(' · ')));
 b.append(ic,t);if(!SET.download)b.append(btn(SET.ready===u.tag?'安装':'更新','primary small',SET.ready===u.tag?updateInstall:updateDownload));return b;}
function updateStatus(){
 const box=el('div','update-status');box.id='update-status';const u=updateInfo();
 if(SET.download){const t=el('div','set-row');t.append(el('span','set-label','正在下载 '+SET.download.tag));const pct=el('span','set-value mono',SET.download.pct+'%');pct.id='update-pct';t.append(pct);box.append(t);
  const track=el('div','progress');track.setAttribute('role','progressbar');track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');track.setAttribute('aria-valuenow',String(SET.download.pct));const bar=el('div','progress-bar');bar.id='update-bar';bar.style.width=SET.download.pct+'%';track.append(bar);box.append(track);return box;}
 const line=el('div','set-row');let text='还没检查过';
 if(updateAvailable())text='可以更新到 '+u.latest.tag;else if(u?.checkedAt)text='已是最新 · '+relative(u.checkedAt);
 line.append(el('span','set-label','状态'),el('span','set-value'+(updateAvailable()?' accent':''),text));box.append(line);
 if(SET.error){const e=el('p','set-note error',SET.error);e.setAttribute('role','alert');box.append(e);}
 if(SET.needPermission)box.append(el('p','set-note','系统要求先允许 Herdr Pocket「安装未知应用」。打开开关后返回，再点「安装」。'));
 const row=el('div','set-actions');
 const check=btn(SET.checking?'正在检查…':'检查更新','secondary small',updateCheck);check.disabled=SET.checking;if(SET.checking)check.prepend(el('span','spinner mini'));row.append(check);
 if(updateAvailable())row.append(btn(SET.ready===u.latest.tag?'安装':'下载并安装','primary small',SET.ready===u.latest.tag?updateInstall:updateDownload,'download'));
 box.append(row);
 if(updateAvailable())box.append(el('p','set-note','安装包从 GitHub 下载，会核对发布的 SHA-256 和应用签名，最后由系统安装程序让你确认。'));
 return box;}
// Repaint keeping the page scroll (download progress itself updates in place, see updateDownload).
function paintSettings(){if(S.tab!=='settings'||S.chat||overlay.childElementCount)return;const m=document.querySelector('.main');const top=m?m.scrollTop:0;render();const m2=document.querySelector('.main');if(m2)m2.scrollTop=top;}
