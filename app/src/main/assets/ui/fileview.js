'use strict';
// Read-only file viewer. A path tapped in a message opens its sheet (timeline.js fileSheet);
// 「查看文件内容」 there asks the bridge (`fileView`) for that one file — only on that tap, never
// ahead of time, never cached. The bridge only reads text files inside the home folder or the
// conversation's project folder, refuses keys/credentials/.env files and sends at most 512 KB
// (see SECURITY.md). A ch route reads on the other computer with the same rules.
const FV={wrap:true,finder:null};
function fvIcons(){paths.wrap=paths.wrap||'M4 6h16M4 12h13a3 3 0 0 1 0 6h-5M14 16l-2 2 2 2M4 18h4';}
try{FV.wrap=localStorage.getItem('hp.fv.wrap')!=='0';}catch(_){}
// "src/app.js:12-20" → path and line range.
function fvRef(ref){const m=String(ref).match(/^(.*?)(?::(\d+)(?:[-:,](\d+))?)?$/);const a=+m[2]||0;return {path:m[1]||String(ref),line:a,end:Math.max(a,+m[3]||a)};}
function fileViewButton(ref){
 const box=el('div','fv-entry');const b=btn('查看文件内容','primary fv-open',()=>fileView(ref),'file');
 box.append(b,el('small','fv-hint','只读。点了才会读取电脑上的这个文件，最多显示 512 KB。'));return box;}
function fvArgs(path){
 const c=S.chat||{},rec=c.record,args={path,provider:c.provider==='codex'?'codex':'claude'};
 const cwd=typeof tlCwd==='function'?tlCwd():'';if(cwd)args.cwd=cwd;
 if(rec?.id)args.record_id=rec.id;const far=rec?.remote||c.agent?.history_ref?.remote;if(far)args.remote=far;
 return args;}
async function fileView(ref){
 const {path,line,end}=fvRef(ref);const name=path.split('/').filter(Boolean).pop()||path;
 FV.finder=null;const box=sheet(name);box.classList.add('fv-sheet');
 const where=el('p','fv-path',path);box.append(where);
 const status=el('div','fv-status');status.append(el('span','spinner mini'),el('span','','正在读取…'));box.append(status);
 let r;
 try{r=S.demo?await fvDemo(path):await remote('fileView',fvArgs(path));}
 catch(e){if(!box.isConnected)return;status.replaceChildren(el('span','fv-error',e.message||String(e)));
  const row=el('div','sheet-actions');row.append(btn('重试','secondary',()=>fileView(ref),'refresh'));status.after(row);return;}
 if(!box.isConnected)return;
 where.textContent=r.path||path;
 const lines=r.binary?[]:String(r.text||'').replace(/\r\n?/g,'\n').split('\n');if(lines.length>1&&lines.at(-1)==='')lines.pop();
 const meta=[fileSize(r.size)];if(!r.binary)meta.push(lines.length+' 行');if(r.mtime){const rt=relative(r.mtime);meta.push(rt==='刚刚'?'刚刚修改':rt+' 修改');}
 status.replaceChildren(el('span','',meta.join(' · ')));status.classList.add('ready');
 if(r.binary){box.append(el('p','note','二进制文件，不显示内容。'));return;}
 if(r.truncated)box.append(el('p','note fv-cut','文件有 '+fileSize(r.size)+'，只显示前 '+fileSize(r.shown)+'。'));
 fvIcons();const tools=el('div','fv-tools');
 const wrap=btn('自动换行','secondary small fv-wrap',()=>{FV.wrap=!FV.wrap;try{localStorage.setItem('hp.fv.wrap',FV.wrap?'1':'0');}catch(_){}sync();},'wrap');
 const find=btn('搜索','secondary small',()=>fvFind(box,code,tools),'search');
 const copy=btn(r.truncated?'复制已显示的部分':'复制全部','secondary small',()=>copyText(r.text),'copy');
 tools.append(wrap,find,copy);box.append(tools);
 const code=el('div','fv-code');code.setAttribute('role','region');code.setAttribute('aria-label','文件内容：'+name);code.tabIndex=0;
 const list=el('div','fv-lines');list.style.setProperty('--fv-digits',String(String(lines.length).length));
 if(!lines.length||lines.length===1&&!lines[0])list.append(el('div','fv-empty','空文件'));
 let target=null;
 for(let i=0;i<lines.length;i+=200){const chunk=el('div','fv-chunk');
  lines.slice(i,i+200).forEach((t,k)=>{const n=i+k+1,row=el('div','fv-line');row.append(el('span','fv-no',String(n)),el('span','fv-text',t||' '));
   if(line&&n>=line&&n<=end){row.classList.add('target');if(n===line)target=row;}chunk.append(row);});
  list.append(chunk);}
 code.append(list);box.append(code);
 function sync(){list.classList.toggle('wrap',FV.wrap);wrap.setAttribute('aria-pressed',String(FV.wrap));wrap.classList.toggle('on',FV.wrap);}
 sync();
 box.addEventListener('fv-find',()=>fvFind(box,code,tools));
 if(target)requestAnimationFrame(()=>target.scrollIntoView({block:'center'}));
 else if(line)toast('文件只有 '+lines.length+' 行');}
function fvFind(box,code,tools){
 if(FV.finder&&FV.finder.bar.isConnected){FV.finder.focus();return;}
 const f=makeFinder({label:'在文件里搜索',placeholder:'在文件里找',fromEnd:false,root:()=>code.isConnected?code:null,mount:bar=>tools.after(bar),onClose:()=>{if(FV.finder===f)FV.finder=null;}});
 FV.finder=f;f.focus();}
// Offline demo: a made-up file; the same refusals as the bridge for secrets.
async function fvDemo(path){
 await new Promise(r=>setTimeout(r,160));
 if(/(^|\/)(\.ssh|\.gnupg|\.aws)(\/|$)|(^|\/)\.env[^/]*$|id_rsa|\.(pem|key)$/i.test(path))throw new Error('这是密钥、凭据或 .env 一类的敏感文件，不在手机上显示');
 const body=['#!/usr/bin/env python3','"""Herdr Pocket protocol v1. One bounded JSON request over SSH stdin."""','import json','import os','from pathlib import Path','',
  'VERSION = "0.6.0"','LIMIT = 65536','','','def history_page(request, catalog):','    """One page of a conversation, newest first."""','    entry = next((x for x in catalog if x["id"] == request.get("record_id")), None)',
  '    if not entry:','        raise BridgeError("历史记录已不存在，请刷新列表")','    before = request.get("before")','    # 35 messages per page; older pages continue from the "before" cursor.',
  '    return read_page(entry["_path"], before, 35)','','','def view_file(raw, base=None, extra_roots=()):','    """One text file under the home folder or the project folder, read-only."""',
  '    real = os.path.realpath(raw)','    if not inside(real, roots): raise BridgeError("只能查看项目目录或主目录里的文件")','    return {"path": real, "text": read_text(real, 512 * 1024)}'];
 const text=Array.from({length:6},(_,k)=>k?body.slice(9).map(l=>l.replace('history_page','history_page_'+k)).join('\n'):body.join('\n')).join('\n\n')+'\n';
 return {path:'/home/demo/projects/pocket/'+path.replace(/^(\.\/|~\/|\/home\/demo\/projects\/pocket\/)/,''),name:path.split('/').pop(),size:new Blob([text]).size,shown:new Blob([text]).size,truncated:false,binary:false,text,mtime:Date.now()/1000-3600};}
