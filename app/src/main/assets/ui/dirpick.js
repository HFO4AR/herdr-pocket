'use strict';
// Directory picker: 常用 directories on top, then a folder tree that starts at 家目录 or 根目录 /
// and opens one level per tap (the read-only bridge op `dirList`: folder names only, never files).
// The 新建会话 and 新建 tmux 会话 sheets open it from their 「浏览目录…」 row; it is meant to be
// reused wherever a directory on the connected computer has to be chosen.
//
// API
//  dirPicker(opts) → picker        builds one; mount picker.el anywhere (a page, a sheet body).
//   opts.value       where to start (absolute, ~ or ~/…); the tree opens down to it. Default: home.
//   opts.home        the computer's home folder when known ('' → asked as ~, learned from the answer).
//   opts.quick       [{path, label?}] 常用 chips above the tree; a tap opens the tree at that folder.
//   opts.title       bar title (default 选目录); opts.pickLabel the main button (default 选这个目录).
//   opts.needWrite   only folders the SSH user may write to can be picked (default: entering is enough).
//   opts.list(paths, {hidden, query}) → Promise<listing[]>   how folders are read; default: dirList
//                    through remote() (one request for a whole way down), a fake tree in demo mode.
//   opts.onPick(path, entry)   the absolute path as browsed (a symlink is not resolved; the bridge
//                    resolves and re-checks what it is given) and that folder's flags.
//   opts.onCancel()            返回 / Android back.
//   picker.open(path) shows that folder · picker.cancel() · picker.current() → the highlighted path.
//  dirPickIn(host, opts) → picker  shows a picker in place of host's other children (a sheet body)
//                    until it picks or cancels; Android back cancels it (sheet.onBack, app.js).
// A listing (bridge dirList, see docs/PROTOCOL.md): {path, real?, parent?, home, enter, list, write,
//  dirs:[{name, link?, real?, enter?:false, list?:false, write?:false, slow?:true}], total,
//  truncated, hidden, partial, note?, error?, code?: missing|notdir|denied|timeout|budget|bad|os}.
const DP_PAGE=100;
// app.js's icon table is declared later in the bundle: added on first use, not at load.
function dpIcons(){if(!paths.link)paths.link='M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1';}

async function dpList(paths,o){
 if(S.demo)return paths.map(p=>dpDemo(p,o));
 const args={hidden:!!o.hidden};
 if(paths.length===1)return [await remote('dirList',{path:paths[0],...args,...(o.query?{query:o.query}:{})})];
 const out=[];for(let i=0;i<paths.length;i+=16){const r=await remote('dirList',{paths:paths.slice(i,i+16),...args});out.push(...(r?.lists||[]));}
 return out;}
function dpOld(m){return /Unknown operation|不支持的操作/.test(m||'');}

function dirPicker(opts={}){
 dpIcons();
 const P={seek:false,miss:'',home:(opts.home||'').replace(/\/+$/,''),root:'',cur:'',nodes:new Map(),hidden:false,filter:'',seq:0,qTimer:0,error:''};
 const list=opts.list||dpList;
 const join=(a,b)=>a==='/'?'/'+b:a+'/'+b;
 const under=(p,r)=>p===r||p.startsWith(r==='/'?'/':r+'/');
 const short=p=>P.home&&under(p,P.home)?'~'+p.slice(P.home.length):p;
 const norm=p=>{p=String(p||'').trim();if(P.home&&(p==='~'||p.startsWith('~/')))p=P.home+p.slice(1);p=p.replace(/\/+/g,'/');return p.length>1?p.replace(/\/$/,''):p;};
 const base=p=>p==='/'?'/':p.split('/').pop();
 const node=p=>{let n=P.nodes.get(p);if(!n){n={path:p,entry:null,open:false,state:'',list:null,shown:DP_PAGE,q:null};P.nodes.set(p,n);}return n;};
 // A folder's flags: from its own listing when read, else from the line in its parent's.
 const flags=n=>n.list&&!n.list.error?{enter:n.list.enter,list:n.list.list,write:n.list.write}:n.list?.code==='denied'?{enter:n.list.enter!==false&&n.entry?.enter!==false,list:false,write:n.list.write!==false&&n.entry?.write!==false}:{enter:n.entry?.enter!==false,list:n.entry?.list!==false,write:n.entry?.write!==false};
 const canOpen=n=>{const f=flags(n);return f.enter&&f.list&&!['missing','notdir','denied'].includes(n.list?.code);};
 const gone=n=>['missing','notdir','bad'].includes(n.list?.code);
 const canPick=n=>{const f=flags(n);return !gone(n)&&f.enter&&(!opts.needWrite||f.write);};

 const root=el('div','dp');
 const bar=el('div','dp-bar');const back=btn('返回','dp-back',()=>cancel(),'back');back.setAttribute('aria-label','返回，不选了');
 // The filter narrows the highlighted folder's own level; it opens from the bar (which stays on
 // screen while the tree scrolls), so it never pushes the rows around unasked.
 const seek=ib('search','筛选当前目录',()=>{P.seek=!P.seek;if(!P.seek&&P.filter){P.filter='';filter.value='';}draw();if(P.seek)setTimeout(()=>filter.focus(),30);});
 seek.classList.add('dp-seek');
 bar.append(back,el('h3','',opts.title||'选目录'),seek);
 const roots=el('div','dp-roots');roots.setAttribute('role','group');roots.setAttribute('aria-label','从哪里开始');
 const rHome=btn('家目录','pill dp-root',()=>open(P.home||'~'),'account'),rTop=btn('根目录 /','pill dp-root',()=>open('/'),'device');
 const hid=btn('隐藏目录','pill dp-hidden',()=>{P.hidden=!P.hidden;reloadOpen();});hid.setAttribute('aria-label','显示隐藏目录');
 roots.append(rHome,rTop,hid);
 const quick=el('div','dp-quick');
 const filter=el('input','field dp-filter');filter.type='search';filter.autocomplete='off';filter.spellcheck=false;filter.setAttribute('autocapitalize','off');filter.setAttribute('enterkeyhint','search');
 filter.oninput=()=>{P.filter=filter.value.trim();const n=node(P.cur);if(P.filter&&!n.open&&canOpen(n)){n.open=true;if(!n.list)load(n);}queryLater();draw();};
 filter.onkeydown=e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();filter.blur();}};
 const tree=el('div','dp-tree');tree.setAttribute('role','tree');tree.setAttribute('aria-label','目录树');
 const foot=el('div','dp-foot');const curLine=el('div','dp-cur');const curNote=el('p','fine dp-cur-note hidden');
 const acts=el('div','sheet-actions');const pick=btn(opts.pickLabel||'选这个目录','primary dp-pick',()=>doPick(),'check');
 acts.append(btn('返回','secondary',()=>cancel()),pick);foot.append(curLine,curNote,acts);
 const head=el('div','dp-head');head.append(bar,filter);
 root.append(head,roots,quick,tree,foot);
 if(opts.quick?.length){quick.append(el('div','section-label','常用'));const row=el('div','dp-chips');
  for(const q of opts.quick.slice(0,8)){const b=btn(q.label||base(norm(q.path)),'pill dp-chip',()=>open(q.path),'folder');b.title=q.path;row.append(b);}quick.append(row);}

 function apply(n,l){n.list=l;n.state=l?.error?'error':'ok';n.q=null;n.shown=Math.max(n.shown,DP_PAGE);
  if(l?.home&&!P.home)P.home=l.home.replace(/\/+$/,'');}
 async function load(n){n.state='loading';if(n.list?.error)n.list=null;draw();
  try{const [l]=await list([n.path],{hidden:P.hidden});apply(n,l||{error:'没读到',code:'os',dirs:[]});}
  catch(e){n.state='error';n.list={error:dpOld(e.message)?'电脑上的桥接程序太旧，到「设备」页重新安装（桥接程序那一行的「…」）':'读不到：'+(e.message||e),code:'rpc',dirs:[]};}
  draw();}
 // The way down from the root to `path`, read in one request; each level opens, the last one is highlighted.
 async function open(path){
  const seq=++P.seq;P.filter='';filter.value='';P.error='';P.miss='';
  if(!P.home&&/^~/.test(String(path||'~'))){
   try{const [h]=await list(['~'],{hidden:P.hidden});if(seq!==P.seq)return;if(h?.home)P.home=h.home.replace(/\/+$/,'');if(h&&!h.error&&h.path===P.home)apply(node(P.home),h);}
   catch(e){if(seq!==P.seq)return;P.error=dpOld(e.message)?'电脑上的桥接程序太旧，到「设备」页重新安装（桥接程序那一行的「…」），手填路径照样能用':'读不到目录：'+(e.message||e);P.root=P.cur='';draw();return;}}
  let p=norm(path||P.home||'/');if(!p.startsWith('/'))p=P.home?join(P.home,p):'/'+p;
  P.root=P.home&&under(p,P.home)?P.home:'/';
  const chain=[P.root];if(p!==P.root){let acc=P.root;for(const s of p.slice(P.root==='/'?1:P.root.length+1).split('/')){acc=join(acc,s);chain.push(acc);}}
  const need=chain.filter(c=>{const n=node(c);return !n.list||n.state==='error';});
  for(const c of need)node(c).state='loading';
  P.cur=p;draw();
  if(need.length){
   try{const got=await list(need,{hidden:P.hidden});if(seq!==P.seq)return;need.forEach((c,i)=>apply(node(c),got[i]||{error:'没读到',code:'os',dirs:[]}));}
   catch(e){if(seq!==P.seq)return;for(const c of need){const n=node(c);n.state='error';n.list={error:dpOld(e.message)?'电脑上的桥接程序太旧，到「设备」页重新安装（桥接程序那一行的「…」）':'读不到：'+(e.message||e),code:'rpc',dirs:[]};}}}
  // Open every level that could be read (an error shows under its row, with 重试); stop at the
  // first one that does not exist and say so.
  let last=chain[0];
  for(const c of chain){const n=node(c);
   if(c!==chain[0]&&gone(n)){P.miss=short(p)+' 不存在，停在了「'+(last===P.home?'家目录':base(last))+'」';break;}
   last=c;n.open=canOpen(n);if(!n.open||n.list?.error)break;}
  P.cur=last;draw();
  requestAnimationFrame(()=>{const r=tree.querySelector('.dp-row.cur');if(r&&r.scrollIntoView)r.scrollIntoView({block:'center'});});}
 function reloadOpen(){const open=[...P.nodes.values()].filter(n=>n.open||n.path===P.cur).map(n=>n.path).filter(p=>under(p,P.root));
  for(const n of P.nodes.values())if(!open.includes(n.path))n.list=null,n.state='';
  open.sort((a,b)=>a.length-b.length);const seq=++P.seq;open.forEach(p=>node(p).state='loading');draw();
  list(open,{hidden:P.hidden}).then(got=>{if(seq!==P.seq)return;open.forEach((p,i)=>apply(node(p),got[i]||{error:'没读到',code:'os',dirs:[]}));draw();})
   .catch(e=>{if(seq!==P.seq)return;open.forEach(p=>{const n=node(p);n.state='error';n.list={error:'读不到：'+(e.message||e),code:'rpc',dirs:[]};});draw();});}
 // A directory too big to list whole (500 folders, or 20000 entries looked at): the filter asks the bridge.
 function queryLater(){clearTimeout(P.qTimer);const n=node(P.cur),q=P.filter;if(!q||!n.list?.truncated)return;
  P.qTimer=setTimeout(async()=>{n.q={q,state:'loading'};draw();
   try{const [l]=await list([n.path],{hidden:P.hidden,query:q});if(n.q?.q===q){n.q={q,state:'ok',list:l};draw();}}
   catch(e){if(n.q?.q===q){n.q={q,state:'error',error:e.message||String(e)};draw();}}},350);}
 function tap(path){const n=node(path);
  if(P.cur!==path){P.cur=path;P.filter='';filter.value='';if(!n.open&&canOpen(n)){n.open=true;if(!n.list||n.state==='error')load(n);}draw();return;}
  if(n.open)n.open=false;else if(canOpen(n)||n.state==='error'){n.open=true;if(!n.list||n.state==='error'||n.list.error)load(n);}
  draw();}
 function meta(n,e){const f=flags(n);
  if(gone(n))return n.list.error;
  if(e?.slow)return '链接'+(e.link?' → '+e.link:'')+' · 目标没响应';
  if(!f.enter)return '没权限进去';
  if(!f.list)return '能进去，但看不到里面';
  if(e?.link)return '→ '+(e.link.startsWith('/')?short(e.link):e.link);
  if(opts.needWrite&&!f.write)return '只读';
  return '';}
 function row(n,depth,label){const e=n.entry,cur=P.cur===n.path,expandable=canOpen(n)||n.state==='error'||!!e?.slow;
  const b=btn('','dp-row'+(cur?' cur':'')+(gone(n)?' gone':''),()=>tap(n.path));b.setAttribute('role','treeitem');b.setAttribute('aria-level',String(depth+1));
  b.setAttribute('aria-selected',String(cur));if(expandable)b.setAttribute('aria-expanded',String(n.open));
  b.style.setProperty('--d',String(Math.min(depth,6)));
  const chev=icon('chevron');chev.classList.add('dp-chev');if(!expandable)chev.classList.add('none');
  const f=flags(n);const ic=icon(!f.enter||!f.list?'lock':e?.link?'link':depth===0&&n.path===P.home?'account':'folder');ic.classList.add('dp-ic');
  const t=el('span','dp-text');const name=el('span','dp-name',label||e?.name||base(n.path));t.append(name);const m=meta(n,e);if(m)t.append(el('small','dp-meta',m));
  b.append(chev,ic,t);b.setAttribute('aria-label',(label||e?.name||base(n.path))+(m?'，'+m:''));
  if(cur&&canPick(n))b.append(icon('check'));return b;}
 function note(text,depth,cls,action){const d=el('div','dp-note'+(cls?' '+cls:''));d.style.setProperty('--d',String(Math.min(depth,6)));
  if(cls==='loading')d.append(el('span','spinner mini'));d.append(el('span','',text));if(action)d.append(action);return d;}
 function kids(n,depth,out){
  if(n.state==='loading'&&!n.list){out.append(note('读取中…',depth,'loading'));return;}
  const l=n.list;if(!l)return;
  if(l.error){out.append(note(l.error,depth,'bad',btn('重试','link-btn',()=>load(n))));return;}
  const isCur=n.path===P.cur,q=isCur?P.filter.toLowerCase():'';
  let dirs=l.dirs||[],from=l;
  if(q&&n.q?.q===P.filter&&n.q.state==='ok'&&n.q.list&&!n.q.list.error){from=n.q.list;dirs=from.dirs||[];}
  else if(q)dirs=dirs.filter(d=>d.name.toLowerCase().includes(q));
  // The way down to the highlighted folder stays visible even when this listing leaves it out
  // (a hidden folder while 隐藏目录 is off, or one past the 500 listed).
  const way=!q&&P.cur!==n.path&&under(P.cur,n.path)?P.cur.slice(n.path==='/'?1:n.path.length+1).split('/')[0]:'';
  if(way&&!dirs.some(d=>d.name===way))dirs=dirs.concat({name:way,pinned:true}).sort((a,b)=>a.name.toLowerCase()<b.name.toLowerCase()?-1:a.name.toLowerCase()>b.name.toLowerCase()?1:0);
  if(n.state==='loading')out.append(note('读取中…',depth,'loading'));
  if(q&&n.q?.state==='loading')out.append(note('在整个目录里找「'+P.filter+'」…',depth,'loading'));
  if(!dirs.length){out.append(note(q?'没有名字里带「'+P.filter+'」的目录':'没有子目录'+(l.hidden?'（有 '+l.hidden+' 个隐藏目录，点上面的「隐藏目录」看）':''),depth,'empty'));}
  const group=el('div','dp-group');group.setAttribute('role','group');
  const page=dirs.slice(0,n.shown);if(way&&!page.some(d=>d.name===way))page.push(dirs.find(d=>d.name===way));
  for(const d of page){const c=node(join(n.path,d.name));c.entry=d;group.append(row(c,depth));if(c.open)kids(c,depth+1,group);}
  out.append(group);
  if(dirs.length>n.shown)out.append(note('还有 '+(dirs.length-n.shown)+' 个',depth,'more',btn('再显示 '+Math.min(DP_PAGE,dirs.length-n.shown)+' 个','link-btn',()=>{n.shown+=DP_PAGE;draw();})));
  if(from.truncated&&!(q&&from!==l))out.append(note(from.total>dirs.length&&!from.partial?'目录太多，只列出前 '+(from.dirs||[]).length+' 个'+(isCur?'；用上面的筛选找':''):'目录太多，只列出了一部分'+(isCur?'；用上面的筛选找':''),depth,'warn'));
  if(from.note)out.append(note(from.note,depth,'warn'));}
 function draw(){
  rHome.classList.toggle('active',!!P.root&&P.root===P.home&&P.root!=='/');rTop.classList.toggle('active',P.root==='/');
  rHome.setAttribute('aria-pressed',String(rHome.classList.contains('active')));rTop.setAttribute('aria-pressed',String(rTop.classList.contains('active')));
  hid.classList.toggle('active',P.hidden);hid.setAttribute('aria-pressed',String(P.hidden));hid.replaceChildren(...(P.hidden?[icon('check')]:[]),document.createTextNode('隐藏目录'));
  const focused=document.activeElement&&tree.contains(document.activeElement)?document.activeElement.getAttribute('aria-label'):null;
  tree.replaceChildren();
  if(P.miss)tree.append(note(P.miss,0,'warn'));
  if(P.error){tree.append(note(P.error,0,'bad',btn('重试','link-btn',()=>open(P.cur||P.home||'~'))));}
  else if(!P.root){tree.append(note('读取中…',0,'loading'));}
  else{const r=node(P.root);tree.append(row(r,0,P.root==='/'?'根目录 /':'家目录'));if(r.open||r.state==='loading')kids(r,1,tree);}
  if(focused){const again=[...tree.querySelectorAll('.dp-row')].find(x=>x.getAttribute('aria-label')===focused);if(again)again.focus({preventScroll:true});}
  const n=P.cur?node(P.cur):null;
  filter.placeholder=n?'在「'+(n.path===P.home?'家目录':base(n.path))+'」里筛选':'筛选';
  seek.disabled=!n||!canOpen(n);if(seek.disabled&&!P.filter)P.seek=false;
  filter.classList.toggle('hidden',!P.seek&&!P.filter);seek.classList.toggle('on',P.seek||!!P.filter);seek.setAttribute('aria-pressed',String(P.seek||!!P.filter));
  curLine.replaceChildren(el('span','dp-cur-label','选中'),el('span','dp-cur-path',n?short(n.path):'—'));
  if(n?.list?.real&&n.list.real!==n.path)curLine.append(el('span','dp-cur-real','实际是 '+short(n.list.real)));
  const ok=!!n&&canPick(n)&&!P.error;pick.disabled=!ok;
  const why=!n||P.error?'':gone(n)?n.list.error:!flags(n).enter?'没权限进这个目录，选不了':opts.needWrite&&!flags(n).write?'这个目录不能写，选不了':'';
  curNote.textContent=why;curNote.classList.toggle('hidden',!why);}
 function doPick(){const n=node(P.cur);if(!canPick(n))return;opts.onPick?.(n.path,{...flags(n),real:n.list?.real||n.entry?.real||''});}
 function cancel(){P.seq++;clearTimeout(P.qTimer);opts.onCancel?.();}
 draw();open(opts.value||P.home||'~');
 return {el:root,open,cancel,current:()=>P.cur};}

function dirPickIn(host,opts={}){
 const sh=host.closest('.sheet'),prevBack=sh?.onBack,scroll=sh?sh.scrollTop:0;let done=false;
 const finish=()=>{if(done)return;done=true;p.el.remove();host.classList.remove('dp-on');if(sh){sh.onBack=prevBack;sh.scrollTop=scroll;}};
 const p=dirPicker({...opts,onPick:(path,info)=>{finish();opts.onPick?.(path,info);},onCancel:()=>{finish();opts.onCancel?.();}});
 host.classList.add('dp-on');host.append(p.el);if(sh){sh.scrollTop=0;sh.onBack=()=>{p.cancel();return true;};}
 return p;}

// Demo mode (no computer): a small fake tree with the same answer shape as the bridge.
const DP_DEMO={'/':['bin','etc','home','mnt','opt','srv','tmp','usr','var'],'/home':['demo'],'/home/demo':['.config','Downloads','notes','projects','work@/mnt/data/work'],
 '/home/demo/projects':['pocket','site','tools'],'/home/demo/projects/pocket':['app','bridge','docs','scripts'],'/mnt':['data'],'/mnt/data':['work'],'/mnt/data/work':['client-a','client-b'],
 '/home/demo/.config':['herdr'],'/srv':['www'],'/usr':['bin','lib','local','share'],'/var':['log','tmp','www']};
function dpDemo(path,o){
 const home='/home/demo';let p=String(path).replace(/^~(?=\/|$)/,home).replace(/\/+$/,'')||'/';
 const real=p.replace(/^\/home\/demo\/work(?=\/|$)/,'/mnt/data/work');
 const raw=DP_DEMO[real];const out={path:p,home,...(p!=='/'?{parent:p.slice(0,p.lastIndexOf('/'))||'/'}:{}),...(real!==p?{real}:{})};
 if(!raw)return {...out,error:'这个目录不存在',code:'missing',dirs:[]};
 const mine=p===home||p.startsWith(home+'/')||p.startsWith('/tmp');
 let dirs=raw.map(x=>{const [name,link]=x.split('@');return {name,...(link?{link,real:link}:{}),...(mine?{}:{write:false})};});
 const hidden=o?.hidden?0:dirs.filter(d=>d.name.startsWith('.')).length;if(!o?.hidden)dirs=dirs.filter(d=>!d.name.startsWith('.'));
 if(o?.query)dirs=dirs.filter(d=>d.name.toLowerCase().includes(o.query.toLowerCase()));
 return {...out,enter:true,list:true,write:mine,dirs,total:dirs.length,truncated:false,hidden,partial:false};}
