'use strict';
// Markdown → DOM for agent replies. Never uses innerHTML: remote text only ever becomes text nodes.
// markdown(text, opts) returns an Element. opts.fold=false disables folding of long messages.

// 机器附带的引用/指令块对人没有意义：整段去掉（代码块内保留原样）。
const MD_NOISE=/<(oai-[\w-]+|citation_entries|rollout_ids|system-reminder|antml:[\w-]+)\b[^>]*>[\s\S]*?<\/\1>|<oai-[\w-]+\b[^>]*\/>|^[ \t]*::[\w-]+\{[^\n]*\}[ \t]*$/gm;
const MD_ITEM=/^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const MD_FENCE=/^( *)(`{3,}|~{3,})\s*([^\s`]*)/;
const MD_HR=/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const MD_TABLE_SEP=/^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/;
const MD_FOLD_PX=520, mdExpanded=new Set();

function mdClean(text){
 const out=[];let fence=null,chunk=[];
 const flush=()=>{if(chunk.length)out.push(chunk.join('\n').replace(MD_NOISE,''));chunk=[];};
 for(const line of String(text||'').replace(/\r\n?/g,'\n').replace(/\t/g,'    ').split('\n')){
  const f=line.match(MD_FENCE);
  if(fence){out.push(line);if(f&&f[2][0]===fence[0]&&f[2].length>=fence.length&&!line.slice(f[0].length).trim())fence=null;continue;}
  if(f){flush();fence=f[2];out.push(line);continue;}
  chunk.push(line);}
 flush();
 return out.join('\n').replace(/\n{3,}/g,'\n\n').replace(/^\s+\n/,'').trimEnd();}

// ---------- inline ----------
const MD_INLINE=new RegExp([
 String.raw`\\[\\\x60*_{}\[\]()#+\-.!|<>~]`,         // escape
 String.raw`(\x60+)[\s\S]*?[^\x60]\1(?!\x60)`, // code span
 String.raw`<br\s*\/?>`,                               // agents put <br> in table cells
 String.raw`<https?:\/\/[^>\s]+>`,                     // autolink
 String.raw`!?\[[^\]\n]+\]\([^)\s]+(?:\s+"[^"]*")?\)`, // link / image
 String.raw`\*\*(?=\S)[^\n]*?\S\*\*(?!\*)`,            // bold (no flanking rules: "**可以，**而且")
 String.raw`(?<![\w\x60])__(?=\S)[^\n]*?\S__(?!\w)`,
 String.raw`~~(?=\S)[^\n~]*?\S~~`,
 String.raw`(?<![\w*\\])\*(?![\s*])[^*\n]*?[^\s*\\]\*(?![\w*])`, // italic; not 2*3*4 or *.py
 String.raw`https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+`,
 String.raw`(?<![\w/.~-])(?:~|\.{1,2})?\/?(?:[\w.@+-]+\/)+[\w.@+-]*\.[A-Za-z][\w]{0,7}(?::\d+(?:[-:]\d+)?)?(?![\w/])`, // path/file.ext[:12]
 String.raw`(?<![\w/.~-])(?:~|\.{1,2})?\/(?:[\w.@+-]+\/)+[\w.@+-]+(?![\w/])`, // absolute dir
 String.raw`(?<![\w/.-])[\w.@+-]+\.[A-Za-z][\w]{0,7}:\d+(?:[-:]\d+)?(?![\w])`, // file.py:123
].join('|'),'g');

function mdTrimUrl(u){
 let t=u.replace(/[.,;:!?'"*]+$/,'');
 while(/[)\]]$/.test(t)){const o=t.endsWith(')')?'(':'[',c=t.slice(-1);if(t.split(o).length<t.split(c).length)t=t.slice(0,-1).replace(/[.,;:!?'"]+$/,'');else break;}
 return t;}
function mdShortUrl(u){
 try{const x=new URL(u);let s=x.host+x.pathname.replace(/\/$/,'')+(x.search?'?…':'');if(s.length>44){const parts=x.pathname.split('/').filter(Boolean);s=x.host+(parts.length>1?'/…/':'/')+(parts.at(-1)||'');if(s.length>48)s=s.slice(0,46)+'…';}return s;}catch(_){return u;}}
function mdCopyable(node,value,hint){
 node.tabIndex=0;node.setAttribute('role','button');node.title=value;node.setAttribute('aria-label',hint+'：'+value+'，点按复制');
 node.onclick=e=>{if(getSelection&&String(getSelection()).length)return;e.stopPropagation();copyText(value);};
 node.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();copyText(value);}};return node;}
function mdUrl(href,label){const a=el('span','md-link',label===undefined?mdShortUrl(href):label);return mdCopyable(a,href,'链接');}
function mdFile(ref,label){const a=el('span','md-file',label===undefined?ref:label);return mdFileNode(a,ref);}
// In the app a tapped path opens its sheet (timeline.js fileSheet: copy, and this chat's edits to it).
function mdFileNode(node,ref){
 mdCopyable(node,ref,'文件');if(typeof fileSheet!=='function')return node;
 const open=()=>fileSheet(ref);node.setAttribute('aria-label','文件：'+ref+'，点按查看');
 node.onclick=e=>{if(getSelection&&String(getSelection()).length)return;e.stopPropagation();open();};
 node.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}};return node;}
const mdIsLocal=h=>/^(?:\/|~\/|\.{1,2}\/|file:)/.test(h)||(!/^[a-z][\w+.-]*:\/\//i.test(h)&&/[\w-]\.[A-Za-z]\w{0,7}(?:[:#]L?\d+.*)?$/.test(h));
function mdLocalRef(h){
 let p=h.replace(/^file:\/\//,'');try{p=decodeURI(p);}catch(_){}const line=p.match(/(?:#L|:)(\d+)(?:[-:]L?(\d+))?$/);p=p.replace(/(?:#L\d+(?:-L?\d+)?|:\d+(?:[-:]\d+)?)$/,'');
 return line?p+':'+line[1]+(line[2]?'-'+line[2]:''):p;}

function inline(text,parent){
 let last=0,m;const re=new RegExp(MD_INLINE.source,'g');
 const add=s=>{if(s)parent.append(document.createTextNode(s));};
 while((m=re.exec(text))){
  let t=m[0];const at=m.index;
  if(/^https?:/.test(t)){const u=mdTrimUrl(t);if(u.length<t.length){t=u;re.lastIndex=at+t.length;}}
  add(text.slice(last,at));last=at+t.length;
  if(t[0]==='\\'){add(t[1]);continue;}
  if(t[0]==='`'){const n=t.match(/^`+/)[0].length;let c=t.slice(n,-n);if(/^ .*[^ ] $/.test(c)||/^ [^ ] $/.test(c))c=c.slice(1,-1);
   const code=el('code','',c);
   if(/^(?:~|\.{0,2}\/)?(?:[\w.@+-]+\/)*[\w.@+-]+\.[A-Za-z]\w{0,7}(?::\d+(?:[-:,]\d+)*)?$/.test(c)&&(c.includes('/')||/:\d/.test(c))){code.className='md-file';mdFileNode(code,c);}
   parent.append(code);continue;}
  if(/^<br/i.test(t)){parent.append(el('br'));continue;}
  if(t[0]==='<'){parent.append(mdUrl(t.slice(1,-1)));continue;}
  if(t[0]==='['||t.startsWith('![')){
   const img=t[0]==='!',s=img?t.slice(1):t,i=s.indexOf('](');let label=s.slice(1,i),href=s.slice(i+2,-1).replace(/\s+"[^"]*"$/,'');
   if(img)label='图片：'+label;
   if(mdIsLocal(href)){const ref=mdLocalRef(href);const span=mdFile(ref,'');inline(label,span);parent.append(span);}
   else if(/^https?:/i.test(href)){const span=mdUrl(href,'');inline(label,span);parent.append(span);}
   else inline(label,parent);
   continue;}
  if(t.startsWith('**')||t.startsWith('__')){inline(t.slice(2,-2),parent.appendChild(el('strong')));continue;}
  if(t.startsWith('~~')){inline(t.slice(2,-2),parent.appendChild(el('del')));continue;}
  if(t[0]==='*'){inline(t.slice(1,-1),parent.appendChild(el('em')));continue;}
  if(/^https?:/.test(t)){parent.append(mdUrl(t));continue;}
  parent.append(mdFile(t));}
 add(text.slice(last));return parent;}

// ---------- blocks ----------
const mdIndent=s=>s.match(/^ */)[0].length;
const mdDedent=(s,n)=>s.slice(Math.min(n,mdIndent(s)));
const mdBlank=s=>!s||!s.trim();
function mdIsTable(lines,i){const a=lines[i]||'',b=lines[i+1]||'';return a.includes('|')&&b.includes('|')&&MD_TABLE_SEP.test(b)&&mdCells(a).length>=Math.min(2,mdCells(b).length);}
function mdStartsBlock(lines,i){const s=lines[i];return MD_FENCE.test(s)&&mdIndent(s)<4||/^ {0,3}#{1,6}(\s|$)/.test(s)||MD_HR.test(s)||/^ {0,3}>/.test(s)||MD_ITEM.test(s)&&mdIndent(s)<4&&!!(s.match(MD_ITEM)[3]||'').trim()||mdIsTable(lines,i);}
function mdCells(row){
 const s=row.trim().replace(/^\|/,'').replace(/(?<!\\)\|$/,'');const out=[];let cur='',tick=0;
 for(let k=0;k<s.length;k++){const c=s[k];
  if(c==='\\'&&s[k+1]==='|'){cur+='|';k++;continue;}
  if(c==='`'){let n=1;while(s[k+n]==='`')n++;tick=tick===n?0:(tick||n);cur+=s.slice(k,k+n);k+=n-1;continue;}
  if(c==='|'&&!tick){out.push(cur.trim());cur='';continue;}
  cur+=c;}
 out.push(cur.trim());return out;}

function markdown(text,opts){
 opts=opts||{};const src=mdClean(text);
 const root=el('div','md');mdBlocks(src.split('\n'),root,true);
 if(opts.fold===false||(src.length<900&&src.split('\n').length<22))return root;
 return mdFold(root,src);}

function mdBlocks(lines,root,top){
 let i=0,firstPara=top;
 while(i<lines.length){
  const line=lines[i];
  if(mdBlank(line)){i++;continue;}
  const fence=line.match(MD_FENCE);
  if(fence&&mdIndent(line)<4){
   const ind=fence[1].length,end=fence[2],buf=[];i++;
   while(i<lines.length){const f=lines[i].match(MD_FENCE);if(f&&f[2][0]===end[0]&&f[2].length>=end.length&&!lines[i].slice(f[0].length).trim()){i++;break;}buf.push(mdDedent(lines[i],ind));i++;}
   root.append(codeBlock(buf.join('\n').replace(/\n+$/,''),fence[3]));firstPara=false;continue;}
  const h=line.match(/^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/);
  if(h){const lv=h[1].length;root.append(inline(h[2]||'',el('h'+Math.min(6,lv+2),'md-h md-h'+lv)));i++;firstPara=false;continue;}
  if(MD_HR.test(line)){root.append(el('hr'));i++;continue;}
  if(mdIsTable(lines,i)){i=mdTable(lines,i,root);firstPara=false;continue;}
  if(/^ {0,3}>/.test(line)){
   const buf=[];while(i<lines.length&&!mdBlank(lines[i])&&(/^ {0,3}>/.test(lines[i])||buf.length&&!mdStartsBlock(lines,i)))buf.push(lines[i++].replace(/^ {0,3}> ?/,''));
   const q=el('blockquote');mdBlocks(buf,q,false);root.append(q);firstPara=false;continue;}
  const it=line.match(MD_ITEM);
  if(it&&((it[3]||'').trim()||!mdBlank(lines[i+1])&&mdIndent(lines[i+1])>mdIndent(line))){i=mdList(lines,i,root);firstPara=false;continue;}
  const para=[];
  while(i<lines.length&&!mdBlank(lines[i])&&(!para.length||!mdStartsBlock(lines,i)))para.push(lines[i++].trim());
  const p=el('p');para.forEach((t,k)=>{if(k)p.append(el('br'));inline(t.replace(/\\$/,''),p);});
  if(firstPara)mdLead(p);firstPara=false;root.append(p);}
 return root;}

// 首段以加粗句开头时，它就是结论：单独成行、字号略大。
function mdLead(p){
 const s=p.firstChild;if(!s||s.nodeName!=='STRONG')return;
 p.classList.add('md-lead');
 if(s.nextSibling&&/[。！？.!?：:；]\s*$/.test(s.textContent))s.classList.add('md-takeaway');}

function mdTable(lines,i,root){
 const head=mdCells(lines[i]),sep=mdCells(lines[i+1]);
 const align=sep.map(c=>/^:-+:$/.test(c)?'center':/-:$/.test(c)?'right':'');
 const rows=[];i+=2;
 while(i<lines.length&&!mdBlank(lines[i])&&lines[i].includes('|')&&!MD_FENCE.test(lines[i])){const r=mdCells(lines[i]);while(r.length<head.length)r.push('');rows.push(r.slice(0,head.length));i++;}
 // 估算自然宽度：CJK 记 2，其余 1；每列封顶后求和。超过手机可读宽度就在窄屏改成卡片。
 const w=s=>{let n=0;for(const ch of s.replace(/\*\*|`|\\/g,''))n+=ch.charCodeAt(0)>0x2e7f?2:1;return n;};
 const cols=head.map((h,c)=>Math.min(30,Math.max(w(h),...rows.map(r=>w(r[c]||'')))));
 // 约 7px 一个单位、每列 20px 内边距；手机气泡内容宽约 340px。
 const wide=(head.length>2||cols.some(c=>c>=24))&&cols.reduce((a,b)=>a+b*7+20,0)>340;
 const box=el('div','table-box'+(wide?' wide':'')),wrap=el('div','table-wrap');
 const table=el('table');const thead=el('thead');const tr=el('tr');
 head.forEach((c,k)=>{const th=inline(c,el('th'));if(align[k])th.style.textAlign=align[k];tr.append(th);});thead.append(tr);table.append(thead);
 const tb=el('tbody');rows.forEach(r=>{const row=el('tr');r.forEach((c,k)=>{const td=inline(c,el('td'));if(align[k])td.style.textAlign=align[k];if(w(c)>24)td.className='long';row.append(td);});tb.append(row);});table.append(tb);
 wrap.append(table);box.append(wrap);root.append(box);mdScrollHints(box,wrap);
 if(wide){
  // 窄屏下每行变成一张卡片：短的首列（优先级、序号）当徽标，下一列当标题，其余列为“表头：内容”。
  const badge=rows.every(r=>w(r[0]||'')<=8)&&head.length>=3,cards=el('div','md-cards');
  rows.forEach(r=>{const card=el('div','md-card'),title=el('div','md-card-title');
   if(badge&&r[0])title.append(inline(r[0],el('span','md-card-badge')));
   inline(r[badge?1:0]||'',title);card.append(title);
   if(head.length===2){if(r[1].trim())card.append(inline(r[1],el('div','md-card-body')));}
   else{const dl=el('dl');r.forEach((c,k)=>{if(k<=(badge?1:0)||!c.trim())return;dl.append(inline(head[k]||'',el('dt')),inline(c,el('dd')));});card.append(dl);}
   cards.append(card);});
  root.append(cards);}
 return i;}

// 表格能横向滚动时，在被遮住的一侧显示阴影提示。
function mdScrollHints(box,wrap){
 const upd=()=>{const max=wrap.scrollWidth-wrap.clientWidth;box.classList.toggle('more-left',wrap.scrollLeft>2);box.classList.toggle('more-right',max-wrap.scrollLeft>2);};
 wrap.addEventListener('scroll',upd,{passive:true});
 if(typeof ResizeObserver==='function')new ResizeObserver(upd).observe(wrap);else requestAnimationFrame(upd);}

function mdList(lines,i,root){
 const first=lines[i].match(MD_ITEM),base=first[1].length,ordered=/\d/.test(first[2]),delim=first[2].slice(-1);
 const list=el(ordered?'ol':'ul');if(ordered&&+first[2].slice(0,-1)!==1)list.start=+first[2].slice(0,-1);
 let loose=false;const items=[];
 while(i<lines.length){
  const m=lines[i].match(MD_ITEM);
  if(!m||m[1].length>base+1||m[1].length+1<base||/\d/.test(m[2])!==ordered||(ordered?m[2].slice(-1)!==delim:false))break;
  const content=m[3]||'',pad=Math.min(4,(lines[i].length-content.length)-m[1].length-m[2].length)||1;
  const ci=m[1].length+m[2].length+pad;const buf=[content];i++;
  while(i<lines.length){
   const s=lines[i];
   if(mdBlank(s)){let j=i;while(j<lines.length&&mdBlank(lines[j]))j++;
    if(j<lines.length&&mdIndent(lines[j])>=Math.min(ci,base+2)){buf.push('');i++;continue;}
    const n=lines[j]&&lines[j].match(MD_ITEM);
    if(n&&Math.abs(n[1].length-base)<=1&&/\d/.test(n[2])===ordered){loose=true;i=j;}
    break;}
   if(mdIndent(s)>=Math.min(ci,base+2)){buf.push(mdDedent(s,ci));i++;continue;}
   if(MD_ITEM.test(s)||mdStartsBlock(lines,i)||mdBlank(buf.at(-1)))break;
   buf.push(s.trim());i++;}// lazy continuation
  items.push(buf);}
 for(const buf of items){
  const li=el('li');const task=buf[0].match(/^\[([ xX])\]\s+(.*)$/);
  if(task){li.className='task';li.append(el('span','box'+(task[1]===' '?'':' done'),task[1]===' '?'':'✓'));buf[0]=task[2];}
  if(buf.some(mdBlank))loose=true;
  const box=el('div');mdBlocks(buf,box,false);
  const kids=[...box.childNodes];
  // 首段直接放进 li，避免列表项里多一层段落间距。
  if(kids[0]&&kids[0].nodeName==='P'){li.append(...kids[0].childNodes);kids.shift();}
  li.append(...kids);list.append(li);}
 if(loose)list.classList.add('loose');
 root.append(list);return i;}

// ---------- code ----------
function codeBlock(code,lang){
 const lines=code.split('\n'),box=el('div','code-block');const bar=el('div','code-bar');
 const label=el('span','code-lang',(lang||'代码')+(lines.length>3?' · '+lines.length+' 行':''));
 bar.append(label,btn('复制','code-copy',()=>copyText(code),'copy'));
 const pre=el('pre');const c=el('code');
 if(/^(diff|patch)$/i.test(lang||'')||!lang&&lines.length>2&&lines.filter(l=>/^(@@|[+-](?![+-]))/.test(l)).length>lines.length/2){
  lines.forEach((l,k)=>{const cls=/^@@/.test(l)?'hunk':/^\+(?!\+\+)/.test(l)?'add':/^-(?!--)/.test(l)?'del':'';c.append(cls?el('span','d-'+cls,l):document.createTextNode(l));if(k<lines.length-1)c.append(document.createTextNode('\n'));});}
 else c.textContent=code;
 pre.append(c);box.append(bar,pre);
 if(lines.length>18){box.classList.add('clipped');const more=btn('展开 '+lines.length+' 行','code-more',()=>{const open=box.classList.toggle('clipped');more.textContent=open?'展开 '+lines.length+' 行':'收起代码';more.setAttribute('aria-expanded',String(!open));},'');more.setAttribute('aria-expanded','false');box.append(more);}
 return box;}

// ---------- folding long messages ----------
function mdHash(s){let h=5381;for(let k=0;k<s.length;k+=1)h=(h*33+s.charCodeAt(k))|0;return s.length+':'+h;}
function mdFold(root,src){
 const key=mdHash(src),wrap=el('div','md-fold'),n=src.replace(/[`*#|>_~-]|\s+/g,'').length,size=' · 约 '+(n<1000?n:Math.round(n/100)*100)+' 字';wrap.append(root);
 const toggle=btn('','md-more',()=>{
  const open=!wrap.classList.contains('open');if(open)mdExpanded.add(key);else mdExpanded.delete(key);
  set(open);if(!open){const r=wrap.getBoundingClientRect();if(r.top<0)wrap.scrollIntoView({block:'start',behavior:document.documentElement.classList.contains('reduce-motion')?'auto':'smooth'});}});
 const set=open=>{wrap.classList.toggle('open',open);toggle.replaceChildren(document.createTextNode(open?'收起':'展开全文'),el('span','md-more-size',open?'':size),icon('down'));toggle.setAttribute('aria-expanded',String(open));};
 wrap.append(toggle);set(mdExpanded.has(key));
 wrap.classList.add('measuring');
 // 插入页面后量一下：没明显超出就不折叠。
 const check=()=>{if(!wrap.isConnected||!root.clientHeight)return false;const over=root.scrollHeight>MD_FOLD_PX*1.3;wrap.classList.toggle('short',!over);wrap.classList.remove('measuring');return true;};
 if(typeof ResizeObserver==='function'){const ro=new ResizeObserver(()=>{check();});ro.observe(root);}
 else requestAnimationFrame(function tick(){if(!check())requestAnimationFrame(tick);});
 return wrap;}

// Kept for callers that expect a ready bubble.
function richText(text,opts){const b=el('div','bubble');b.append(markdown(text,opts));return b;}
if(typeof module==='object'&&module.exports)module.exports={markdown,inline,mdClean,mdCells};
