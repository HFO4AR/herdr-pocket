'use strict';
// Office reading view: .docx (continuous blocks), .xlsx (sheet tabs + virtual rows), .pptx
// (slide canvas). Native OfficePreview parses everything and returns bounded JSON; this file only
// builds DOM nodes with textContent. It never assigns innerHTML, never executes document content
// and never navigates a document-provided link. Images are derived preview assets (40-hex keys)
// served by the Phase 1 PreviewServer at /preview/office/<key>; officeImageUrl() is the single
// place to change if that route is renamed at merge time.
const OF_IMAGE_BASE='https://pocket.invalid/preview/office/';
const OF_LEGACY=/\.(doc|xls|ppt|docm|xlsm|pptm|dotx|dotm|xltx|xltm|potx|potm|ppsx|ppsm|odt|ods|odp|rtf)$/i;
const OF_MAX=80_000_000;
const OF_ROW_H=30,OF_COL_W=84,OF_ROWNUM_W=46,OF_XLSX_BUCKET=200,OF_CHUNK=80;
const OF_PH={title:'标题',ctrTitle:'标题',subTitle:'副标题',body:'正文'};

function officeImageUrl(token){return token?OF_IMAGE_BASE+encodeURIComponent(token):'';}
function officeIsModern(name){return /\.(docx|xlsx|pptx)$/i.test(name||'');}
function officeIsLegacy(name){return OF_LEGACY.test(name||'');}
function officeLabel(name){if(/\.xlsx$/i.test(name))return 'Excel 表格';if(/\.pptx$/i.test(name))return '演示文稿';if(/\.docx$/i.test(name))return 'Word 文档';return 'Office 文档';}

// ─── Opening and closing ────────────────────────────────────────────────────
function officeOpen(p){
 if(!p)return;
 const o=p.of={loading:true,error:'',code:'',session:'',kind:'',blocks:[],next:0,total:0,done:false,truncated:false,
  sheets:[],styles:[],sheet:0,sheetName:'',totalRows:0,cols:0,widths:[],merges:[],chunks:new Map(),pending:new Set(),
  slides:0,slide:0,slideData:new Map(),slideLoading:false,zoom:1,io:null,busy:false,restore:null};
 if(officeIsLegacy(p.name)){ofFail(p,'office_legacy','这是旧版 Office、宏文档或 OpenDocument，手机上不能预览；可以下载后用其他应用打开');return;}
 if(!officeIsModern(p.name)){ofFail(p,'office_unsupported','这个文件不是 .docx/.xlsx/.pptx 格式');return;}
 if((p.size||0)>OF_MAX){ofFail(p,'office_too_large','文档有 '+fileSize(p.size)+'，超过手机预览的 80 MB 上限；可以下载后用其他应用打开');return;}
 const token=p.token||('of'+uuid());p.token=token;
 if(typeof paintPreview==='function')paintPreview();
 rpc('sftpOfficeOpen',{device:FX.view.device,path:p.path,allowLarge:!!p.allowLarge,token},n=>{
  if(FX.pv!==p)return;const got=Number(n);if(!(got>=0))return;p.got=got;if(typeof fxPaintReadProgress==='function')fxPaintReadProgress();})
 .then(r=>{
  if(FX.pv!==p||!p.of){if(r&&r.session)rpc('sftpOfficeClose',{session:r.session}).catch(()=>{});return;}
  const o=p.of;o.loading=false;o.session=r.session;o.kind=r.kind;
  p.r=r;p.key=r.key;p.size=r.size||p.size;p.mtime=r.mtime||p.mtime;p.loading=false;p.error='';
  if(r.kind==='docx'){
   o.blocks=(r.blocks||[]).slice();o.next=r.next||0;o.total=r.total||0;o.done=!!r.done;o.truncated=!!r.truncated;p.pages=o.total;
  }else if(r.kind==='xlsx'){
   o.sheets=r.sheets||[];o.styles=r.styles||[];o.sheet=(r.sheet&&r.sheet.sheet)||0;ofTakeSheet(o,r.sheet||{});p.pages=o.sheets.length;
  }else if(r.kind==='pptx'){
   o.slides=r.slides||0;o.width=r.width||0;o.height=r.height||0;
   if(r.slide){o.slideData.set(r.slide.index,r.slide);o.slide=r.slide.index||0;}
   p.pages=o.slides;
  }
  paintPreview();
 }).catch(e=>{
  if(FX.pv!==p||!p.of)return;
  p.loading=false;
  if(e.code==='preview_large'&&typeof confirmAction==='function'){
   ofFail(p,'preview_large',e.message||'文件不小，预览要先读到手机上。');
   confirmAction('预览 '+fileSize(p.size)+' 的文件？','「'+p.name+'」不小，预览要先把整份读到手机的 App 缓存里（不会放进「下载」）。用流量的话会花一些。','仍然预览',()=>{
    p.allowLarge=true;p.of=null;p.r=null;p.loading=true;p.error='';p.got=0;officeOpen(p);
   });
   return;
  }
  ofFail(p,e.code||'',e.message||String(e));
 });
}

function ofFail(p,code,message){
 const o=p.of;if(!o)return;
 p.loading=false;p.error=message;o.loading=false;o.error=message;o.code=code||'';
 if(typeof paintPreview==='function')paintPreview();
}

function officeClose(p){
 const o=p&&p.of;if(!o)return;
 if(o.io){o.io.disconnect();o.io=null;}
 if(o.session){rpc('sftpOfficeClose',{session:o.session}).catch(()=>{});}
 else if(p.token&&p.loading){rpc('sftpOfficeCancel',{token:p.token}).catch(()=>{});}
 p.of=null;
}

// ─── Painting ───────────────────────────────────────────────────────────────
function officePaint(body){
 const p=FX.pv,o=p&&p.of;if(!body||!o)return;
 if(o.loading&&!o.session){body.append(typeof fxReadBox==='function'?fxReadBox():el('div','fx-read','正在从电脑上读取…'));return;}
 if(o.error){body.append(ofFallback(p,o.error,o.code));return;}
 if(o.kind==='docx')ofPaintDocx(body,p,o);
 else if(o.kind==='xlsx')ofPaintXlsx(body,p,o);
 else if(o.kind==='pptx')ofPaintPptx(body,p,o);
 else body.append(ofFallback(p,'这种文档不能预览',''));
}

function ofFallback(p,message,code){
 const legacy=code==='office_legacy';
 const box=el('div','fx-fallback');
 const ic=el('div','fx-fallback-icon'+(legacy?'':' alert'));ic.append(icon(legacy?'file':'alert'));box.append(ic);
 box.append(el('h2','',legacy?'旧版或加密的 Office 文档':'打不开这个文档'),el('p','fx-fallback-why',message||'这个文件读不出来。'));
 const facts=el('div','fx-facts');
 for(const [k,v] of [['大小',p.size>0?fileSize(p.size):'未知'],['修改',p.mtime?time(p.mtime):'未知'],['类型',officeLabel(p.name)]]){const r=el('div','fx-fact');r.append(el('span','',k),el('span','',v));facts.append(r);}
 box.append(facts);
 const acts=el('div','fx-fallback-acts');
 if(p.r&&p.r.key&&p.r.complete&&typeof fxPreviewOpen==='function'){
  acts.append(btn('用其他应用打开','primary',()=>fxPreviewOpen(false),'file'),btn('分享','secondary',()=>fxPreviewOpen(true),'fShare'));
 }
 acts.append(btn('下载到手机','secondary',()=>fileDownload(p.entry,false),'download'));
 acts.append(btn('另存为…','secondary',()=>fileDownload(p.entry,true),'file'));
 acts.append(btn('复制路径','secondary',()=>copyText(p.path),'copy'));
 if(!legacy&&code!=='office_too_large')acts.append(btn('重试','secondary',()=>officeRetry(p),'refresh'));
 box.append(acts);
 const note=el('p','fine',legacy?'旧版 .doc/.xls/.ppt、加密文档和 ODF 不在 App 内解析。下载后用电脑上的 Office/WPS 打开。':'只读预览，不会执行文件里的宏、脚本或外部内容。');
 box.append(note);
 return box;
}

function officeRetry(p){
 const o=p.of;if(!o)return;
 if(o.io){o.io.disconnect();o.io=null;}
 if(o.session)rpc('sftpOfficeClose',{session:o.session}).catch(()=>{});
 p.of=null;p.r=null;p.loading=true;p.error='';p.got=0;
 officeOpen(p);
}

// ─── DOCX ───────────────────────────────────────────────────────────────────
function ofPaintDocx(body,p,o){
 if(o.io){o.io.disconnect();o.io=null;}
 const art=el('article','fx-docx');art.id='fx-docx';art.style.setProperty('--oz',String(o.zoom));
 art.setAttribute('aria-label',p.name+' 文档内容');
 const host=el('div','fx-docx-blocks');art.append(host);
 for(const b of o.blocks)host.append(ofBlock(b));
 body.append(art);
 if(o.truncated)body.append(el('p','fx-notice','文档内容较多，只显示了前面的部分。'));
 body.append(ofNote(p));
 ofDocxObserve(p,host);
}

function ofDocxObserve(p,host){
 const o=p.of;if(!o)return;
 if(o.done||o.next>=o.total)return;
 const sentinel=el('div','fx-docx-more');sentinel.id='fx-docx-more';
 sentinel.append(el('span','spinner'),el('span','','正在读取后面的内容…'));
 host.append(sentinel);
 const load=()=>ofDocxMore(p,host,sentinel);
 if(typeof IntersectionObserver!=='function'){load();return;}
 o.io=new IntersectionObserver(es=>{if(es.some(e=>e.isIntersecting))load();},{root:document.getElementById('fx-body'),rootMargin:'600px 0px'});
 o.io.observe(sentinel);
 // A short first chunk can leave the sentinel already visible; IntersectionObserver's first
 // callback is not guaranteed to arrive before the next frame, so check once.
 requestAnimationFrame(()=>{
  const body=document.getElementById('fx-body');if(!body||FX.pv!==p||!p.of||p.of!==o||!sentinel.isConnected)return;
  const r=sentinel.getBoundingClientRect(),b=body.getBoundingClientRect();
  if(r.top<b.bottom+600)load();
 });
}

function ofDocxMore(p,host,sentinel){
 const o=p.of;if(!o||o.busy||o.done||o.next>=o.total)return;
 o.busy=true;
 rpc('sftpOfficeChunk',{session:o.session,from:o.next,count:OF_CHUNK}).then(r=>{
  if(FX.pv!==p||!p.of)return;
  o.busy=false;
  for(const b of (r.blocks||[])){host.insertBefore(ofBlock(b),sentinel);o.blocks.push(b);}
  o.next=r.next;o.total=r.total;o.done=!!r.done;o.truncated=!!r.truncated;
  if(o.done||o.next>=o.total){
   sentinel.remove();if(o.io){o.io.disconnect();o.io=null;}
   if(o.truncated)host.append(el('p','fx-notice','文档内容较多，只显示了前面的部分。'));
  }
 }).catch(e=>{
  if(FX.pv!==p||!p.of)return;o.busy=false;
  if(sentinel.isConnected)sentinel.replaceChildren(el('span','fx-notice','后面的内容没读出来：'+(e.message||e)));
 });
}

function ofBlock(b){
 if(!b||!b.t)return el('div');
 if(b.t==='p')return ofParagraph(b.p,{});
 if(b.t==='img'){
  const fig=el('figure','fx-docx-figure');
  const img=el('img','fx-docx-img');img.alt=(b.name||p_name())+' 图片';img.loading='lazy';img.decoding='async';
  img.src=officeImageUrl(b.asset);
  img.style.width=Math.min(Math.max(40,b.w||320),900)+'px';
  img.onerror=()=>{img.remove();fig.append(el('span','fx-docx-img-missing','[图片]'));};
  fig.append(img);return fig;
 }
 if(b.t==='br')return el('div','fx-docx-break');
 if(b.t==='table'){
  const wrap=el('div','fx-docx-tablewrap');
  const table=el('table','fx-docx-table');
  for(const row of b.rows||[]){
   const tr=el('tr');
   for(const c of row.cells||[]){
    if(c.cover)continue;
    const cell=el(row.h?'th':'td');
    if((c.cs||1)>1)cell.colSpan=c.cs;
    if((c.rs||1)>1)cell.rowSpan=c.rs;
    if(c.fill)cell.style.background=ofColor(c.fill);
    for(const x of c.blocks||[])cell.append(ofBlock(x));
    tr.append(cell);
   }
   table.append(tr);
  }
  wrap.append(table);return wrap;
 }
 return el('div');
}

function p_name(){return FX.pv?.name||'文档';}

function ofParagraph(p,opts={}){
 if(!p)return el('div');
 const h=p.h>=1&&p.h<=6?p.h:0;
 const n=el(h?('h'+h):'div','fx-docx-block '+(h?'fx-docx-h h'+h:'fx-docx-p')+(p.lvl>=0?' fx-docx-list':''));
 if(p.al)n.style.textAlign=p.al;
 if(p.before!=null)n.style.marginTop=(p.before*1.2)+'px';
 if(p.after!=null)n.style.marginBottom=(p.after*1.2)+'px';
 if(p.lvl>=0)n.style.paddingLeft=(p.lvl*18)+'px';
 if(p.marker!=null){const m=el('span','fx-docx-marker',p.marker);n.append(m);}
 const body=el('span','fx-docx-line');
 const runs=p.runs||[];
 if(!runs.length){body.append(document.createTextNode(' '));}
 for(const r of runs)body.append(ofRun(r,opts));
 n.append(body);
 return n;
}

function ofRun(r,opts={}){
 let n;
 if(opts.inline){n=document.createTextNode(r.t||'');}else{n=el('span','fx-docx-run',r.t||'');}
 if(r.b&&!opts.inline)n.style.fontWeight='700';
 if(r.i&&!opts.inline)n.style.fontStyle='italic';
 if(!opts.inline){
  const deco=[];if(r.u)deco.push('underline');if(r.s)deco.push('line-through');
  if(deco.length)n.style.textDecoration=deco.join(' ');
  if(r.color)n.style.color=ofColor(r.color);
  if(r.sz)n.style.fontSize=(r.sz/12).toFixed(2)+'em';
  if(r.link){n.classList.add('fx-docx-link');n.title=r.link;n.setAttribute('aria-label',(r.t||'')+'（链接，仅显示）');}
 }
 return n;
}

function ofColor(v){return /^#[0-9a-f]{6}$/i.test(v||'')?v:'#000';}

function ofNote(p){
 const box=el('div','fx-notices');
 box.append(el('p','fx-notice','只读预览 · 不会执行宏、脚本或加载文档里的远程内容。'));
 if(p.of&&p.of.truncated)box.append(el('p','fx-notice','文档较大，只显示了能安全解析的一部分。'));
 return box;
}

// ─── XLSX ───────────────────────────────────────────────────────────────────
function ofTakeSheet(o,s){
 if(!s||!s.rows)return;
 o.sheet=s.sheet!=null?s.sheet:o.sheet;o.sheetName=s.name||o.sheetName;
 o.totalRows=s.totalRows||0;o.cols=s.cols||0;o.widths=s.widths||[];o.merges=s.merges||[];o.truncated=!!s.truncated;
 o.chunks.clear();o.pending.clear();o.chunks.set(s.start||0,s);
}

function ofPaintXlsx(body,p,o){
 const old=document.getElementById('fx-xl-scroll');
 if(old&&!o.restore)o.restore={top:old.scrollTop,left:old.scrollLeft};
 const wrap=el('div','fx-xl');wrap.style.setProperty('--oz',String(o.zoom));
 const tabs=el('div','fx-xl-tabs');tabs.id='fx-xl-tabs';tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','工作表');
 for(const s of o.sheets){
  const b=btn(s.name,'fx-xl-tab'+(s.index===o.sheet?' active':''),()=>officeSheet(p,s.index));
  b.setAttribute('role','tab');b.setAttribute('aria-selected',s.index===o.sheet?'true':'false');
  if(s.hidden)b.classList.add('hidden-sheet');
  tabs.append(b);
 }
 wrap.append(tabs);
 const headwrap=el('div','fx-xl-headwrap');headwrap.id='fx-xl-headwrap';
 const head=el('div','fx-xl-head');head.id='fx-xl-head';
 const corner=el('div','fx-xl-corner','#');
 headwrap.append(corner,head);wrap.append(headwrap);
 const scroll=el('div','fx-xl-scroll');scroll.id='fx-xl-scroll';scroll.tabIndex=0;scroll.setAttribute('role','grid');scroll.setAttribute('aria-label',o.sheetName||'工作表');
 const canvas=el('div','fx-xl-canvas');canvas.id='fx-xl-canvas';
 scroll.append(canvas);wrap.append(scroll);
 const status=el('div','fx-xl-status');status.id='fx-xl-status';
 status.append(el('span','',o.totalRows+' 行 × '+o.cols+' 列'),el('span','fx-xl-hint','点单元格复制内容'));
 wrap.append(status);
 body.append(wrap);body.append(ofNote(p));
 ofXlsxHead(p);
 ofXlsxRows(p);
 scroll.addEventListener('scroll',()=>ofXlsxScroll(p),{passive:true});
 scroll.addEventListener('keydown',e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'||e.key==='PageDown'||e.key==='PageUp'){/* native scrolling */}});
 if(o.restore){const r=o.restore;o.restore=null;requestAnimationFrame(()=>{scroll.scrollTop=r.top;scroll.scrollLeft=r.left;ofXlsxScroll(p);});}
 else requestAnimationFrame(()=>ofXlsxScroll(p));
}

function ofXlsxWidths(o){return (o.widths&&o.widths.length?o.widths:Array(o.cols||1).fill(OF_COL_W));}
function ofXlsxTotalW(o){return OF_ROWNUM_W*o.zoom+ofXlsxWidths(o).reduce((s,w)=>s+w*o.zoom,0);}
function ofXlsxPrefix(o){const x=[0];let at=OF_ROWNUM_W*o.zoom;for(const w of ofXlsxWidths(o)){at+=w*o.zoom;x.push(at);}return x;}
function ofColName(i){let s='';i++;while(i>0){const m=(i-1)%26;s=String.fromCharCode(65+m)+s;i=Math.floor((i-1)/26);}return s;}
function ofXlsxColAt(x,prefix){let lo=0,hi=prefix.length-2;while(lo<hi){const mid=(lo+hi+1)>>1;if(prefix[mid]<=x)lo=mid;else hi=mid-1;}return lo;}

function ofXlsxHead(p){
 const o=p.of,head=document.getElementById('fx-xl-head');if(!o||!head)return;
 head.replaceChildren();
 head.style.width=ofXlsxTotalW(o)+'px';head.style.paddingLeft=(OF_ROWNUM_W*o.zoom)+'px';
 const widths=ofXlsxWidths(o);
 widths.forEach((w,i)=>{const c=el('div','fx-xl-ch',ofColName(i));c.style.width=(w*o.zoom)+'px';head.append(c);});
 ofXlsxScroll(p);
}

function ofXlsxScroll(p){
 const o=p.of,scroll=document.getElementById('fx-xl-scroll'),head=document.getElementById('fx-xl-head');
 if(!o||!scroll)return;
 if(head)head.style.transform='translateX('+(-scroll.scrollLeft)+'px)';
 if(o.frame)cancelAnimationFrame(o.frame);
 o.frame=requestAnimationFrame(()=>{o.frame=0;if(FX.pv===p&&p.of)ofXlsxRows(p);});
}

function ofXlsxRows(p){
 const o=p.of,scroll=document.getElementById('fx-xl-scroll'),canvas=document.getElementById('fx-xl-canvas');
 if(!o||!scroll||!canvas)return;
 const zoom=o.zoom,rh=OF_ROW_H*zoom,rnw=OF_ROWNUM_W*zoom,totalW=ofXlsxTotalW(o),widths=ofXlsxWidths(o),prefix=ofXlsxPrefix(o);
 const totalRows=o.totalRows||1;
 canvas.style.width=totalW+'px';canvas.style.height=(totalRows*rh)+'px';
 const top=scroll.scrollTop,height=Math.max(80,scroll.clientHeight||300);
 const start=Math.max(0,Math.floor(top/rh)-6);
 const end=Math.min(totalRows,start+Math.ceil(height/rh)+14);
 const left=scroll.scrollLeft,right=left+(scroll.clientWidth||320);
 let cStart=Math.max(0,ofXlsxColAt(left,prefix)-1),cEnd=Math.min((o.cols||1)-1,ofXlsxColAt(right,prefix)+1);
 if(cEnd<cStart)cEnd=cStart;
 ofEnsureSheet(p,start,end,cStart,cEnd);
 const rows=ofRowsIn(o,start,end);
 const mergeSpans=new Map(),mergeCover=new Set();
 for(const m of o.merges||[]){
  if(m.r1<start||m.r2>=end||m.c1<cStart||m.c2>cEnd)continue;
  for(let r=m.r1;r<=m.r2;r++)for(let c=m.c1;c<=m.c2;c++){if(r===m.r1&&c===m.c1)continue;mergeCover.add(r+':'+c);}
  mergeSpans.set(m.r1+':'+m.c1,{cs:m.c2-m.c1+1,rs:m.r2-m.r1+1});
 }
 const frag=document.createDocumentFragment();
 for(let i=start;i<end;i++){
  const data=rows.get(i)||{i,cells:[]};
  const row=el('div','fx-xl-row'+(data.hidden?' hidden-row':''));
  row.style.top=(i*rh)+'px';row.style.height=rh+'px';row.style.width=totalW+'px';
  const num=el('div','fx-xl-rownum',String(i+1));num.style.width=rnw+'px';num.style.height=rh+'px';row.append(num);
  if(cStart>0){const sp=el('div','fx-xl-spacer');sp.style.width=(prefix[cStart]-rnw)+'px';sp.style.height=rh+'px';row.append(sp);}
  const byCol=new Map((data.cells||[]).map(c=>[c.c, c]));
  for(let c=cStart;c<=cEnd;c++){
   const key=i+':'+c;if(mergeCover.has(key))continue;
   const merge=mergeSpans.get(key);
   const cell=byCol.get(c)||{c,v:'',t:'s',s:0};
   const style=o.styles?.[cell.s]||{};
   const td=el('div','fx-xl-cell'+(merge?' merged':''));
   let w=widths[c]||OF_COL_W;
   if(merge)for(let k=1;k<merge.cs&&c+k<widths.length;k++)w+=widths[c+k];
   td.style.width=(w*zoom)+'px';td.style.height=merge?(rh*merge.rs)+'px':rh+'px';
   if(merge)td.style.zIndex='2';
   td.style.fontSize=(12*zoom)+'px';
   if(style.b)td.style.fontWeight='700';
   if(style.i)td.style.fontStyle='italic';
   if(style.u)td.style.textDecoration='underline';
   if(style.s)td.classList.add('strike');
   if(style.color)td.style.color=ofColor(style.color);
   if(style.fill)td.style.background=ofColor(style.fill);
   const align=style.al||((cell.t==='n'||cell.t==='d')?'right':null);
   if(align){td.style.textAlign=align;td.style.justifyContent=align==='right'?'flex-end':align==='center'?'center':'flex-start';}
   if(style.val==='center')td.style.alignItems='center';
   if(style.wrap)td.classList.add('wrap');
   td.textContent=cell.v||'';
   if(cell.v)td.title=cell.v.length>500?cell.v.slice(0,500):cell.v;
   td.tabIndex=0;
   td.addEventListener('click',()=>{if(cell.v)copyText(cell.v);});
   td.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&cell.v){e.preventDefault();copyText(cell.v);}});
   row.append(td);
   if(merge)c+=merge.cs-1;
  }
  frag.append(row);
 }
 canvas.replaceChildren(frag);
 const st=document.getElementById('fx-xl-status');
 if(st){
  const tr=o.truncated?' · 只显示前 '+o.totalRows+' 行':'';
  st.firstChild.textContent=o.sheetName+' · '+o.totalRows+' 行 × '+o.cols+' 列'+tr;
 }
}

function ofRowsIn(o,start,end){
 const rows=new Map();
 for(const s of o.chunks.values())for(const r of s.rows||[])if(r.i>=start&&r.i<end)rows.set(r.i,r);
 return rows;
}

function ofEnsureSheet(p,start,end,cStart,cEnd){
 const o=p.of;if(!o||!o.session)return;
 for(let b=Math.floor(start/OF_XLSX_BUCKET)*OF_XLSX_BUCKET;b<end;b+=OF_XLSX_BUCKET){
  if(o.chunks.has(b)||o.pending.has(b))continue;
  o.pending.add(b);
  rpc('sftpOfficeSheet',{session:o.session,sheet:o.sheet,start:b,count:OF_XLSX_BUCKET}).then(r=>{
   if(FX.pv!==p||!p.of)return;
   o.pending.delete(b);o.chunks.set(r.start,r);
   if(r.totalRows>o.totalRows)o.totalRows=r.totalRows;
   ofXlsxRows(p);
  }).catch(e=>{
   if(FX.pv!==p||!p.of)return;o.pending.delete(b);
   const st=document.getElementById('fx-xl-status');if(st)st.firstChild.textContent='这一块没读出来：'+(e.message||e);
  });
 }
}

function officeSheet(p,index){
 const o=p.of;if(!o||o.kind!=='xlsx')return;
 if(index===o.sheet&&o.chunks.size)return;
 o.sheet=index;o.chunks.clear();o.pending.clear();o.totalRows=0;o.cols=0;o.merges=[];o.restore={top:0,left:0};
 rpc('sftpOfficeSheet',{session:o.session,sheet:index,start:0,count:OF_XLSX_BUCKET}).then(r=>{
  if(FX.pv!==p||!p.of)return;
  ofTakeSheet(o,r);paintPreview();
 }).catch(e=>{if(FX.pv===p)toast(e.message||String(e));});
}

// ─── PPTX ───────────────────────────────────────────────────────────────────
function ofPaintPptx(body,p,o){
 const slide=o.slideData.get(o.slide);
 const wrap=el('div','fx-ppt-wrap');wrap.id='fx-ppt-wrap';
 const stage=el('div','fx-ppt-stage');
 const canvas=el('div','fx-ppt-canvas');canvas.id='fx-ppt-canvas';
 canvas.setAttribute('role','img');canvas.setAttribute('aria-label',p.name+' 第 '+((o.slide||0)+1)+' 张幻灯片');
 if(slide){
  canvas.style.aspectRatio=(slide.w||12192000)+' / '+(slide.h||6858000);
  canvas.style.background=ofColor(slide.bg||'#FFFFFF');
  if(slide.bgAsset){const bg=el('img','fx-ppt-bg');bg.alt='';bg.src=officeImageUrl(slide.bgAsset);bg.onerror=()=>bg.remove();canvas.append(bg);}
  for(const s of slide.shapes||[])canvas.append(ofPptShape(s,slide.w||12192000,slide.h||6858000));
 }else{
  const l=el('div','fx-ppt-loading');l.append(el('span','spinner'),el('span','','正在读取这一张…'));canvas.append(l);
 }
 stage.append(canvas);wrap.append(stage);body.append(wrap);body.append(ofNote(p));
 requestAnimationFrame(()=>ofPptSize(p));
 const pts=new Map();let down=null;
 wrap.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse'&&e.button!==0)return;down={x:e.clientX,y:e.clientY};});
 wrap.addEventListener('pointerup',e=>{
  if(!down)return;const dx=e.clientX-down.x,dy=e.clientY-down.y;down=null;
  if(Math.abs(dx)>56&&Math.abs(dx)>Math.abs(dy)*1.4&&!(typeof getSelection==='function'&&getSelection().toString().length))officeSlide(p,o.slide+(dx<0?1:-1));
 });
 wrap.addEventListener('pointercancel',()=>{down=null;});
}

function ofPptShape(s,sw,sh){
 if(s.k==='image'&&s.asset){
  const img=el('img','fx-ppt-img');img.alt=s.name||'图片';img.loading='lazy';img.src=officeImageUrl(s.asset);
  ofPptBox(img,s,sw,sh);
  img.onerror=()=>{
   const ph=el('div','fx-ppt-shape placeholder');ofPptBox(ph,s,sw,sh);
   ph.append(el('div','fx-ppt-label','图片'));img.replaceWith(ph);
  };
  return img;
 }
 const box=el('div','fx-ppt-shape'+(s.k==='placeholder'?' placeholder':''));
 ofPptBox(box,s,sw,sh);
 if(s.fill)box.style.background=ofColor(s.fill);
 const hasText=(s.ps||[]).some(p=>(p.runs||[]).length);
 if(!hasText&&s.label){const l=el('div','fx-ppt-label',OF_PH[s.label]||s.label);box.append(l);}
 for(const p of s.ps||[])box.append(ofPptParagraph(p));
 return box;
}

function ofPptBox(n,s,sw,sh){
 const w=Math.max(1,Number(s.w)||1),h=Math.max(1,Number(s.h)||1);
 n.style.left=((Number(s.x)||0)/sw*100)+'%';
 n.style.top=((Number(s.y)||0)/sh*100)+'%';
 n.style.width=(w/sw*100)+'%';
 n.style.height=(h/sh*100)+'%';
}

function ofPptParagraph(p){
 const n=el('div','fx-ppt-p'+(p.lvl>=0?' lvl'+Math.min(p.lvl,4):''));
 if(p.al){n.style.textAlign=p.al;n.style.justifyContent=p.al==='center'?'center':p.al==='right'?'flex-end':'flex-start';}
 if(p.marker!=null)n.append(el('span','fx-ppt-marker',p.marker));
 for(const r of p.runs||[])n.append(ofPptRun(r));
 if(!(p.runs||[]).length)n.append(document.createTextNode(' '));
 return n;
}

function ofPptRun(r){
 const n=el('span','fx-ppt-run',r.t||'');
 const pt=r.sz||18;n.dataset.pt=String(pt);n.style.fontSize=pt+'px';
 if(r.b)n.style.fontWeight='700';
 if(r.i)n.style.fontStyle='italic';
 if(r.u||r.s){const d=[];if(r.u)d.push('underline');if(r.s)d.push('line-through');n.style.textDecoration=d.join(' ');}
 if(r.color)n.style.color=ofColor(r.color);
 return n;
}

function ofPptSize(p){
 const o=p&&p.of,slide=o&&o.slideData.get(o.slide),canvas=document.getElementById('fx-ppt-canvas'),body=document.getElementById('fx-body');
 if(!o||!canvas||!body)return;
 const avail=Math.max(240,Math.min(1100,(body.clientWidth||innerWidth)-20));
 const natural=(slide?.w||12192000)/9525;
 const width=avail*o.zoom;
 canvas.style.width=Math.min(width,Math.max(avail*3,2400))+'px';
 if(!slide)return;
 const scale=canvas.clientWidth/(natural||1);
 canvas.querySelectorAll('[data-pt]').forEach(n=>{n.style.fontSize=Math.max(6,(Number(n.dataset.pt)/1)*96/72*scale)+'px';});
}

function officeSlide(p,index){
 const o=p.of;if(!o||o.kind!=='pptx')return;
 const i=Math.max(0,Math.min((o.slides||1)-1,index));
 if(i===o.slide)return;
 o.slide=i;
 if(o.slideData.has(i)){paintPreview();return;}
 o.slideLoading=true;paintPreview();
 rpc('sftpOfficeSlide',{session:o.session,index:i}).then(r=>{
  if(FX.pv!==p||!p.of)return;
  o.slideLoading=false;o.slideData.set(r.index,r);
  while(o.slideData.size>3)o.slideData.delete(o.slideData.keys().next().value);
  paintPreview();
 }).catch(e=>{
  if(FX.pv!==p||!p.of)return;o.slideLoading=false;toast(e.message||String(e));paintPreview();
 });
}

// ─── Tools, footer, zoom ────────────────────────────────────────────────────
function ofChip(label,fn,name,on,aria){
 const b=btn(label,'pill fx-chip'+(on?' active':''),fn,name);
 if(aria)b.setAttribute('aria-label',aria);
 return b;
}

function officePaintTools(n){
 const p=FX.pv,o=p&&p.of;if(!n||!o)return;
 const busy=!o.session&&!o.error;
 if(!busy&&o.session){
  n.append(ofChip('−',()=>officeZoom(p,1/1.25),'fMinus',false,'缩小'));
  n.append(ofChip('+',()=>officeZoom(p,1.25),'plus',false,'放大'));
  n.append(ofChip('适应',()=>officeFit(p),'fFit',false,'适应屏幕'));
 }
 n.append(ofChip('下载',()=>fileDownload(p.entry,false),'download',false,'下载到手机'));
 if(p.r&&p.r.key&&p.r.complete&&typeof fxPreviewOpen==='function'){
  n.append(ofChip('打开',()=>fxPreviewOpen(false),'file',false,'用其他应用打开'));
  n.append(ofChip('分享',()=>fxPreviewOpen(true),'fShare',false,'分享'));
 }
 n.append(el('span','pill fx-chip-static','只读'));
 if(p.mtime)n.append(el('span','pill fx-chip-static',relative(p.mtime)));
 if(o.kind==='xlsx'&&o.sheets.length)n.append(el('span','pill fx-chip-static',o.sheets.length+' 个工作表'));
 if(o.kind==='pptx'&&o.slides)n.append(el('span','pill fx-chip-static',o.slides+' 张幻灯片'));
 if(o.kind==='docx'&&o.total)n.append(el('span','pill fx-chip-static',o.total+' 段'));
 const files=typeof filesSorted==='function'?filesSorted(FX.view?.list?.entries||[]).filter(e=>!fileIsDir(e)):[];
 if(files.length>1&&typeof fxStepFile==='function'){
  n.append(ofChip('上一个',()=>fxStepFile(-1),'back',false,'上一个文件'));
  n.append(ofChip('下一个',()=>fxStepFile(1),'chevron',false,'下一个文件'));
 }
}

function officePaintFoot(n){
 const p=FX.pv,o=p&&p.of;if(!n||!o)return;
 if(o.kind==='pptx'&&o.slides>0){
  const bar=el('div','fx-pager');
  const prev=btn('上一张','secondary small',()=>officeSlide(p,o.slide-1),'back');prev.disabled=o.slide<=0;bar.append(prev);
  bar.append(el('span','fx-page-n','第 '+((o.slide||0)+1)+' / '+o.slides+' 张'));
  const next=btn('下一张','secondary small',()=>officeSlide(p,o.slide+1),'chevron');next.disabled=o.slide>=o.slides-1;bar.append(next);
  n.append(bar);
 }else if(o.kind==='xlsx'){
  n.append(el('p','fine center','左右滑动表格 · 上下虚拟滚动 · 点单元格复制内容 · 双指或按钮缩放'));
 }else if(o.kind==='docx'){
  n.append(el('p','fine center','连续阅读 · 可以选中文字复制 · 双指或按钮缩放'));
 }else if(o.error){
  n.append(el('p','fine center','可以下载到手机，或用其他应用打开'));
 }
}

function officeZoom(p,factor){
 const o=p&&p.of;if(!o||!o.session)return;
 o.zoom=Math.max(.5,Math.min(3,Math.round(o.zoom*factor*100)/100));
 if(o.kind==='docx'){
  const art=document.getElementById('fx-docx');if(art)art.style.setProperty('--oz',String(o.zoom));
 }else if(o.kind==='xlsx'){
  const s=document.getElementById('fx-xl-scroll');if(s)o.restore={top:s.scrollTop,left:s.scrollLeft};
  paintPreview();
 }else if(o.kind==='pptx'){
  ofPptSize(p);
 }
 if(typeof paintPreviewTools==='function')paintPreviewTools(document.getElementById('fx-tools'));
}

function officeFit(p){
 const o=p&&p.of;if(!o||!o.session)return;
 o.zoom=1;
 if(o.kind==='docx'){const art=document.getElementById('fx-docx');if(art)art.style.setProperty('--oz','1');}
 else if(o.kind==='xlsx'){o.restore={top:0,left:0};paintPreview();}
 else if(o.kind==='pptx')ofPptSize(p);
}

// Arrow keys change slides while a presentation is open.
window.addEventListener('keydown',e=>{
 const p=FX.pv,o=p&&p.of;if(!o||o.kind!=='pptx'||!o.session)return;
 const t=e.target;if(t&&/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))return;
 if(e.key==='ArrowLeft'){e.preventDefault();officeSlide(p,o.slide-1);}
 else if(e.key==='ArrowRight'){e.preventDefault();officeSlide(p,o.slide+1);}
});
window.addEventListener('resize',()=>{const p=FX.pv,o=p&&p.of;if(!o)return;if(o.kind==='pptx')ofPptSize(p);else if(o.kind==='xlsx'&&!o.frame)o.frame=requestAnimationFrame(()=>{o.frame=0;ofXlsxRows(p);});});
