'use strict';
// 文件: browse a connected computer's folders and move files both ways over its SSH connection (SFTP).
//  · Native (RemoteFiles.kt / Transfers.kt) does every SFTP call on that computer's own session, with
//    the SSH user's permissions; nothing goes through a shell or the bridge. Paths are plain strings.
//  · Every request names its computer (FX.view.device), so switching the device on screen never sends a
//    request to the wrong one. Transfers run natively and keep going while this page changes; the page
//    polls their counters (sftpTransfers) and toasts when one ends. Progress is only ever what native
//    reported: bars animate between real byte updates, never past the last one.
//  · Uploads never overwrite silently: a name that already exists asks 替换 / 保留两个 / 跳过 first, and
//    native re-checks when it moves the finished temporary file into place.
//  · 预览 (Previews.kt) reads one file into the app's private cache and hands this page text plus
//    passive image/PDF URLs on https://pocket.invalid/preview/… (PreviewServer.kt). Remote HTML/JS is
//    only ever shown as text: this file never assigns innerHTML from remote content and never loads
//    remote scripts.
const FX={view:null,transfers:[],states:new Map(),want:0,sort:'name',hidden:false,prefs:false,
 pv:null,pcache:new Map(),meters:new Map(),hint:undefined,hintLoaded:'',nav:0,flew:new Set(),lastPoll:0};
const FX_BIG=200e6;// downloads above this ask first (mobile data, phone storage)
const FX_MEDIA_MAX=20_000_000;// mirrors Previews.MEDIA_MAX / MediaPreview.CONFIRM_MAX: large previews ask first
const FX_PLAY_MAX=1_000_000_000;// mirrors MediaPreview.HARD_MAX: one cached video/audio file
const FX_MAX_LINES=4000,FX_SYNTAX_LINES=2500,FX_SEARCH_LINES=20000,FX_PCACHE=12;const FX_IMG=/\.(png|jpe?g|gif|webp|bmp|avif|heic|heif)$/i,FX_PDF=/\.pdf$/i;
// Videos/audio are cached whole and played by the native PlayerActivity; the WebView never gets a media element.
const FX_AUDIO=/\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|wma|amr|mid|midi|aiff|aif|mka)$/i;
const FX_MEDIA=/\.(mp4|m4v|mov|mkv|webm|avi|3gp|m2ts|mpg|mpeg|flv|wmv|mp3|m4a|aac|wav|flac|ogg|oga|opus|wma|amr|mid|midi|aiff|aif|mka)$/i;
const FX_OFFICE=/\.(docx|xlsx|pptx)$/i;
const FX_OFFICE_ANY=/\.(docx|xlsx|pptx|doc|xls|ppt|docm|xlsm|pptm|dotx|dotm|xltx|xltm|potx|potm|ppsx|ppsm|odt|ods|odp|rtf)$/i;
const FX_MD=/\.(md|markdown|mdown|mkd|mdx)$/i,FX_JSON=/\.(json|jsonc|json5|geojson|webmanifest)$/i;
const FX_CSV=/\.(csv|tsv)$/i,FX_LOG=/\.(log|out|err|trace|nohup)$/i;
function filesIcons(){if(paths.fUpload)return;Object.assign(paths,{fUpload:'M12 20V9M7 14l5-5 5 5M5 4h14',fTrash:'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',fHome:'M3 11l9-7 9 7M5 9.5V20h5v-6h4v6h5V9.5',fLink:'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',fSort:'M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4',fEye:'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6',fShare:'M12 3v13M7 8l5-5 5 5M5 14v6h14v-6',fFolderPlus:'M4 5h5l2 2.5h9a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM12 10.5v6M9 13.5h6',fSelect:'M4 6l2 2 4-4M4 16l2 2 4-4M13 7h7M13 17h7',fMinus:'M5 12h14',fFit:'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',fWrap:'M4 6h16M4 12h13a3 3 0 1 1 0 6h-3M4 18h6M16 15l-3 3 3 3'});}
// Sort and 显示隐藏文件 are remembered per computer in the app's own encrypted cache (cache.js; the
// WebView has no DOM storage). Read once per run; a choice made meanwhile wins.
function filesPrefs(dev){if(!dev||FX.prefs)return;FX.prefs=true;cacheGet('files:prefs',dev).then(v=>{if(!v||FX.prefsSet)return;if(['name','time','size'].includes(v.sort))FX.sort=v.sort;FX.hidden=!!v.hidden;paintFiles();});}
function filesSavePrefs(){FX.prefsSet=true;const dev=FX.view?.device;if(dev)cachePut('files:prefs',{sort:FX.sort,hidden:FX.hidden},dev);}
function fxReduced(){return document.documentElement.classList.contains('reduce-motion')||matchMedia('(prefers-reduced-motion: reduce)').matches;}
function fxMotion(node,cls,ms){if(!node||fxReduced())return;node.classList.add(cls);setTimeout(()=>node.classList.remove(cls),ms);}

// ─── Opening and leaving ────────────────────────────────────────────────────
// opts.path: where to start (an agent's or pane's folder); a folder that does not exist falls back to ~.
function filesOpen(opts={}){
 filesIcons();fxClosePreview();
 if(S.demo){toast('演示模式不连电脑，不能传文件');return;}
 const dev=opts.device||S.device;if(!dev){toast('先连上电脑');return;}
 filesPrefs(dev.id);
 const backChat=S.chat,backTerminal=(typeof T!=='undefined'&&T.view)?T.view:null;
 if(typeof leaveTerminal==='function')leaveTerminal();closeSheet();S.chat=null;
 FX.view={device:dev.id,name:dev.name||dev.host||'电脑',path:opts.path||'~',back:[],list:null,loading:true,error:'',select:null,epoch:0,backChat,backTerminal,
  target:'',nav:'',navDone:'',first:true,everLoaded:false,selectNew:false};
 filesHintSeen(dev.id);
 renderFiles();filesLoad(FX.view.path);filesPoll();}
function filesLeave(){fxClosePreview();FX.view=null;}
// One tap out of 文件, back to the conversation/terminal it was opened from (or the tab).
function filesReturn(){const v=FX.view;if(!v)return false;const chat=v.backChat,term=v.backTerminal;FX.view=null;fxClosePreview();
 if(chat){S.chat=chat;S.epoch++;renderChat();return true;}
 if(term&&typeof T!=='undefined'){if(term.kind==='attach'&&typeof attachOpen==='function'){attachOpen(term.pane,term.readOnly);return true;}if(!term.disposed){T.view=term;renderTerminal();if(typeof pollTerminal==='function')pollTerminal();return true;}}
 render();return true;}
// Back: out of a preview, then selection, then up the folders you came through, then out of 文件.
function filesBack(){const v=FX.view;if(!v)return false;if(FX.pv){fxClosePreview();renderFiles();return true;}
 if(v.select){v.select=null;paintFiles();return true;}
 if(v.back.length){filesLoad(v.back.pop(),false);return true;}filesLeave();render();return true;}

async function filesLoad(path,push){
 const v=FX.view;if(!v)return;const ep=++v.epoch;
 const from=v.list?.path;
 v.loading=true;v.error='';v.target=path;
 v.nav=from&&from!==path?(push?'fwd':'back'):'';
 if(v.nav){v.keepList=v.list;v.list=null;fxGhostOut(v.nav);}
 paintFiles();
 try{const r=await rpc('sftpList',{device:v.device,path});if(FX.view!==v||ep!==v.epoch)return;
  if(push&&v.keepList&&v.keepList.path!==r.path)v.back.push(v.keepList.path);
  v.keepList=null;v.list=r;v.path=r.path;v.home=r.home;v.select=null;v.navDone=v.nav;v.nav='';v.target='';}
 catch(e){if(FX.view!==v||ep!==v.epoch)return;
  if(v.nav&&v.keepList){v.list=v.keepList;v.navDone='';v.nav='';v.keepList=null;}
  if(!v.list&&path!=='~'){toast('打不开 '+path+'：'+(e.message||e)+'，先从主目录开始');v.loading=false;v.nav='';v.target='';return filesLoad('~',false);}
  v.error=e.message||String(e);}
 finally{if(FX.view===v&&ep===v.epoch){v.loading=false;paintFiles();
  const m=document.getElementById('files-main');if(m&&push!==undefined&&!v.navDone)m.scrollTop=0;
  const list=document.getElementById('files-list');
  if(list&&v.navDone&&!fxReduced()){list.classList.add(v.navDone==='fwd'?'fx-in-fwd':'fx-in-back');v.navDone='';}
  else v.navDone='';}}}
function filesGo(path){filesLoad(path,true);}
function filesHere(){return FX.view?.list?.path||FX.view?.target||'';}
// Sliding the old level out while the new one (or its skeleton) paints in.
function fxGhostOut(dir){
 const main=document.getElementById('files-main'),list=document.getElementById('files-list');
 if(!main||!list||!list.firstChild||fxReduced())return;
 const g=list.cloneNode(true);g.removeAttribute('id');g.classList.remove('fx-in-fwd','fx-in-back');g.classList.add('fx-ghost',dir==='fwd'?'fx-out-fwd':'fx-out-back');
 g.setAttribute('aria-hidden','true');g.setAttribute('inert','');
 g.querySelectorAll('[id]').forEach(n=>n.removeAttribute('id'));main.append(g);
 setTimeout(()=>g.remove(),230);}

// ─── Screen ─────────────────────────────────────────────────────────────────
// On a tablet the two-pane frame would otherwise keep the 会话 placeholder beside 文件. 文件 is one
// full content column next to the rail, so switch the frame to its solo mode before shell() picks a host.
function filesWideSolo(){
 if(typeof LAYOUT==='undefined'||!LAYOUT.wide||!LAYOUT.frame)return;
 const f=LAYOUT.frame;f.root.dataset.mode='solo';f.detail.replaceChildren();
 const de=document.documentElement;de.classList.add('wide-on');de.classList.remove('wide-split','wide-focus');}
function renderFiles(){
 const v=FX.view;if(!v)return;filesIcons();
 // render() (status polls, connection changes) rebuilds this screen: the list keeps its reading
 // position instead of snapping to the top, the same as the tabs do, and closing a preview comes back
 // to where the list was. A text preview keeps its own scroll the same way (a PDF keeps its anchor).
 const oldMain=document.getElementById('files-main'),oldBody=document.getElementById('fx-body');
 if(oldMain)v.listScroll={path:filesHere(),top:oldMain.scrollTop};
 if(FX.pv&&oldBody&&oldBody.dataset.pv===FX.pv.token&&FX.pv.keepScroll===undefined)FX.pv.keepScroll=oldBody.scrollTop;
 filesWideSolo();
 if(FX.pv)return renderPreviewView();
 const root=shell();root.classList.add('files-shell');
 const head=el('header','chat-head files-head');const backLabel=v.backChat?'返回会话':v.backTerminal?'返回终端':'返回';head.append(ib('back',backLabel,()=>filesReturn()),ib('fHome','回到主目录',()=>filesGo('~')));
 const av=el('div','avatar files-av');av.append(icon('folder'));head.append(av);
 const id=el('div','grow chat-id');id.append(el('h2','','文件'),el('small','files-sub',v.name+' · 通过 SSH 传文件'));head.append(id);
 head.append(ib('fUpload','上传到这里',filesUpload),ib('more','文件选项',filesMenu));root.append(head);
 const crumbs=el('nav','files-crumbs');crumbs.id='files-crumbs';crumbs.setAttribute('aria-label','当前位置');root.append(crumbs);
 const main=el('main','main files-main');main.id='files-main';const list=el('div','files-list');list.id='files-list';main.append(list);root.append(main);
 pullRefresh(main,()=>filesLoad(filesHere()||v.path));
 const dock=el('div','files-dock');dock.id='files-dock';root.append(dock);
 paintFiles();
 if(v.listScroll&&v.list&&v.listScroll.path===filesHere())main.scrollTop=v.listScroll.top;}
function paintFiles(){if(!FX.view)return;if(FX.pv){paintPreview();return;}if(!document.getElementById('files-list')){if(!S.chat&&!overlay.querySelector('.sheet')&&!(typeof T!=='undefined'&&T.view))renderFiles();return;}paintCrumbs();paintFileList();paintDock();}

// "/ › home › yuki › src" with the home folder shown as 主目录; scrolled so the current folder shows.
function paintCrumbs(){
 const n=document.getElementById('files-crumbs');const v=FX.view;if(!n||!v)return;
 const path=v.list?.path||v.target||'',home=v.home||'';
 const changed=n.dataset.path&&n.dataset.path!==path;
 n.dataset.path=path;n.replaceChildren();
 if(!path){n.append(el('span','files-crumb-wait','读取中…'));return;}
 const parts=[];let base='/',rest=path;
 if(home&&home!=='/'&&(path===home||path.startsWith(home+'/'))){parts.push(['主目录',home,'fHome']);base=home;rest=path.slice(home.length);}
 else parts.push(['/','/','']);
 let acc=base;rest.split('/').filter(Boolean).forEach(seg=>{acc=acc==='/'?'/'+seg:acc+'/'+seg;parts.push([seg,acc,'']);});
 parts.forEach(([label,p,ic],i)=>{if(i)n.append(el('span','files-sep','›'));const here=i===parts.length-1;
  const b=btn(ic?'':label,'files-crumb'+(here?' here':''),()=>{if(!here)filesGo(p);},ic||undefined);if(ic){b.append(document.createTextNode(label));}
  b.setAttribute('aria-label',(here?'当前位置 ':'去 ')+(ic?label+' '+p:p));if(here)b.setAttribute('aria-current','location');n.append(b);});
 if(changed&&!fxReduced()){n.classList.remove('fx-crumb-step');void n.offsetWidth;n.classList.add('fx-crumb-step');}
 requestAnimationFrame(()=>{n.scrollLeft=n.scrollWidth;});}

function filesSorted(entries){
 const dir=e=>e.type==='dir'||e.type==='link'&&e.target==='dir';
 const list=entries.filter(e=>FX.hidden||!e.name.startsWith('.'));
 const by={name:(a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true,sensitivity:'base'}),time:(a,b)=>(b.mtime||0)-(a.mtime||0),size:(a,b)=>(b.size||0)-(a.size||0)}[FX.sort];
 return list.sort((a,b)=>(dir(b)-dir(a))||by(a,b)||a.name.localeCompare(b.name));}
function fileIsDir(e){return e.type==='dir'||e.type==='link'&&e.target==='dir';}
function filePath(e){const d=filesHere();return d==='/'?'/'+e.name:d+'/'+e.name;}
function fileWhen(e){return e.mtime?relative(e.mtime):'';}
function fxMeta(e){
 if(e.type==='link')return e.target==='dir'?'链接 → 文件夹':e.target==='broken'?'链接 · 指向的东西不在了':'链接 · '+fileSize(e.size);
 if(e.type==='dir')return '文件夹';if(e.type==='other')return '特殊文件';return fileSize(e.size);}
// A quiet colour cue per file family; the extension chip or page icon stays the same.
function fxKindClass(name){const x=(name.split('.').pop()||'').toLowerCase();
 if(FX_IMG.test(name))return 'kind-image';if(FX_PDF.test(name))return 'kind-pdf';
 if(FX_OFFICE_ANY.test(name))return 'kind-office';
 if(['zip','tar','gz','tgz','bz2','xz','7z','rar','zst','dmg','iso'].includes(x))return 'kind-archive';
 if(FX_MEDIA.test(name))return 'kind-media';
 if(FX_JSON.test(name)||FX_CSV.test(name)||['xml','yaml','yml','toml','ini','conf','sql','db','sqlite'].includes(x))return 'kind-data';
 if(['js','jsx','ts','tsx','mjs','cjs','c','h','cc','cpp','hpp','cs','java','kt','kts','go','rs','py','rb','php','swift','sh','bash','zsh','fish','lua','pl','scss','css','html','vue','svelte'].includes(x))return 'kind-code';
 if(['md','markdown','mdown','mkd','txt','rst','org'].includes(x))return 'kind-doc';return '';}

function paintFileList(){
 const n=document.getElementById('files-list');const v=FX.view;if(!n||!v)return;n.replaceChildren();
 if(v.nav&&v.loading){const s=el('div','files-skeleton');s.setAttribute('role','status');s.setAttribute('aria-label','正在读取文件夹');s.append(el('span','sr-only','正在读取文件夹…'));skeleton(s,5);n.append(s);return;}
 if(v.error&&!v.loading){const box=el('div','files-error');box.setAttribute('role','alert');
  const ic=el('div','files-state-icon alert');ic.append(icon('alert'));
  box.append(ic,el('h2','','读不了这个文件夹'),el('p','',v.error));
  const row=el('div','files-error-actions');row.append(btn('重试','primary',()=>filesLoad(filesHere()||v.path)));if(v.list||v.path!=='~')row.append(btn('回主目录','secondary',()=>filesGo('~')));box.append(row);n.append(box);if(!v.list)return;}
 if(!v.list){if(v.loading){const s=el('div','files-loading');s.setAttribute('role','status');s.append(el('span','spinner'),el('span','','正在读取电脑上的文件夹…'));n.append(s);skeleton(n,4);}return;}
 const all=v.list.entries||[],shown=filesSorted(all.slice()),hidden=all.length-all.filter(e=>FX.hidden||!e.name.startsWith('.')).length;
 const bar=el('div','row files-bar');const facts=el('span','grow files-facts');
 const dirs=shown.filter(fileIsDir).length;facts.append(el('span','',dirs+' 个文件夹 · '+(shown.length-dirs)+' 个文件'));
 if(hidden)facts.append(el('span','files-hidden-note',' · '+hidden+' 个隐藏'));if(v.loading)facts.append(el('span','spinner mini'));
 const sort=btn('','pill files-sort',filesSortSheet,'fSort');sort.append(el('span','',{name:'名称',time:'时间',size:'大小'}[FX.sort]));sort.setAttribute('aria-label','排序方式：'+{name:'按名称',time:'按修改时间',size:'按大小'}[FX.sort]);
 bar.append(facts,sort);n.append(bar);
 const card=el('div','card list-card files-card');card.setAttribute('role','list');card.setAttribute('aria-label','文件夹内容');
 if(v.first&&!fxReduced())card.classList.add('fx-stagger');
 if(v.list.parent&&!v.select){const up=btn('','card-button file-row file-up',()=>filesGo(v.list.parent));up.setAttribute('role','listitem');const ic=el('span','file-icon dir');ic.append(icon('back'));up.append(ic,fileText('上一级',v.list.parent));card.append(up);}
 const pending=FX.transfers.filter(t=>t.kind==='up'&&(t.state==='queued'||t.state==='running')&&t.where===v.list.path);
 for(const t of pending)card.append(fxPendingRow(t));
 if(!shown.length&&!pending.length){const e=el('div','empty small files-empty');
  const ic=el('div','files-state-icon');ic.append(icon(all.length?'fEye':'folder'));e.append(ic,el('h2','',all.length?'只有隐藏文件':'空文件夹'),el('p','',all.length?'在「⋯」里打开「显示隐藏文件」':'点右上角的上传，把手机上的文件放进来，长按还能多选'));card.append(e);}
 let i=0;for(const e of shown){const r=fileRow(e);if(!fxReduced())r.style.setProperty('--i',String(Math.min(i,9)));card.append(r);i++;}
 n.append(card);
 if(v.list.truncated)n.append(el('p','fine center','文件太多，只列出前 '+all.length+' 个'));
 n.append(el('p','fine files-note','用这台电脑的 SSH 连接（SFTP）传文件，不用另开 FTP；点文件可以预览，左右滑动切换，长按多选。能动哪些文件，和这个 SSH 用户在电脑上一样。'));
 v.first=false;v.selectNew=false;}

function fileRow(e){
 const v=FX.view,dir=fileIsDir(e),sel=v.select,picked=sel?.has(e.name);
 const row=el('div','file-row-wrap'+(picked?' picked':''));row.setAttribute('role','listitem');
 const b=btn('','card-button file-row',()=>{if(row.dataset.long){delete row.dataset.long;return;}if(v.select){fileToggle(e);return;}if(dir)filesGo(filePath(e));else filesPreview(e);});
 if(sel){const c=el('span','file-check'+(picked?' on':'')+(v.selectNew?' fx-check-in':''));c.append(icon('check'));b.append(c);b.setAttribute('aria-pressed',picked?'true':'false');}
 let ic;if(dir||e.type==='link'){ic=el('span','file-icon '+(dir?'dir':'link'));ic.append(icon(dir?'folder':'fLink'));}else{ic=fileBadge(e.name);ic.classList.add('file-icon-badge');const k=fxKindClass(e.name);if(k)ic.classList.add(k);}
 b.append(ic,fileText(e.name,[fxMeta(e),fileWhen(e)].filter(Boolean).join(' · ')));
 const dl=!dir&&!sel?fxDownloadFor(e):null;
 if(dl)b.append(fxRing(dl));
 else if(!dir&&!sel){const t=FX.transfers.find(x=>x.kind==='down'&&x.state==='done'&&x.remote===filePath(e)&&x.canOpen);if(t){const ck=el('span','file-done');ck.append(icon('check'));b.append(ck);}}
 b.setAttribute('aria-label',(dir?'文件夹 ':'文件 ')+e.name+(sel?(picked?'，已选':'，未选'):dl?'，正在下载':''));
 // Long press starts picking several (download or delete together).
 let timer=0;const start=()=>{clearTimeout(timer);timer=setTimeout(()=>{row.dataset.long='1';if(typeof haptic==='function')haptic('long');if(!v.select){v.select=new Set();v.selectNew=true;}fileToggle(e);},520);};
 const stop=()=>clearTimeout(timer);
 b.addEventListener('touchstart',start,{passive:true});b.addEventListener('touchend',stop);b.addEventListener('touchmove',stop,{passive:true});b.addEventListener('touchcancel',stop);
 b.addEventListener('contextmenu',ev=>{ev.preventDefault();});
 row.append(b);
 if(!sel){const more=ib('more',e.name+' 的操作',()=>fxSheet(e));more.classList.add('file-more');row.append(more);}
 return row;}
function fileToggle(e){const v=FX.view;if(!v.select)v.select=new Set();if(v.select.has(e.name))v.select.delete(e.name);else v.select.add(e.name);if(!v.select.size)v.select=null;paintFiles();}
function fxDownloadFor(e){const path=filePath(e);return FX.transfers.find(t=>t.kind==='down'&&t.remote===path&&(t.state==='running'||t.state==='queued'));}
// Live updates without rebuilding the list: the ring on a downloading row and the pending upload
// rows move only by the counters native reported. Anything that just ended is taken off the list.
function fxUpdateRows(){
 document.querySelectorAll('#files-list .fx-ring[data-tid]').forEach(n=>{
  const t=FX.transfers.find(x=>x.id===n.dataset.tid);const active=t&&(t.state==='running'||t.state==='queued');
  if(!active){n.remove();return;}
  const pct=transferPct(t);n.setAttribute('aria-valuenow',String(pct));const num=n.querySelector('.fx-ring-n');if(num)num.textContent=pct+'%';
  const fg=n.querySelector('.fx-ring-fg');if(fg){const c=2*Math.PI*14;fg.setAttribute('stroke-dashoffset',(c*(1-pct/100)).toFixed(1));}});
 document.querySelectorAll('#files-list .fx-pending[data-tid]').forEach(n=>{
  const t=FX.transfers.find(x=>x.id===n.dataset.tid);const active=t&&(t.state==='running'||t.state==='queued');
  if(!active){n.remove();return;}
  const pct=transferPct(t),meta=n.querySelector('[data-pmeta]');
  if(meta)meta.textContent='上传中 · '+pct+'%'+(t.size>0?' · '+fileSize(t.done)+' / '+fileSize(t.size):'');
  const bar=n.querySelector('.files-progress');if(bar){bar.setAttribute('aria-valuenow',String(pct));const fill=bar.firstChild;if(fill)fill.style.width=pct+'%';}});}
function fxRing(t){
 const pct=transferPct(t),wrap=el('span','fx-ring');wrap.dataset.tid=t.id;wrap.setAttribute('role','progressbar');wrap.setAttribute('aria-label','下载进度');wrap.setAttribute('aria-valuemin','0');wrap.setAttribute('aria-valuemax','100');wrap.setAttribute('aria-valuenow',String(pct));
 const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 36 36');svg.setAttribute('aria-hidden','true');
 const bg=document.createElementNS(ns,'circle');bg.setAttribute('cx','18');bg.setAttribute('cy','18');bg.setAttribute('r','14');bg.setAttribute('class','fx-ring-bg');
 const fg=document.createElementNS(ns,'circle');fg.setAttribute('cx','18');fg.setAttribute('cy','18');fg.setAttribute('r','14');fg.setAttribute('class','fx-ring-fg');
 const c=2*Math.PI*14;fg.setAttribute('stroke-dasharray',c.toFixed(1));fg.setAttribute('stroke-dashoffset',(c*(1-pct/100)).toFixed(1));
 svg.append(bg,fg);wrap.append(svg,el('span','fx-ring-n',pct+'%'));return wrap;}
function fxPendingRow(t){
 const row=el('div','file-row-wrap fx-pending');row.dataset.tid=t.id;row.setAttribute('role','listitem');
 const b=el('div','card-button file-row');b.setAttribute('aria-label','正在上传 '+t.name);
 const ic=el('span','file-icon kind-code');ic.append(icon('fUpload'));
 const pct=transferPct(t);const txt=fileText(t.name,'上传中 · '+pct+'%'+(t.size>0?' · '+fileSize(t.done)+' / '+fileSize(t.size):''));
 txt.lastChild.dataset.pmeta='1';
 const bar=el('span','files-progress');bar.setAttribute('role','progressbar');bar.setAttribute('aria-valuenow',String(pct));bar.setAttribute('aria-valuemin','0');bar.setAttribute('aria-valuemax','100');
 const fill=el('span','');fill.style.width=pct+'%';bar.append(fill);txt.append(bar);
 b.append(ic,txt);row.append(b);
 if(!FX.flew.has(t.id)){FX.flew.add(t.id);if(!fxReduced())row.classList.add('fx-fly');}
 return row;}

// ─── One entry: what can be done with it ────────────────────────────────────
function fxSheet(e){
 const dir=fileIsDir(e),path=filePath(e),v=FX.view;const box=sheet(e.name);
 const head=el('div','file-detail');const ic=dir?el('span','file-badge'):fileBadge(e.name);if(dir)ic.append(icon('folder'));
 const t=el('div');t.append(el('span','file-detail-name',e.name),el('small','muted',[fxMeta(e),e.mtime?time(e.mtime):'',e.perm||''].filter(Boolean).join(' · ')));head.append(ic,t);box.append(head);
 box.append(el('code','file-path',path));
 if(dir)menuItem(box,'打开',()=>filesGo(path),'folder');
 else{menuItem(box,'预览',()=>filesPreview(e),'fEye',fxKindLabel(e));}
 if(!dir&&e.type!=='other'&&e.target!=='broken'){
  if(v.list?.downloads)menuItem(box,'下载到手机',()=>fileDownload(e,false),'download','存到手机的「下载/Herdr Pocket」');
  menuItem(box,'另存为…',()=>fileDownload(e,true),'file','自己选手机上的位置和名字');}
 menuItem(box,'重命名',()=>fileRename(e),'edit');
 menuItem(box,'复制路径',()=>copyText(path),'copy');
 const del=menuItem(box,'删除',()=>fileDelete(e),'fTrash',dir&&e.type==='dir'?'空文件夹直接删；里面有东西会再问一次':'电脑上的这个文件会被删掉');del.classList.add('danger-item');}

// Keys, credentials and .env files: allowed (it is your own account), but said out loud first, since
// the phone's 下载 folder can be read by other apps. Same families as the bridge's fileView refusals.
const FX_SECRET=/(^|\/)(\.ssh|\.gnupg|\.aws|\.password-store|\.kube|\.docker)(\/|$)|(^|\/)(\.env[^/]*|[^/]*id_(rsa|ed25519|ecdsa|dsa)[^/]*|[^/]*\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)|\.netrc|\.pgpass|\.git-credentials|\.npmrc|\.pypirc|credentials[^/]*|auth\.json|\.credentials\.json)$/i;
function fileDownload(e,saveAs,checked){
 const v=FX.view,path=filePath(e),size=e.size||0;
 if(!checked&&FX_SECRET.test(path)){confirmAction('下载这个敏感文件？','「'+e.name+'」看起来是密钥、凭据或 .env 一类的文件。存到手机后，'+(saveAs?'你选的位置':'「下载」文件夹')+'里的文件别的应用也可能读到。确定需要再下载。','仍然下载',()=>fileDownload(e,saveAs,true),true);return;}
 const go=async()=>{try{const r=await rpc('sftpDownload',{device:v.device,path,size,saveAs});if(r.cancelled)return;filesTrack(r);toast('开始下载「'+e.name+'」');}catch(err){error(err);}};
 if(size>FX_BIG){confirmAction('下载 '+fileSize(size)+'？','「'+e.name+'」比较大。用流量的话会花不少，手机也要有足够空间。下完才会出现在手机上，中途断了不会留下半个文件。','下载',go);return;}
 go();}
function fileRename(e){
 const v=FX.view,path=filePath(e);const box=sheet('重命名');
 const input=el('input','field files-input');input.value=e.name;input.setAttribute('aria-label','新名字');input.autocapitalize='off';input.spellcheck=false;
 const err=el('p','field-error');err.setAttribute('role','alert');
 const row=el('div','sheet-actions');const ok=btn('改名','primary',async()=>{const name=input.value;const why=fileNameProblem(name);if(why){err.textContent=why;return;}if(name===e.name){closeSheet();return;}
  ok.disabled=true;try{await rpc('sftpRename',{device:v.device,path,name});closeSheet();toast('改好了');filesLoad(filesHere());}catch(x){err.textContent=x.message;ok.disabled=false;}});
 row.append(btn('取消','secondary',closeSheet),ok);box.append(input,err,row);
 input.onkeydown=ev=>{if(ev.key==='Enter')ok.click();};
 setTimeout(()=>{input.focus();const dot=e.name.lastIndexOf('.');input.setSelectionRange(0,dot>0&&!fileIsDir(e)?dot:e.name.length);},80);}
function fileNameProblem(name){if(!name.trim())return '名字不能为空';if(name==='.'||name==='..')return '不能用 . 或 .. 当名字';if(name.includes('/'))return '名字里不能有 /';
 if(/[\x00-\x1f\x7f]/.test(name))return '名字里不能有控制字符';if(name.trim()!==name)return '开头或结尾不能是空格';if(new TextEncoder().encode(name).length>255)return '名字太长了';return '';}
function filesMkdir(){
 const v=FX.view;if(!v?.list)return;const dir=v.list.path;const box=sheet('新建文件夹');
 const input=el('input','field files-input');input.placeholder='文件夹名';input.setAttribute('aria-label','文件夹名');input.autocapitalize='off';input.spellcheck=false;
 const err=el('p','field-error');err.setAttribute('role','alert');
 const row=el('div','sheet-actions');const ok=btn('创建','primary',async()=>{const name=input.value;const why=fileNameProblem(name);if(why){err.textContent=why;return;}
  ok.disabled=true;try{await rpc('sftpMkdir',{device:v.device,dir,name});closeSheet();toast('建好了「'+name+'」');filesLoad(dir);}catch(x){err.textContent=x.message;ok.disabled=false;}});
 row.append(btn('取消','secondary',closeSheet),ok);box.append(el('p','muted close-sub','建在 '+dir),input,err,row);
 input.onkeydown=ev=>{if(ev.key==='Enter')ok.click();};setTimeout(()=>input.focus(),80);}

// Files and links go at once (after a confirm); a folder only when empty. A folder with things in it
// asks again and needs its name typed before 全部删除 — never followed through links.
function fileDelete(e){
 const v=FX.view,path=filePath(e),dir=e.type==='dir';
 confirmAction('删除「'+e.name+'」？',dir?'电脑上的这个文件夹会被删掉，不能恢复。':e.type==='link'?'只删这个链接，它指向的东西不动。':'电脑上的这个文件会被删掉，不能恢复（不进回收站）。','删除',async()=>{
  try{await rpc('sftpDelete',{device:v.device,path});toast('删掉了「'+e.name+'」');filesLoad(filesHere());}
  catch(x){if(x.code==='sftp_not_empty')fileDeleteAll(e,path);else error(x);}},true);}
function fileDeleteAll(e,path){
 const v=FX.view;const box=sheet('文件夹里还有东西');
 box.append(el('p','muted','「'+e.name+'」里面还有文件。全部删除会把里面所有的文件和子文件夹都删掉，不能恢复。链接只删链接本身。'));
 box.append(el('code','file-path',path));
 const input=el('input','field files-input');input.placeholder=e.name;input.setAttribute('aria-label','输入文件夹名确认');input.autocapitalize='off';input.spellcheck=false;
 const err=el('p','field-error');err.setAttribute('role','alert');
 const row=el('div','sheet-actions');const ok=btn('全部删除','primary danger-fill',async()=>{ok.disabled=true;err.textContent='';
  try{const r=await rpc('sftpDelete',{device:v.device,path,recursive:true,confirm:input.value});closeSheet();toast('删掉了 '+r.deleted+' 项');filesLoad(filesHere());}
  catch(x){err.textContent=x.message;ok.disabled=input.value!==e.name;if(x.code==='sftp_partial')filesLoad(filesHere());}});
 ok.disabled=true;input.oninput=()=>{ok.disabled=input.value!==e.name;};
 row.append(btn('取消','secondary',closeSheet),ok);box.append(el('p','fine','输入文件夹名「'+e.name+'」确认：'),input,err,row);setTimeout(()=>input.focus(),80);}

// ─── Several at once ────────────────────────────────────────────────────────
function filesPicked(){const v=FX.view;if(!v?.select||!v.list)return [];return v.list.entries.filter(e=>v.select.has(e.name));}
async function filesDownloadPicked(){
 const v=FX.view,files=filesPicked().filter(e=>!fileIsDir(e)&&e.type!=='other'&&e.target!=='broken');
 if(!files.length){toast('选中的里面没有能下载的文件（文件夹要进去一个个下）');return;}
 if(!v.list.downloads){toast('这个安卓版本只能一个个「另存为」');return;}
 const total=files.reduce((n,e)=>n+(e.size||0),0);
 if(files.some(e=>FX_SECRET.test(filePath(e)))){toast('选中的里有密钥或凭据一类的文件，请单独下载');return;}
 const go=async()=>{v.select=null;paintFiles();let n=0;for(const e of files){try{filesTrack(await rpc('sftpDownload',{device:v.device,path:filePath(e),size:e.size||0}));n++;}catch(x){error(x);}}if(n)toast('开始下载 '+n+' 个文件');};
 if(total>FX_BIG)confirmAction('下载 '+files.length+' 个文件，共 '+fileSize(total)+'？','用流量的话会花不少，手机也要有足够空间。','下载',go);else go();}
function filesDeletePicked(){
 const v=FX.view,list=filesPicked();if(!list.length)return;
 confirmAction('删除选中的 '+list.length+' 项？','电脑上的这些文件会被删掉，不能恢复。文件夹只有空的才会删，里面有东西的会跳过。','删除',async()=>{
  let ok=0;const skipped=[];for(const e of list){try{await rpc('sftpDelete',{device:v.device,path:filePath(e)});ok++;}catch(x){skipped.push(e.name+'：'+(x.code==='sftp_not_empty'?'里面还有东西':x.message));}}
  v.select=null;toast('删掉了 '+ok+' 项'+(skipped.length?'，'+skipped.length+' 项没删（'+skipped[0]+(skipped.length>1?' 等':'')+'）':''));filesLoad(filesHere());},true);}

// ─── Upload ─────────────────────────────────────────────────────────────────
async function filesUpload(){
 const v=FX.view;if(!v?.list){toast('等文件夹读出来再上传');return;}const dir=v.list.path,device=v.device;
 let r;try{r=await rpc('sftpPickUpload',{});}catch(e){error(e);return;}
 const files=r.files||[];if(r.failed)toast((r.failed>1?r.failed+' 个文件读不到：':'有个文件读不到：')+(r.reason||''));else if(r.extra)toast('一次最多传 50 个，多出来的 '+r.extra+' 个没加');
 if(!files.length)return;
 // Names taken right now in the target folder (fresh, not the list on screen).
 let taken;try{const l=await rpc('sftpList',{device,path:dir});taken=new Map((l.entries||[]).map(e=>[e.name,e]));}
 catch(e){error(e);rpc('sftpDropPicks',{ids:files.map(f=>f.id)}).catch(()=>{});return;}
 const plan=[],drop=[];let all=null;const clashes=files.filter(f=>taken.has(f.name)).length;let seen=0;
 for(const f of files){const ex=taken.get(f.name);if(!ex){plan.push({f,mode:'new'});continue;}seen++;
  let c=all&&(all.mode!=='replace'||ex.type==='file')?all:await fileConflict(f,ex,clashes-seen);
  if(c.all)all=c;if(c.mode==='skip'||c.mode==='stop'){drop.push(f.id);if(c.mode==='stop'){files.slice(files.indexOf(f)+1).forEach(x=>drop.push(x.id));break;}continue;}plan.push({f,mode:c.mode});}
 if(drop.length)rpc('sftpDropPicks',{ids:drop}).catch(()=>{});
 let n=0;for(const p of plan){try{filesTrack(await rpc('sftpUpload',{device,dir,id:p.f.id,name:p.f.name,mode:p.mode}));n++;}catch(e){error(e);}}
 if(n)toast(n>1?'开始上传 '+n+' 个文件':'开始上传「'+plan[0].f.name+'」');}
// Resolves with {mode: replace|keep|skip|stop, all}; closing the sheet stops the rest.
function fileConflict(f,ex,more){
 return new Promise(resolve=>{
  const box=sheet('已经有「'+f.name+'」了');let done=false;const finish=c=>{if(done)return;done=true;mo.disconnect();resolve({...c,all:c.mode!=='stop'&&!!check?.checked});closeSheet();};
  const file=ex.type==='file';
  box.append(el('p','muted',file?'电脑上这个文件夹里已经有同名文件（'+fileSize(ex.size)+(ex.mtime?' · '+time(ex.mtime):'')+'）。手机上的这个是 '+fileSize(f.size)+'。':'电脑上同名的是'+(ex.type==='dir'?'一个文件夹':'一个链接')+'，不能替换。'));
  let check=null;if(more>0){const lab=el('label','files-all');check=el('input');check.type='checkbox';lab.append(check,el('span','','后面 '+more+' 个同名的也这样处理'));box.append(lab);}
  const acts=el('div','files-choices');
  const rep=btn('替换','secondary',()=>finish({mode:'replace'}));rep.disabled=!file;if(file)rep.append(el('small','','电脑上的旧文件会被换掉'));
  const keep=btn('保留两个','primary',()=>finish({mode:'keep'}));keep.append(el('small','','新的叫「'+numbered(f.name)+'」'));
  const skip=btn('跳过','secondary',()=>finish({mode:'skip'}));acts.append(keep,rep,skip);box.append(acts);
  const mo=new MutationObserver(()=>{if(!box.isConnected&&!done){done=true;mo.disconnect();resolve({mode:'stop'});}});mo.observe(overlay,{childList:true,subtree:true});});}
function numbered(name){const m=name.match(/^(.+?)(\.[^.]{1,16})$/);return m&&m[1]?m[1]+' (2)'+m[2]:name+' (2)';}

// ─── Preview ────────────────────────────────────────────────────────────────
// One file at a time, read by Previews.kt over SFTP into the app's private cache. Text is decoded
// natively (UTF-8, else GB18030); images are re-encoded natively; PDF pages are rendered natively.
// Nothing from the file is ever parsed as HTML here, and HTML files only show as source text.
function fxKindLabel(e){const n=e.name;
 if(fileIsDir(e))return '文件夹';
 if(FX_IMG.test(n))return '图片';if(FX_PDF.test(n))return 'PDF';
 if(FX_MEDIA.test(n))return FX_AUDIO.test(n)?'音频':'视频';
 if(FX_OFFICE.test(n))return officeLabel(n);if(FX_OFFICE_ANY.test(n))return '旧版 Office';
 if(FX_MD.test(n))return 'Markdown';if(FX_JSON.test(n))return 'JSON';if(FX_CSV.test(n))return 'CSV 表格';
 if(FX_LOG.test(n))return '日志';if(fxKindClass(n)==='kind-code')return '代码 · '+(n.split('.').pop()||'').toUpperCase();
 return e.type==='other'?'特殊文件':'文本';}
function fxPreviewKind(e){if(FX_IMG.test(e.name))return 'image';if(FX_PDF.test(e.name))return 'pdf';if(FX_MEDIA.test(e.name))return 'media';if(FX_OFFICE_ANY.test(e.name))return 'office';return 'text';}
function fxPreviewKey(dev,path,e,kind,tail){return [dev,path,e.mtime||0,e.size||0,kind,tail?'tail':'head'].join('|');}
function fxPreviewCache(key,r){FX.pcache.delete(key);FX.pcache.set(key,r);while(FX.pcache.size>FX_PCACHE)FX.pcache.delete(FX.pcache.keys().next().value);}
// 设置 → 清除缓存 removes native sources/derived URLs; do not keep reopening them from this page.
function fxForgetPreviews(){FX.pcache.clear();}
function filesPreview(e,opts={}){
 const v=FX.view;if(!v?.list)return;
 const path=filePath(e),kind=fxPreviewKind(e),size=e.size||0;
 if(!opts.sensitive&&FX_SECRET.test(path)){
  confirmAction('预览这个敏感文件？','「'+e.name+'」看起来是密钥、凭据或 .env 一类的文件。预览只放在 App 的私有缓存里，不会进手机的「下载」文件夹，但屏幕上的内容别人也看得到。确定要看再打开。','仍然预览',()=>filesPreview(e,{sensitive:true,large:opts.large}));return;}
 if(kind==='media'&&size>FX_PLAY_MAX){toast('这个文件超过 1 GB，App 内播放不了；可以下载后用其他应用打开');return;}
 if(kind==='media'&&size>FX_MEDIA_MAX&&!opts.large){
  confirmAction('缓存 '+fileSize(size)+' 后播放？','「'+e.name+'」不小，要先把整份缓存到手机的 App 私有空间，再用 App 内的播放器播放（不会放进「下载」，也不边下边播）。用流量的话会花一些。','缓存并播放',()=>filesPreview(e,{sensitive:opts.sensitive,large:true}));return;}
 if((kind==='image'||kind==='pdf'||(kind==='office'&&FX_OFFICE.test(e.name)))&&size>FX_MEDIA_MAX&&!opts.large){
  confirmAction('预览 '+fileSize(size)+' 的文件？','「'+e.name+'」不小，预览要先把整份读到手机的 App 缓存里（不会放进「下载」）。用流量的话会花一些。','仍然预览',()=>filesPreview(e,{sensitive:opts.sensitive,large:true}));return;}
 const tail=kind==='text'&&FX_LOG.test(e.name);
 if(FX.pv&&FX.pv.kind==='office'&&typeof officeClose==='function')officeClose(FX.pv);
 const cacheable=kind!=='office',key=cacheable?fxPreviewKey(v.device,path,e,kind,tail):'',hit=cacheable?FX.pcache.get(key):null;
 if(FX.pv)fxStopTail();
 FX.pv={entry:e,path,name:e.name,size,mtime:e.mtime||0,kind,tail,wrap:false,mode:'',q:'',hits:[],hit:-1,
  page:0,pages:0,pdfData:new Map(),pdfFail:new Map(),pdfMiss:new Map(),pdfBusy:false,pdfDoc:null,pdfZoom:1,pdfAnchor:null,pdfFirst:null,pdfNote:'',pdfError:'',
  imgView:null,imgError:'',imgLoading:false,imgTry:0,cached:!!hit,fromCache:!!hit,loading:!hit,error:'',r:null,
  token:'pv'+uuid(),allowLarge:!!opts.large,prepared:false,keepScroll:undefined,keepBottom:false,slide:opts.slide||0};
 filesHintSeen();
 if(kind==='office'){renderFiles();officeOpen(FX.pv);return;}
 if(hit){
  const p=FX.pv;p.r=hit;p.loading=false;p.cached=true;p.prepared=false;fxPrepare(hit);
  renderFiles();paintPreview();
  const b=document.getElementById('fx-body');if(b&&p.slide&&!fxReduced())b.classList.add(p.slide>0?'fx-in-left':'fx-in-right');
  return;
 }
 renderFiles();fxFetchPreview();
}
function fxClosePreview(){fxStopTail();const p=FX.pv;if(!p)return;
 if(p.kind==='office'&&typeof officeClose==='function')officeClose(p);
 else if(p.loading){const token=p.token;rpc(p.kind==='media'?'sftpMediaCancel':'sftpPreviewCancel',{token}).catch(()=>{});}
 FX.pv=null;}
async function fxFetchPreview(quiet){
 const p=FX.pv;if(!p)return;const v=FX.view;if(!v)return;
 if(quiet&&p.quietBusy)return;if(quiet)p.quietBusy=true;
 const body=document.getElementById('fx-body'),stick=body&&body.scrollTop+body.clientHeight>=body.scrollHeight-48;
 if(!quiet){p.loading=true;p.error='';p.got=0;paintPreview();}
 else{p.keepScroll=body?body.scrollTop:0;p.keepBottom=!!stick;}
 try{
  const media=p.kind==='media';
  const r=await rpc(media?'sftpMediaOpen':'sftpPreview',media
   ?{device:v.device,path:p.path,allowLarge:!!p.allowLarge,token:p.token}
   :{device:v.device,path:p.path,kind:p.kind,tail:!!(p.tail&&p.kind==='text'),allowLarge:!!p.allowLarge,width:fxPdfWidth(),token:p.token},n=>{
   if(FX.pv!==p)return;const got=Number(n);if(!(got>=0))return;p.got=got;fxPaintReadProgress();});
  if(FX.pv!==p)return;
  p.r=r;p.loading=false;p.quietBusy=false;p.cached=!!r.cached;p.key=r.key;p.size=r.size||p.size;p.mtime=r.mtime||p.mtime;
  p.error='';p.prepared=false;fxPrepare(r);
  fxPreviewCache(fxPreviewKey(v.device,p.path,{mtime:p.mtime,size:p.size},p.kind,p.tail),r);
  fxApplyPreview(r,quiet);
  fxTailStart();
 }catch(err){
  if(FX.pv!==p)return;p.quietBusy=false;p.loading=false;if(quiet){if(err.code!=='preview_cancelled')toast('最新内容没读到：'+(err.message||err));return;}
  p.error=err.message||String(err);
  if(err.code==='media_large'&&err.info?.hard){paintPreview();return;}
  if(err.code==='media_large'){
   paintPreview();
   confirmAction('缓存 '+fileSize(p.size)+' 后播放？','「'+p.name+'」不小，要先把整份缓存到手机的 App 私有空间，再用 App 内的播放器播放（不会放进「下载」，也不边下边播）。用流量的话会花一些。','缓存并播放',()=>{p.allowLarge=true;p.error='';fxFetchPreview();});
   return;}
  if(err.code==='preview_large'){
   paintPreview();
   confirmAction('预览 '+fileSize(p.size)+' 的文件？','「'+p.name+'」不小，预览要先把整份读到手机的 App 缓存里（不会放进「下载」）。用流量的话会花一些。','仍然预览',()=>{p.allowLarge=true;p.error='';fxFetchPreview();});
   return;}
  paintPreview();}
}
function fxApplyPreview(r,quiet){
 const p=FX.pv;if(!p)return;
 const body=document.getElementById('fx-body'),top=body?body.scrollTop:0;
 const keep=p.keepScroll,stick=p.keepBottom;
 paintPreview();
 const b=document.getElementById('fx-body');if(!b)return;
 if(quiet){if(stick)b.scrollTop=b.scrollHeight;else b.scrollTop=Math.min(keep||0,Math.max(0,b.scrollHeight-b.clientHeight));}
 else if(p.slide&&!fxReduced())b.classList.add(p.slide>0?'fx-in-left':'fx-in-right');
 else if(top)b.scrollTop=0;
}
function fxPrepare(r){
 const p=FX.pv;if(!p)return;
 p.rawText=typeof r.text==='string'?r.text:'';
 p.encoding=r.encoding||'';p.binary=!!r.binary;p.truncated=!!r.truncated;p.tailResult=!!r.tail;
 p.pages=r.page?.pages||p.pages||0;
 p.media=r.media||p.media||null;p.poster=typeof r.poster==='string'?r.poster:(p.poster||'');
 p.prettyText='';p.tableData=null;p.totalLines=0;p.lines=[];p.imgError='';p.pdfError='';
 if(r.page){p.pdfFirst=r.page;const got=p.pdfData.get(r.page.index||0)||{};if(!got.lo){got.lo=r.page;p.pdfData.set(r.page.index||0,got);}}
 if(!p.prepared){
  if(FX_MD.test(p.name))p.mode='rendered';
  else if(FX_CSV.test(p.name))p.mode='table';
  else if(FX_JSON.test(p.name))p.mode='pretty';
  else p.mode='source';
  p.prepared=true;}
 fxBuildText();
}
function fxBuildText(){
 const p=FX.pv;if(!p)return;let text=p.rawText||'';
 if(p.kind==='text'&&FX_JSON.test(p.name)){
  if(p.mode==='pretty'&&!p.prettyText&&text.length<=2_000_000){try{p.prettyText=JSON.stringify(JSON.parse(text),null,2);}catch(_){p.prettyText='';}}
  if(p.mode==='pretty'&&p.prettyText)text=p.prettyText;}
 if(p.kind==='text'&&FX_CSV.test(p.name)&&p.mode==='table'&&!p.tableData&&text.length<=2_000_000)p.tableData=fxParseCsv(text,p.name.toLowerCase().endsWith('.tsv')?'\t':',');
 const lines=text.split('\n');p.totalLines=lines.length;p.lines=lines.slice(0,FX_MAX_LINES);p.rawLines=lines;
}
function fxParseCsv(text,sep){
 const rows=[];let row=[],cell='',q=false;
 for(let i=0;i<text.length&&rows.length<=2000;i++){const c=text[i];
  if(q){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else q=false;}else cell+=c;}
  else if(c==='"')q=true;
  else if(c===sep){row.push(cell);cell='';}
  else if(c==='\n'){row.push(cell);rows.push(row);row=[];cell='';}
  else if(c!=='\r')cell+=c;}
 if(cell!==''||row.length){row.push(cell);rows.push(row);}
 return rows.map(r=>r.slice(0,50));}
// Pages are rendered at the screen's real pixel density for fitting the width, which is sharp at
// 100% and keeps each decoded page around 2 MP. Past FX_PDF_HI zoom the pages on screen are swapped
// for a 2.5× render (~10 MP each), so only those get it. Native applies its own pixel ceiling.
function fxPdfWidth(hi){
 const body=document.getElementById('fx-body');const css=Math.max(240,(body?.clientWidth||innerWidth)-2*FX_PDF_GAP);
 const dpr=Math.max(1,Math.min(4,window.devicePixelRatio||1));
 return Math.min(3000,Math.max(1200,Math.round(css*dpr*(hi?2.5:1))));
}

// ─── Preview screen ─────────────────────────────────────────────────────────
function renderPreviewView(){
 const p=FX.pv,v=FX.view;if(!p||!v)return;
 const root=shell();root.classList.add('files-shell','fx-shell');
 const head=el('header','chat-head fx-head');head.append(ib('back','返回文件列表',()=>filesBack()));
 const ic=fileBadge(p.name);ic.classList.add('fx-head-badge');const k=fxKindClass(p.name);if(k)ic.classList.add(k);head.append(ic);
 const id=el('div','grow chat-id');id.append(el('h2','fx-title',p.name),el('small','fx-sub',fxSub(p)));head.append(id);
 head.append(ib('more',p.name+' 的操作',()=>fxSheet(p.entry)));root.append(head);
 const tools=el('div','fx-tools');tools.id='fx-tools';root.append(tools);
 const find=el('div','fx-find hidden');find.id='fx-find';
 const input=el('input','');input.type='search';input.placeholder='在文件里查找';input.setAttribute('aria-label','在文件里查找');input.enterKeyHint='search';
 const count=el('span','fx-find-count','0');count.id='fx-find-count';count.setAttribute('aria-live','polite');
 const prev=ib('back','上一个匹配',()=>fxFindGo(-1));const next=ib('chevron','下一个匹配',()=>fxFindGo(1));
 const close=ib('x','关闭查找',()=>fxFindClose());
 find.append(input,count,prev,next,close);root.append(find);
 input.oninput=()=>{clearTimeout(fxFindTimer);fxFindTimer=setTimeout(fxRunSearch,120);};
 input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();fxFindGo(e.shiftKey?-1:1);}else if(e.key==='Escape')fxFindClose();};
 const body=el('div','fx-body'+(p.kind==='image'||p.kind==='pdf'?' fx-view-body':''));body.id='fx-body';body.dataset.pv=p.token;root.append(body);
 if(p.kind!=='image'&&p.kind!=='pdf'&&p.kind!=='office')fxBindSwipe(body);
 const foot=el('div','fx-foot');foot.id='fx-foot';root.append(foot);
 paintPreview();
}
let fxFindTimer=0;
function fxSub(p){const parts=[fxKindLabel(p.entry)];if(p.size>0)parts.push(fileSize(p.size));if(p.mtime)parts.push(relative(p.mtime));
 if(p.media?.durationMs>0)parts.push(fxDuration(p.media.durationMs));
 if(p.media?.width>0&&p.media?.height>0)parts.push(p.media.width+'×'+p.media.height);
 if(p.kind==='office'&&p.of){if(p.of.kind==='xlsx'&&p.of.sheets?.length)parts.push(p.of.sheets.length+' 个工作表');
  if(p.of.kind==='pptx'&&p.of.slides)parts.push(p.of.slides+' 张幻灯片');}
 if(p.encoding)parts.push(p.encoding);if(p.cached)parts.push('已缓存');return parts.join(' · ');}

function paintPreview(){
 const p=FX.pv;if(!p)return;
 const tools=document.getElementById('fx-tools');if(!tools){if(document.getElementById('files-list'))renderPreviewView();return;}
 paintPreviewTools(tools);
 const sub=document.querySelector('.fx-sub');if(sub)sub.textContent=fxSub(p);
 const body=document.getElementById('fx-body');if(!body)return;
 const scroll=body.scrollTop;
 const viewer=p.kind==='image'||p.kind==='pdf';
 body.classList.toggle('fx-view-body',viewer);
 body.replaceChildren();
 if(p.kind==='office'&&typeof officePaint==='function')officePaint(body);
 else if(p.loading&&!p.r)body.append(fxReadBox());
 else if(p.error&&!p.r)body.append(fxPreviewError());
 else if(p.kind==='image'&&p.r&&!p.binary&&p.r.url)fxImageBody(body);
 else if(p.kind==='media'&&p.r&&!p.binary)fxMediaBody(body);
 else if(p.kind==='pdf'&&p.r&&!p.binary&&(p.pdfError||p.r.page))fxPdfBody(body); else if(p.kind==='text'&&p.r&&!p.binary)fxTextBody(body);
 else fxFallbackBody(body);
 if(p.keepScroll!==undefined){body.scrollTop=p.keepScroll;p.keepScroll=undefined;}
 else if(scroll&&p.kind!=='image')body.scrollTop=Math.min(scroll,Math.max(0,body.scrollHeight-body.clientHeight));
 paintPreviewFoot();
}
function paintPreviewTools(n){
 const p=FX.pv;if(!n)return;n.replaceChildren();
 if(p.kind==='office'&&typeof officePaintTools==='function'){officePaintTools(n);return;}
 const chip=(label,fn,name,on,aria)=>{const b=btn(label,'pill fx-chip'+(on?' active':''),fn,name);if(aria)b.setAttribute('aria-label',aria);b.setAttribute('aria-pressed',on?'true':'false');return b;};
 if(p.kind==='text'&&p.r&&!p.binary){
  n.append(chip('查找',fxFindOpen,'search',false,'在文件里查找'));
  n.append(chip('换行',()=>fxToggleWrap(),'fWrap',p.wrap,'自动换行'));
  if(fxCanTail(p))n.append(chip(p.tail?'跟随中':'跟随日志',()=>fxToggleTail(),'refresh',p.tail,'跟随日志末尾'));
  if(FX_MD.test(p.name))n.append(chip(p.mode==='rendered'?'源码':'预览',()=>fxToggleMode('rendered'),'file',p.mode==='rendered'));
  if(FX_JSON.test(p.name))n.append(chip(p.mode==='pretty'?'原始':'格式化',()=>fxToggleMode('pretty'),'fSort',p.mode==='pretty'));
  if(FX_CSV.test(p.name))n.append(chip(p.mode==='table'?'源码':'表格',()=>fxToggleMode('table'),'fSort',p.mode==='table'));
 }
 if(p.kind==='image'){
  n.append(chip('−',()=>fxViewerZoomBy(p.imgView,.8),'fMinus',false,'缩小'));
  n.append(chip('+',()=>fxViewerZoomBy(p.imgView,1.25),'plus',false,'放大'));
  const pct=el('span','pill fx-chip-static fx-zoom-pct','100%');pct.id='fx-zoom-pct';n.append(pct);
  n.append(chip('适应',()=>fxViewerFit(p.imgView),'fFit',false,'适应屏幕'));
  n.append(chip('1:1',()=>fxViewerOne(p.imgView),'fSelect',false,'按原像素显示'));
  n.append(chip('旋转',()=>fxViewerRotate(p.imgView),'refresh',false,'旋转 90 度'));
 }
 if(p.kind==='pdf'){
  // 100% is the page width fitted to the screen, the way a phone document viewer opens.
  n.append(chip('−',()=>fxPdfZoom(p,p.pdfZoom/1.25),'fMinus',false,'缩小'));
  n.append(chip('+',()=>fxPdfZoom(p,p.pdfZoom*1.25),'plus',false,'放大'));
  const pct=el('span','pill fx-chip-static fx-zoom-pct',Math.round(p.pdfZoom*100)+'%');pct.id='fx-zoom-pct';n.append(pct);
  n.append(chip('适应',()=>fxPdfZoom(p,1),'fFit',false,'适应屏幕'));
 }
 if(p.kind==='media'&&p.media?.durationMs>0)n.append(el('span','pill fx-chip-static',fxDuration(p.media.durationMs)));
 n.append(chip('下载',()=>fileDownload(p.entry,false),'download',false,'下载到手机'));
 if((p.kind==='image'||p.kind==='pdf')&&p.r?.key&&p.r?.complete){
  n.append(chip('分享',()=>fxPreviewOpen(true),'fShare',false,'分享'));n.append(chip('打开',()=>fxPreviewOpen(false),'file',false,'用其他应用打开'));}
 if(p.cached)n.append(el('span','pill fx-cache-chip',p.fromCache?'已缓存':'系统缓存'));
 if(p.mtime)n.append(el('span','pill fx-chip-static',relative(p.mtime)));
 if(p.encoding)n.append(el('span','pill fx-chip-static',p.encoding));
 if(filesSorted(FX.view.list?.entries||[]).filter(e=>!fileIsDir(e)).length>1){
  n.append(chip('上一个',()=>fxStepFile(-1),'back',false,'上一个文件'));
  n.append(chip('下一个',()=>fxStepFile(1),'chevron',false,'下一个文件'));}
}
function fxReadBox(){
 const p=FX.pv,box=el('div','fx-read');box.id='fx-read';box.setAttribute('role','status');
 const row=el('div','fx-read-row');row.append(el('span','spinner'),el('span','grow',p.kind==='media'?'正在缓存到手机…':'正在从电脑上读取…'));
 const got=el('span','fx-read-bytes',p.size>0?fileSize(p.got||0)+' / '+fileSize(p.size):'');got.dataset.got='1';row.append(got);box.append(row);
 const bar=el('span','files-progress fx-read-bar');bar.setAttribute('role','progressbar');bar.setAttribute('aria-valuemin','0');bar.setAttribute('aria-valuemax',String(p.size||0));bar.setAttribute('aria-valuenow',String(p.got||0));bar.setAttribute('aria-label','读取进度');
 const fill=el('span','');fill.style.width=(p.size>0?Math.min(100,(p.got||0)*100/p.size):0)+'%';bar.append(fill);box.append(bar);
 if(p.cached)box.append(el('p','fine',p.kind==='media'?'缓存里已有完整副本，马上就能播放。':'这是缓存里的副本，马上就能看。'));
 return box;}
function fxPaintReadProgress(){
 const p=FX.pv;if(!p)return;const box=document.getElementById('fx-read');if(!box)return;
 const got=box.querySelector('[data-got]');if(got)got.textContent=p.size>0?fileSize(p.got||0)+' / '+fileSize(p.size):fileSize(p.got||0);
 const bar=box.querySelector('.files-progress');if(bar){const pct=p.size>0?Math.min(100,(p.got||0)*100/p.size):0;bar.setAttribute('aria-valuenow',String(p.got||0));const f=bar.firstChild;if(f)f.style.width=pct+'%';}}
function fxPreviewError(){
 const p=FX.pv,box=el('div','fx-fallback');box.setAttribute('role','alert');
 const ic=el('div','fx-fallback-icon alert');ic.append(icon('alert'));
 box.append(ic,el('h2','','打不开这个文件'),el('p','fx-fallback-why',p.error));
 const acts=el('div','fx-fallback-acts');acts.append(btn('重试','primary',()=>fxFetchPreview(),'refresh'),btn('下载到手机','secondary',()=>fileDownload(p.entry,false),'download'));
 acts.append(btn('复制路径','secondary',()=>copyText(p.path),'copy'));
 box.append(acts);return box;}
function fxFallbackBody(body){
 const p=FX.pv,box=el('div','fx-fallback');
 const ic=el('div','fx-fallback-icon');ic.append(icon(p.binary?'file':'file'));box.append(ic);
 box.append(el('h2','',p.binary?'这是二进制文件':'这个文件在这里不能直接看'));
 box.append(el('p','fx-fallback-why',p.binary?'内容不是文本，手机上不强行显示。可以下载后用其他应用打开。':(p.error||'这种文件没有可用的预览方式。可以下载或分享到其他应用。')));
 const meta=el('div','fx-facts');for(const [k,v] of [['大小',p.size>0?fileSize(p.size):'未知'],['修改',p.mtime?time(p.mtime):'未知'],['类型',p.r?.mime||'未知']]){const row=el('div','fx-fact');row.append(el('span','',k),el('span','',v));meta.append(row);}box.append(meta);
 const acts=el('div','fx-fallback-acts');
 const complete=!!(p.r?.key&&p.r?.complete);
 if(complete){acts.append(btn('用其他应用打开','primary',()=>fxPreviewOpen(false),'file'));acts.append(btn('分享','secondary',()=>fxPreviewOpen(true),'fShare'));}
 acts.append(btn('下载到手机','secondary',()=>fileDownload(p.entry,false),'download'));
 acts.append(btn('另存为…','secondary',()=>fileDownload(p.entry,true),'download'));
 acts.append(btn('复制路径','secondary',()=>copyText(p.path),'copy'));
 if(!complete&&p.r?.key)acts.append(el('p','fine','只读了一部分；下载完整的文件后才能用其他应用打开或分享。'));
 box.append(acts);body.append(box);}
function fxPreviewOpen(share){const p=FX.pv;if(!p?.r?.key){toast('先等文件读完');return;}rpc(p.kind==='media'?'sftpMediaExternal':'sftpPreviewOpen',{key:p.r.key,share:!!share}).catch(error);}

function fxTextBody(body){
 const p=FX.pv,wrap=el('div','fx-text');
 if(p.mode==='rendered'&&FX_MD.test(p.name)){const md=typeof markdown==='function'?markdown(p.rawText,{fold:false}):el('pre','',p.rawText);md.classList.add('fx-md');wrap.append(md);body.append(wrap,fxTextNotice(p));return;}
 if(p.mode==='table'&&FX_CSV.test(p.name)&&p.tableData){wrap.append(fxCsvTable(p.tableData));body.append(wrap,fxTextNotice(p));return;}
 const code=fxCodeNode();wrap.append(code);body.append(wrap,fxTextNotice(p));}
function fxTextNotice(p){
 const notes=[];
 if(p.tailResult||p.tail)notes.push('日志模式：显示最后 '+fileSize(p.r?.shown||0)+'。');
 else if(p.truncated)notes.push('文件比较大，只读了开头 '+fileSize(p.r?.shown||0)+'；下载后可看全文。');
 if(p.totalLines>FX_MAX_LINES)notes.push('只显示前 '+FX_MAX_LINES+' 行（共 '+p.totalLines+' 行）。');
 const box=el('div','fx-notices');notes.forEach(t=>box.append(el('p','fx-notice',t)));
 if(p.mode!=='rendered')box.append(el('p','fx-notice','只读预览，不会执行文件里的任何代码。'));
 return box;}
function fxCodeNode(){
 const p=FX.pv,box=el('div','fx-code'+(p.wrap?' wrap':''));
 const lang=fxLang(p.name),q=p.q;
 const shown=Math.min(p.lines.length,FX_MAX_LINES);
 for(let i=0;i<shown;i++){
  const row=el('div','fx-line');row.dataset.line=String(i+1);if(q&&p.hitSet?.has(i))row.classList.add('hit');if(q&&p.hits[p.hit]===i)row.classList.add('current');
  row.append(el('span','fx-ln',String(i+1)));
  const src=el('span','fx-src');
  if(q)fxMarked(src,p.lines[i],q);
  else if(lang&&i<FX_SYNTAX_LINES)src.append(fxTokenize(p.lines[i],lang));
  else src.textContent=p.lines[i];
  row.append(src);box.append(row);}
 return box;}
function fxCsvTable(rows){
 const wrap=el('div','fx-table-wrap');const table=el('table','fx-table');
 if(rows.length){const thead=el('thead'),hr=el('tr');rows[0].forEach(c=>hr.append(el('th','',c)));thead.append(hr);table.append(thead);}
 const tb=el('tbody');rows.slice(1).forEach(r=>{const tr=el('tr');r.forEach(c=>tr.append(el('td','',c)));tb.append(tr);});table.append(tb);wrap.append(table);
 const p=FX.pv,note=el('p','fx-notice',rows.length-1+' 行 · '+Math.max(0,(rows[0]||[]).length)+' 列'+(rows.length>2000?'（只显示前 2000 行）':''));wrap.append(note);return wrap;}
function fxToggleWrap(){const p=FX.pv;if(!p)return;p.wrap=!p.wrap;const c=document.querySelector('#fx-body .fx-code');if(c)c.classList.toggle('wrap',p.wrap);paintPreviewTools(document.getElementById('fx-tools'));}
function fxToggleMode(mode){
 const p=FX.pv;if(!p)return;
 if(mode==='rendered')p.mode=p.mode==='rendered'?'source':'rendered';
 else if(mode==='pretty')p.mode=p.mode==='pretty'?'raw':'pretty';
 else if(mode==='table')p.mode=p.mode==='table'?'source':'table';
 fxBuildText();paintPreview();}
function fxToggleTail(){const p=FX.pv;if(!p)return;p.tail=!p.tail;p.q='';p.hit=-1;p.hits=[];fxFindClose();fxFetchPreview();}
function fxCanTail(p){return p.kind==='text'&&(FX_LOG.test(p.name)||(p.size||0)>200_000);}
let fxTailTimer=0;
function fxStopTail(){clearInterval(fxTailTimer);fxTailTimer=0;}
function fxTailStart(){
 fxStopTail();const p=FX.pv;if(!p||!p.tail)return;
 fxTailTimer=setInterval(()=>{
  const cur=FX.pv;if(!cur||!cur.tail||cur.loading||!S.active||!FX.view)return;
  const body=document.getElementById('fx-body');cur.keepBottom=!!body&&body.scrollTop+body.clientHeight>=body.scrollHeight-48;
  fxFetchPreview(true);},3000);}

// ─── Text highlighting (safe: text nodes and spans only) ────────────────────
const FX_KW={
 c:'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false NULL include define',
 js:'await async break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield true false null undefined interface type enum implements public private protected readonly as',
 py:'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None self',
 sh:'case do done elif else esac fi for function if in select then until while time export local readonly set unset echo cd return exit',
 go:'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil',
 rs:'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
 java:'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null',
 rb:'alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield',
 php:'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile eval exit extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield true false null',
 swift:'associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch false is nil super self Self throw throws true try',
 sql:'select from where insert into values update set delete create table drop alter add index on join left right inner outer group by order having limit offset and or not null is in like as distinct union all case when then else end primary key foreign references'
};
const FX_RULES={};
function fxLang(name){
 const x=(name.split('.').pop()||'').toLowerCase();
 if(['html','htm','xhtml','xml','svg','vue','svelte'].includes(x))return 'html';
 if(['css','scss','sass','less'].includes(x))return 'css';
 if(x==='json'||x==='jsonc'||x==='json5'||x==='geojson')return 'json';
 if(['py','pyw'].includes(x))return 'py';
 if(['sh','bash','zsh','fish','bashrc','zshrc','profile'].includes(x)||FX_LOG.test(name))return 'sh';
 if(['go'].includes(x))return 'go';if(['rs'].includes(x))return 'rs';
 if(['java','kt','kts','scala','groovy'].includes(x))return 'java';
 if(['rb'].includes(x))return 'rb';if(['php'].includes(x))return 'php';
 if(['swift'].includes(x))return 'swift';if(['sql'].includes(x))return 'sql';
 if(['yaml','yml','toml','ini','conf'].includes(x))return 'yaml';
 if(['js','jsx','ts','tsx','mjs','cjs'].includes(x))return 'js';
 if(FX_MD.test(name))return 'md';
 if(['c','h','cc','cpp','cxx','hpp','hh','m','mm','cs','mjs'].includes(x))return 'c';
 return 'c';}
function fxRules(lang){
 if(FX_RULES[lang])return FX_RULES[lang];
 let re;
 const kw=(FX_KW[lang]||FX_KW.c).trim().split(/\s+/).map(w=>w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
 if(lang==='json')re=/(?<key>"(?:\\.|[^"\\])*"(?=\s*:))|(?<str>"(?:\\.|[^"\\])*")|(?<num>-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(?<kw>\b(?:true|false|null)\b)/g;
 else if(lang==='html')re=/(?<com><!--[\s\S]*?-->)|(?<tag><\/?[A-Za-z][\w:-]*)|(?<attr>[A-Za-z_:][\w:.-]*(?=\s*=))|(?<str>"[^"]*"|'[^']*')/g;
 else if(lang==='css')re=/(?<com>\/\*[\s\S]*?\*\/)|(?<str>"[^"]*"|'[^']*')|(?<num>\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg)?\b)|(?<kw>@[A-Za-z-]+|\b(?:important|inherit|initial|none|flex|grid|block|inline|absolute|relative|fixed|sticky)\b)/g;
 else{
  const com=['py','sh','rb','yaml'].includes(lang)?'#.*$':'//.*$';
  const md=lang==='md'?'|(?<tag>^#{1,6}[^\\n]*)|(?<str>`[^`\\n]*`)':'';
  re=new RegExp('(?<com>'+com+')|(?<str>"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\')|(?<num>\\b(?:0[xX][0-9a-fA-F]+|\\d+(?:\\.\\d+)?)\\b)|(?<kw>\\b(?:'+kw+')\\b)'+md,'gm');
 }
 FX_RULES[lang]=re;return re;}
function fxTokenize(line,lang){
 const frag=document.createDocumentFragment(),re=fxRules(lang);if(!re){frag.append(document.createTextNode(line));return frag;}
 re.lastIndex=0;let last=0,m;
 while((m=re.exec(line))){
  if(!m[0]){re.lastIndex++;continue;}
  if(m.index>last)frag.append(document.createTextNode(line.slice(last,m.index)));
  const g=m.groups||{};const cls=g.com?'com':g.str?'str':g.num?'num':g.key?'key':g.kw?'kw':g.tag?'tag':g.attr?'attr':'';
  const sp=el('span','fx-tok'+(cls?' '+cls:''));sp.textContent=m[0];frag.append(sp);
  last=m.index+m[0].length;
 }
 if(last<line.length)frag.append(document.createTextNode(line.slice(last)));
 return frag;}
function fxMarked(node,line,q){
 const low=line.toLowerCase(),needle=q.toLowerCase();let at=0;
 while(at<line.length){const i=low.indexOf(needle,at);if(i<0){node.append(document.createTextNode(line.slice(at)));break;}
  if(i>at)node.append(document.createTextNode(line.slice(at,i)));
  node.append(el('mark','fx-hit',line.slice(i,i+q.length)));at=i+q.length;}
}
function fxRunSearch(){
 const p=FX.pv;if(!p)return;const input=document.querySelector('#fx-find input');p.q=(input?.value||'').trim();
 p.hits=[];p.hit=-1;
 if(p.q){const ql=p.q.toLowerCase();const n=Math.min(p.lines.length,FX_SEARCH_LINES);
  for(let i=0;i<n;i++){if(p.lines[i].toLowerCase().includes(ql))p.hits.push(i);}}
 p.hitSet=new Set(p.hits);
 if(p.q&&p.mode!=='source'&&(FX_MD.test(p.name)||FX_CSV.test(p.name)||FX_JSON.test(p.name))){p.findRestore=p.mode;p.mode='source';fxBuildText();paintPreviewTools(document.getElementById('fx-tools'));}
 const body=document.getElementById('fx-body');if(body){body.replaceChildren();const wrap=el('div','fx-text');wrap.append(fxCodeNode());body.append(wrap,fxTextNotice(p));}
 if(p.hits.length){p.hit=0;fxFindCount();requestAnimationFrame(()=>fxFindScroll());}
 else fxFindCount();}
function fxFindCount(){const n=document.getElementById('fx-find-count');if(!n)return;const p=FX.pv;n.textContent=p&&p.q?(p.hits.length?((p.hit+1)+' / '+p.hits.length):'没有匹配'):'0';}
function fxFindScroll(){const p=FX.pv,line=p?.hits[p?.hit];if(line===undefined)return;const n=document.querySelector('#fx-body .fx-line[data-line="'+(line+1)+'"]');if(!n)return;
 document.querySelectorAll('#fx-body .fx-line.current').forEach(x=>x.classList.remove('current'));n.classList.add('current');n.scrollIntoView({block:'center',behavior:fxReduced()?'auto':'smooth'});}
function fxFindOpen(){const p=FX.pv;if(!p)return;const f=document.getElementById('fx-find');if(!f)return;f.classList.remove('hidden');const input=f.querySelector('input');input.value=p.q||'';input.focus();if(p.q)fxRunSearch();}
function fxFindClose(){const p=FX.pv,f=document.getElementById('fx-find');if(f){f.classList.add('hidden');const input=f.querySelector('input');if(input)input.value='';}
 if(p){p.q='';p.hits=[];p.hit=-1;if(p.findRestore){p.mode=p.findRestore;p.findRestore=null;}fxBuildText();const body=document.getElementById('fx-body');if(body&&p.kind==='text'&&!p.binary){body.replaceChildren();fxTextBody(body);}paintPreviewTools(document.getElementById('fx-tools'));}}
function fxFindGo(dir){const p=FX.pv;if(!p||!p.hits.length)return;p.hit=(p.hit+dir+p.hits.length)%p.hits.length;fxFindCount();fxFindScroll();}

// ─── Viewers: one transform model (fit, pan, rotation, clamp) for images and PDF pages ────────────
function fxViewerMetrics(v){
 if(!v)return false;const r=v.stage.getBoundingClientRect(),cs=getComputedStyle(v.stage);
 // Fit inside the stage's padding, not its border box (the page must not touch the screen edge).
 v.stageW=Math.max(1,r.width-(parseFloat(cs.paddingLeft)||0)-(parseFloat(cs.paddingRight)||0));
 v.stageH=Math.max(1,r.height-(parseFloat(cs.paddingTop)||0)-(parseFloat(cs.paddingBottom)||0));
 const swap=Math.abs(v.rotation%180)===90;const rw=swap?v.naturalH:v.naturalW,rh=swap?v.naturalW:v.naturalH;
 if(!(rw>0&&rh>0))return false;
 v.fit=Math.min(v.stageW/rw,v.stageH/rh);v.min=Math.min(v.fit,1);v.max=Math.max(4,Math.min(8,v.fit*8));return true;
}
function fxViewerClamp(v){
 const r=v.rotation*Math.PI/180,c=Math.abs(Math.cos(r)),s=Math.abs(Math.sin(r));
 const dw=(v.naturalW*c+v.naturalH*s)*v.scale,dh=(v.naturalW*s+v.naturalH*c)*v.scale;
 const mx=Math.max(0,(dw-v.stageW)/2),my=Math.max(0,(dh-v.stageH)/2);
 v.tx=Math.max(-mx,Math.min(mx,v.tx));v.ty=Math.max(-my,Math.min(my,v.ty));
}
function fxViewerApply(v,instant){
 if(!v?.el)return;
 // Zoom by sizing the <img> itself, not with transform:scale(). A scaled 2400 px page is a huge
 // composited layer that the WebView rasterizes at full size; past its tile budget it simply skips
 // tiles, so the page showed up half-drawn (black blocks). Laid out at display size, it rasterizes
 // only what is on screen at the right sharpness. The transform is left with pan and rotation.
 if(v.img&&v.naturalW>0&&v.naturalH>0){v.img.style.width=(v.naturalW*v.scale)+'px';v.img.style.height=(v.naturalH*v.scale)+'px';}
 v.el.style.transform='translate3d('+v.tx+'px,'+v.ty+'px,0) rotate('+v.rotation+'deg)';
 v.el.style.transition=instant||fxReduced()?'none':'transform .18s var(--ease-out)';
 const pct=document.getElementById('fx-zoom-pct');if(pct)pct.textContent=Math.round(v.scale*100)+'%';
}
function fxViewerFit(v,instant){
 if(!v||!fxViewerMetrics(v))return;v.scale=v.fit;v.tx=0;v.ty=0;fxViewerApply(v,instant);
}
function fxViewerOne(v){if(!v)return;v.scale=1;v.tx=0;v.ty=0;fxViewerClamp(v);fxViewerApply(v);}
function fxViewerZoomAt(v,next,fx,fy){
 if(!v)return;const n=Math.max(v.min??0.05,Math.min(v.max??8,next));
 if(!(n>0)||!isFinite(n))return;
 if(fx!==undefined&&fy!==undefined){const cx=v.stageW/2,cy=v.stageH/2,ratio=n/v.scale;v.tx=(fx-cx)-((fx-cx)-v.tx)*ratio;v.ty=(fy-cy)-((fy-cy)-v.ty)*ratio;}
 v.scale=n;fxViewerClamp(v);fxViewerApply(v,true);
}
function fxViewerZoomBy(v,f){if(!v)return;fxViewerZoomAt(v,v.scale*f);}
function fxViewerRotate(v){
 if(!v)return;const atFit=Math.abs(v.scale-v.fit)<.01;v.rotation=(v.rotation+90)%360;
 if(!fxViewerMetrics(v))return;
 if(atFit){v.scale=v.fit;v.tx=0;v.ty=0;}fxViewerClamp(v);fxViewerApply(v);
}
function fxViewerCycle(v){
 if(!v)return;const levels=[v.fit,Math.min(v.max,v.fit*2),Math.min(v.max,v.fit*4)];
 const next=levels.find(x=>x>v.scale+.01)??v.fit;
 if(next===v.fit){v.scale=v.fit;v.tx=0;v.ty=0;fxViewerApply(v);}else fxViewerZoomAt(v,next);
}
function fxViewerResize(){
 const p=FX.pv;if(!p)return;
 if(p.kind==='pdf'){const d=p.pdfDoc,a=p.pdfAnchor;if(!d)return;fxPdfLayout(p);if(a)fxPdfToAnchor(p,a);fxPdfOnScroll(p);return;}
 const v=p.imgView;if(!v)return;
 const atFit=Math.abs(v.scale-v.fit)<.01;if(!fxViewerMetrics(v))return;
 if(atFit){v.scale=v.fit;v.tx=0;v.ty=0;}else fxViewerClamp(v);
 fxViewerApply(v);
}
let fxViewerResizeTimer=0;
window.addEventListener('resize',()=>{clearTimeout(fxViewerResizeTimer);fxViewerResizeTimer=setTimeout(fxViewerResize,120);});
function fxViewerBind(stage,v,onSwipe){
 const pts=new Map();let down=null,pinch=null,lastTap=0;
 stage.addEventListener('pointerdown',e=>{
  if(e.pointerType==='mouse'&&e.button!==0)return;pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(pts.size===2){const [a,b]=[...pts.values()];pinch={d:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)),scale:v.scale};down=null;return;}
  down={x:e.clientX,y:e.clientY,tx:v.tx,ty:v.ty,moved:0,at:Date.now()};try{stage.setPointerCapture(e.pointerId);}catch(_){}
 });
 stage.addEventListener('pointermove',e=>{
  if(!pts.has(e.pointerId))return;pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(pinch&&pts.size>=2){const [a,b]=[...pts.values()];const d=Math.max(1,Math.hypot(a.x-b.x,a.y-b.y));fxViewerZoomAt(v,pinch.scale*d/pinch.d,(a.x+b.x)/2,(a.y+b.y)/2);return;}
  if(!down)return;const dx=e.clientX-down.x,dy=e.clientY-down.y;down.moved=Math.max(down.moved,Math.abs(dx)+Math.abs(dy));
  if(v.scale>v.fit*1.02){v.tx=down.tx+dx;v.ty=down.ty+dy;fxViewerClamp(v);fxViewerApply(v,true);}
 });
 const end=e=>{
  pts.delete(e.pointerId);
  if(pinch){if(pts.size<2)pinch=null;down=null;return;}
  if(!down)return;const dx=e.clientX-down.x,dy=e.clientY-down.y,moved=down.moved,dur=Date.now()-down.at;down=null;
  if(moved<9&&dur<380){
   const now=Date.now();if(now-lastTap<360){lastTap=0;fxViewerCycle(v);}else lastTap=now;
   return;
  }
  if(v.scale<=v.fit*1.05&&onSwipe&&Math.abs(dx)>64&&Math.abs(dx)>Math.abs(dy)*1.4&&moved>60)onSwipe(dx<0?1:-1);
 };
 stage.addEventListener('pointerup',end);
 stage.addEventListener('pointercancel',e=>{pts.delete(e.pointerId);pinch=null;down=null;});
 stage.addEventListener('wheel',e=>{e.preventDefault();fxViewerZoomAt(v,v.scale*(e.deltaY<0?1.12:.89),e.clientX-stage.getBoundingClientRect().left,e.clientY-stage.getBoundingClientRect().top);},{passive:false});
}

// ─── Images: original URL, pinch / double-tap fit→2×→4×, pan, rotate, fit, 1:1 ───
function fxViewerLoading(stage,text){
 const box=el('div','fx-viewer-status');box.setAttribute('role','status');box.append(el('span','spinner'),el('span','',text));stage.append(box);return box;
}
function fxImageViewerError(p,stage,box){
 p.imgError='图片没有加载出来。';p.imgLoading=false;box.replaceChildren();
 const ic=el('div','fx-viewer-error-icon');ic.append(icon('alert'));box.append(ic,el('p','fx-viewer-error',p.imgError));
 const acts=el('div','fx-viewer-actions');acts.append(btn('重试','primary',()=>fxImageRetry(),'refresh'),btn('下载到手机','secondary',()=>fileDownload(p.entry,false),'download'));
 if(p.r?.complete)acts.append(btn('用其他应用打开','secondary',()=>fxPreviewOpen(false),'file'));
 box.append(acts);box.classList.add('shown');
}
function fxImageRetry(){const p=FX.pv;if(!p?.r?.url)return;p.imgTry++;p.imgError='';p.imgLoading=true;paintPreview();}
function fxImageBody(body){
 const p=FX.pv,stage=el('div','fx-stage');stage.tabIndex=0;stage.setAttribute('role','group');stage.setAttribute('aria-label',p.name+'，可缩放');
 const zoom=el('div','fx-zoom');const img=el('img');img.alt=p.name;img.draggable=false;img.decoding='async';zoom.append(img);stage.append(zoom);
 const v={el:zoom,stage,img,naturalW:0,naturalH:0,rotation:0,scale:1,tx:0,ty:0,fit:1,min:.05,max:4};p.imgView=v;
 const box=fxViewerLoading(stage,'正在载入原图…');p.imgLoading=true;
 img.addEventListener('load',()=>{
  v.naturalW=img.naturalWidth;v.naturalH=img.naturalHeight;fxViewerFit(v,true);box.remove();p.imgLoading=false;p.imgError='';});
 img.addEventListener('error',()=>fxImageViewerError(p,stage,box));
 body.append(stage);
 if(p.r.note)stage.append(el('div','fx-viewer-note',p.r.note));
 fxViewerBind(stage,v,dir=>fxStepFile(dir));
 img.src=p.r.url+(p.imgTry?'?r='+p.imgTry:'');
 if(img.complete&&img.naturalWidth)setTimeout(()=>{if(v.naturalW===0)img.dispatchEvent(new Event('load'));},0);
}

// ─── Video / audio: whole file cached, played by the native PlayerActivity ───
// Nothing here creates a <video>/<audio> element or a media URL: native owns decoding, audio focus,
// headphone unplug, screen-on and the cache pin while playing.
function fxDuration(ms){const s=Math.max(0,Math.round(ms/1000)),h=Math.floor(s/3600),m=Math.floor((s%3600)/60),x=s%60;
 return h?h+':'+String(m).padStart(2,'0')+':'+String(x).padStart(2,'0'):m+':'+String(x).padStart(2,'0');}
function fxMediaBody(body){
 const p=FX.pv,m=p.media||{};
 const card=el('div','fx-media');card.id='fx-media';
 const art=el('div','fx-media-art '+(m.kind==='audio'?'audio':'video'));
 if(p.poster){const img=el('img');img.alt='';img.src=p.poster;art.append(img);}
 else{const g=el('span','fx-media-glyph');g.append(icon(m.kind==='audio'?'music':'video'));art.append(g);}
 const play=btn('','fx-media-play',fxMediaPlay,'play');play.setAttribute('aria-label','播放 '+p.name);play.disabled=!!p.playBusy;art.append(play);
 card.append(art);
 const info=el('div','fx-media-info');
 info.append(el('h2','fx-media-title',m.title||p.name));
 const sub=[m.artist,m.album].filter(Boolean).join(' · ');if(sub)info.append(el('p','fx-media-sub',sub));
 const facts=[];if(m.durationMs>0)facts.push(fxDuration(m.durationMs));if(p.size>0)facts.push(fileSize(p.size));
 if(m.width>0&&m.height>0)facts.push(m.width+'×'+m.height);facts.push(p.r?.cached?'已在手机缓存':'已缓存到手机');
 info.append(el('p','fx-media-meta',facts.join(' · ')));
 if(p.playError)info.append(el('p','fx-media-error',p.playError));
 const acts=el('div','fx-media-acts');
 acts.append(btn('用其他应用打开','secondary small',()=>fxPreviewOpen(false),'file'),btn('分享','secondary small',()=>fxPreviewOpen(true),'fShare'),btn('下载到手机','secondary small',()=>fileDownload(p.entry,false),'download'));
 info.append(acts);card.append(info);body.append(card);
 body.append(el('p','fx-notice','视频和音乐会先完整缓存到手机的 App 私有空间，再由 App 内的播放器播放；不会在网页里播放，也不会边下边播。'));
}
function fxMediaPlay(){
 const p=FX.pv;if(!p?.r?.key||p.playBusy)return;
 p.playBusy=true;p.playError='';paintPreview();
 rpc('sftpMediaPlay',{key:p.r.key}).then(()=>{const q=FX.pv;if(q!==p)return;p.playBusy=false;paintPreview();})
  .catch(e=>{if(FX.pv!==p)return;p.playBusy=false;p.playError=e.message||String(e);paintPreview();});
}

// ─── PDF: every page in one vertical scroll, like a phone's document viewer ───
// Pages are rendered natively one at a time (the WebView never parses a PDF), only near the screen,
// and far-away pages drop their image so a long document stays light. All pages are laid out up front
// from their sizes, so scrolling never jumps. Zoom resizes the pages themselves (no scaled layer, see
// fxViewerApply) around the pinch point; native scrolling does the panning.
const FX_PDF_GAP=8,FX_PDF_ZMIN=.5,FX_PDF_ZMAX=5,FX_PDF_HI=1.4;
function fxPdfAspect(p,i){
 const s=p.r?.sizes?.[i];if(s&&s[0]>0&&s[1]>0)return s[1]/s[0];
 const f=p.pdfFirst;return f&&f.width>0&&f.height>0?f.height/f.width:1.414;
}
function fxPdfBody(body){
 const p=FX.pv,wrap=el('div','fx-pdf');wrap.id='fx-pdf';
 if(p.pdfError){
  const box=el('div','fx-viewer-status shown');box.setAttribute('role','alert');
  const ic=el('div','fx-viewer-error-icon');ic.append(icon('alert'));box.append(ic,el('p','fx-viewer-error',p.pdfError));
  const acts=el('div','fx-viewer-actions');acts.append(btn('重试','primary',()=>fxPdfRetry(),'refresh'),btn('下载到手机','secondary',()=>fileDownload(p.entry,false),'download'));
  if(p.r?.complete)acts.append(btn('用其他应用打开','secondary',()=>fxPreviewOpen(false),'file'));
  box.append(acts);wrap.append(box);body.append(wrap);return;
 }
 const sc=el('div','fx-pdf-scroll');sc.tabIndex=0;sc.setAttribute('role','document');sc.setAttribute('aria-label',p.name+'，共 '+p.pages+' 页，可缩放');
 const doc=el('div','fx-pdf-doc');sc.append(doc);
 const d={sc,doc,pages:[],tops:[],hs:[],w:0,raf:0,goTo:null,goTop:0};
 for(let i=0;i<p.pages;i++){
  const pg=el('div','fx-pdf-page');pg.setAttribute('aria-label','第 '+(i+1)+' 页');
  pg.append(el('div','fx-pdf-ph',String(i+1)));doc.append(pg);d.pages.push({el:pg,img:null,tier:''});
 }
 p.pdfDoc=d;wrap.append(sc);body.append(wrap);
 fxPdfLayout(p);
 if(p.pdfAnchor)fxPdfToAnchor(p,p.pdfAnchor);
 for(const i of p.pdfFail.keys())fxPdfPageError(p,i);
 sc.addEventListener('scroll',()=>fxPdfOnScroll(p),{passive:true});
 fxPdfBindZoom(p,d);
 fxPdfAttach(p);fxPdfPump(p);
}
function fxPdfLayout(p){
 const d=p.pdfDoc;if(!d)return;
 d.w=Math.max(1,Math.round((d.sc.clientWidth-2*FX_PDF_GAP)*p.pdfZoom));let y=FX_PDF_GAP;
 d.pages.forEach((pg,i)=>{const h=Math.max(1,Math.round(d.w*fxPdfAspect(p,i)));d.tops[i]=y;d.hs[i]=h;pg.el.style.width=d.w+'px';pg.el.style.height=h+'px';y+=h+FX_PDF_GAP;});
 const pct=document.getElementById('fx-zoom-pct');if(pct)pct.textContent=Math.round(p.pdfZoom*100)+'%';
}
function fxPdfAt(d,y){let lo=0,hi=d.tops.length-1;while(lo<hi){const m=(lo+hi+1)>>1;if(d.tops[m]<=y)lo=m;else hi=m-1;}return Math.max(0,lo);}
function fxPdfLeft(d){return FX_PDF_GAP+Math.max(0,(d.sc.clientWidth-2*FX_PDF_GAP-d.w)/2);}
// The document point under a screen point, as a page and fractions of it: survives a zoom or resize.
function fxPdfAnchor(p,vx,vy){
 const d=p.pdfDoc,y=d.sc.scrollTop+vy,x=d.sc.scrollLeft+vx,i=fxPdfAt(d,y);
 return {i,fy:(y-d.tops[i])/Math.max(1,d.hs[i]),fx:(x-fxPdfLeft(d))/Math.max(1,d.w),vx,vy};
}
function fxPdfToAnchor(p,a){
 const d=p.pdfDoc;if(!d||!d.pages.length)return;const i=Math.min(a.i,d.pages.length-1);
 d.sc.scrollTop=d.tops[i]+a.fy*d.hs[i]-a.vy;d.sc.scrollLeft=fxPdfLeft(d)+a.fx*d.w-a.vx;
}
function fxPdfZoom(p,z,vx,vy){
 const d=p?.pdfDoc;if(!d)return;z=Math.max(FX_PDF_ZMIN,Math.min(FX_PDF_ZMAX,z));if(!isFinite(z))return;
 if(vx===undefined){vx=d.sc.clientWidth/2;vy=d.sc.clientHeight/2;}
 const a=fxPdfAnchor(p,vx,vy);p.pdfZoom=z;fxPdfLayout(p);fxPdfToAnchor(p,a);fxPdfOnScroll(p);
}
function fxPdfOnScroll(p){
 const d=p.pdfDoc;if(!d||d.raf)return;
 d.raf=requestAnimationFrame(()=>{
  d.raf=0;if(FX.pv!==p||p.pdfDoc!==d)return;const sc=d.sc;
  p.pdfAnchor=fxPdfAnchor(p,0,0);
  // The current page covers the upper third of the screen. A jump to a page that cannot reach the
  // top (the last ones) keeps the page that was asked for until the reader scrolls.
  let cur=fxPdfAt(d,sc.scrollTop+sc.clientHeight/3);
  if(d.goTo!==null){if(Math.abs(sc.scrollTop-d.goTop)<2)cur=d.goTo;else d.goTo=null;}
  if(cur!==p.page){p.page=cur;fxPdfFootSync(p);}
  fxPdfAttach(p);fxPdfPump(p);
 });
}
// Pages from `before` screens above to `after` screens below the visible area.
function fxPdfRange(d,before,after){const sc=d.sc,h=sc.clientHeight;return [fxPdfAt(d,sc.scrollTop-before*h),fxPdfAt(d,sc.scrollTop+h+after*h)];}
function fxPdfAttach(p){
 const d=p.pdfDoc;if(!d)return;const [a,b]=fxPdfRange(d,2,3),hi=p.pdfZoom>FX_PDF_HI;
 d.pages.forEach((pg,i)=>{
  if(i<a||i>b){if(pg.img){pg.el.querySelectorAll('img').forEach(x=>x.remove());pg.img=null;pg.tier='';}return;}
  const got=p.pdfData.get(i);if(!got)return;
  const tier=hi&&got.hi?'hi':got.lo?'lo':got.hi?'hi':'';if(!tier||pg.tier===tier)return;
  // The new image goes over the old one, which leaves only once the new one is decoded (no flash).
  const img=el('img');img.alt=p.name+' 第 '+(i+1)+' 页';img.decoding='async';img.draggable=false;
  img.onload=()=>{if(pg.img===img)pg.el.querySelectorAll('img').forEach(x=>{if(x!==img)x.remove();});};
  img.onerror=()=>{
   if(pg.img!==img)return;img.remove();pg.img=null;pg.tier='';delete got[tier];
   // A cached page file can be pruned natively; ask again once, then show the page's own error.
   const n=(p.pdfMiss.get(i)||0)+1;p.pdfMiss.set(i,n);
   if(n>2){p.pdfFail.set(i,'页面图片没有加载出来');fxPdfPageError(p,i);}else fxPdfPump(p);
  };
  img.src=got[tier].url;pg.el.append(img);pg.img=img;pg.tier=tier;
 });
}
function fxPdfPump(p){
 const d=p.pdfDoc;if(!d||p.pdfBusy||FX.pv!==p||!p.r?.key)return;
 const [a,b]=fxPdfRange(d,1,2),[va,vb]=fxPdfRange(d,0,0);
 const order=[];for(let i=a;i<=b;i++)order.push(i);order.sort((x,y)=>Math.abs(x-p.page)-Math.abs(y-p.page));
 let job=null;
 for(const i of order){const got=p.pdfData.get(i);if(!p.pdfFail.has(i)&&!got?.lo&&!got?.hi){job={i,tier:'lo'};break;}}
 if(!job&&p.pdfZoom>FX_PDF_HI)for(let i=va;i<=vb;i++){const got=p.pdfData.get(i);if(got&&!got.hi&&!got.noHi&&!p.pdfFail.has(i)){job={i,tier:'hi'};break;}}
 if(!job)return;
 p.pdfBusy=true;
 rpc('sftpPreviewPage',{key:p.r.key,page:job.i,width:fxPdfWidth(job.tier==='hi')}).then(r=>{
  if(FX.pv!==p)return;const got=p.pdfData.get(job.i)||{};got[job.tier]=r;p.pdfData.set(job.i,got);
  if(r.note&&!p.pdfNote){p.pdfNote=r.note;paintPreviewFoot();}
 }).catch(e=>{
  if(FX.pv!==p)return;
  if(e?.code==='preview_gone'){p.pdfError=e.message||String(e);p.pdfBusy=false;paintPreview();return;}
  if(job.tier==='hi'){const got=p.pdfData.get(job.i);if(got)got.noHi=true;return;}
  p.pdfFail.set(job.i,e?.message||String(e));fxPdfPageError(p,job.i);
 }).finally(()=>{if(FX.pv!==p)return;p.pdfBusy=false;fxPdfAttach(p);fxPdfPump(p);});
}
function fxPdfPageError(p,i){
 const pg=p.pdfDoc?.pages[i];if(!pg)return;const ph=pg.el.querySelector('.fx-pdf-ph');if(!ph)return;
 ph.classList.add('err');
 ph.replaceChildren(el('span','','第 '+(i+1)+' 页没渲染出来'),btn('重试','secondary small',()=>{
  p.pdfFail.delete(i);p.pdfMiss.delete(i);ph.classList.remove('err');ph.replaceChildren(String(i+1));fxPdfPump(p);},'refresh'));
}
function fxPdfBindZoom(p,d){
 const sc=d.sc;let pinch=null,want=null,raf=0,tap=null,lastTap=0;
 const dist=t=>Math.max(1,Math.hypot(t[0].clientX-t[1].clientX,t[0].clientY-t[1].clientY));
 sc.addEventListener('touchstart',e=>{if(e.touches.length===2){pinch={d:dist(e.touches),z:p.pdfZoom};tap=null;}},{passive:true});
 sc.addEventListener('touchmove',e=>{
  if(!pinch||e.touches.length<2)return;if(e.cancelable)e.preventDefault();
  const r=sc.getBoundingClientRect(),t=e.touches;
  want={z:pinch.z*dist(t)/pinch.d,x:(t[0].clientX+t[1].clientX)/2-r.left,y:(t[0].clientY+t[1].clientY)/2-r.top};
  if(!raf)raf=requestAnimationFrame(()=>{raf=0;if(want&&p.pdfDoc===d)fxPdfZoom(p,want.z,want.x,want.y);});
 },{passive:false});
 sc.addEventListener('touchend',e=>{if(e.touches.length<2)pinch=null;});
 sc.addEventListener('touchcancel',()=>{pinch=null;});
 // Double tap: fitted width ↔ 2× at the tapped point.
 sc.addEventListener('pointerdown',e=>{if(e.isPrimary)tap={x:e.clientX,y:e.clientY,at:Date.now()};});
 sc.addEventListener('pointercancel',()=>{tap=null;});
 sc.addEventListener('pointerup',e=>{
  if(!tap||!e.isPrimary)return;const moved=Math.abs(e.clientX-tap.x)+Math.abs(e.clientY-tap.y),dur=Date.now()-tap.at;tap=null;
  if(moved>9||dur>380)return;const now=Date.now();
  if(now-lastTap<360){lastTap=0;const r=sc.getBoundingClientRect();fxPdfZoom(p,p.pdfZoom>1.05?1:2,e.clientX-r.left,e.clientY-r.top);}else lastTap=now;
 });
 sc.addEventListener('wheel',e=>{if(!e.ctrlKey)return;e.preventDefault();const r=sc.getBoundingClientRect();fxPdfZoom(p,p.pdfZoom*(e.deltaY<0?1.12:.89),e.clientX-r.left,e.clientY-r.top);},{passive:false});
}
function fxPdfRetry(){const p=FX.pv;if(!p)return;p.pdfError='';p.pdfFail.clear();p.pdfMiss.clear();p.pdfData.clear();p.pdfDoc=null;fxFetchPreview();}
function fxPdfGo(i){
 const p=FX.pv,d=p?.pdfDoc;if(!d||!p.pages)return;const page=Math.max(0,Math.min(p.pages-1,i));
 d.sc.scrollTop=d.tops[page]-FX_PDF_GAP;d.goTo=page;d.goTop=d.sc.scrollTop;
 p.page=page;fxPdfFootSync(p);fxPdfOnScroll(p);
}
function fxPdfFootSync(p){
 const n=document.getElementById('fx-foot');if(!n||FX.pv!==p)return;
 const input=n.querySelector('.fx-page-input');if(input&&document.activeElement!==input)input.value=String(p.page+1);
 const slider=n.querySelector('.fx-page-slider');if(slider)slider.value=String(p.page+1);
 const prev=n.querySelector('[data-pdf="prev"]'),next=n.querySelector('[data-pdf="next"]');
 if(prev)prev.disabled=p.page<=0;if(next)next.disabled=p.page>=p.pages-1;
}
function paintPreviewFoot(){
 const n=document.getElementById('fx-foot');const p=FX.pv;if(!n||!p)return;n.replaceChildren();
 if(p.kind==='office'&&typeof officePaintFoot==='function'){officePaintFoot(n);return;}
 const prev=document.getElementById('fx-find');if(prev&&p.mode!=='source'&&FX_MD.test(p.name)){/* find stays available */}
 if(p.kind==='pdf'&&p.pages){
  const bar=el('div','fx-pager');const prev=btn('上一页','secondary small',()=>fxPdfGo(p.page-1),'back');prev.dataset.pdf='prev';prev.disabled=p.page<=0;bar.append(prev);
  const edit=el('label','fx-page-edit','第 ');
  const input=el('input','fx-page-input');input.type='number';input.min='1';input.max=String(p.pages);input.value=String(p.page+1);
  input.setAttribute('aria-label','页码');input.enterKeyHint='go';
  input.onchange=()=>{const v=Math.round(Number(input.value));if(Number.isFinite(v))fxPdfGo(v-1);else input.value=String(p.page+1);};
  input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();input.blur();}};
  edit.append(input,el('span','',' / '+p.pages+' 页'));bar.append(edit);
  const nx=btn('下一页','secondary small',()=>fxPdfGo(p.page+1),'chevron');nx.dataset.pdf='next';nx.disabled=p.page>=p.pages-1;bar.append(nx);n.append(bar);
  const sliderRow=el('div','fx-slider-row');const slider=el('input','fx-page-slider');slider.type='range';slider.min='1';slider.max=String(p.pages);slider.value=String(p.page+1);
  slider.setAttribute('aria-label','页面滑块');slider.onchange=()=>fxPdfGo(Number(slider.value)-1);sliderRow.append(slider);n.append(sliderRow);
  if(p.pdfNote)n.append(el('p','fine center',p.pdfNote));
 }else if(p.kind==='image'){
  n.append(el('p','fine center','双指缩放 · 双击 2×/4× · 拖动 · 旋转 · 左右滑动切换文件'));
 }else if(p.kind==='media'){
  const many=filesSorted(FX.view?.list?.entries||[]).filter(e=>!fileIsDir(e)).length>1;
  n.append(el('p','fine center','真实进度缓存到手机 · App 内播放'+(many?' · 左右滑动切换文件':''))); }else if(p.kind==='text'&&p.r&&!p.binary){
  const files=filesSorted(FX.view?.list?.entries||[]).filter(e=>!fileIsDir(e));const at=files.findIndex(e=>e.name===p.name);
  if(files.length>1){const bar=el('div','fx-pager');const a=btn('上一个','secondary small',()=>fxStepFile(-1),'back');a.disabled=at<=0;bar.append(a,el('span','fx-page-n',(at+1)+' / '+files.length));const b=btn('下一个','secondary small',()=>fxStepFile(1),'chevron');b.disabled=at<0||at>=files.length-1;bar.append(b);n.append(bar);}
 }else if(p.kind!=='image'){}
}
function fxStepFile(dir){
 const v=FX.view,p=FX.pv;if(!v?.list||!p)return;
 const files=filesSorted(v.list.entries.slice()).filter(e=>!fileIsDir(e));
 const at=files.findIndex(e=>e.name===p.name);if(at<0)return;
 const to=at+dir;if(to<0||to>=files.length){toast(dir<0?'已经是第一个文件了':'已经是最后一个文件了');return;}
 filesPreview(files[to],{slide:dir});
}
// Text/PDF/fallback previews: one horizontal drag moves to the next file in this folder. Vertical
// drags stay scrolling, and a drag that selected text does nothing.
function fxBindSwipe(body){
 let d=null;
 body.addEventListener('pointerdown',e=>{
  if(e.pointerType==='mouse'&&e.button!==0)return;
  if(e.target.closest('button,input,a,textarea'))return;
  d={x:e.clientX,y:e.clientY,at:Date.now()};});
 body.addEventListener('pointerup',e=>{
  if(!d)return;const dx=e.clientX-d.x,dy=e.clientY-d.y;d=null;
  if(Math.abs(dx)>64&&Math.abs(dx)>Math.abs(dy)*1.5&&!(typeof getSelection==='function'&&getSelection().toString().length))fxStepFile(dx<0?1:-1);});
 body.addEventListener('pointercancel',()=>{d=null;});
}

// ─── Transfers ──────────────────────────────────────────────────────────────
function filesTrack(t){if(!t?.id)return;const fresh=!FX.transfers.some(x=>x.id===t.id);FX.states.set(t.id,t.state);const i=FX.transfers.findIndex(x=>x.id===t.id);if(i>=0)FX.transfers[i]=t;else FX.transfers.push(t);FX.want=Date.now();fxSample(t);paintDock();paintTransfers();fxPaintEntry();fxUpdateRows();
 if(fresh&&t.kind==='up'&&FX.view?.list?.path===t.where)paintFiles();
 if(fresh&&t.kind==='down'&&FX.view&&!FX.pv)paintFiles();}
function filesActive(){return FX.transfers.filter(t=>t.state==='running'||t.state==='queued');}
let filesPolling=false;
async function filesPoll(){
 if(filesPolling||S.demo)return;filesPolling=true;FX.lastPoll=Date.now();
 try{const r=await rpc('sftpTransfers',{});const list=r.transfers||[];
  for(const t of list){const was=FX.states.get(t.id);FX.states.set(t.id,t.state);fxSample(t);
   if(!was||was===t.state||(was!=='running'&&was!=='queued'))continue;
   if(t.state==='done'){
    if(t.kind==='down')fxDoneToast(t);
    else{toast('「'+t.name+'」传到电脑上了');if(FX.view?.device===t.device&&filesHere()===t.where)filesLoad(filesHere());}
   } else if(t.state==='failed')toast((t.kind==='down'?'下载':'上传')+'「'+t.name+'」没成功：'+t.error);}
  FX.transfers=list;paintDock();paintTransfers();fxPaintEntry();fxUpdateRows();}
 catch(_){}
 finally{filesPolling=false;}}
// Fast while something moves (or was just started); a slow poll keeps the entry badge and completion
// toasts alive even after leaving 文件; otherwise only when 文件 is open.
setInterval(()=>{if(!S.active||S.demo)return;
 if(FX.view){if(filesActive().length||Date.now()-FX.want<4000)filesPoll();}
 else if(filesActive().length&&Date.now()-FX.lastPoll>1500)filesPoll();},800);
function transferPct(t){return t.size>0?Math.max(0,Math.min(100,Math.floor(t.done*100/t.size))):t.state==='done'?100:0;}
function fxSample(t){
 if(t.state!=='running'&&t.state!=='queued'){FX.meters.delete(t.id);return;}
 const now=Date.now(),m=FX.meters.get(t.id);
 if(!m){FX.meters.set(t.id,{done:t.done,at:now,bps:0});return;}
 const dt=(now-m.at)/1000;
 if(t.done>m.done&&dt>=0.12){const bps=(t.done-m.done)/dt;m.bps=m.bps?m.bps*.55+bps*.45:bps;}
 if(t.done<m.done)m.bps=0;
 m.done=t.done;m.at=now;}
function fxRateText(t){if(t.phase==='verify')return '正在核对…';const m=FX.meters.get(t.id);if(!m||!m.bps||t.state!=='running')return '';return fxSpeed(m.bps);}
function fxSpeed(n){if(!(n>0))return '';if(n<1000)return Math.round(n)+' B/s';if(n<1e6)return (n/1e3).toFixed(n<1e4?1:0)+' KB/s';return (n/1e6).toFixed(1)+' MB/s';}
function fxEta(t){if(t.phase==='verify'||t.state!=='running'||!t.size)return '';const m=FX.meters.get(t.id);if(!m||!m.bps)return '';const left=(t.size-t.done)/m.bps;if(left<1)return '马上完成';if(left<60)return '还剩 '+Math.ceil(left)+' 秒';if(left<3600)return '还剩 '+Math.ceil(left/60)+' 分';return '还剩 '+Math.ceil(left/3600)+' 小时';}
function fxPhaseText(t){
 if(t.state==='queued')return '排队中';
 if(t.state==='running')return t.phase==='verify'?'正在核对…':'传输中';
 if(t.state==='done')return '完成';
 if(t.state==='failed')return '失败';
 if(t.state==='cancelled')return '已取消';
 return t.state;}
function fxDoneToast(t){
 const text=t.kind==='down'?'「'+t.name+'」下载好了，在'+t.where:'「'+t.name+'」传到电脑上了';
 const acts=[];if(t.canOpen){acts.push(['打开',()=>rpc('sftpOpen',{transfer:t.id}).catch(error)]);acts.push(['分享',()=>rpc('sftpOpen',{transfer:t.id,share:true}).catch(error)]);}
 fxActionToast(text,acts);}
// A toast that can carry 打开 / 分享. app.js's plain toast clears these children again.
function fxActionToast(text,actions){
 const n=document.getElementById('toast');if(!n){toast(text);return;}
 toastSpot(n);n.replaceChildren(el('span','toast-text',text));
 if(actions.length){n.classList.add('with-actions');const row=el('div','toast-actions');actions.forEach(([label,fn])=>row.append(btn(label,'toast-act',()=>{n.classList.remove('show');fn();})));n.append(row);}
 else n.classList.remove('with-actions');
 n.classList.add('show');clearTimeout(toastTimer);
 toastTimer=setTimeout(()=>{n.classList.remove('show');toastTimer=setTimeout(()=>{if(!n.classList.contains('show'))n.replaceChildren();},400);},5200);}
function paintDock(){
 const n=document.getElementById('files-dock');if(!n)return;n.replaceChildren();const v=FX.view;
 if(v?.select){const fresh=!n.classList.contains('show');n.classList.add('show');if(fresh)fxMotion(n,'fx-dock-in',220);const bar=el('div','files-select-bar');bar.append(el('span','grow','已选 '+v.select.size+' 项'));
  const one=v.select.size===1?filesPicked()[0]:null;
  bar.append(btn('下载','secondary small',filesDownloadPicked,'download'));if(one)bar.append(btn('改名','secondary small',()=>fileRename(one),'edit'));bar.append(btn('删除','secondary small danger-text',filesDeletePicked,'fTrash'),ib('x','不选了',()=>{v.select=null;paintFiles();}));n.append(bar);return;}
 const mine=FX.transfers;if(!mine.length){n.classList.remove('show');return;}
 const show=!n.classList.contains('show');n.classList.add('show');
 const act=filesActive(),b=btn('','files-dock-btn',transfersSheet);
 const ic=el('span','file-icon'+(act.length?' busy':''));ic.append(icon(act.length?'refresh':'check'));b.append(ic);
 const t=el('span','grow file-text');
 if(act.length){const size=act.reduce((s,x)=>s+(x.size>0?x.size:0),0),done=act.reduce((s,x)=>s+x.done,0);
  t.append(el('span','file-name',act.length+' 个正在传'+(act.length===1?'：'+act[0].name:'')));
  const rate=act.length===1?[fxRateText(act[0]),fxEta(act[0])].filter(Boolean).join(' · '):'';
  t.append(el('small','file-meta',fileSize(done)+(size?' / '+fileSize(size):'')+(rate?' · '+rate:'')));
  const bar=el('span','files-progress');bar.setAttribute('role','progressbar');bar.setAttribute('aria-valuemin','0');bar.setAttribute('aria-valuemax',String(size||0));bar.setAttribute('aria-valuenow',String(done));bar.setAttribute('aria-label','总传输进度');
  const fill=el('span','');fill.style.width=(size?Math.min(100,done*100/size):0)+'%';bar.append(fill);t.append(bar);
  if(act.length>1){const items=el('span','dock-items');act.slice(0,3).forEach(x=>{const row=el('span','dock-item');row.append(el('span','dock-name',x.name),el('span','dock-state',fxPhaseText(x)+' · '+transferPct(x)+'%'));items.append(row);});t.append(items);}
 }else{const failed=mine.filter(x=>x.state==='failed').length;t.append(el('span','file-name',failed?failed+' 个没传成功':'都传完了'),el('small','file-meta','共 '+mine.length+' 个 · 点开看'));}
 b.append(t);b.setAttribute('aria-label','传输列表');n.append(b);
 if(show)fxMotion(n,'fx-dock-in',220);}
function transfersSheet(){const box=sheet('传输');box.classList.add('transfers-sheet');const list=el('div','transfer-list');list.id='files-transfers';box.append(list);
 const foot=el('div','sheet-actions');foot.append(btn('清除已结束的','secondary',async()=>{try{const r=await rpc('sftpForget',{});FX.transfers=r.transfers||[];paintTransfers();paintDock();fxPaintEntry();if(!FX.transfers.length)closeSheet();}catch(e){error(e);}}));box.append(foot);
 box.append(el('p','fine','传输在手机上进行，换到别的页面也会继续；App 被系统关掉时会停下，没传完的不会留下半个文件。'));paintTransfers();}
function paintTransfers(){
 const n=document.getElementById('files-transfers');if(!n)return;n.replaceChildren();
 if(!FX.transfers.length){n.append(el('p','muted','还没有传输。'));return;}
 for(const t of FX.transfers.slice().reverse()){
  const row=el('div','transfer-row '+t.state+(t.phase==='verify'?' verify':''));if(t.state==='queued')row.classList.add('queued');
  const ic=el('span','file-icon');ic.append(icon(t.state==='done'?'check':t.state==='failed'?'alert':t.kind==='down'?'download':'fUpload'));row.append(ic);
  const body=el('div','grow file-text');body.append(el('span','file-name',t.name));
  const where=t.kind==='down'?'从 '+t.deviceName+' 下载':'传到 '+t.deviceName+' · '+(t.where||t.remote);
  const pct=transferPct(t),rate=fxRateText(t),eta=fxEta(t);
  let label;
  if(t.state==='queued')label='排队中';
  else if(t.state==='running')label=t.phase==='verify'?'正在核对…':pct+'% · '+fileSize(t.done)+(t.size>0?' / '+fileSize(t.size):'')+(rate?' · '+rate:'')+(eta?' · '+eta:'');
  else if(t.state==='done')label=t.kind==='down'?'已存到 '+t.where:'已上传';
  else if(t.state==='failed')label='失败：'+t.error;
  else label='已取消';
  body.append(el('small','file-meta',label),el('small','file-meta transfer-where',where));
  if(t.state==='running'||t.state==='queued'){const bar=el('span','files-progress'+(t.phase==='verify'?' verifying':''));bar.setAttribute('role','progressbar');bar.setAttribute('aria-valuemin','0');bar.setAttribute('aria-valuemax',String(t.size||0));bar.setAttribute('aria-valuenow',String(t.done));bar.setAttribute('aria-label',t.name+' 传输进度');const fill=el('span','');fill.style.width=(t.phase==='verify'?100:pct)+'%';bar.append(fill);body.append(bar);}
  row.append(body);const acts=el('div','transfer-acts');
  if(t.state==='running'||t.state==='queued')acts.append(btn('取消','secondary small',async()=>{try{filesTrack(await rpc('sftpCancel',{transfer:t.id}));}catch(e){error(e);}}));
  if(t.canOpen){acts.append(btn('打开','secondary small',()=>rpc('sftpOpen',{transfer:t.id}).catch(error)),ib('fShare','分享 '+t.name,()=>rpc('sftpOpen',{transfer:t.id,share:true}).catch(error)));}
  row.append(acts);n.append(row);}}

// ─── Entry points ───────────────────────────────────────────────────────────
// A header button on every tab: one tap from anywhere, scoped to the device on screen. First run
// carries a 新 mark until 文件 has been opened once (remembered per computer).
function filesEntryButton(){
 filesIcons();
 const b=btn('','files-entry'+(FX.hint?'':' is-new'),()=>filesOpen());
 b.title=FX.hint?'文件：上传、下载和预览':'新功能 · 文件：上传、下载和预览';
 b.setAttribute('aria-label',(FX.hint?'':'新功能 · ')+'文件：上传、下载和预览电脑上的文件');
 const ic=el('span','files-entry-ic');ic.append(icon('folder'));
 b.append(ic,el('span','files-entry-label','文件'));
 const n=filesActive().length;if(n)b.append(fxEntryBadge(n));
 if(!FX.hint)b.append(el('span','files-entry-new','新'));
 filesHintLoad();return b;}
function fxEntryBadge(n){const s=el('span','files-entry-badge',String(Math.min(n,9))+(n>9?'+':''));s.setAttribute('aria-label',n+' 个传输进行中');return s;}
function fxPaintEntry(){const n=filesActive().length;document.querySelectorAll('.files-entry').forEach(b=>{
 const old=b.querySelector('.files-entry-badge');
 if(!n){old?.remove();return;}
 if(old){old.textContent=String(Math.min(n,9))+(n>9?'+':'');old.setAttribute('aria-label',n+' 个传输进行中');}
 else{const nb=fxEntryBadge(n);const nw=b.querySelector('.files-entry-new');if(nw)nw.before(nb);else b.append(nb);}});}
function filesHintLoad(){
 const dev=S.device?.id;if(!dev||S.demo||FX.hintLoaded===dev)return;FX.hintLoaded=dev;
 cacheGet('files:hint',dev).then(v=>{if(FX.hintLoaded!==dev||FX.hint===true)return;FX.hint=!!v;
  if(v)document.querySelectorAll('.files-entry.is-new').forEach(b=>{b.classList.remove('is-new');b.querySelector('.files-entry-new')?.remove();});});}
function filesHintSeen(dev){
 const id=dev||S.device?.id;if(!id||S.demo)return;FX.hint=true;
 document.querySelectorAll('.files-entry.is-new').forEach(b=>{b.classList.remove('is-new');b.querySelector('.files-entry-new')?.remove();});
 cachePut('files:hint',{seen:true},id);}

function filesMenu(){const v=FX.view;const box=sheet('文件选项');
 menuItem(box,'上传到这里',filesUpload,'fUpload','从手机选一个或多个文件');
 menuItem(box,'新建文件夹',filesMkdir,'fFolderPlus');
 menuItem(box,'多选',()=>{v.select=new Set();v.selectNew=true;paintFiles();},'fSelect','一次下载或删除好几个；长按文件也行');
 menuItem(box,FX.hidden?'不显示隐藏文件':'显示隐藏文件',()=>{FX.hidden=!FX.hidden;filesSavePrefs();paintFiles();},'fEye','名字以 . 开头的');
 menuItem(box,'排序',filesSortSheet,'fSort',{name:'按名称',time:'按修改时间',size:'按大小'}[FX.sort]);
 menuItem(box,'刷新',()=>filesLoad(filesHere()||v.path),'refresh');
 if(v.home&&filesHere()!==v.home)menuItem(box,'回主目录',()=>filesGo('~'),'fHome',v.home);
 if(filesHere())menuItem(box,'复制当前路径',()=>copyText(filesHere()),'copy',filesHere());
 if(FX.transfers.length)menuItem(box,'传输列表',transfersSheet,'download',filesActive().length?filesActive().length+' 个正在传':'');}
function filesSortSheet(){const box=sheet('排序');[['name','按名称'],['time','按修改时间（新的在前）'],['size','按大小（大的在前）']].forEach(([k,label])=>{const b=menuItem(box,label,()=>{FX.sort=k;filesSavePrefs();paintFiles();},FX.sort===k?'check':'sort');if(FX.sort===k)b.classList.add('current');});
 box.append(el('p','fine','文件夹总是排在前面。'));}
// 终端 tab: a row under the SSH terminal.
function filesRow(){filesIcons();const b=btn('','card-button files-row',()=>filesOpen(),'');b.setAttribute('aria-label','打开文件：上传或下载电脑上的文件');
 const av=el('div','avatar files-av');av.append(icon('folder'));const n=filesActive().length;if(n)av.append(el('span','status-dot work'));
 const info=el('div','grow');info.append(el('div','card-title','文件'),el('div','card-meta truncate',n?n+' 个正在传':'上传、下载 · 通过 SSH 传文件'));b.append(av,info);
 const side=el('div','row-side');side.append(el('span','badge plain','打开'));b.append(side);return b;}
// Terminal ⋯: the SSH shell opens 文件 at home; a pane at its working folder.
function filesTermItem(box,entry){const p=entry.pane;const dir=p?.foreground_cwd||p?.cwd||entry.cwd||'';
 menuItem(box,'传文件',()=>filesOpen(dir?{path:dir}:{}),'folder',dir?'打开 '+(typeof shortPath==='function'?shortPath(dir):dir):'上传、下载电脑上的文件');}
// Chat ⋯: the agent's working folder (a ch route's agent runs elsewhere; that folder may not exist here).
function filesAgentItem(box,a){const dir=a?.foreground_cwd||a?.cwd||'';if(S.demo)return;
 menuItem(box,'项目文件',()=>filesOpen(dir?{path:dir}:{}),'folder',dir?'在「文件」里打开 '+(typeof shortPath==='function'?shortPath(dir):dir):'上传、下载电脑上的文件');}
