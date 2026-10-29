// 文件 (sftp.js): browse a connected computer's folders over SFTP, preview text/code/Markdown/JSON/
// CSV/images/PDF plus fallbacks, entry points + first-run hint, upload with 替换 / 保留两个 / 跳过,
// download with progress / cancel / 打开, new folder, rename, delete (strong confirm for a folder with
// things in it), several at once, errors, back navigation and reduced-motion-independent real progress.
// Offline: native is a strict fake with an in-memory file tree; nothing reaches a computer.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {png}=require('./png_fixture.cjs');
(async()=>{
const root=path.resolve(__dirname,'..');
const html=require('./ui_bundle.cjs')(root);
const shots=path.join(root,'ui-artifacts');fs.mkdirSync(shots,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});
const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
const PNG=png();
await page.route('https://pocket.invalid/preview/**',route=>route.fulfill({status:200,contentType:'image/png',headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'},body:PNG}));
await page.addInitScript(()=>{window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push({directive:e.violatedDirective,blocked:e.blockedURI}));});
await page.addInitScript(()=>{
 const now=Math.floor(Date.now()/1000);
 const D={A:{id:'A',name:'家里的电脑',user:'u',host:'home.invalid',port:22,remember:true}};
 // path → {type, size, mtime, kids?}
 const T=new Map();const mk=(p,type,size=0,age=60)=>T.set(p,{type,size,mtime:now-age});
 mk('/','dir');mk('/home','dir');mk('/home/u','dir');mk('/home/u/src','dir',0,30);mk('/home/u/src/app','dir');mk('/home/u/src/app/main.c','file',1200);
 mk('/home/u/src/notes.md','file',900);mk('/home/u/report.pdf','file',2_400_000,7200);mk('/home/u/.bashrc','file',300);mk('/home/u/big.iso','file',3_200_000_000,86400);
 mk('/home/u/empty','dir',0,5000);mk('/home/u/a*b?.txt','file',10);T.set('/home/u/latest',{type:'link',target:'dir',size:0,mtime:now-50});mk('/tmp','dir');
 // Preview fixtures are added by the test itself (below) so the first listing stays small.
 const C={
  '/home/u/src/app/main.c':'#include <stdio.h>\n\nint main(void) {\n  printf("hello\\n");\n  return 0;\n}\n',
  '/home/u/src/notes.md':'# 项目笔记\n\n- 第一项\n- **第二项**\n\n```sh\nmake test\n```\n'
 };
 const IMG='https://pocket.invalid/preview/'+'a'.repeat(40),PAGE='https://pocket.invalid/preview/page/'+'b'.repeat(40);
 const kids=p=>[...T.keys()].filter(k=>k!==p&&k.slice(0,k.lastIndexOf('/')||1)===p);
 const base=p=>p.slice(p.lastIndexOf('/')+1),join=(d,n)=>d==='/'?'/'+n:d+'/'+n,parent=p=>p.slice(0,p.lastIndexOf('/'))||'/';
 const resolve=p=>!p||p==='~'?'/home/u':p.startsWith('~/')?'/home/u'+p.slice(1):p;
 window.fx={D,T,C,IMG,PAGE,calls:[],unnamed:[],transfers:[],seq:0,picks:[],listFail:0,listDelay:0,opened:[],dropped:[],
  previews:[],previewPages:[],previewCancelled:[],previewOpened:[],previewDelay:20};
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);let data={};fx.calls.push({op,a});
  const fail=(msg,code,info)=>{setTimeout(()=>nativeResult(id,{ok:false,error:msg,...(code?{code}:{}),...(info?{info}:{})}),10);};
  try{
   if(op==='devices')data={devices:[D.A],version:'test',connected:D.A,connections:[D.A]};
   else if(op==='remote'){if(a.op==='sessions')data={sessions:[{name:'main',running:true}]};else if(a.op==='agents')data={agents:[]};else if(a.op==='status')data={agents:[]};
    else if(a.op==='panes')data={panes:[]};else if(a.op==='catalog')data={records:[],total:0,next:null};else if(a.op==='account')data={ssh_user:'u',hostname:'box'};
    else if(a.op==='hello')data={version:'0.6.0',protocol:1};else if(a.op==='doctor')data={herdr:true,running:1};else if(a.op==='glance')data={previews:{}};else if(a.op==='tmux')data={available:false,panes:[]};else data={};}
   else if(op.startsWith('sftp')){
    if(!['sftpTransfers','sftpCancel','sftpForget','sftpOpen','sftpPickUpload','sftpDropPicks','sftpPreviewPage','sftpPreviewOpen','sftpPreviewCancel'].includes(op)&&a.device!=='A'){fx.unnamed.push(op);return fail('request without device: '+op);}
    if(op==='sftpList'){
     const answer=()=>{const p=resolve(a.path);if(fx.listFail){fx.listFail--;return fail('SSH 连接断了，没做完','sftp_link');}
      const n=T.get(p);if(!n)return fail('这个文件夹不在了：'+p,'sftp_missing');if(n.type!=='dir')return fail('这不是文件夹：'+p,'sftp_not_dir');
      data={path:p,home:'/home/u',parent:p==='/'?null:parent(p),downloads:true,truncated:false,entries:kids(p).map(k=>{const e=T.get(k);return {name:base(k),type:e.type,size:e.size,mtime:e.mtime,perm:e.type==='dir'?'drwxr-xr-x':'-rw-r--r--',...(e.target?{target:e.target}:{})};})};
      setTimeout(()=>nativeResult(id,{ok:true,data}),10);};
     if(fx.listDelay){const d=fx.listDelay;fx.listDelay=0;setTimeout(answer,d);}else answer();return;}
    if(op==='sftpMkdir'){const p=join(a.dir,a.name);if(T.has(p))return fail('这里已经有叫「'+a.name+'」的了','sftp_exists');mk(p,'dir',0,0);data={path:p,name:a.name};}
    else if(op==='sftpRename'){const to=join(parent(a.path),a.name);if(T.has(to))return fail('这里已经有叫「'+a.name+'」的了，没改名','sftp_exists');
     for(const k of [...T.keys()])if(k===a.path||k.startsWith(a.path+'/')){T.set(to+k.slice(a.path.length),T.get(k));T.delete(k);}data={path:to,name:a.name};}
    else if(op==='sftpDelete'){const n=T.get(a.path);if(!n)return fail('已经不在了','sftp_missing');
     if(n.type==='dir'&&kids(a.path).length&&!a.recursive)return fail('「'+base(a.path)+'」里面还有东西','sftp_not_empty');
     if(a.recursive&&a.confirm!==base(a.path))return fail('要输入文件夹名确认','sftp_confirm');
     let d=0;for(const k of [...T.keys()])if(k===a.path||k.startsWith(a.path+'/')){T.delete(k);d++;}data={deleted:d};}
    else if(op==='sftpPickUpload'){data=fx.picks.shift()||{files:[],cancelled:true};}
    else if(op==='sftpDropPicks'){fx.dropped.push(...a.ids);}
    else if(op==='sftpUpload'){const t={id:'t'+(++fx.seq),device:'A',deviceName:'家里的电脑',kind:'up',name:a.name,remote:a.dir,size:1000,done:0,state:'running',phase:'copy',error:'',where:a.dir,mode:a.mode,canOpen:false};fx.transfers.push(t);data=t;}
    else if(op==='sftpDownload'){const t={id:'t'+(++fx.seq),device:'A',deviceName:'家里的电脑',kind:'down',name:base(a.path),remote:a.path,size:a.size,done:0,state:'running',phase:'copy',error:'',where:'',canOpen:false,saveAs:!!a.saveAs};fx.transfers.push(t);data=t;}
    else if(op==='sftpTransfers')data={transfers:fx.transfers.map(t=>({...t}))};
    else if(op==='sftpCancel'){const t=fx.transfers.find(x=>x.id===a.transfer);t.state='cancelled';data={...t};}
    else if(op==='sftpForget'){fx.transfers=fx.transfers.filter(t=>t.state==='running'||t.state==='queued');data={transfers:fx.transfers};}
    else if(op==='sftpOpen'){fx.opened.push(a);data={};}
    else if(op==='sftpPreview'){
     const p=resolve(a.path),e=T.get(p);if(!e)return fail('找不到这个文件','sftp_missing');if(e.type!=='file')return fail('只能预览普通文件','sftp_not_file');
     if((a.kind==='image'||a.kind==='pdf')&&e.size>20e6&&!a.allowLarge)return fail('文件有 25 MB，预览要先读到手机上','preview_large',{size:e.size,max:20000000});
     fx.previews.push(a);const key='a'.repeat(40),name=base(p),mime=/\.pdf$/.test(p)?'application/pdf':/\.png$/.test(p)?'image/png':'text/plain';
     const result={key,name,mime,size:e.size,mtime:e.mtime,cached:false,complete:true,path:p};
     if(a.kind==='image'){setTimeout(()=>window.nativeProgress(id,String(Math.floor(e.size/2))),8);setTimeout(()=>nativeResult(id,{ok:true,data:{...result,url:fx.IMG,width:2400,height:3200,origWidth:2400,origHeight:3200}}),fx.previewDelay);return;}
     if(a.kind==='pdf'){setTimeout(()=>window.nativeProgress(id,String(Math.floor(e.size/2))),8);setTimeout(()=>nativeResult(id,{ok:true,data:{...result,page:{url:fx.PAGE,width:3200,height:2400,index:0,pages:3},sizes:[[600,800],[800,600],[600,800]]}}),fx.previewDelay);return;}
     const txt=fxC(p),binary=/\.bin$/.test(p);
     setTimeout(()=>window.nativeProgress(id,String(Math.floor(e.size/2))),10);
     setTimeout(()=>window.nativeProgress(id,String(e.size)),Math.max(40,Math.round(fx.previewDelay*.75)));
     setTimeout(()=>nativeResult(id,{ok:true,data:binary?{...result,binary:true,shown:0,truncated:false,tail:false,offset:0}:{...result,binary:false,text:txt,encoding:'UTF-8',shown:txt.length,truncated:false,tail:!!a.tail,offset:0}}),fx.previewDelay);return;}
    else if(op==='sftpPreviewPage'){fx.previewPages.push(a);if(fx.pageFail===a.page){fx.pageFail=-1;return fail('这页 PDF 渲染不了','preview_pdf');}data={url:fx.PAGE,width:3200,height:2400,index:Math.max(0,Math.min(2,a.page)),pages:3};}
    else if(op==='sftpPreviewOpen'){fx.previewOpened.push(a);data={};}
    else if(op==='sftpPreviewCancel'){fx.previewCancelled.push(a.token);data={};}
    else throw Error('unexpected '+op);}
   else if(!['protect','settings','cacheGet','cachePut','setAlerts','watchState','activate'].includes(op))throw Error('unexpected native op '+op);
   if(op==='cacheGet')data={value:null};
  }catch(e){return fail(e.message);}
  setTimeout(()=>nativeResult(id,{ok:true,data}),(op==='sftpPreviewPage'&&fx.pageDelay)||10);}};
 function fxC(p){return fx.C[p]||'';}
 // Fake transfer progress: the test moves it by hand.
 window.fxStep=(id,done,state,extra={})=>{const t=fx.transfers.find(x=>x.id===id);t.done=done;if(state)t.state=state;Object.assign(t,extra);};
 window.fxAdd=(p,type,size,text)=>{fx.T.set(p,{type,size,mtime:Math.floor(Date.now()/1000)});if(text!==undefined)fx.C[p]=text;};
});
await page.goto(require('./ui_bundle.cjs').url(html));
const calls=op=>page.evaluate(o=>fx.calls.filter(c=>c.op===o).map(c=>c.a),op);
const theme=t=>page.evaluate(t=>{document.documentElement.dataset.theme=t;},t);
const shot=async name=>{await page.evaluate(()=>document.getElementById('toast').classList.remove('show'));await page.waitForTimeout(300);await page.screenshot({path:path.join(shots,'sftp-'+name+'.png')});};
const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||[...document.querySelectorAll('.sheet,.main,.files-dock,.chat-head,.fx-tools,.fx-body')].some(n=>n.scrollWidth>n.clientWidth+1));
const row=name=>page.locator('#files-list .file-row-wrap').filter({has:page.locator('.file-name',{hasText:new RegExp('^'+name.replace(/[.*?()[\]]/g,'\\$&')+'$')})});
const names=()=>page.locator('#files-list .files-card .file-row-wrap .file-name').allTextContents();
const toastSeen=text=>page.waitForFunction(t=>document.getElementById('toast').textContent.includes(t),text);
const tap=name=>page.getByRole('button',{name,exact:true}).click();
const item=name=>page.getByRole('dialog',{name:'文件选项'}).getByRole('button',{name:new RegExp('^'+name)}).first().click();
const back=()=>page.getByRole('button',{name:'返回文件列表',exact:true}).click();
const title=t=>page.locator('.fx-title').filter({hasText:new RegExp('^'+t.replace(/[.*?()[\]]/g,'\\$&')+'$')}).waitFor();

// ── Entry: header button (all tabs), 终端 tab row and the 设备 card ──
const entry=page.locator('.files-entry');await entry.waitFor();
assert.match(await entry.getAttribute('aria-label'),/文件：上传、下载和预览电脑上的文件/);
assert.equal(await page.locator('.bottom-nav .nav-item').count(),5,'仍只有五个底部导航；文件放在页头');
assert.equal(await page.locator('.files-entry.is-new').count(),1,'first-run mark shows until 文件 is opened');
await entry.click();
await page.getByRole('heading',{name:'文件',exact:true}).waitFor();
await page.locator('.files-head').getByRole('button',{name:'返回',exact:true}).click();
await page.getByRole('heading',{name:'会话',exact:true}).waitFor();
await page.waitForFunction(()=>fx.calls.some(c=>c.op==='cachePut'&&c.a.key==='files:hint'),null,{timeout:4000});
await tap('终端');
const termEntry=page.getByRole('button',{name:'打开文件：上传或下载电脑上的文件',exact:true});await termEntry.waitFor();
assert.match(await termEntry.innerText(),/通过 SSH 传文件/);
await tap('设备');await page.getByRole('button',{name:'打开文件：上传、下载',exact:true}).waitFor();
console.log('PASS: 文件 is reachable from the header (all tabs), 终端 and the device card; first-run hint is remembered');

// ── Open: home listing, folders first, hidden files hidden, crumbs ──
await tap('打开文件：上传、下载');
await page.getByRole('heading',{name:'文件',exact:true}).waitFor();
await row('src').waitFor();
assert.deepEqual(await names(),['empty','latest','src','a*b?.txt','big.iso','report.pdf'],'folders (and links to folders) first, then files by name; .bashrc hidden');
assert.match(await page.locator('.files-facts').textContent(),/3 个文件夹 · 3 个文件 · 1 个隐藏/);
assert.equal(await page.locator('.files-crumb.here').innerText(),'主目录');
assert.match(await row('report.pdf').innerText(),/2\.4 MB/);
assert.match(await row('latest').innerText(),/链接 → 文件夹/);
assert.equal((await calls('sftpList'))[0].path,'~');
await page.getByText('不用另开 FTP',{exact:false}).waitFor();
await shot('home-light');await theme('dark');await shot('home-dark');await theme('light');
await page.setViewportSize({width:320,height:640});assert.equal(await overflow(),false,'listing + header entry fit 320 px');await shot('home-320');await page.setViewportSize({width:390,height:844});
console.log('PASS: home listing (folders first, hidden files counted), crumbs, sizes, link targets, 320 px');

// Hidden files and sort from the menu, remembered.
await page.getByRole('button',{name:'文件选项',exact:true}).click();await item('显示隐藏文件');
await row('.bashrc').waitFor();
await page.getByRole('button',{name:/^排序方式/}).click();await page.getByRole('button',{name:/^按大小/}).click();
assert.deepEqual((await names()).slice(3),['big.iso','report.pdf','.bashrc','a*b?.txt'],'files by size, biggest first; folders stay first');
await page.waitForFunction(()=>fx.calls.some(c=>c.op==='cachePut'&&c.a.key==='files:prefs'));
assert.deepEqual((await calls('cachePut')).filter(c=>c.key==='files:prefs').at(-1),{key:'files:prefs',value:{sort:'size',hidden:true},device:'A'},'remembered per computer in the native cache');
await page.getByRole('button',{name:/^排序方式/}).click();await page.getByRole('button',{name:/^按名称/}).click();
await page.getByRole('button',{name:'文件选项',exact:true}).click();await item('不显示隐藏文件');await row('.bashrc').waitFor({state:'detached'});
console.log('PASS: hidden toggle and sort (by size), saved per phone');

// ── Navigation: into folders, crumbs, back goes up the way you came, then out ──
await row('src').locator('.file-row').click();await row('app').waitFor();
assert.deepEqual((await page.locator('.files-crumb').allTextContents()),['主目录','src']);
await row('app').locator('.file-row').click();await row('main.c').waitFor();
await page.getByRole('button',{name:'去 主目录 /home/u',exact:true}).click();await row('report.pdf').waitFor();
await page.evaluate(()=>pocketBack());await row('main.c').waitFor();
await page.evaluate(()=>pocketBack());await row('app').waitFor();
await page.locator('#files-list .file-up').click();await row('src').waitFor();
await row('src').locator('.file-row').click();await row('app').waitFor();
// Came through ~ → src → ~ (上一级) → src: four steps back, the last one leaves.
let backs=0;while(backs<8&&await page.evaluate(()=>!!FX.view)){await page.evaluate(()=>pocketBack());backs++;await page.waitForTimeout(200);}
assert.equal(backs,4,'one back per folder visited, then out');
assert.equal(await page.evaluate(()=>FX.view),null,'back past the first folder leaves 文件');
assert.equal(await page.locator('.files-head').count(),0);
console.log('PASS: folders open, crumbs jump, back walks the folders you came through, then leaves');
// Home button jumps straight to ~ from any depth.
await page.evaluate(()=>filesOpen());await row('src').waitFor();
await row('src').locator('.file-row').click();await row('app').waitFor();
await page.getByRole('button',{name:'回到主目录',exact:true}).click();await row('report.pdf').waitFor();
assert.equal(await page.locator('.files-crumb.here').innerText(),'主目录');
console.log('PASS: home button jumps straight to ~');
// One tap back to the conversation 文件 was opened from.
await page.evaluate(()=>{S.chat={record:{id:'r1',thread:'t1',title:'测试会话',provider:'claude',parent:null,cwd:'/home/u',modified:Date.now()/1000},agent:null,title:'测试会话',provider:'claude'};filesOpen();});
await page.getByRole('heading',{name:'文件',exact:true}).waitFor();
assert.equal(await page.getByRole('button',{name:'返回会话',exact:true}).count(),1,'the header names the conversation it returns to');
await page.getByRole('button',{name:'返回会话',exact:true}).click();
await page.getByText('Claude · 历史只读',{exact:true}).waitFor();
console.log('PASS: 返回会话 leaves 文件 in one tap');

// ── Errors: a start folder that is gone falls back to home; a failed read shows 重试 ──
await page.evaluate(()=>filesOpen({path:'/gone/away'}));
await toastSeen('先从主目录开始');await row('src').waitFor();
await page.evaluate(()=>{fx.listFail=1;});
await page.getByRole('button',{name:'文件选项',exact:true}).click();await item('刷新');
await page.getByRole('alert').filter({hasText:'SSH 连接断了'}).waitFor();
assert.equal(await row('src').count(),1,'the last listing stays under the error');
await page.getByRole('button',{name:'重试',exact:true}).click();
await page.getByRole('alert').filter({hasText:'SSH 连接断了'}).waitFor({state:'detached'});
console.log('PASS: missing start folder falls back to ~; read errors are shown with 重试, list kept');

// ── Preview: code with line numbers, highlighting, wrap, in-file search, real read bytes ──
await row('src').locator('.file-row').click();await row('app').waitFor();
await row('app').locator('.file-row').click();await row('main.c').waitFor();
await page.evaluate(()=>{fx.previewDelay=400;});
await row('main.c').locator('.file-row').click();
await title('main.c');
await page.waitForFunction(()=>document.querySelector('.fx-read-bytes')?.textContent.includes('600 B'));
assert.match(await page.locator('.fx-read-bytes').innerText(),/^600 B \/ 1 KB$/);
assert.equal(await page.evaluate(()=>FX.pv.got),600,'the bar shows only bytes native reported');
await page.locator('.fx-code').waitFor();
assert((await page.locator('.fx-line').count())>=6,'one row per source line');
assert.equal(await page.locator('.fx-line').first().locator('.fx-ln').innerText(),'1');
assert((await page.locator('.fx-tok.kw').count())>0,'C keywords are tokenised');
assert.match(await page.locator('.fx-code').innerText(),/printf\("hello/);
await shot('preview-code-light');await theme('dark');await shot('preview-code-dark');await theme('light');
// wrap toggle
assert.equal(await page.locator('.fx-code.wrap').count(),0);
await page.getByRole('button',{name:'自动换行',exact:true}).click();
assert.equal(await page.locator('.fx-code.wrap').count(),1);
// in-file search
await page.getByRole('button',{name:'在文件里查找',exact:true}).click();
await page.locator('#fx-find input').fill('printf');
await page.waitForFunction(()=>document.getElementById('fx-find-count').textContent.includes('1 / 1'));
assert.equal((await page.locator('mark.fx-hit').allTextContents()).join(''),'printf');
await page.getByRole('button',{name:'关闭查找',exact:true}).click();
await back();await row('main.c').waitFor();
await page.evaluate(()=>{fx.previewDelay=60;});
await page.getByRole('button',{name:'去 主目录 /home/u',exact:true}).click();await row('report.pdf').waitFor();
console.log('PASS: code preview: line numbers, syntax colours, wrap toggle, in-file search, real read bytes');

// ── Preview kinds: Markdown, JSON, CSV, image zoom, PDF pages, fallback, HTML never runs ──
await page.evaluate(()=>{
 fxAdd('/home/u/notes.md','file',900,'# 项目笔记\n\n- 第一项\n- **第二项**\n\n```sh\nmake test\n```\n');
 fxAdd('/home/u/data.json','file',120,'{"name":"pocket","n":3,"ok":true,"items":[1,2]}');
 fxAdd('/home/u/table.csv','file',80,'name,size\nmain.c,1200\nnotes.md,900\n');
 fxAdd('/home/u/shot.png','file',4000);
 fxAdd('/home/u/blob.bin','file',400,'binary');
 fxAdd('/home/u/evil.html','file',200,'<script>window.__pwn=1</script><img src=x onerror="window.__pwn=2">');
 fxAdd('/home/u/.env','file',80,'API_KEY=secret\nDB=local\n');
 fxAdd('/home/u/huge.jpg','file',25_000_000);
 fxAdd('/home/u/pair','dir',0);fxAdd('/home/u/pair/one.txt','file',10,'one');fxAdd('/home/u/pair/two.txt','file',10,'two');
});
await page.getByRole('button',{name:'文件选项',exact:true}).click();await item('刷新');await row('data.json').waitFor();
// Markdown is rendered, source is one tap away.
await row('notes.md').locator('.file-row').click();await title('notes.md');
await page.locator('.fx-md .md-h').filter({hasText:'项目笔记'}).waitFor();
assert((await page.locator('.fx-md li').count())>=2);
await page.getByRole('button',{name:'源码',exact:true}).click();await page.locator('.fx-code').waitFor();
await page.getByRole('button',{name:'预览',exact:true}).click();await page.locator('.fx-md .md-h').waitFor();
await back();
// JSON is pretty-printed.
await row('data.json').locator('.file-row').click();await title('data.json');await page.locator('.fx-code').waitFor();
assert.match(await page.locator('.fx-code').innerText(),/"name": "pocket"/);
assert.match(await page.locator('.fx-code').innerText(),/\n  "n": 3/);
await back();
// CSV is a table.
await row('table.csv').locator('.file-row').click();await title('table.csv');await page.locator('.fx-table').waitFor();
assert.deepEqual(await page.locator('.fx-table th').allTextContents(),['name','size']);
assert.equal(await page.locator('.fx-table tbody tr').count(),2);
await page.getByRole('button',{name:'源码',exact:true}).click();await page.locator('.fx-code').waitFor();
await back();
// A repaint (status polls call render()) keeps the list where it was; closing a preview comes back there.
await page.setViewportSize({width:390,height:420});
const listTop=await page.evaluate(()=>{const m=document.getElementById('files-main');m.scrollTop=m.scrollHeight;return m.scrollTop;});
assert(listTop>0,'the list scrolls at this height');
await page.evaluate(()=>render());
assert.equal(await page.evaluate(()=>document.getElementById('files-main').scrollTop),listTop,'render() keeps the file list position');
await row('notes.md').locator('.file-row').evaluate(b=>b.click());await title('notes.md');
await page.locator('.fx-md').waitFor();
await page.evaluate(()=>{const b=document.getElementById('fx-body');b.scrollTop=40;render();});
assert.equal(await page.evaluate(()=>document.getElementById('fx-body').scrollTop),await page.evaluate(()=>Math.min(40,document.getElementById('fx-body').scrollHeight-document.getElementById('fx-body').clientHeight)),'render() keeps a text preview position');
await back();
assert.equal(await page.evaluate(()=>document.getElementById('files-main').scrollTop),listTop,'closing a preview returns to the same list position');
await page.setViewportSize({width:390,height:844});
console.log('PASS: render() and closing a preview keep the file list position');
// Image: the original cache file is served by URL (never data:), decoded at full width.
await row('shot.png').locator('.file-row').click();await title('shot.png');await page.locator('.fx-zoom img').waitFor();
await page.waitForFunction(()=>{const i=document.querySelector('.fx-zoom img');return i&&i.complete&&i.naturalWidth>2000;});
const imgSrc=await page.locator('.fx-zoom img').getAttribute('src');
assert.match(imgSrc,/^https:\/\/pocket\.invalid\/preview\/[0-9a-f]{40}$/);
assert.equal((await page.evaluate(()=>[...document.querySelectorAll('#fx-body img')].filter(i=>i.src.startsWith('data:image')).length)),0,'image preview never uses data:');
const fit=await page.evaluate(()=>FX.pv.imgView.scale);
assert(fit>0&&fit<1,'fit scale shrinks a 2400 px picture');
const scaleNow=()=>page.evaluate(()=>FX.pv.imgView.scale);
await page.getByRole('button',{name:'放大',exact:true}).click();
assert((await scaleNow())>fit,'+ zooms in');
// Pinch: two touch pointers moving apart.
const beforePinch=await scaleNow();
await page.evaluate(()=>{const st=document.querySelector('.fx-stage');const ev=(t,id,x,y)=>st.dispatchEvent(new PointerEvent(t,{bubbles:true,clientX:x,clientY:y,pointerId:id,pointerType:'touch'}));
 ev('pointerdown',11,140,420);ev('pointerdown',12,240,420);ev('pointermove',12,340,420);ev('pointerup',11,140,420);ev('pointerup',12,340,420);});
assert((await scaleNow())>beforePinch,'pinch zooms');
await page.getByRole('button',{name:'适应屏幕',exact:true}).click();
assert.match(await page.locator('.fx-zoom').getAttribute('style'),/translate3d\(0px, 0px, 0px\)/,'fit recentres');
await page.getByRole('button',{name:'旋转 90 度',exact:true}).click();
assert.match(await page.locator('.fx-zoom').getAttribute('style'),/rotate\(90deg\)/);
await page.getByRole('button',{name:'按原像素显示',exact:true}).click();
assert.equal(await page.evaluate(()=>{const i=document.querySelector('.fx-zoom img');return i.offsetWidth===i.naturalWidth&&i.offsetHeight===i.naturalHeight;}),true,'1:1 shows native pixels');
assert.doesNotMatch(await page.locator('.fx-zoom').getAttribute('style'),/scale\(/,'zoom sizes the image; no huge scaled layer');
await page.getByRole('button',{name:'适应屏幕',exact:true}).click();
await back();
// PDF: every page in one vertical scroll (no page turning), rendered natively at screen density as
// it comes near; buttons, page input and slider scroll to a page; zoom resizes the pages.
await row('report.pdf').locator('.file-row').click();await title('report.pdf');
await page.locator('.fx-pdf-page img').first().waitFor();
await page.waitForFunction(()=>{const i=document.querySelector('.fx-pdf-page img');return i&&i.complete&&i.naturalWidth>2000;});
const pdfSrc=await page.locator('.fx-pdf-page img').first().getAttribute('src');
assert.match(pdfSrc,/^https:\/\/pocket\.invalid\/preview\/page\/[0-9a-f]{40}$/);
assert.equal((await page.evaluate(()=>[...document.querySelectorAll('#fx-body img')].filter(i=>i.src.startsWith('data:image')).length)),0,'PDF pages never use data:');
assert.equal(await page.locator('.fx-pdf-page').count(),3,'all pages are laid out in one scroll');
assert.equal(await page.locator('.fx-page-input').inputValue(),'1');
assert.equal(await page.getByRole('button',{name:'旋转 90 度',exact:true}).count(),0,'no single-page rotate in the continuous view');
const pdfWidth=(await calls('sftpPreview')).filter(a=>a.kind==='pdf').at(-1).width;
assert(pdfWidth>=1200&&pdfWidth<=3000,'PDF pages render at the device-pixel width, not 4×/4096: '+pdfWidth);
// Pages fit the screen width and keep their own shapes (portrait, landscape, portrait) before they render.
const pdfLay=await page.evaluate(()=>{const s=document.querySelector('.fx-pdf-scroll').getBoundingClientRect();
 return {sw:s.width,innerW:innerWidth,pages:[...document.querySelectorAll('.fx-pdf-page')].map(g=>{const r=g.getBoundingClientRect();return [r.width,r.height];}),style:[...document.querySelectorAll('.fx-pdf-page')].map(g=>g.getAttribute('style')).join(';')};});
assert(pdfLay.sw<=pdfLay.innerW+1,'PDF scroll fits the screen: '+JSON.stringify(pdfLay));
assert(pdfLay.pages.every(([w])=>w<=pdfLay.sw&&w>=pdfLay.sw-24),'pages fill the width: '+JSON.stringify(pdfLay));
assert(Math.abs(pdfLay.pages[0][1]-pdfLay.pages[0][0]*4/3)<2&&Math.abs(pdfLay.pages[1][1]-pdfLay.pages[1][0]*3/4)<2,'each page keeps its own size: '+JSON.stringify(pdfLay));
assert.doesNotMatch(pdfLay.style,/scale\(/,'pages are sized, never a scaled layer');
await page.waitForFunction(()=>document.querySelectorAll('.fx-pdf-page img').length===3);
assert.deepEqual((await page.evaluate(()=>fx.previewPages.map(a=>a.page))).sort(),[1,2],'the other pages are rendered once each, page 1 came with the preview');
await page.setViewportSize({width:320,height:640});
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'PDF preview fits 320 px');
assert.equal(await page.evaluate(()=>{const n=document.querySelector('.fx-pager');return !n||n.scrollWidth<=n.clientWidth+1;}),true,'page controls fit 320 px');
await page.waitForFunction(()=>{const s=document.querySelector('.fx-pdf-scroll'),g=document.querySelector('.fx-pdf-page');return g.getBoundingClientRect().width<=s.clientWidth;});
await shot('preview-pdf-320');
await page.setViewportSize({width:390,height:844});
// Pager: buttons, input and slider scroll to the page; scrolling by hand updates the number.
await page.getByRole('button',{name:'下一页',exact:true}).click();
await page.waitForFunction(()=>FX.pv?.page===1);
assert.equal(await page.locator('.fx-page-input').inputValue(),'2');
assert(await page.evaluate(()=>{const s=document.querySelector('.fx-pdf-scroll'),g=document.querySelectorAll('.fx-pdf-page')[1];return g.getBoundingClientRect().top<s.getBoundingClientRect().bottom;}),'page 2 is on screen');
await page.locator('.fx-page-slider').evaluate(el=>{el.value='3';el.dispatchEvent(new Event('change'));});
await page.waitForFunction(()=>FX.pv?.page===2);
assert.equal(await page.locator('.fx-page-input').inputValue(),'3');
assert.equal(await page.getByRole('button',{name:'下一页',exact:true}).isDisabled(),true,'下一页 stops at the last page');
await page.getByRole('button',{name:'上一页',exact:true}).click();await page.waitForFunction(()=>FX.pv?.page===1);
await page.locator('.fx-pdf-scroll').evaluate(s=>{s.scrollTop=0;});
await page.waitForFunction(()=>FX.pv?.page===0);
assert.equal(await page.locator('.fx-page-input').inputValue(),'1','scrolling updates the page number');
// Zoom: 100% is the fitted width; + resizes the pages; past 140% the visible pages get a sharper render.
const w0=await page.evaluate(()=>document.querySelector('.fx-pdf-page').getBoundingClientRect().width);
await page.getByRole('button',{name:'放大',exact:true}).click();
assert.equal(await page.locator('#fx-zoom-pct').innerText(),'125%');
const w1=await page.evaluate(()=>document.querySelector('.fx-pdf-page').getBoundingClientRect().width);
assert(Math.abs(w1-w0*1.25)<2,'zoom resizes the pages: '+w0+' → '+w1);
assert(await page.evaluate(()=>document.querySelector('.fx-pdf-scroll').scrollWidth>document.querySelector('.fx-pdf-scroll').clientWidth),'a zoomed page pans sideways');
await page.getByRole('button',{name:'放大',exact:true}).click();
await page.waitForFunction(w=>fx.previewPages.some(a=>a.width>w),pdfWidth);
await page.getByRole('button',{name:'适应屏幕',exact:true}).click();
assert.equal(await page.locator('#fx-zoom-pct').innerText(),'100%');
await back();
// A page that fails to render says so in place with 重试; the rest of the document still shows.
await page.evaluate(()=>{fx.pageFail=1;});
await row('report.pdf').locator('.file-row').click();await title('report.pdf');
await page.locator('.fx-pdf-ph.err').waitFor();
assert.match(await page.locator('.fx-pdf-ph.err').innerText(),/第 2 页没渲染出来/);
assert((await page.locator('.fx-pdf-page img').count())>=1,'other pages still show');
await page.locator('.fx-pdf-ph.err').getByRole('button',{name:'重试',exact:true}).click();
await page.waitForFunction(()=>document.querySelectorAll('.fx-pdf-page')[1].querySelector('img'));
assert.equal(await page.locator('.fx-pdf-ph.err').count(),0);
await back();
// Binary fallback keeps the useful actions and moves no bytes into the page.
await row('blob.bin').locator('.file-row').click();await title('blob.bin');
await page.locator('.fx-fallback').waitFor();
assert.match(await page.locator('.fx-fallback').innerText(),/二进制文件/);
const fb=page.locator('.fx-fallback');
for(const b of ['用其他应用打开','分享','下载到手机','另存为…','复制路径'])await fb.getByRole('button',{name:b,exact:true}).waitFor();
await fb.getByRole('button',{name:'用其他应用打开',exact:true}).click();
await fb.getByRole('button',{name:'分享',exact:true}).click();
assert.deepEqual(await page.evaluate(()=>fx.previewOpened),[{key:'a'.repeat(40),share:false},{key:'a'.repeat(40),share:true}]);
await back();
// Remote HTML/JS is text, never a document: no script runs, no img element is created.
await row('evil.html').locator('.file-row').click();await title('evil.html');await page.locator('.fx-code').waitFor();
assert.equal(await page.evaluate(()=>window.__pwn),undefined,'remote script did not run');
assert.equal(await page.locator('.fx-code img').count(),0,'remote HTML did not become elements');
assert.match(await page.locator('.fx-code').innerText(),/<script>window\.__pwn=1<\/script>/);
await back();
console.log('PASS: Markdown rendered, JSON pretty, CSV table, image zoom, PDF pages, binary fallback, remote HTML inert');

// Keys and credentials: preview and download both warn first.
await page.evaluate(()=>{FX.hidden=true;paintFiles();});
await row('.env').waitFor();
const previewsBefore=(await calls('sftpPreview')).length;
await row('.env').locator('.file-row').click();
const warn=page.getByRole('dialog',{name:'预览这个敏感文件？'});await warn.getByText('不会进手机的「下载」文件夹',{exact:false}).waitFor();
assert.equal((await calls('sftpPreview')).length,previewsBefore,'nothing read before the warning is accepted');
await warn.getByRole('button',{name:'仍然预览'}).click();await page.locator('.fx-code').waitFor();
assert.match(await page.locator('.fx-code').innerText(),/API_KEY=secret/);
await back();
// Big media asks before reading the whole file.
const beforeBig=(await calls('sftpPreview')).length;
await row('huge.jpg').locator('.file-row').click();
const big=page.getByRole('dialog',{name:/^预览 25 MB 的文件？/});await big.waitFor();
assert.equal((await calls('sftpPreview')).length,beforeBig);
await big.getByRole('button',{name:'仍然预览'}).click();
await page.locator('.fx-zoom img').waitFor();
assert.equal((await calls('sftpPreview')).at(-1).allowLarge,true);
await back();
console.log('PASS: sensitive preview warns first; oversized media asks before reading');

// Cache hit paints instantly; swiping moves between files in the folder.
const mdCalls=(await calls('sftpPreview')).length;
await row('notes.md').locator('.file-row').click();await title('notes.md');
await page.locator('.fx-cache-chip').filter({hasText:'已缓存'}).waitFor({timeout:500});
assert.equal((await calls('sftpPreview')).length,mdCalls,'the second open did not read the file again');
await back();
await row('pair').locator('.file-row').click();await row('one.txt').waitFor();
await row('one.txt').locator('.file-row').click();await title('one.txt');await page.locator('.fx-code').waitFor();
await page.evaluate(()=>{const b=document.getElementById('fx-body');const ev=(t,x)=>b.dispatchEvent(new PointerEvent(t,{bubbles:true,clientX:x,clientY:240,pointerId:1,pointerType:'touch'}));ev('pointerdown',320);ev('pointerup',160);});
await title('two.txt');await page.locator('.fx-code').waitFor();
await back();await page.getByRole('button',{name:'去 主目录 /home/u',exact:true}).click();await row('report.pdf').waitFor();
// Leaving while a read is still going tells native to stop at its next block.
await page.evaluate(()=>{fxAdd('/home/u/slow.txt','file',5000,'slow');filesLoad(filesHere());});
await row('slow.txt').waitFor();
await page.evaluate(()=>{fx.previewDelay=900;});
await row('slow.txt').locator('.file-row').click();await title('slow.txt');
await page.waitForFunction(()=>FX.pv?.token);
const token=await page.evaluate(()=>FX.pv.token);
await back();
await page.waitForFunction(t=>fx.previewCancelled.includes(t),token);
await page.evaluate(()=>{fx.previewDelay=60;});
console.log('PASS: cache hit is instant; horizontal swipe moves to the next file; leaving cancels the read');

// ── Download: sheet, progress in the dock, done toast with 打开 / 分享; big file asks first; cancel ──
await row('report.pdf').locator('.file-more').click();
const sheetBox=page.getByRole('dialog',{name:'report.pdf'});await sheetBox.waitFor();
await sheetBox.locator('code',{hasText:'/home/u/report.pdf'}).waitFor();
await shot('file-sheet');
await sheetBox.getByRole('button',{name:/^下载到手机/}).click();
await toastSeen('开始下载「report.pdf」');
assert.deepEqual((await calls('sftpDownload')).at(-1),{device:'A',path:'/home/u/report.pdf',size:2400000,saveAs:false});
await page.evaluate(()=>fxStep('t1',1_200_000));
await page.locator('.files-dock').getByText('1 个正在传：report.pdf').waitFor();
await page.locator('.files-dock').getByText(/1\.2 MB \/ 2\.4 MB/).waitFor();
await shot('dock-progress');
await page.evaluate(()=>fxStep('t1',2_400_000,'done',{where:'下载/Herdr Pocket',canOpen:true}));
await toastSeen('「report.pdf」下载好了，在下载/Herdr Pocket');
await page.getByRole('button',{name:'打开',exact:true}).waitFor();
await page.getByRole('button',{name:'分享',exact:true}).waitFor();
await page.locator('.files-dock').getByText('都传完了').waitFor();
await page.getByRole('button',{name:'传输列表',exact:true}).click();
const tl=page.getByRole('dialog',{name:'传输'});await tl.getByText('已存到 下载/Herdr Pocket').waitFor();
await tl.getByRole('button',{name:'打开',exact:true}).click();
await tl.getByRole('button',{name:'分享 report.pdf',exact:true}).click();
await page.waitForFunction(()=>fx.opened.length===2);
assert.deepEqual(await page.evaluate(()=>fx.opened),[{transfer:'t1'},{transfer:'t1',share:true}],'open/share name the transfer, never a URI');
await shot('transfers-sheet');
await page.getByRole('button',{name:'关闭',exact:true}).click();
// Big file: asks first; 另存为 goes through the picker flag.
await row('big.iso').locator('.file-more').click();
await page.getByRole('dialog',{name:'big.iso'}).getByRole('button',{name:/^另存为/}).click();
const bigDl=page.getByRole('dialog',{name:/^下载 3200 MB/});await bigDl.waitFor();
await bigDl.getByRole('button',{name:'下载',exact:true}).click();
await toastSeen('开始下载「big.iso」');
assert.equal((await calls('sftpDownload')).at(-1).saveAs,true);
await page.getByRole('button',{name:'传输列表',exact:true}).click();
await tl.getByRole('button',{name:'取消',exact:true}).click();
await tl.getByText('已取消').waitFor();
assert.equal((await calls('sftpCancel'))[0].transfer,'t2');
await tl.getByRole('button',{name:'清除已结束的',exact:true}).click();
await tl.waitFor({state:'detached'});
await page.locator('.files-dock').waitFor({state:'hidden'});
console.log('PASS: download: progress dock, done toast with 打开/分享, 打开/分享 by transfer id, big file confirm, 另存为, cancel, clear');

// Keys and credentials: download only after a warning.
await page.evaluate(()=>fx.T.set('/home/u/server.pem',{type:'file',size:900,mtime:1}));
await page.getByRole('button',{name:'文件选项',exact:true}).click();await item('刷新');await row('server.pem').waitFor();
const downs=(await calls('sftpDownload')).length;
await row('server.pem').locator('.file-more').click();
await page.getByRole('dialog',{name:'server.pem'}).getByRole('button',{name:/^下载到手机/}).click();
const warnDl=page.getByRole('dialog',{name:'下载这个敏感文件？'});await warnDl.getByText('别的应用也可能读到',{exact:false}).waitFor();
assert.equal((await calls('sftpDownload')).length,downs,'nothing downloaded before the warning is accepted');
await warnDl.getByRole('button',{name:'仍然下载'}).click();await toastSeen('开始下载「server.pem」');
assert.equal((await calls('sftpDownload')).at(-1).path,'/home/u/server.pem');
await page.evaluate(()=>{fx.T.delete('/home/u/server.pem');fxStep('t3',900,'done',{where:'下载/Herdr Pocket',canOpen:true});});
await toastSeen('「server.pem」下载好了');
await page.getByRole('button',{name:'文件选项',exact:true}).click();await item('刷新');await row('server.pem').waitFor({state:'detached'});
console.log('PASS: key / credential files download only after a warning');

// ── Upload: no clash goes as "new"; a clash asks 替换 / 保留两个 / 跳过; folders cannot be replaced ──
await page.evaluate(()=>fx.picks.push({files:[{id:'p1',name:'photo.jpg',size:1000},{id:'p2',name:'report.pdf',size:5000},{id:'p3',name:'src',size:10}],failed:0}));
await page.getByRole('button',{name:'上传到这里',exact:true}).click();
const clash=page.getByRole('dialog',{name:'已经有「report.pdf」了'});await clash.waitFor();
await clash.getByText('后面 1 个同名的也这样处理').waitFor();
await clash.getByText('新的叫「report (2).pdf」').waitFor();
await shot('upload-conflict');
await clash.getByRole('button',{name:/^保留两个/}).click();
const clash2=page.getByRole('dialog',{name:'已经有「src」了'});await clash2.waitFor();
assert.equal(await clash2.getByRole('button',{name:/^替换/}).isDisabled(),true,'a folder is never replaced');
await clash2.getByRole('button',{name:'跳过',exact:true}).click();
await toastSeen('开始上传 2 个文件');
const ups=await calls('sftpUpload');
assert.deepEqual(ups.map(u=>[u.id,u.name,u.mode,u.dir,u.device]),[['p1','photo.jpg','new','/home/u','A'],['p2','report.pdf','keep','/home/u','A']]);
assert.deepEqual(await page.evaluate(()=>fx.dropped),['p3'],'a skipped pick is let go natively');
// The upload appears in the list as a pending row with a real progress bar.
await page.locator('.fx-pending').filter({hasText:'photo.jpg'}).waitFor();
// Done upload into the folder on screen reloads it.
const lists=(await calls('sftpList')).length;
await page.evaluate(()=>{fx.T.set('/home/u/photo.jpg',{type:'file',size:1000,mtime:Math.floor(Date.now()/1000)});fxStep('t4',1000,'done');});
await toastSeen('「photo.jpg」传到电脑上了');await row('photo.jpg').waitFor();
assert((await calls('sftpList')).length>lists,'listing refreshed after the upload landed here');
await page.evaluate(()=>fxStep('t5',100,'failed',{error:'电脑上已经有「report.pdf」了，没有覆盖'}));
await toastSeen('上传「report.pdf」没成功：电脑上已经有「report.pdf」了，没有覆盖');
// Closing the clash sheet stops the rest; nothing is uploaded for them.
await page.evaluate(()=>fx.picks.push({files:[{id:'q1',name:'report.pdf',size:1},{id:'q2',name:'zzz.txt',size:1}],failed:0}));
await page.getByRole('button',{name:'上传到这里',exact:true}).click();
await page.getByRole('dialog',{name:'已经有「report.pdf」了'}).waitFor();
await page.getByRole('button',{name:'关闭',exact:true}).click();
await page.waitForFunction(()=>fx.dropped.includes('q2'));
assert.equal((await calls('sftpUpload')).length,2,'closing the question uploads nothing more');
// 替换 for all the rest.
await page.evaluate(()=>fx.picks.push({files:[{id:'r1',name:'report.pdf',size:1},{id:'r2',name:'a*b?.txt',size:1}],failed:0}));
await page.getByRole('button',{name:'上传到这里',exact:true}).click();
await page.getByRole('dialog',{name:'已经有「report.pdf」了'}).getByText('后面 1 个同名的也这样处理').click();
await page.getByRole('button',{name:/^替换/}).click();
await page.waitForFunction(()=>fx.calls.filter(c=>c.op==='sftpUpload').length===4);
assert.deepEqual((await calls('sftpUpload')).slice(2).map(u=>[u.name,u.mode]),[['report.pdf','replace'],['a*b?.txt','replace']],'答案 applies to the rest; names with * and ? go as they are');
assert.equal(await page.getByRole('dialog').count(),0,'asked only once');
console.log('PASS: upload: new / 保留两个 / 跳过 / 替换 (also for the rest), pending row, folders not replaced, closing stops, reload on landing');

// ── New folder, rename ──
await page.getByRole('button',{name:'文件选项',exact:true}).click();await item('新建文件夹');
const mkd=page.getByRole('dialog',{name:'新建文件夹'});await mkd.getByText('建在 /home/u').waitFor();
await mkd.getByRole('textbox',{name:'文件夹名'}).fill('a/b');await mkd.getByRole('button',{name:'创建'}).click();
await mkd.getByText('名字里不能有 /').waitFor();assert.equal((await calls('sftpMkdir')).length,0,'checked before asking the computer');
await mkd.getByRole('textbox',{name:'文件夹名'}).fill('src');await mkd.getByRole('button',{name:'创建'}).click();
await mkd.getByText('这里已经有叫「src」的了').waitFor();
await mkd.getByRole('textbox',{name:'文件夹名'}).fill('新项目');await mkd.getByRole('textbox',{name:'文件夹名'}).press('Enter');
await toastSeen('建好了「新项目」');await row('新项目').waitFor();
assert.deepEqual((await calls('sftpMkdir')).at(-1),{device:'A',dir:'/home/u',name:'新项目'});
await row('新项目').locator('.file-more').click();await page.getByRole('dialog',{name:'新项目'}).getByRole('button',{name:'重命名'}).click();
const ren=page.getByRole('dialog',{name:'重命名'});await ren.getByRole('textbox',{name:'新名字'}).fill('项目二');await ren.getByRole('button',{name:'改名'}).click();
await toastSeen('改好了');await row('项目二').waitFor();
assert.deepEqual((await calls('sftpRename')).at(-1),{device:'A',path:'/home/u/新项目',name:'项目二'});
console.log('PASS: new folder (inline name errors, clash), rename');

// ── Delete: a file after a confirm; a folder with things in it needs its name typed ──
await row('photo.jpg').locator('.file-more').click();await page.getByRole('dialog',{name:'photo.jpg'}).getByRole('button',{name:/^删除/}).click();
await page.getByRole('dialog',{name:'删除「photo.jpg」？'}).getByText('不进回收站',{exact:false}).waitFor();
await page.getByRole('dialog',{name:'删除「photo.jpg」？'}).getByRole('button',{name:'删除',exact:true}).click();await toastSeen('删掉了「photo.jpg」');await row('photo.jpg').waitFor({state:'detached'});
await row('src').locator('.file-more').click();await page.getByRole('dialog',{name:'src'}).getByRole('button',{name:/^删除/}).click();
await page.getByRole('dialog',{name:'删除「src」？'}).getByRole('button',{name:'删除',exact:true}).click();
const strong=page.getByRole('dialog',{name:'文件夹里还有东西'});await strong.waitFor();
const all=strong.getByRole('button',{name:'全部删除'});assert.equal(await all.isDisabled(),true);
await strong.getByRole('textbox',{name:'输入文件夹名确认'}).fill('sr');assert.equal(await all.isDisabled(),true,'only the exact name unlocks it');
await shot('delete-strong');
await strong.getByRole('textbox',{name:'输入文件夹名确认'}).fill('src');await all.click();
await toastSeen('删掉了 4 项');await row('src').waitFor({state:'detached'});
assert.deepEqual((await calls('sftpDelete')).map(d=>[d.path,!!d.recursive,d.confirm||'']),[['/home/u/photo.jpg',false,''],['/home/u/src',false,''],['/home/u/src',true,'src']]);
console.log('PASS: delete: file confirm, non-empty folder only after typing its name');

// ── Several at once: 多选 → delete; non-empty folders are skipped ──
await page.evaluate(()=>{fx.T.set('/home/u/x1.txt',{type:'file',size:1,mtime:1});fx.T.set('/home/u/x2.txt',{type:'file',size:1,mtime:1});fx.T.set('/home/u/full',{type:'dir',size:0,mtime:1});fx.T.set('/home/u/full/f',{type:'file',size:1,mtime:1});});
await page.getByRole('button',{name:'文件选项',exact:true}).click();await item('刷新');await row('x1.txt').waitFor();
await page.getByRole('button',{name:'文件选项',exact:true}).click();await item('多选');
await row('x1.txt').locator('.file-row').click();await row('x2.txt').locator('.file-row').click();await row('full').locator('.file-row').click();
await page.locator('.files-select-bar').getByText('已选 3 项').waitFor();
assert.equal(await row('x1.txt').locator('.file-row').getAttribute('aria-pressed'),'true');
await shot('select');
await page.setViewportSize({width:320,height:640});assert.equal(await overflow(),false,'selection bar fits 320 px');await page.setViewportSize({width:390,height:844});
await page.locator('.files-select-bar').getByRole('button',{name:'删除'}).click();
await page.getByRole('dialog',{name:'删除选中的 3 项？'}).getByRole('button',{name:'删除',exact:true}).click();
await toastSeen('删掉了 2 项，1 项没删（full：里面还有东西）');
await row('full').waitFor();assert.equal(await row('x1.txt').count(),0);
assert.equal(await page.locator('.files-select-bar').count(),0,'selection ends after the action');
console.log('PASS: 多选: several deleted together, a folder with things in it is skipped and named');

// ── From a terminal / chat: opens at that folder; every SFTP request named its computer ──
await page.evaluate(()=>{filesLeave();setTab('terminals');});
await page.evaluate(()=>{const box=sheet('x');filesTermItem(box,{kind:'pane',pane:{cwd:'/home/u/empty'}});});
await page.getByRole('button',{name:/^传文件/}).click();
await page.locator('.files-crumb.here',{hasText:'empty'}).waitFor();
await page.getByText('空文件夹',{exact:true}).waitFor();
assert.deepEqual(await page.evaluate(()=>fx.unnamed),[],'every device-bound SFTP request named its computer');
assert.deepEqual(await page.evaluate(()=>window.__csp),[],'no CSP violations while showing pocket.invalid preview assets');
assert.deepEqual(errors,[]);
console.log('PASS: terminal ⋯ 传文件 opens at the pane folder; all requests carry the device');
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
