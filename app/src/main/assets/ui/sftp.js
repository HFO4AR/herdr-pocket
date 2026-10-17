'use strict';
// 文件: browse a connected computer's folders and move files both ways over its SSH connection (SFTP).
//  · Native (RemoteFiles.kt / Transfers.kt) does every SFTP call on that computer's own session, with
//    the SSH user's permissions; nothing goes through a shell or the bridge. Paths are plain strings.
//  · Every request names its computer (FX.view.device), so switching the device on screen never sends a
//    request to the wrong one. Transfers run natively and keep going while this page changes; the page
//    polls their counters (sftpTransfers) and toasts when one ends.
//  · Uploads never overwrite silently: a name that already exists asks 替换 / 保留两个 / 跳过 first, and
//    native re-checks when it moves the finished temporary file into place.
const FX={view:null,transfers:[],states:new Map(),want:0,sort:'name',hidden:false,prefs:false};
const FX_BIG=200e6;// downloads above this ask first (mobile data, phone storage)
function filesIcons(){if(paths.fUpload)return;Object.assign(paths,{fUpload:'M12 20V9M7 14l5-5 5 5M5 4h14',fTrash:'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',fHome:'M3 11l9-7 9 7M5 9.5V20h5v-6h4v6h5V9.5',fLink:'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',fSort:'M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4',fEye:'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6',fShare:'M12 3v13M7 8l5-5 5 5M5 14v6h14v-6',fFolderPlus:'M4 5h5l2 2.5h9a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM12 10.5v6M9 13.5h6',fSelect:'M4 6l2 2 4-4M4 16l2 2 4-4M13 7h7M13 17h7'});}
// Sort and 显示隐藏文件 are remembered per computer in the app's own encrypted cache (cache.js; the
// WebView has no DOM storage). Read once per run; a choice made meanwhile wins.
function filesPrefs(dev){if(!dev||FX.prefs)return;FX.prefs=true;cacheGet('files:prefs',dev).then(v=>{if(!v||FX.prefsSet)return;if(['name','time','size'].includes(v.sort))FX.sort=v.sort;FX.hidden=!!v.hidden;paintFiles();});}
function filesSavePrefs(){FX.prefsSet=true;const dev=FX.view?.device;if(dev)cachePut('files:prefs',{sort:FX.sort,hidden:FX.hidden},dev);}

// ─── Opening and leaving ────────────────────────────────────────────────────
// opts.path: where to start (an agent's or pane's folder); a folder that does not exist falls back to ~.
function filesOpen(opts={}){
 filesIcons();
 if(S.demo){toast('演示模式不连电脑，不能传文件');return;}
 const dev=opts.device||S.device;if(!dev){toast('先连上电脑');return;}
 filesPrefs(dev.id);
 if(typeof leaveTerminal==='function')leaveTerminal();closeSheet();S.chat=null;
 FX.view={device:dev.id,name:dev.name||dev.host||'电脑',path:opts.path||'~',back:[],list:null,loading:true,error:'',select:null,epoch:0};
 renderFiles();filesLoad(FX.view.path);filesPoll();}
function filesLeave(){FX.view=null;}
// Back: out of selection, then up the folders you came through, then out of 文件.
function filesBack(){const v=FX.view;if(!v)return false;if(v.select){v.select=null;paintFiles();return true;}
 if(v.back.length){filesLoad(v.back.pop(),false);return true;}filesLeave();render();return true;}

async function filesLoad(path,push){
 const v=FX.view;if(!v)return;const ep=++v.epoch;v.loading=true;v.error='';paintFiles();
 try{const r=await rpc('sftpList',{device:v.device,path});if(FX.view!==v||ep!==v.epoch)return;
  if(push&&v.list&&v.list.path!==r.path)v.back.push(v.list.path);
  v.list=r;v.path=r.path;v.home=r.home;v.select=null;}
 catch(e){if(FX.view!==v||ep!==v.epoch)return;
  if(!v.list&&path!=='~'){toast('打不开 '+path+'：'+(e.message||e)+'，先从主目录开始');v.loading=false;return filesLoad('~',false);}
  v.error=e.message||String(e);}
 finally{if(FX.view===v&&ep===v.epoch){v.loading=false;paintFiles();const m=document.getElementById('files-main');if(m&&push!==undefined)m.scrollTop=0;}}}
function filesGo(path){filesLoad(path,true);}
function filesHere(){return FX.view?.list?.path||'';}

// ─── Screen ─────────────────────────────────────────────────────────────────
function renderFiles(){
 const v=FX.view;if(!v)return;filesIcons();const root=shell();root.classList.add('files-shell');
 const head=el('header','chat-head files-head');head.append(ib('back','返回',()=>filesBack()));
 const av=el('div','avatar files-av');av.append(icon('folder'));head.append(av);
 const id=el('div','grow chat-id');id.append(el('h2','','文件'),el('small','files-sub',v.name+' · 通过 SSH 传文件'));head.append(id);
 head.append(ib('fUpload','上传到这里',filesUpload),ib('more','文件选项',filesMenu));root.append(head);
 const crumbs=el('nav','files-crumbs');crumbs.id='files-crumbs';crumbs.setAttribute('aria-label','当前位置');root.append(crumbs);
 const main=el('main','main files-main');main.id='files-main';const list=el('div','files-list');list.id='files-list';main.append(list);root.append(main);
 pullRefresh(main,()=>filesLoad(filesHere()||v.path));
 const dock=el('div','files-dock');dock.id='files-dock';root.append(dock);
 paintFiles();}
function paintFiles(){if(!FX.view)return;if(!document.getElementById('files-list')){if(!S.chat&&!overlay.querySelector('.sheet')&&!(typeof T!=='undefined'&&T.view))renderFiles();return;}paintCrumbs();paintFileList();paintDock();}

// "/ › home › yuki › src" with the home folder shown as 主目录; scrolled so the current folder shows.
function paintCrumbs(){
 const n=document.getElementById('files-crumbs');const v=FX.view;if(!n||!v)return;n.replaceChildren();
 const path=v.list?.path||'',home=v.home||'';if(!path){n.append(el('span','files-crumb-wait','读取中…'));return;}
 const parts=[];let base='/',rest=path;
 if(home&&home!=='/'&&(path===home||path.startsWith(home+'/'))){parts.push(['主目录',home,'fHome']);base=home;rest=path.slice(home.length);}
 else parts.push(['/','/','']);
 let acc=base;rest.split('/').filter(Boolean).forEach(seg=>{acc=acc==='/'?'/'+seg:acc+'/'+seg;parts.push([seg,acc,'']);});
 parts.forEach(([label,p,ic],i)=>{if(i)n.append(el('span','files-sep','›'));const here=i===parts.length-1;
  const b=btn(ic?'':label,'files-crumb'+(here?' here':''),()=>{if(!here)filesGo(p);},ic||undefined);if(ic){b.append(document.createTextNode(label));}
  b.setAttribute('aria-label',(here?'当前位置 ':'去 ')+(ic?label+' '+p:p));if(here)b.setAttribute('aria-current','location');n.append(b);});
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

function paintFileList(){
 const n=document.getElementById('files-list');const v=FX.view;if(!n||!v)return;n.replaceChildren();
 if(v.error&&!v.loading){const box=el('div','files-error');box.setAttribute('role','alert');box.append(el('h2','','读不了这个文件夹'),el('p','',v.error));
  const row=el('div','files-error-actions');row.append(btn('重试','primary',()=>filesLoad(filesHere()||v.path)));if(v.list||v.path!=='~')row.append(btn('回主目录','secondary',()=>filesGo('~')));box.append(row);n.append(box);if(!v.list)return;}
 if(!v.list){if(v.loading){const s=el('div','files-loading');s.setAttribute('role','status');s.append(el('span','spinner'),el('span','','正在读取电脑上的文件夹…'));n.append(s);skeleton(n,4);}return;}
 const all=v.list.entries||[],shown=filesSorted(all.slice()),hidden=all.length-all.filter(e=>FX.hidden||!e.name.startsWith('.')).length;
 const bar=el('div','row files-bar');const facts=el('span','grow files-facts');
 const dirs=shown.filter(fileIsDir).length;facts.append(el('span','',dirs+' 个文件夹 · '+(shown.length-dirs)+' 个文件'));
 if(hidden)facts.append(el('span','files-hidden-note',' · '+hidden+' 个隐藏'));if(v.loading)facts.append(el('span','spinner mini'));
 const sort=btn('','pill files-sort',filesSortSheet,'fSort');sort.append(el('span','',{name:'名称',time:'时间',size:'大小'}[FX.sort]));sort.setAttribute('aria-label','排序方式：'+{name:'按名称',time:'按修改时间',size:'按大小'}[FX.sort]);
 bar.append(facts,sort);n.append(bar);
 const card=el('div','card list-card files-card');card.setAttribute('role','list');card.setAttribute('aria-label','文件夹内容');
 if(v.list.parent&&!v.select){const up=btn('','card-button file-row file-up',()=>filesGo(v.list.parent));up.setAttribute('role','listitem');const ic=el('span','file-icon dir');ic.append(icon('back'));up.append(ic,fileText('上一级',v.list.parent));card.append(up);}
 if(!shown.length){const e=el('div','empty small');e.append(el('h2','',all.length?'只有隐藏文件':'空文件夹'),el('p','',all.length?'在「⋯」里打开「显示隐藏文件」':'点右上角的上传，把手机上的文件放进来'));card.append(e);}
 for(const e of shown)card.append(fileRow(e));
 n.append(card);
 if(v.list.truncated)n.append(el('p','fine center','文件太多，只列出前 '+all.length+' 个'));
 n.append(el('p','fine files-note','用这台电脑的 SSH 连接（SFTP）传文件，不用另开 FTP；能动哪些文件，和这个 SSH 用户在电脑上一样。'));}

function fileRow(e){
 const v=FX.view,dir=fileIsDir(e),sel=v.select,picked=sel?.has(e.name);
 const row=el('div','file-row-wrap'+(picked?' picked':''));row.setAttribute('role','listitem');
 const b=btn('','card-button file-row',()=>{if(row.dataset.long){delete row.dataset.long;return;}if(v.select){fileToggle(e);return;}if(dir)filesGo(filePath(e));else fxSheet(e);});
 if(sel){const c=el('span','file-check'+(picked?' on':''));c.append(icon('check'));b.append(c);b.setAttribute('aria-pressed',picked?'true':'false');}
 let ic;if(dir||e.type==='link'){ic=el('span','file-icon '+(dir?'dir':'link'));ic.append(icon(dir?'folder':'fLink'));}else ic=fileBadge(e.name);
 b.append(ic,fileText(e.name,[fxMeta(e),fileWhen(e)].filter(Boolean).join(' · ')));
 b.setAttribute('aria-label',(dir?'文件夹 ':'文件 ')+e.name+(sel?(picked?'，已选':'，未选'):''));
 // Long press starts picking several (download or delete together).
 let timer=0;const start=()=>{clearTimeout(timer);timer=setTimeout(()=>{row.dataset.long='1';if(typeof haptic==='function')haptic('long');if(!v.select)v.select=new Set();fileToggle(e);},520);};
 const stop=()=>clearTimeout(timer);
 b.addEventListener('touchstart',start,{passive:true});b.addEventListener('touchend',stop);b.addEventListener('touchmove',stop,{passive:true});b.addEventListener('touchcancel',stop);
 b.addEventListener('contextmenu',ev=>{ev.preventDefault();});
 row.append(b);
 if(!sel){const more=ib('more',e.name+' 的操作',()=>fxSheet(e));more.classList.add('file-more');row.append(more);}
 return row;}
function fileToggle(e){const v=FX.view;if(!v.select)v.select=new Set();if(v.select.has(e.name))v.select.delete(e.name);else v.select.add(e.name);if(!v.select.size)v.select=null;paintFiles();}

// ─── One entry: what can be done with it ────────────────────────────────────
function fxSheet(e){
 const dir=fileIsDir(e),path=filePath(e),v=FX.view;const box=sheet(e.name);
 const head=el('div','file-detail');const ic=dir?el('span','file-badge'):fileBadge(e.name);if(dir)ic.append(icon('folder'));
 const t=el('div');t.append(el('span','file-detail-name',e.name),el('small','muted',[fxMeta(e),e.mtime?time(e.mtime):'',e.perm||''].filter(Boolean).join(' · ')));head.append(ic,t);box.append(head);
 box.append(el('code','file-path',path));
 if(dir)menuItem(box,'打开',()=>filesGo(path),'folder');
 else if(e.type!=='other'&&e.target!=='broken'){
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

// ─── Transfers ──────────────────────────────────────────────────────────────
function filesTrack(t){if(!t?.id)return;FX.states.set(t.id,t.state);const i=FX.transfers.findIndex(x=>x.id===t.id);if(i>=0)FX.transfers[i]=t;else FX.transfers.push(t);FX.want=Date.now();paintDock();paintTransfers();}
function filesActive(){return FX.transfers.filter(t=>t.state==='running'||t.state==='queued');}
let filesPolling=false;
async function filesPoll(){
 if(filesPolling||S.demo)return;filesPolling=true;
 try{const r=await rpc('sftpTransfers',{});const list=r.transfers||[];
  for(const t of list){const was=FX.states.get(t.id);FX.states.set(t.id,t.state);if(!was||was===t.state||(was!=='running'&&was!=='queued'))continue;
   if(t.state==='done'){toast(t.kind==='down'?'「'+t.name+'」下载好了，在'+t.where:'「'+t.name+'」传到电脑上了');
    if(t.kind==='up'&&FX.view?.device===t.device&&filesHere()===t.where)filesLoad(filesHere());}
   else if(t.state==='failed')toast((t.kind==='down'?'下载':'上传')+'「'+t.name+'」没成功：'+t.error);}
  FX.transfers=list;paintDock();paintTransfers();}
 catch(_){}
 finally{filesPolling=false;}}
// Fast while something moves (or was just started), otherwise only when 文件 is open.
setInterval(()=>{if(!S.active||S.demo)return;if(filesActive().length||Date.now()-FX.want<4000)filesPoll();},800);
function transferPct(t){return t.size>0?Math.min(100,Math.floor(t.done*100/t.size)):t.state==='done'?100:0;}
function paintDock(){
 const n=document.getElementById('files-dock');if(!n)return;n.replaceChildren();const v=FX.view;
 if(v?.select){n.classList.add('show');const bar=el('div','files-select-bar');bar.append(el('span','grow','已选 '+v.select.size+' 项'));
  const one=v.select.size===1?filesPicked()[0]:null;
  bar.append(btn('下载','secondary small',filesDownloadPicked,'download'));if(one)bar.append(btn('改名','secondary small',()=>fileRename(one),'edit'));bar.append(btn('删除','secondary small danger-text',filesDeletePicked,'fTrash'),ib('x','不选了',()=>{v.select=null;paintFiles();}));n.append(bar);return;}
 const mine=FX.transfers;if(!mine.length){n.classList.remove('show');return;}n.classList.add('show');
 const act=filesActive(),b=btn('','files-dock-btn',transfersSheet);
 const ic=el('span','file-icon'+(act.length?' busy':''));ic.append(icon(act.length?'refresh':'check'));b.append(ic);
 const t=el('span','grow file-text');
 if(act.length){const size=act.reduce((s,x)=>s+(x.size>0?x.size:0),0),done=act.reduce((s,x)=>s+x.done,0);
  t.append(el('span','file-name',act.length+' 个正在传'+(act.length===1?'：'+act[0].name:'')),el('small','file-meta',fileSize(done)+(size?' / '+fileSize(size):'')));
  const bar=el('span','files-progress');const fill=el('span','');fill.style.width=(size?Math.min(100,done*100/size):0)+'%';bar.append(fill);t.append(bar);}
 else{const failed=mine.filter(x=>x.state==='failed').length;t.append(el('span','file-name',failed?failed+' 个没传成功':'都传完了'),el('small','file-meta','共 '+mine.length+' 个 · 点开看'));}
 b.append(t);b.setAttribute('aria-label','传输列表');n.append(b);}
function transfersSheet(){const box=sheet('传输');box.classList.add('transfers-sheet');const list=el('div','transfer-list');list.id='files-transfers';box.append(list);
 const foot=el('div','sheet-actions');foot.append(btn('清除已结束的','secondary',async()=>{try{const r=await rpc('sftpForget',{});FX.transfers=r.transfers||[];paintTransfers();paintDock();if(!FX.transfers.length)closeSheet();}catch(e){error(e);}}));box.append(foot);
 box.append(el('p','fine','传输在手机上进行，换到别的页面也会继续；App 被系统关掉时会停下，没传完的不会留下半个文件。'));paintTransfers();}
function paintTransfers(){
 const n=document.getElementById('files-transfers');if(!n)return;n.replaceChildren();
 if(!FX.transfers.length){n.append(el('p','muted','还没有传输。'));return;}
 for(const t of FX.transfers.slice().reverse()){const row=el('div','transfer-row '+t.state);
  const ic=el('span','file-icon');ic.append(icon(t.kind==='down'?'download':'fUpload'));row.append(ic);
  const body=el('div','grow file-text');body.append(el('span','file-name',t.name));
  const where=t.kind==='down'?'从 '+t.deviceName+' 下载':'传到 '+t.deviceName+' · '+(t.where||t.remote);
  const label={queued:'排队中',running:transferPct(t)+'% · '+fileSize(t.done)+(t.size>0?' / '+fileSize(t.size):''),done:t.kind==='down'?'已存到 '+t.where:'已上传',failed:'失败：'+t.error,cancelled:'已取消'}[t.state]||t.state;
  body.append(el('small','file-meta',label),el('small','file-meta transfer-where',where));
  if(t.state==='running'||t.state==='queued'){const bar=el('span','files-progress');const fill=el('span','');fill.style.width=transferPct(t)+'%';bar.append(fill);body.append(bar);}
  row.append(body);const acts=el('div','transfer-acts');
  if(t.state==='running'||t.state==='queued')acts.append(btn('取消','secondary small',async()=>{try{filesTrack(await rpc('sftpCancel',{transfer:t.id}));}catch(e){error(e);}}));
  if(t.canOpen){acts.append(btn('打开','secondary small',()=>rpc('sftpOpen',{transfer:t.id}).catch(error)),ib('fShare','分享 '+t.name,()=>rpc('sftpOpen',{transfer:t.id,share:true}).catch(error)));}
  row.append(acts);n.append(row);}}

// ─── Menus and entry points ─────────────────────────────────────────────────
function filesMenu(){const v=FX.view;const box=sheet('文件选项');
 menuItem(box,'上传到这里',filesUpload,'fUpload','从手机选一个或多个文件');
 menuItem(box,'新建文件夹',filesMkdir,'fFolderPlus');
 menuItem(box,'多选',()=>{v.select=new Set();paintFiles();},'fSelect','一次下载或删除好几个；长按文件也行');
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
 const info=el('div','grow');info.append(el('div','card-title','文件'),el('div','card-meta truncate',n?n+' 个正在传':'上传、下载 · 通过 SSH 传文件'));
 const side=el('div','row-side');side.append(el('span','badge plain','打开'));b.append(av,info,side);return b;}
// Terminal ⋯: the SSH shell opens 文件 at home; a pane at its working folder.
function filesTermItem(box,entry){const p=entry.pane;const dir=p?.foreground_cwd||p?.cwd||entry.cwd||'';
 menuItem(box,'传文件',()=>filesOpen(dir?{path:dir}:{}),'folder',dir?'打开 '+(typeof shortPath==='function'?shortPath(dir):dir):'上传、下载电脑上的文件');}
// Chat ⋯: the agent's working folder (a ch route's agent runs elsewhere; that folder may not exist here).
function filesAgentItem(box,a){const dir=a?.foreground_cwd||a?.cwd||'';if(S.demo)return;
 menuItem(box,'项目文件',()=>filesOpen(dir?{path:dir}:{}),'folder',dir?'在「文件」里打开 '+(typeof shortPath==='function'?shortPath(dir):dir):'上传、下载电脑上的文件');}
