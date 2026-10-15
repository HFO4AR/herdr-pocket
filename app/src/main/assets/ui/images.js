'use strict';
// Pictures in a conversation.
//  · Composer: pictures are picked and re-encoded natively (rotated upright, ≤ 2048 px, no EXIF);
//    JS only keeps a small preview and an id per picture, so nothing large crosses the bridge.
//  · Sending: pictures are uploaded first (idempotent, content-addressed), then one prompt is sent
//    with their names; the bridge turns them into a path or a ch-file:// address for the agent.
//  · History: "[图片] <path|ch-file://…>" lines and pictures embedded in a transcript show as
//    thumbnails, fetched lazily and only from places the bridge allows.
const IMG_MAX=4;
const IMG=new Map();// draft key → [{id,thumb,width,height,bytes,type,name?,sha256?}]
function imgAttached(key=draftKey()){return IMG.get(key)||[];}
function imgSet(key,list){if(list.length)IMG.set(key,list);else IMG.delete(key);}
function imgMenu(){
 const key=draftKey();const left=IMG_MAX-imgAttached(key).length,docs=FILE_MAX-fileAttached(key).length;
 const box=sheet('添加附件');
 const gallery=menuItem(box,'从相册选',()=>imgPick('gallery',key),'image',left>0?'还能加 '+left+' 张':'图片已满 4 张');
 const camera=menuItem(box,'拍照',()=>imgPick('camera',key),'camera');gallery.disabled=camera.disabled=left<=0;
 menuItem(box,'文件',()=>filePick(key),'file',docs>0?'PDF、日志、压缩包等，单个不超过 25 MB · 还能加 '+docs+' 个':'文件已满 4 个').disabled=docs<=0;
 box.append(el('p','fine','图片会在手机上压缩，并去掉拍摄地点等信息；文件原样上传，保留文件名。'));}
async function imgPick(source,key){
 if(S.demo){toast('演示模式：不能添加图片');return;}
 const left=IMG_MAX-imgAttached(key).length;if(left<=0)return;
 try{const r=await rpc('pickImages',{source,max:left});const all=r.images||[];
  const got=all.slice(0,IMG_MAX-imgAttached(key).length);
  if(got.length)imgSet(key,imgAttached(key).concat(got));
  const extra=all.slice(got.length);if(extra.length)rpc('dropImages',{ids:extra.map(a=>a.id)}).catch(()=>{});
  if(r.failed)toast(r.failed+' 张图片没能读取'+(r.reason?'：'+r.reason:''));else if(extra.length)toast('一条消息最多带 4 张图片');
  renderComposer();}
 catch(e){error(e);}}
function imgRemove(key,id){imgSet(key,imgAttached(key).filter(a=>a.id!==id));rpc('dropImages',{ids:[id]}).catch(()=>{});renderComposer();}
function imgBytes(list){const b=list.reduce((s,a)=>s+(a.bytes||0),0);return b>=1e6?(b/1e6).toFixed(1)+' MB':Math.max(1,Math.round(b/1e3))+' KB';}
// Previews above the input; rebuilt only when the set of pictures changes.
function imgTray(compose,key){
 let tray=compose.querySelector('.att-tray');const list=imgAttached(key);
 if(!list.length){tray?.remove();return;}
 if(!tray){tray=el('div','att-tray');tray.setAttribute('role','list');tray.setAttribute('aria-label','要发送的图片');compose.prepend(tray);}
 const sig=list.map(a=>a.id).join(',');if(tray.dataset.sig===sig)return;tray.dataset.sig=sig;tray.replaceChildren();
 list.forEach((a,i)=>{const item=el('div','att');item.setAttribute('role','listitem');const img=el('img');img.src=a.thumb;img.alt='图片 '+(i+1);
  img.onclick=()=>imgView(list.map(x=>({url:x.thumb})),i);item.append(img);
  const x=ib('x','删掉图片 '+(i+1),()=>imgRemove(key,a.id));x.classList.add('att-x');item.append(x);tray.append(item);});
 tray.append(el('span','att-note',list.length+'/'+IMG_MAX+' 张 · '+imgBytes(list)));}
// Uploads pictures not yet on the computer. A failure means nothing was sent to the agent; uploaded
// names are kept on the attachment so trying again does not upload twice.
async function imgUpload(list,progress){
 for(let i=0;i<list.length;i++){const a=list[i];if(a.name)continue;
  progress(list.length>1?'正在上传图片 '+(i+1)+'/'+list.length+'…':'正在上传图片…');
  try{const r=await rpc('uploadImage',{id:a.id});a.name=r.name;a.sha256=r.sha256;}
  catch(e){throw new Error('没发出去：图片没传上去（'+e.message+'）');}}
 return list.map(a=>({name:a.name,sha256:a.sha256}));}

// ─── History ────────────────────────────────────────────────────────────────
const IMG_LINE=/^\[图片[^\]\n]*\]\s*(\S+)\s*$/;
function imgRef(ref){
 let m=ref.match(/\/\.herdr-pocket\/uploads\/(\d{4}-\d{2}-\d{2}\/[a-f0-9]{64}\.(?:jpg|png))$/);if(m)return {kind:'upload',name:m[1]};
 if(/^ch-file:\/\/[a-f0-9]{64}\.(?:png|jpe?g|gif|webp)$/.test(ref))return {kind:'ch',address:ref};return null;}
// A prompt's own words, and the pictures it carries (reference lines and embedded transcript pictures).
function imgSplit(m){
 const specs=[],files=[];const rec=S.chat?.record;
 const text=String(m.text||'').split('\n').filter(line=>{const f=fileLine(line);if(f){files.push(f);return false;}const x=line.match(IMG_LINE);const spec=x&&imgRef(x[1]);if(spec)specs.push(spec);return !spec;}).join('\n').trim();
 if(Array.isArray(m.images)&&rec)m.images.forEach(i=>specs.push({kind:'transcript',record_id:rec.id,item:m.id,block:i.block,...(rec.remote?{remote:rec.remote}:{})}));
 return {text,specs,files};}
// Reassignable on purpose: offline tests serve fixture pictures.
let imgFetch=(spec,variant)=>S.demo?Promise.reject(new Error('演示里没有图片')):rpc('image',{...spec,variant}).then(r=>r.url);
const imgDone=new Map(),imgFailed=new Map(),imgWaiting=new Map();let imgActive=0;const imgQueue=[];
function imgKey(spec,variant){return variant+':'+[spec.kind,spec.name,spec.address,spec.record_id,spec.item,spec.block].join('|');}
function imgLoad(spec,variant='thumb'){
 if(spec.url)return Promise.resolve(spec.url);
 const key=imgKey(spec,variant);if(imgDone.has(key))return Promise.resolve(imgDone.get(key));
 if(imgWaiting.has(key))return imgWaiting.get(key);
 const p=new Promise((resolve,reject)=>{imgQueue.push({run:()=>imgFetch(spec,variant),resolve,reject});imgPump();})
  .then(url=>{imgDone.set(key,url);imgFailed.delete(key);if(imgDone.size>80)imgDone.delete(imgDone.keys().next().value);return url;},
   e=>{imgFailed.set(key,e.message||String(e));throw e;}).finally(()=>imgWaiting.delete(key));
 imgWaiting.set(key,p);return p;}
// Two at a time: thumbnails share the SSH link with status polls.
// A reply that never comes must not block the queue: give up after 45 s (tap the tile to retry).
function imgPump(){while(imgActive<2&&imgQueue.length){const job=imgQueue.shift();imgActive++;let timer;
 Promise.race([Promise.resolve().then(job.run),new Promise((_,no)=>{timer=setTimeout(()=>no(new Error('图片加载超时')),45000);})])
  .then(job.resolve,job.reject).finally(()=>{clearTimeout(timer);imgActive--;imgPump();});}}
function imgReason(msg){msg=String(msg||'');return /超时/.test(msg)?'超时，点一下重试':/清理/.test(msg)?'已清理':/太大/.test(msg)?'太大，在电脑上看':/找不到|不存在/.test(msg)?'找不到了':'加载失败';}
// Thumbnails load when they come within a screen of the visible part of the chat.
let imgObs=null;
function imgObserver(){if(typeof IntersectionObserver==='undefined')return null;const root=document.getElementById('chat-scroll');if(!root)return null;
 if(imgObs?.root!==root){imgObs?.disconnect();imgObs=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){imgObs.unobserve(e.target);imgStart(e.target);}}),{root,rootMargin:'600px 0px'});}
 return imgObs;}
function imgFill(b,url){const img=el('img');img.alt='';img.decoding='async';img.src=url;b.classList.remove('loading','broken');b.replaceChildren(img);}
function imgBroken(b,msg){b.classList.remove('loading');b.classList.add('broken');b.replaceChildren(icon('image'),el('span','',imgReason(msg)));}
function imgStart(b){imgLoad(b.imgSpec).then(url=>imgFill(b,url),e=>imgBroken(b,e.message));}
function imgTile(specs,i){
 const spec=specs[i];const b=btn('','img-tile',()=>{if(b.classList.contains('broken')){imgFailed.delete(imgKey(spec,'thumb'));b.classList.add('loading');b.replaceChildren();imgStart(b);return;}imgView(specs,i);});
 b.setAttribute('aria-label','图片 '+(i+1)+(specs.length>1?' / '+specs.length:''));b.imgSpec=spec;
 const key=imgKey(spec,'thumb');const done=spec.url||imgDone.get(key);
 if(done)imgFill(b,done);else if(imgFailed.has(key))imgBroken(b,imgFailed.get(key));
 else{b.classList.add('loading');const seen=imgObserver();if(seen)seen.observe(b);else imgStart(b);}
 return b;}
function imgStrip(specs){const box=el('div','img-strip'+(specs.length===1?' one':''));specs.forEach((_,i)=>box.append(imgTile(specs,i)));return box;}
// Full-screen look at one picture: the thumbnail first, then a larger copy.
function imgView(specs,start){
 overlay.replaceChildren();let at=start;
 const back=el('div','img-viewer');back.setAttribute('role','dialog');back.setAttribute('aria-modal','true');back.setAttribute('aria-label','查看图片');
 const bar=el('div','img-bar');const count=el('span','img-count grow');const status=el('span','img-status');status.setAttribute('aria-live','polite');
 const stage=el('div','img-stage');const img=el('img');stage.append(img);
 const show=()=>{const spec=specs[at];count.textContent=specs.length>1?(at+1)+' / '+specs.length:'';img.alt='图片 '+(at+1);
  img.src=spec.url||imgDone.get(imgKey(spec,'thumb'))||'';status.textContent=spec.url?'':'正在加载大图…';
  if(!spec.url){const want=at;imgLoad(spec,'full').then(url=>{if(want===at){img.src=url;status.textContent='';}},e=>{if(want===at)status.textContent=imgReason(e.message);});}
  prev.disabled=at===0;next.disabled=at===specs.length-1;};
 const prev=ib('back','上一张',()=>{if(at>0){at--;show();}}),next=ib('chevron','下一张',()=>{if(at<specs.length-1){at++;show();}});
 bar.append(count,status);if(specs.length>1)bar.append(prev,next);bar.append(ib('close','关闭',closeSheet));
 back.append(bar,stage);stage.onclick=e=>{if(e.target===stage)closeSheet();};overlay.append(back);show();}
