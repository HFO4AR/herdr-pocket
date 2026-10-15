'use strict';
// Files in a conversation (PDF, logs, archives, code…), next to pictures (images.js).
//  · Composer: the system file picker; native code keeps the content URI, JS only an id, the
//    name and the size. Bytes are streamed and hashed natively, never through this page.
//  · Sending: each file is uploaded (same content + name = same path, so retries are harmless),
//    then staged for the pane (copied to the other computer for a ch route), then one prompt names
//    them. Any failure before the prompt means nothing reached the agent.
//  · History: "[文件] <…/.herdr-pocket/uploads/<day>/<prefix>/<name>>" lines show as file chips.
const FILE_MAX=4,FILE_LIMIT=25e6;
const FILES=new Map();// draft key → [{id,name,size,mime,up?:{name,sha256}}]
function fileAttached(key=draftKey()){return FILES.get(key)||[];}
function fileSet(key,list){if(list.length)FILES.set(key,list);else FILES.delete(key);}
// Pictures and files together: what the send button and the composer care about.
function attCount(key=draftKey()){return imgAttached(key).length+fileAttached(key).length;}
async function filePick(key){
 if(S.demo){toast('演示模式：不能添加文件');return;}
 const left=FILE_MAX-fileAttached(key).length;if(left<=0){toast('一条消息最多带 4 个文件');return;}
 try{const r=await rpc('pickFiles',{max:left});const have=fileAttached(key);const keep=[],drop=[];
  for(const f of r.files||[]){if(have.length+keep.length>=FILE_MAX||have.concat(keep).some(x=>x.name===f.name&&x.size===f.size))drop.push(f);else keep.push(f);}
  if(drop.length)rpc('dropFiles',{ids:drop.map(f=>f.id)}).catch(()=>{});
  if(keep.length)fileSet(key,have.concat(keep));
  if(r.failed)toast((r.failed>1?r.failed+' 个文件没加上：':'没加上：')+(r.reason||'读不到'));
  else if(r.extra||drop.length)toast(drop.some(f=>have.some(x=>x.name===f.name))?'有文件已经加过了':'一条消息最多带 4 个文件');
  renderComposer();}
 catch(e){error(e);}}
function fileRemove(key,id){fileSet(key,fileAttached(key).filter(f=>f.id!==id));rpc('dropFiles',{ids:[id]}).catch(()=>{});renderComposer();}
function fileSize(n){if(!(n>=0))return '';if(n<1000)return n+' B';if(n<1e6)return Math.round(n/1e3)+' KB';return (n/1e6).toFixed(n<1e7?1:0)+' MB';}
function fileExt(name){const m=String(name).match(/\.([A-Za-z0-9]{1,5})$/);return m?m[1].toUpperCase():'';}
// The square on the left of a chip: the extension when there is a short one, else a page icon.
function fileBadge(name){const b=el('span','file-badge');const x=fileExt(name);if(x){b.classList.add('ext');b.append(el('b','',x));}else b.append(icon('file'));return b;}
function fileText(name,meta){const t=el('span','file-text');t.append(el('span','file-name',name));const m=el('small','file-meta',meta||'');t.append(m);return t;}

// Chips above the input; rebuilt only when the set of files changes.
function fileTray(compose,key){
 let tray=compose.querySelector('.file-tray');const list=fileAttached(key);
 if(!list.length){tray?.remove();return;}
 if(!tray){tray=el('div','file-tray');tray.setAttribute('role','list');tray.setAttribute('aria-label','要发送的文件');const pics=compose.querySelector('.att-tray');if(pics)pics.after(tray);else compose.prepend(tray);}
 const sig=list.map(f=>f.id).join(',');if(tray.dataset.sig===sig)return;tray.dataset.sig=sig;tray.replaceChildren();
 list.forEach(f=>{const chip=el('div','file-chip');chip.setAttribute('role','listitem');chip.append(fileBadge(f.name),fileText(f.name,fileSize(f.size)));
  const x=ib('x','删掉文件 '+f.name,()=>fileRemove(key,f.id));x.classList.add('file-x');chip.append(x);tray.append(chip);});
 const total=list.reduce((s,f)=>s+Math.max(0,f.size||0),0);
 tray.append(el('span','att-note',list.length+'/'+FILE_MAX+' 个'+(total?' · '+fileSize(total):'')));}

// Uploads (once per attachment) and stages every file for this pane. Throws "没发出去：…" on any
// failure: the prompt has not been sent then.
async function fileUpload(list,a,progress){
 const far=!!a.history_ref?.remote;
 for(let i=0;i<list.length;i++){const f=list[i];const n=list.length>1?' '+(i+1)+'/'+list.length:'';
  if(!f.up){progress('正在上传文件'+n+'…');let last=0;
   try{const r=await rpc('uploadFile',{id:f.id},sent=>{const v=Number(sent),now=Date.now();if(!(v>=0)||now-last<700)return;last=now;progress('正在上传文件'+n+' · '+fileSize(v)+(f.size>0?' / '+fileSize(f.size):''));});
    f.up={name:r.name,sha256:r.sha256};if(r.size>=0)f.size=r.size;}
   catch(e){throw new Error('没发出去：「'+f.name+'」没传上去（'+e.message+'）');}}
  // Cheap for a local pane; for a ch route it copies the file to the other computer (again on every send).
  progress((far?'正在把文件传到远端电脑':'正在核对文件')+n+'…');
  try{await remote('stageFile',{session:S.session,target:a.pane_id,identity:a.identity,name:f.up.name,sha256:f.up.sha256,remote:far});}
  catch(e){throw new Error(/^没发出去/.test(e.message)?e.message:'没发出去：「'+f.name+'」没交给 Agent（'+e.message+'）');}}
 return list.map(f=>({name:f.up.name,sha256:f.up.sha256}));}

// ─── History ────────────────────────────────────────────────────────────────
// Only lines naming one of our uploads become chips; anything else stays text.
function fileLine(line){
 const x=String(line).match(/^\[文件\]\s+(\/.*\/\.herdr-pocket\/uploads\/(\d{4}-\d{2}-\d{2}\/[a-f0-9]{16}\/([^\/]+)))\s*$/);
 return x?{path:x[1],ref:x[2],file:x[3]}:null;}
// Size or "cleaned up", asked of the bridge in small batches; a ch route's copy is looked up by
// the same name on this computer (where it was uploaded first).
const fileMeta=new Map();let fileAsk=new Set(),fileTimer=0;
function fileLookup(ref){if(S.demo||fileMeta.has(ref)||fileAsk.has(ref))return;fileAsk.add(ref);clearTimeout(fileTimer);fileTimer=setTimeout(fileFlush,60);}
async function fileFlush(){
 const names=[...fileAsk].slice(0,60);names.forEach(n=>fileAsk.delete(n));if(!names.length)return;
 names.forEach(n=>fileMeta.set(n,{}));
 try{const r=await remote('fileInfo',{names});names.forEach(n=>fileMeta.set(n,r.files?.[n]||{}));}
 catch(_){names.forEach(n=>fileMeta.delete(n));return;}
 finally{if(fileAsk.size)fileTimer=setTimeout(fileFlush,60);}
 document.querySelectorAll('.file-chip[data-ref]').forEach(c=>{if(names.includes(c.dataset.ref))fileMark(c,fileMeta.get(c.dataset.ref));});}
function fileMark(chip,meta){const m=chip.querySelector('.file-meta');if(!m||!meta)return;chip.classList.toggle('gone',!!meta.gone);m.textContent=meta.gone?'已清理':meta.size>=0?fileSize(meta.size):m.textContent;}
// Chips under a prompt (history) or a pending message (outbox: {file,size}).
function fileList(files){
 const box=el('div','file-list');
 files.forEach(f=>{const meta=f.ref?fileMeta.get(f.ref):null;
  const chip=btn('','file-chip',()=>fileDetail(f));chip.setAttribute('aria-label','文件 '+f.file);
  chip.append(fileBadge(f.file),fileText(f.file,f.size>=0?fileSize(f.size):''));
  if(f.ref){chip.dataset.ref=f.ref;if(meta)fileMark(chip,meta);else fileLookup(f.ref);}
  box.append(chip);});
 return box;}
function fileDetail(f){
 if(!f.path)return;const meta=fileMeta.get(f.ref)||{};const box=sheet('文件');
 const head=el('div','file-detail');head.append(fileBadge(f.file));const t=el('div','grow');t.append(el('strong','file-detail-name',f.file),el('small','',meta.gone?'电脑上已经清理掉了':meta.size>=0?fileSize(meta.size):'大小未知'));head.append(t);box.append(head);
 box.append(el('code','file-path',f.path));
 menuItem(box,'复制路径',()=>copyText(f.path),'copy');
 menuItem(box,'复制文件名',()=>copyText(f.file),'file');
 box.append(el('p','fine','手机发的文件放在电脑的 ~/.herdr-pocket/uploads 里，14 天后自动清理。'));}
