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
  slides:0,slide:0,slideData:new Map(),pptAsk:new Set(),pptTop:0,zoom:1,io:null,busy:false,restore:null};
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
// All slides in one vertical scroll, each fetched as it comes near. A slide is laid out at its own
// size (1 px = 9525 EMU, 1 pt = 4/3 px, so text wraps the same at any zoom) and scaled as a whole.
// Geometry and colours come resolved from native (PptxParser); only numbers and #RRGGBB reach the DOM.
const OF_EMU=9525,OF_PPT_GAP=12,OF_SVG='http://www.w3.org/2000/svg';
let ofPptSeq=0;
function ofPaintPptx(body,p,o){
 const wrap=el('div','fx-ppt-wrap'),list=el('div','fx-ppt-list');list.id='fx-ppt-list';
 for(let i=0;i<(o.slides||0);i++){const c=el('div','fx-ppt-canvas');c.dataset.i=String(i);c.setAttribute('role','img');c.setAttribute('aria-label',p.name+' 第 '+(i+1)+' 张幻灯片');list.append(c);}
 wrap.append(list);body.append(wrap,ofNote(p));ofPptSize(p);
 o.io?.disconnect?.();
 o.io=new IntersectionObserver(es=>{for(const e of es){if(e.isIntersecting)ofPptShow(p,Number(e.target.dataset.i),e.target);else if(o.slides>12&&e.target.dataset.on)ofPptHide(e.target);}},{root:body,rootMargin:'900px 0px'});
 list.querySelectorAll('.fx-ppt-canvas').forEach(c=>o.io.observe(c));
 if(body._pptFor!==p){body._pptFor=p;body.addEventListener('scroll',()=>{if(FX.pv===p)ofPptScrolled(p,body);},{passive:true});}
 if(o.pptTop)body.scrollTop=o.pptTop;}
function ofPptShow(p,i,c){
 const o=p.of,s=o.slideData.get(i);
 if(s){if(!c.dataset.on){c.dataset.on='1';c.replaceChildren(ofPptSlide(s));}return;}
 if(!c.childElementCount){const l=el('div','fx-ppt-loading');l.append(el('span','spinner'));c.append(l);}
 if(o.pptAsk.has(i))return;o.pptAsk.add(i);
 rpc('sftpOfficeSlide',{session:o.session,index:i}).then(r=>{
  o.pptAsk.delete(i);if(FX.pv!==p||!p.of)return;o.slideData.set(r.index,r);
  const n=document.querySelector('.fx-ppt-canvas[data-i="'+r.index+'"]');if(n?.querySelector('.fx-ppt-loading'))ofPptShow(p,r.index,n);
 }).catch(e=>{
  o.pptAsk.delete(i);if(FX.pv!==p||!p.of)return;
  c.replaceChildren(btn('这一张没读出来，点一下重试','link-btn fx-ppt-retry',()=>{c.replaceChildren();ofPptShow(p,i,c);}));
 });}
function ofPptHide(c){delete c.dataset.on;c.replaceChildren();}
function ofPptSize(p){
 const o=p?.of,list=document.getElementById('fx-ppt-list'),body=document.getElementById('fx-body');if(!o||!list||!body)return;
 const W=(o.width||12192000)/OF_EMU,H=(o.height||6858000)/OF_EMU,w=Math.round(Math.max(240,Math.min(1076,(body.clientWidth||innerWidth)-24))*o.zoom);
 const set=(k,v)=>list.style.setProperty(k,v);
 set('--ppt-w',w+'px');set('--ppt-h',(w*H/W)+'px');set('--ppt-s',String(w/W));set('--ppt-sw',W+'px');set('--ppt-sh',H+'px');}
// Which slide the scroll is at: the top one at the very top, the last one at the very end.
function ofPptScrolled(p,body){
 const o=p.of;if(!o||o.kind!=='pptx')return;o.pptTop=body.scrollTop;
 if(performance.now()<(o.pptHold||0))return;
 const c=document.querySelector('.fx-ppt-canvas');if(!c)return;
 const room=Math.max(1,body.scrollHeight-body.clientHeight),line=body.scrollTop+body.clientHeight*Math.min(1,body.scrollTop/room);
 const i=Math.max(0,Math.min(o.slides-1,Math.floor((line-OF_PPT_GAP)/(c.offsetHeight+OF_PPT_GAP))));
 if(i!==o.slide){o.slide=i;ofPptFoot(o);}}
function ofPptFoot(o){
 const n=document.querySelector('.fx-page-n');if(n)n.textContent='第 '+((o.slide||0)+1)+' / '+o.slides+' 张';
 const b=document.querySelectorAll('.fx-pager button');if(b.length===2){b[0].disabled=o.slide<=0;b[1].disabled=o.slide>=o.slides-1;}}
function officeSlide(p,index){
 const o=p.of;if(!o||o.kind!=='pptx')return;
 const i=Math.max(0,Math.min((o.slides||1)-1,index));if(i===o.slide)return;
 o.slide=i;o.pptHold=performance.now()+250;ofPptFoot(o);
 const body=document.getElementById('fx-body'),c=document.querySelector('.fx-ppt-canvas[data-i="'+i+'"]');
 if(body&&c)body.scrollTop=OF_PPT_GAP+i*(c.offsetHeight+OF_PPT_GAP);}

function ofPptSlide(s){
 const root=el('div','fx-ppt-slide');root.style.background=s.bgGrad?ofPptCssGrad(s.bgGrad):ofColor(s.bg||'#FFFFFF');
 if(s.bgAsset){const bg=el('img','fx-ppt-bg');bg.alt='';bg.src=officeImageUrl(s.bgAsset);bg.onerror=()=>bg.remove();root.append(bg);}
 for(const shape of s.shapes||[])root.append(ofPptShape(shape));
 return root;}
function ofRgba(c,a){const h=ofColor(c),n=parseInt(h.slice(1),16),al=a==null?1:Math.max(0,Math.min(1,Number(a)||0));return 'rgba('+(n>>16&255)+','+(n>>8&255)+','+(n&255)+','+al+')';}
// DrawingML: 0° runs left to right, clockwise. CSS: 0° runs bottom to top, clockwise.
function ofPptCssGrad(g){return 'linear-gradient('+((Number(g.ang)||0)+90)+'deg,'+(g.stops||[]).map(x=>ofRgba(x[1],x[2])+' '+(Number(x[0])||0)*100+'%').join(',')+')';}

function ofPptShape(s){
 const w=(Number(s.w)||0)/OF_EMU,h=(Number(s.h)||0)/OF_EMU,box=el('div','fx-ppt-shape');
 box.style.left=(Number(s.x)||0)/OF_EMU+'px';box.style.top=(Number(s.y)||0)/OF_EMU+'px';box.style.width=w+'px';box.style.height=h+'px';
 if(s.rot)box.style.transform='rotate('+Number(s.rot)+'deg)';
 if(s.k==='placeholder'){box.classList.add('placeholder');box.append(el('div','fx-ppt-label',OF_PH[s.label]||s.label||'对象'));return box;}
 if(s.k==='table'&&s.table){box.append(ofPptTable(s.table));return box;}
 if(s.k==='chart'&&s.chart){box.append(ofPptChart(s.chart,w,h));return box;}
 if(s.k==='image'&&s.asset)box.append(ofPptImage(s,box));
 const svg=ofPptSvg(s,w,h);if(svg)box.append(svg);
 if((s.ps||[]).some(p=>(p.runs||[]).length))box.append(ofPptText(s.ps,s.body));
 return box;}
function ofPptImage(s,box){
 const img=el('img','fx-ppt-img');img.alt=s.name||'图片';img.loading='lazy';img.src=officeImageUrl(s.asset);
 img.onerror=()=>{box.classList.add('placeholder');img.replaceWith(el('div','fx-ppt-label','图片'));};
 const c=s.crop,tr=[];
 if(c){const vw=1-c[0]-c[2],vh=1-c[1]-c[3];img.style.width=100/vw+'%';img.style.height=100/vh+'%';img.style.left=-c[0]/vw*100+'%';img.style.top=-c[1]/vh*100+'%';box.classList.add('clip');}
 if(s.flipH)tr.push('scaleX(-1)');if(s.flipV)tr.push('scaleY(-1)');if(tr.length)img.style.transform=tr.join(' ');
 if(s.geom==='ellipse'){box.classList.add('clip');box.style.borderRadius='50%';}
 if(s.geom==='roundRect'){box.classList.add('clip');box.style.borderRadius=Math.min(Number(s.w),Number(s.h))/OF_EMU*(Number(s.adj?.adj??16667)/1e5)+'px';}
 return img;}

// ─── Shapes as SVG ──────────────────────────────────────────────────────────
function ofSvgNode(tag,attrs){const n=document.createElementNS(OF_SVG,tag);for(const k in attrs)n.setAttribute(k,attrs[k]);return n;}
function ofPptSvg(s,w,h){
 const fill=s.grad||(s.k!=='image'&&s.fill),line=s.line;if(!fill&&!line)return null;
 const parts=s.paths?.length?s.paths.map(x=>({d:ofPptScale(x.d,x.w?w/x.w:1,x.h?h/x.h:1),fill:!x.noFill,stroke:!x.noStroke})):ofPptPreset(s.geom||'rect',w,h,s.adj||{});
 const svg=ofSvgNode('svg',{class:'fx-ppt-svg','aria-hidden':'true'});svg.style.width=Math.max(w,1)+'px';svg.style.height=Math.max(h,1)+'px';
 const defs=ofSvgNode('defs',{});let paint=s.fill?ofColor(s.fill):'none';
 if(s.grad){const id='g'+(++ofPptSeq),a=(Number(s.grad.ang)||0)*Math.PI/180,g=ofSvgNode('linearGradient',{id,x1:50-50*Math.cos(a)+'%',y1:50-50*Math.sin(a)+'%',x2:50+50*Math.cos(a)+'%',y2:50+50*Math.sin(a)+'%'});
  for(const x of s.grad.stops||[])g.append(ofSvgNode('stop',{offset:(Number(x[0])||0)*100+'%','stop-color':ofColor(x[1]),'stop-opacity':String(x[2]??1)}));defs.append(g);paint='url(#'+id+')';}
 const attrs={};
 if(line){const sw=Math.max(.75,(Number(line.w)||0)/OF_EMU);attrs.stroke=ofColor(line.c);attrs['stroke-width']=String(sw);if(line.a!=null)attrs['stroke-opacity']=String(line.a);
  const dash=OF_DASH[line.dash];if(dash)attrs['stroke-dasharray']=dash.map(v=>v*sw).join(' ');
  if(line.head)attrs['marker-start']='url(#'+ofPptMarker(defs,line.head,attrs.stroke,sw)+')';
  if(line.tail)attrs['marker-end']='url(#'+ofPptMarker(defs,line.tail,attrs.stroke,sw)+')';}
 if(defs.childElementCount)svg.append(defs);
 const g=ofSvgNode('g',{});const flip=[];if(s.flipH)flip.push('translate('+w+' 0) scale(-1 1)');if(s.flipV)flip.push('translate(0 '+h+') scale(1 -1)');if(flip.length)g.setAttribute('transform',flip.join(' '));
 for(const part of parts){const a={d:part.d,fill:part.fill===false?'none':paint,...attrs};
  if(part.fill!==false&&s.fa!=null)a['fill-opacity']=String(s.fa);if(part.evenOdd)a['fill-rule']='evenodd';
  if(part.stroke===false||!line){a.stroke='none';delete a['marker-start'];delete a['marker-end'];}
  g.append(ofSvgNode('path',a));}
 svg.append(g);return svg;}
const OF_DASH={sysDot:[1,1],dot:[1,3],sysDash:[3,1],dash:[4,3],dashDot:[4,3,1,3],lgDash:[8,3],lgDashDot:[8,3,1,3],lgDashDotDot:[8,3,1,3,1,3],sysDashDot:[3,1,1,1],sysDashDotDot:[3,1,1,1,1,1]};
// Arrow sizes go by the line, but never as if it were thinner than 2 pt.
function ofPptMarker(defs,end,color,sw){
 const id='m'+(++ofPptSeq),size={sm:2,med:3,lg:5},unit=Math.max(sw,8/3),mw=(size[end[2]]||3)*unit,mh=(size[end[1]]||3)*unit,type=end[0];
 const m=ofSvgNode('marker',{id,viewBox:'0 0 10 10',refX:type==='oval'||type==='diamond'?'5':'10',refY:'5',markerUnits:'userSpaceOnUse',markerWidth:String(mw),markerHeight:String(mh),orient:'auto-start-reverse',preserveAspectRatio:'none'});
 const d={oval:'M0 5a5 5 0 1 0 10 0a5 5 0 1 0-10 0z',diamond:'M5 0L10 5L5 10L0 5z',stealth:'M0 0L10 5L0 10L3 5z',arrow:'M0 0L10 5L0 10L2 5z'}[type]||'M0 0L10 5L0 10z';
 m.append(ofSvgNode('path',{d,fill:color,stroke:'none'}));defs.append(m);return id;}
// A custom path's whole numbers, onto the shape's size.
function ofPptScale(d,sx,sy){let i=0,out='';for(const t of String(d).match(/[A-Z]|-?\d+(?:\.\d+)?/g)||[]){if(t>='A'&&t<='Z'){i=0;out+=t;}else{out+=(i?' ':'')+Math.round(Number(t)*(i%2?sy:sx)*100)/100;i++;}}return out;}
// Preset shapes: DrawingML's formulas for the common ones. Anything else draws as its box.
function ofPptPreset(g,w,h,adj){
 const A=(k,d)=>adj[k]!=null?Number(adj[k]):d,m=Math.min(w,h),closed=d=>[{d}],open=d=>[{d,fill:false}];
 const poly=(...p)=>closed('M'+p.map(q=>q[0]+' '+q[1]).join('L')+'Z');
 const round=(r)=>'M'+r+' 0H'+(w-r)+'A'+r+' '+r+' 0 0 1 '+w+' '+r+'V'+(h-r)+'A'+r+' '+r+' 0 0 1 '+(w-r)+' '+h+'H'+r+'A'+r+' '+r+' 0 0 1 0 '+(h-r)+'V'+r+'A'+r+' '+r+' 0 0 1 '+r+' 0Z';
 const oval='M0 '+h/2+'A'+w/2+' '+h/2+' 0 1 1 '+w+' '+h/2+'A'+w/2+' '+h/2+' 0 1 1 0 '+h/2+'Z';
 const star=(n,inner)=>{const pts=[];for(let i=0;i<n*2;i++){const a=-Math.PI/2+i*Math.PI/n,r=i%2?inner:.5;pts.push([w/2+Math.cos(a)*w*r,h/2+Math.sin(a)*h*r]);}return poly(...pts);};
 switch(g){
  case 'line':case 'straightConnector1':return open('M0 0L'+w+' '+h);
  case 'bentConnector2':return open('M0 0H'+w+'V'+h);
  case 'bentConnector3':case 'bentConnector4':case 'bentConnector5':{const x=w*A('adj1',50000)/1e5;return open('M0 0H'+x+'V'+h+'H'+w);}
  case 'curvedConnector2':return open('M0 0C'+w/2+' 0 '+w+' '+h/2+' '+w+' '+h);
  case 'curvedConnector3':case 'curvedConnector4':case 'curvedConnector5':{const x=w*A('adj1',50000)/1e5;return open('M0 0C'+x/2+' 0 '+x+' '+h/4+' '+x+' '+h/2+'S'+(x+w)/2+' '+h+' '+w+' '+h);}
  case 'roundRect':case 'flowChartAlternateProcess':return closed(round(m*Math.min(.5,A('adj',16667)/1e5)));
  case 'flowChartTerminator':return closed(round(m/2));
  case 'ellipse':case 'flowChartConnector':return closed(oval);
  case 'triangle':case 'flowChartExtract':{const x=w*A('adj',50000)/1e5;return poly([0,h],[x,0],[w,h]);}
  case 'flowChartMerge':return poly([0,0],[w,0],[w/2,h]);
  case 'rtTriangle':return poly([0,0],[w,h],[0,h]);
  case 'diamond':case 'flowChartDecision':return poly([w/2,0],[w,h/2],[w/2,h],[0,h/2]);
  case 'parallelogram':case 'flowChartInputOutput':{const x=m*A('adj',25000)/1e5;return poly([x,0],[w,0],[w-x,h],[0,h]);}
  case 'trapezoid':{const x=m*A('adj',25000)/1e5;return poly([x,0],[w-x,0],[w,h],[0,h]);}
  case 'flowChartManualOperation':return poly([0,0],[w,0],[w*.8,h],[w*.2,h]);
  case 'pentagon':return poly([w/2,0],[w,h*.382],[w*.81,h],[w*.19,h],[0,h*.382]);
  case 'homePlate':{const x=w-m*A('adj',50000)/1e5;return poly([0,0],[x,0],[w,h/2],[x,h],[0,h]);}
  case 'chevron':{const x=m*A('adj',50000)/1e5;return poly([0,0],[w-x,0],[w,h/2],[w-x,h],[0,h],[x,h/2]);}
  case 'hexagon':{const x=m*A('adj',25000)/1e5;return poly([x,0],[w-x,0],[w,h/2],[w-x,h],[x,h],[0,h/2]);}
  case 'octagon':{const x=m*A('adj',29289)/1e5;return poly([x,0],[w-x,0],[w,x],[w,h-x],[w-x,h],[x,h],[0,h-x],[0,x]);}
  case 'plus':case 'flowChartOr':{const x=m*A('adj',25000)/1e5;return poly([x,0],[w-x,0],[w-x,x],[w,x],[w,h-x],[w-x,h-x],[w-x,h],[x,h],[x,h-x],[0,h-x],[0,x],[x,x]);}
  case 'star4':return star(4,A('adj',12500)/1e5);case 'star5':return star(5,.19);case 'star6':return star(6,.29);case 'star8':return star(8,A('adj',37500)/1e5);
  case 'rightArrow':case 'leftArrow':{const t=h*A('adj1',50000)/2e5,l=m*A('adj2',50000)/1e5;const a=[[0,h/2-t],[w-l,h/2-t],[w-l,0],[w,h/2],[w-l,h],[w-l,h/2+t],[0,h/2+t]];return poly(...(g==='rightArrow'?a:a.map(q=>[w-q[0],q[1]])));}
  case 'upArrow':case 'downArrow':{const t=w*A('adj1',50000)/2e5,l=m*A('adj2',50000)/1e5;const a=[[w/2-t,0],[w/2-t,h-l],[0,h-l],[w/2,h],[w,h-l],[w/2+t,h-l],[w/2+t,0]];return poly(...(g==='downArrow'?a:a.map(q=>[q[0],h-q[1]])));}
  case 'leftRightArrow':{const t=h*A('adj1',50000)/2e5,l=m*A('adj2',50000)/1e5;return poly([0,h/2],[l,0],[l,h/2-t],[w-l,h/2-t],[w-l,0],[w,h/2],[w-l,h],[w-l,h/2+t],[l,h/2+t],[l,h]);}
  case 'upDownArrow':{const t=w*A('adj1',50000)/2e5,l=m*A('adj2',50000)/1e5;return poly([w/2,0],[w,l],[w/2+t,l],[w/2+t,h-l],[w,h-l],[w/2,h],[0,h-l],[w/2-t,h-l],[w/2-t,l],[0,l]);}
  case 'can':case 'flowChartMagneticDisk':{const r=m*A('adj',25000)/2e5;return [{d:'M0 '+r+'A'+w/2+' '+r+' 0 0 1 '+w+' '+r+'V'+(h-r)+'A'+w/2+' '+r+' 0 0 1 0 '+(h-r)+'Z'},{d:'M0 '+r+'A'+w/2+' '+r+' 0 0 0 '+w+' '+r,fill:false}];}
  case 'donut':{const t=m*A('adj',25000)/1e5,rx=w/2-t,ry=h/2-t;return [{d:oval+'M'+t+' '+h/2+'A'+rx+' '+ry+' 0 1 0 '+(w-t)+' '+h/2+'A'+rx+' '+ry+' 0 1 0 '+t+' '+h/2+'Z',evenOdd:true}];}
  case 'foldedCorner':{const x=m*A('adj',16667)/1e5;return [{d:'M0 0H'+w+'V'+(h-x)+'L'+(w-x)+' '+h+'H0Z'},{d:'M'+(w-x)+' '+h+'V'+(h-x)+'H'+w,fill:false}];}
  case 'flowChartDocument':return closed('M0 0H'+w+'V'+h*.83+'C'+w*.75+' '+h*.7+' '+w*.25+' '+h*1.05+' 0 '+h*.9+'Z');
  case 'wedgeRectCallout':case 'wedgeRoundRectCallout':case 'wedgeEllipseCallout':{
   const tx=w/2+w*A('adj1',-20833)/1e5,ty=h/2+h*A('adj2',62500)/1e5;const box=g==='wedgeEllipseCallout'?oval:g==='wedgeRoundRectCallout'?round(m*.16667):'M0 0H'+w+'V'+h+'H0Z';
   const bw=Math.min(w,h)*.12;return [{d:box},{d:'M'+(w/2-bw)+' '+h/2+'L'+tx+' '+ty+'L'+(w/2+bw)+' '+h/2+'Z'}];}
  case 'leftBracket':return open('M'+w+' 0C'+w*.3+' 0 0 '+h*.05+' 0 '+h*.15+'V'+h*.85+'C0 '+h*.95+' '+w*.3+' '+h+' '+w+' '+h);
  case 'rightBracket':return open('M0 0C'+w*.7+' 0 '+w+' '+h*.05+' '+w+' '+h*.15+'V'+h*.85+'C'+w+' '+h*.95+' '+w*.7+' '+h+' 0 '+h);
  case 'leftBrace':return open('M'+w+' 0C'+w*.5+' 0 '+w/2+' '+h*.1+' '+w/2+' '+h*.2+'V'+h*.4+'C'+w/2+' '+h*.47+' 0 '+h*.5+' 0 '+h*.5+'C0 '+h*.5+' '+w/2+' '+h*.53+' '+w/2+' '+h*.6+'V'+h*.8+'C'+w/2+' '+h*.9+' '+w*.5+' '+h+' '+w+' '+h);
  case 'rightBrace':return open('M0 0C'+w*.5+' 0 '+w/2+' '+h*.1+' '+w/2+' '+h*.2+'V'+h*.4+'C'+w/2+' '+h*.47+' '+w+' '+h*.5+' '+w+' '+h*.5+'C'+w+' '+h*.5+' '+w/2+' '+h*.53+' '+w/2+' '+h*.6+'V'+h*.8+'C'+w/2+' '+h*.9+' '+w*.5+' '+h+' 0 '+h);
  case 'arc':{const s=A('adj1',16200000)/6e4*Math.PI/180,e=A('adj2',0)/6e4*Math.PI/180,x=a=>w/2+w/2*Math.cos(a),y=a=>h/2+h/2*Math.sin(a),big=((e-s+2*Math.PI)%(2*Math.PI))>Math.PI?1:0;return open('M'+x(s)+' '+y(s)+'A'+w/2+' '+h/2+' 0 '+big+' 1 '+x(e)+' '+y(e));}
  default:return closed('M0 0H'+w+'V'+h+'H0Z');}}

// ─── Text ───────────────────────────────────────────────────────────────────
function ofPptText(ps,b){
 b=b||{};const t=el('div','fx-ppt-text'),ins=(b.ins||[91440,45720,91440,45720]).map(v=>(Number(v)||0)/OF_EMU);
 t.style.padding=ins[1]+'px '+ins[2]+'px '+ins[3]+'px '+ins[0]+'px';
 if(b.anchor)t.style.justifyContent=b.anchor==='center'?'center':'flex-end';
 if(b.nowrap)t.classList.add('nowrap');
 if(b.center)t.style.alignItems='center';
 if(b.vert){t.style.writingMode='vertical-rl';if(b.vert==='vert')t.style.textOrientation='sideways';if(b.vert==='vert270'){t.style.textOrientation='sideways';t.style.transform='rotate(180deg)';}}
 for(const p of ps||[])t.append(ofPptParagraph(p));
 return t;}
function ofPptParagraph(p){
 const n=el('div','fx-ppt-p'),pp=p.pp||{},px=v=>(Number(v)||0)*4/3;
 n.style.fontSize=px(pp.pt||18)+'px';
 if(p.al)n.style.textAlign=p.al;
 if(pp.mar)n.style.paddingLeft=px(pp.mar)+'px';
 if(pp.ind)n.style.textIndent=px(pp.ind)+'px';
 if(pp.ln)n.style.lineHeight=String(1.2*Number(pp.ln));else if(pp.lnPt)n.style.lineHeight=px(pp.lnPt)+'px';
 if(pp.bef)n.style.marginTop=px(pp.bef)+'px';
 if(pp.aft)n.style.marginBottom=px(pp.aft)+'px';
 if(pp.color)n.style.color=ofColor(pp.color);
 const runs=p.runs||[];
 if(p.marker!=null){const m=el('span','fx-ppt-marker',p.marker);
  if(pp.ind<0)m.style.minWidth=px(-pp.ind)+'px';else m.style.marginRight='.4em';
  const c=pp.mc||runs[0]?.color;if(c)m.style.color=ofColor(c);
  const sz=(Number(runs[0]?.sz)||pp.pt||18)*(Number(pp.ms)||1);m.style.fontSize=px(sz)+'px';n.append(m);}
 for(const r of runs)n.append(ofPptRun(r));
 if(!runs.length)n.append('​');
 return n;}
function ofPptRun(r){
 const n=el('span','fx-ppt-run',r.t||''),px=(Number(r.sz)||18)*4/3;
 n.style.fontSize=px+'px';
 if(r.bl){n.style.verticalAlign=r.bl>0?'super':'sub';n.style.fontSize=px*.66+'px';}
 if(r.b)n.style.fontWeight='700';
 if(r.i)n.style.fontStyle='italic';
 if(r.u||r.s){const d=[];if(r.u)d.push('underline');if(r.s)d.push('line-through');n.style.textDecoration=d.join(' ');}
 if(r.color)n.style.color=ofColor(r.color);
 return n;}

// ─── Tables ─────────────────────────────────────────────────────────────────
function ofPptTable(t){
 const tbl=el('table','fx-ppt-table'),cols=document.createElement('colgroup');
 for(const w of t.cols||[]){const c=document.createElement('col');c.style.width=(Number(w)||0)/OF_EMU+'px';cols.append(c);}
 tbl.append(cols);const side={L:'Left',R:'Right',T:'Top',B:'Bottom'};
 for(const r of t.rows||[]){const tr=document.createElement('tr');tr.style.height=(Number(r.h)||0)/OF_EMU+'px';
  for(const c of r.cells||[]){if(c.covered)continue;const td=document.createElement('td');
   if(c.span>1)td.colSpan=c.span;if(c.rowSpan>1)td.rowSpan=c.rowSpan;
   const ins=(c.body?.ins||[91440,45720,91440,45720]).map(v=>(Number(v)||0)/OF_EMU);td.style.padding=ins[1]+'px '+ins[2]+'px '+ins[3]+'px '+ins[0]+'px';
   td.style.verticalAlign=c.body?.anchor==='center'?'middle':c.body?.anchor==='bottom'?'bottom':'top';
   if(c.fill)td.style.background=ofRgba(c.fill,c.fa);
   for(const k in c.borders||{}){const l=c.borders[k];if(!side[k])continue;td.style['border'+side[k]]=Math.max(.75,(Number(l.w)||0)/OF_EMU)+'px '+(l.dash?'dashed':'solid')+' '+ofRgba(l.c,l.a);}
   for(const p of c.ps||[])td.append(ofPptParagraph(p));
   tr.append(td);}
  tbl.append(tr);}
 return tbl;}

// ─── Charts: the chart's own cached numbers, drawn plainly. ─────────────────
function ofChartNum(v,fmt,pct){
 if(pct)return Math.round(v*100)+'%';
 const f=String(fmt||'');if(/%/.test(f)){const d=(f.match(/\.(0+)/)||[,''])[1].length;return (v*100).toFixed(d)+'%';}
 const d=f.match(/^[^.]*\.(0+)/);if(d)return v.toFixed(d[1].length);
 return String(Math.round(v*1000)/1000);}
// A rough width of text, to leave room for labels before they are drawn.
function ofChartWidth(t,px){let w=0;for(const c of String(t))w+=c.charCodeAt(0)>255?1:.56;return w*px;}
function ofPptChart(c,W,H){
 const svg=ofSvgNode('svg',{class:'fx-ppt-svg','aria-hidden':'true'});svg.style.width=Math.max(W,1)+'px';svg.style.height=Math.max(H,1)+'px';
 const ink=ofColor(c.ink||'#000000'),muted=ofRgba(ink,.25),px=v=>(Number(v)||10)*4/3;
 const text=(t,x,y,size,anchor='middle',fill=ink,weight)=>{const n=ofSvgNode('text',{x,y,'font-size':size,'text-anchor':anchor,fill,stroke:'none','dominant-baseline':'central'});if(weight)n.setAttribute('font-weight',weight);n.textContent=t;svg.append(n);return n;};
 const line=(x1,y1,x2,y2,color=muted,w=1)=>svg.append(ofSvgNode('line',{x1,y1,x2,y2,stroke:color,'stroke-width':w}));
 const rect=(x,y,w,h,fill)=>svg.append(ofSvgNode('rect',{x,y,width:Math.max(0,w),height:Math.max(0,h),fill,stroke:'none'}));
 let top=6,bottom=H-6,left=6,right=W-6;
 if(c.title){const s=px(c.titlePt);text(c.title,W/2,top+s*.7,s);top+=s*1.5;}
 const series=c.series||[],cats=c.cats||[],round=c.kind==='pie'||c.kind==='doughnut';
 // Legend: one row at the top or bottom, a column at the side.
 const names=round?cats:series.map(s=>s.name);
 if(c.legend&&names.some(Boolean)){const s=px(c.legendPt),key=s*.7,colorOf=i=>round?(series[0]?.points?.[i]||series[0]?.color):series[i]?.color;
  if(c.legend==='t'||c.legend==='b'){const y=c.legend==='t'?top+s*.7:bottom-s*.7;let total=0;const ws=names.map(n=>{const w=key+s*.3+ofChartWidth(n,s)+s;total+=w;return w;});let x=Math.max(left,(W-total)/2);
   names.forEach((n,i)=>{rect(x,y-key/2,key,key,ofColor(colorOf(i)));text(n,x+key+s*.3,y,s,'start');x+=ws[i];});if(c.legend==='t')top+=s*1.5;else bottom-=s*1.5;}
  else{const w=Math.min(W*.35,Math.max(...names.map(n=>ofChartWidth(n,s)))+key+s*.6),x=c.legend==='l'?left:right-w;let y=(top+bottom)/2-names.length*s*.7+s*.7;
   names.forEach((n,i)=>{rect(x,y-key/2,key,key,ofColor(colorOf(i)));text(n,x+key+s*.3,y,s,'start');y+=s*1.4;});if(c.legend==='l')left+=w+s*.5;else right-=w+s*.5;}}
 if(round){ofChartPie(svg,c,text,left,top,right,bottom,px);return svg;}
 // Scale: from zero unless the values or the file say otherwise, up to a round number.
 const stacked=!!c.stack,all=[];
 if(stacked)for(let i=0;i<cats.length;i++){let up=0,down=0,sum=0;for(const s of series){const v=s.values[i]||0;sum+=Math.abs(v);if(v>0)up+=v;else down+=v;}all.push(c.stack==='percentStacked'?(sum?100:0):up,c.stack==='percentStacked'?0:down);}
 else for(const s of series)for(const v of s.values)if(v!=null)all.push(v);
 let lo=c.min??Math.min(0,...all),hi=c.max??Math.max(0,...all);if(hi===lo)hi=lo+1;
 const step=c.max==null||c.min==null?(()=>{const raw=(hi-lo)/5,mag=Math.pow(10,Math.floor(Math.log10(raw))),n=raw/mag;return (n<=1?1:n<=2?2:n<=5?5:10)*mag;})():(hi-lo)/5;
 if(c.max==null)hi=Math.ceil(hi/step-1e-9)*step;if(c.min==null&&lo<0)lo=Math.floor(lo/step+1e-9)*step;
 const fmtAxis=v=>String(Math.round(v*1000)/1000)+(c.stack==='percentStacked'?'%':'');
 const horizontal=c.kind==='bar'&&c.horizontal,catPx=px(c.catPt),valPx=px(c.valPt);
 const labelW=c.noCatAxis?0:Math.min((right-left)*.48,Math.max(0,...cats.map(t=>ofChartWidth(t,catPx)))+catPx*.5);
 const valW=c.noValAxis?0:Math.max(ofChartWidth(fmtAxis(hi),valPx),ofChartWidth(fmtAxis(lo),valPx))+valPx*.5;
 const labelled=series.some(s=>s.showVal);
 const room=labelled&&horizontal?ofChartWidth(ofChartNum(hi,series[0].fmt),px(series[0].labelPt||c.valPt))+8:0;
 const x0=left+(horizontal?labelW:valW),x1=right-(horizontal?room:0),y0=top+(labelled&&!horizontal?px(series[0].labelPt||c.valPt)*1.4:0);
 const y1=bottom-(horizontal?(c.noValAxis?0:valPx*1.4):(c.noCatAxis?0:catPx*1.4));
 const n=Math.max(1,cats.length);
 // Value → position along the value axis; band i → position along the category axis.
 const vp=v=>horizontal?x0+(v-lo)/(hi-lo)*(x1-x0):y1-(v-lo)/(hi-lo)*(y1-y0);
 const span=horizontal?y1-y0:x1-x0;
 const band=c.kind==='bar'?span/n:span/Math.max(1,c.kind==='scatter'?n:n);
 const at=i=>{const k=horizontal&&!c.reverse||!horizontal&&c.reverse?n-1-i:i;return (horizontal?y0:x0)+k*band;};
 for(let v=lo;v<=hi+step/1000;v+=step){const p=vp(v);
  if(c.grid)horizontal?line(p,y0,p,y1):line(x0,p,x1,p);
  if(!c.noValAxis)horizontal?text(fmtAxis(v),p,y1+valPx*.7,valPx):text(fmtAxis(v),x0-valPx*.3,p,valPx,'end');}
 horizontal?line(vp(Math.max(lo,0)),y0,vp(Math.max(lo,0)),y1,ofRgba(ink,.45)):line(x0,vp(Math.max(lo,0)),x1,vp(Math.max(lo,0)),ofRgba(ink,.45));
 if(!c.noCatAxis&&c.kind!=='scatter')cats.forEach((t,i)=>{const m=at(i)+band/2;horizontal?text(t,x0-catPx*.3,m,catPx,'end'):text(t,m,y1+catPx*.7,catPx);});
 const zero=vp(Math.max(lo,Math.min(hi,0)));
 if(c.kind==='bar'){
  const thick=band/(1+(Number(c.gap)||0)/100),each=stacked?thick:thick/Math.max(1,series.length);
  for(let i=0;i<n;i++){let up=0,down=0,sum=0;if(c.stack==='percentStacked')for(const s of series)sum+=Math.abs(s.values[i]||0);
   series.forEach((s,k)=>{let v=s.values[i];if(v==null)return;if(sum)v=v/sum*100;
    const from=stacked?(v>=0?up:down):0,to=from+v;if(stacked){if(v>=0)up=to;else down=to;}
    const a=vp(from),b=vp(to),off=at(i)+(band-thick)/2+(stacked?0:k*each),fill=ofColor(s.points?.[i]||s.color);
    horizontal?rect(Math.min(a,b),off,Math.abs(b-a),each,fill):rect(off,Math.min(a,b),each,Math.abs(b-a),fill);
    if(s.showVal){const size=px(s.labelPt||c.valPt),t=ofChartNum(s.values[i],s.fmt);horizontal?text(t,Math.max(a,b)+4,off+each/2,size,'start'):text(t,off+each/2,Math.min(a,b)-size*.6,size);}});}
 }else{
  series.forEach(s=>{const color=ofColor(s.color),xy=[];
   const xs=s.xs,xLo=xs?Math.min(...xs.filter(v=>v!=null)):0,xHi=xs?Math.max(...xs.filter(v=>v!=null)):1;
   s.values.forEach((v,i)=>{if(v==null)return;const x=xs&&xs[i]!=null?x0+(xs[i]-xLo)/((xHi-xLo)||1)*(x1-x0):at(i)+band/2;xy.push([x,vp(v),v]);});
   if(!xy.length)return;const d='M'+xy.map(q=>q[0]+' '+q[1]).join('L');
   if(c.kind==='area')svg.append(ofSvgNode('path',{d:d+'L'+xy[xy.length-1][0]+' '+zero+'L'+xy[0][0]+' '+zero+'Z',fill:color,'fill-opacity':'.75',stroke:'none'}));
   else{if(c.kind==='line')svg.append(ofSvgNode('path',{d,fill:'none',stroke:color,'stroke-width':2.5}));
    for(const q of xy)svg.append(ofSvgNode('circle',{cx:q[0],cy:q[1],r:3.5,fill:color,stroke:'none'}));}
   if(s.showVal)for(const q of xy)text(ofChartNum(q[2],s.fmt),q[0],q[1]-px(s.labelPt||c.valPt)*.8,px(s.labelPt||c.valPt));});}
 return svg;}
function ofChartPie(svg,c,text,left,top,right,bottom,px){
 const s=c.series[0],vals=s.values.map(v=>Math.max(0,v||0)),total=vals.reduce((a,b)=>a+b,0)||1,cx=(left+right)/2,cy=(top+bottom)/2,r=Math.max(4,Math.min(right-left,bottom-top)/2-4),hole=c.kind==='doughnut'?r*(Number(c.hole)||50)/100:0;
 let a=-Math.PI/2;
 vals.forEach((v,i)=>{const sweep=v/total*2*Math.PI;if(!sweep)return;const b=a+Math.min(sweep,2*Math.PI-1e-4),big=sweep>Math.PI?1:0,pt=(rad,ang)=>(cx+rad*Math.cos(ang))+' '+(cy+rad*Math.sin(ang));
  const d=hole?'M'+pt(r,a)+'A'+r+' '+r+' 0 '+big+' 1 '+pt(r,b)+'L'+pt(hole,b)+'A'+hole+' '+hole+' 0 '+big+' 0 '+pt(hole,a)+'Z':'M'+cx+' '+cy+'L'+pt(r,a)+'A'+r+' '+r+' 0 '+big+' 1 '+pt(r,b)+'Z';
  svg.append(ofSvgNode('path',{d,fill:ofColor(s.points?.[i]||s.color),stroke:'#fff','stroke-width':1}));
  if(s.showVal||s.showPct||s.showCat){const m=a+sweep/2,rr=hole?(r+hole)/2:r*.65,bits=[];if(s.showCat&&c.cats?.[i])bits.push(c.cats[i]);if(s.showVal)bits.push(ofChartNum(v,s.fmt));if(s.showPct)bits.push(Math.round(v/total*100)+'%');
   text(bits.join(' '),cx+rr*Math.cos(m),cy+rr*Math.sin(m),px(s.labelPt||c.valPt));}
  a+=sweep;});}

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
  n.append(ofChip('',()=>officeZoom(p,1/1.25),'fMinus',false,'缩小'));
  n.append(ofChip('',()=>officeZoom(p,1.25),'plus',false,'放大'));
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
  const b=document.getElementById('fx-body'),at=b?b.scrollTop/Math.max(1,b.scrollHeight):0;ofPptSize(p);if(b)b.scrollTop=at*b.scrollHeight;
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
