'use strict';
// Markdown → DOM for transcript text. Never uses innerHTML; remote text stays text.
function inline(text,parent){
 const re=/(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*|\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/[^\s)）]+)/g;let last=0,m;
 while((m=re.exec(text))){if(m.index>last)parent.append(document.createTextNode(text.slice(last,m.index)));const t=m[0];
  if(t[0]==='`')parent.append(el('code','',t.slice(1,-1)));
  else if(t.startsWith('**')||t.startsWith('__'))inline(t.slice(2,-2),parent.appendChild(el('strong')));
  else if(t[0]==='*')inline(t.slice(1,-1),parent.appendChild(el('em')));
  else if(t[0]==='['){const i=t.indexOf('](');const a=el('span','md-link',t.slice(1,i));a.title=t.slice(i+2,-1);parent.append(a);}
  else parent.append(el('span','md-link',t));
  last=m.index+t.length;}
 if(last<text.length)parent.append(document.createTextNode(text.slice(last)));return parent;}
function codeBlock(code,lang){const box=el('div','code-block');const bar=el('div','code-bar');bar.append(el('span','',lang||'代码'));const c=btn('复制','code-copy',()=>copyText(code),'copy');bar.append(c);const pre=el('pre');pre.append(el('code','',code));box.append(bar,pre);return box;}
function markdown(text){
 const root=el('div','md');const lines=text.replace(/\r\n/g,'\n').split('\n');let i=0;
 const isTable=k=>/^\s*\|.*\|\s*$/.test(lines[k]||'')&&/^\s*\|?\s*:?-{2,}/.test(lines[k+1]||'');
 while(i<lines.length){const line=lines[i];
  const fence=line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/);
  if(fence){const end=fence[1];const buf=[];i++;while(i<lines.length&&!lines[i].trim().startsWith(end))buf.push(lines[i++]);i++;root.append(codeBlock(buf.join('\n'),fence[2]));continue;}
  if(!line.trim()){i++;continue;}
  const h=line.match(/^(#{1,6})\s+(.*)/);if(h){root.append(inline(h[2],el('h'+Math.min(6,h[1].length+2),'md-h')));i++;continue;}
  if(/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)){root.append(el('hr'));i++;continue;}
  if(isTable(i)){const row=s=>s.trim().replace(/^\||\|$/g,'').split('|').map(x=>x.trim());const wrap=el('div','table-wrap');const table=el('table');const head=el('tr');row(lines[i]).forEach(c=>head.append(inline(c,el('th'))));table.append(head);i+=2;while(i<lines.length&&/^\s*\|.*\|\s*$/.test(lines[i])){const tr=el('tr');row(lines[i]).forEach(c=>tr.append(inline(c,el('td'))));table.append(tr);i++;}wrap.append(table);root.append(wrap);continue;}
  if(/^\s*>/.test(line)){const buf=[];while(i<lines.length&&/^\s*>/.test(lines[i]))buf.push(lines[i++].replace(/^\s*>\s?/,''));const q=el('blockquote');q.append(markdown(buf.join('\n')));root.append(q);continue;}
  const item=/^(\s*)([-*+]|\d+[.)])\s+(.*)/;
  if(item.test(line)){const ordered=/\d/.test(line.match(item)[2]);const list=el(ordered?'ol':'ul');const base=line.match(item)[1].length;
   while(i<lines.length){const m=lines[i].match(item);if(m&&m[1].length<=base+1){const li=el('li');const task=m[3].match(/^\[([ xX])\]\s+(.*)/);if(task){li.className='task';li.append(el('span','box'+(task[1]===' '?'':' done'),task[1]===' '?'':'✓'));inline(task[2],li);}else inline(m[3],li);list.append(li);i++;}
    else if(m||(lines[i].trim()&&/^\s{2,}/.test(lines[i]))){const last=list.lastElementChild;const sub=[];while(i<lines.length&&(lines[i].match(item)?.[1].length>base+1||(lines[i].trim()&&/^\s{2,}/.test(lines[i])&&!lines[i].match(item))))sub.push(lines[i++].replace(/^\s{2,4}/,''));if(last&&sub.length)last.append(markdown(sub.join('\n')));else break;}
    else break;}
   root.append(list);continue;}
  const para=[];while(i<lines.length&&lines[i].trim()&&!/^\s*(```|~~~|#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i])&&!isTable(i))para.push(lines[i++]);
  const p=el('p');para.forEach((t,k)=>{if(k)p.append(el('br'));inline(t,p);});root.append(p);}
 return root;}
// Kept for callers that expect a ready bubble.
function richText(text){const b=el('div','bubble');b.append(markdown(text));return b;}
