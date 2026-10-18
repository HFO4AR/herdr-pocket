// Sending files and seeing them in history. Offline: the native layer is a strict fake that "picks"
// documents and records uploads; `remote` is a recorded fake. Nothing is sent anywhere.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const P='/home/yuki/.herdr-pocket/uploads/2026-10-15/';

(async()=>{
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});
const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
await page.addInitScript(()=>{
 window.nx={calls:[],picks:[],uploadFail:new Set()};let n=0;
 const hex=s=>[...s].map(c=>c.charCodeAt(0).toString(16)).join('').padEnd(64,'0').slice(0,64);
 window.PocketNative={request(id,op,raw){const args=JSON.parse(raw);nx.calls.push({op,args});
  const ok=data=>setTimeout(()=>nativeResult(id,{ok:true,data}),20),fail=error=>setTimeout(()=>nativeResult(id,{ok:false,error}),20);
  if(['devices','demo','disconnect','protect','watchState','dropFiles','dropImages'].includes(op))return ok(op==='devices'?{devices:[]}:{});
  if(op==='pickFiles'){const pick=nx.picks.shift()||{files:[]};const files=(pick.files||[]).map(([name,size])=>({id:'doc-'+(++n),name,size,mime:'application/octet-stream'}));
   return ok({files:files.slice(0,args.max),failed:pick.failed||0,reason:pick.reason||'',extra:Math.max(0,files.length-args.max)});}
  if(op==='uploadFile'){
   if(nx.uploadFail.has(args.id)){nx.uploadFail.delete(args.id);return fail('SFTP 写入失败');}
   const sha=hex(args.id);setTimeout(()=>nativeProgress(id,'2000'),5);
   return setTimeout(()=>nativeResult(id,{ok:true,data:{name:'2026-10-15/'+sha.slice(0,16)+'/'+nx.names[args.id],sha256:sha,size:nx.sizes[args.id]}}),900);}
  throw Error('Forbidden native call in offline UI test: '+op);}};
 nx.names={};nx.sizes={};});
await page.goto(require('./ui_bundle.cjs').url(html));
const folder=path.join(root,'ui-artifacts');fs.mkdirSync(folder,{recursive:true});
const shot=async file=>{await page.evaluate(()=>document.getElementById('toast').classList.remove('show'));await page.waitForTimeout(250);await page.screenshot({path:file});};
await page.getByRole('button',{name:'体验聊天演示',exact:true}).click();

// Demo mode never opens the file picker.
await page.getByRole('button',{name:/重构登录|清理构建缓存/}).first().click();
await page.getByRole('button',{name:'添加附件',exact:true}).click();
await page.getByRole('dialog',{name:'添加附件',exact:true}).waitFor();
await page.getByRole('button',{name:/^文件.*单个不超过 25 MB.*还能加 4 个/}).click();
await page.getByText('演示模式：不能添加文件',{exact:true}).waitFor();
assert(!(await page.evaluate(()=>nx.calls.some(c=>c.op==='pickFiles'))),'demo must not open a picker');
await page.getByRole('button',{name:'返回列表',exact:true}).click();
console.log('PASS: demo refuses files');

await page.evaluate(P=>{
 const t=n=>new Date(Date.UTC(2026,9,15,9,n)).toISOString();
 const msg=(n,kind,text,extra={})=>({id:n*100+':0',kind,text,title:'',call_id:'',timestamp:t(n),...extra});
 window.fx={calls:[],promptError:null,stageError:null,messages:[
  msg(1,'user','这是线上的报错日志，帮我看看是哪里挂了\n\n[文件] '+P+'0123456789abcdef/server-2026-10-15.log'),
  msg(2,'assistant','看完了：第 412 行连接池耗尽，`max_connections` 只有 10。'),
  msg(3,'user','[文件] '+P+'fedcba9876543210/需求说明 v3（终版）.pdf\n[文件] '+P+'00000000000000aa/backup.tar.gz'),
  msg(4,'assistant','需求说明读完了，压缩包里是旧版本的配置。'),
  msg(5,'user','这张截图和这个配置对一下\n\n[图片] '+P+'a'.repeat(64)+'.jpg\n[文件] /home/yuki/.herdr-pocket/uploads/2026-09-01/1111111111111111/old.yaml'),
  msg(6,'assistant','配置文件已经被清理了，你再发一次吧。'),
  msg(7,'user','[文件] 不是上传目录里的东西 /etc/hosts')]};
 fx.agent={pane_id:'w1:p3',identity:'id-doc',agent:'codex',agent_status:'idle',cwd:'/home/demo/api',terminal_title:'排查连接池',agent_session:{value:'s1'},
  history_ref:{status:'matched',record:{id:'rec-doc',thread:'s1',provider:'codex',title:'排查连接池',cwd:'/home/demo/api',modified:Date.now()/1000}}};
 const sizes={'2026-10-15/0123456789abcdef/server-2026-10-15.log':348211,'2026-10-15/fedcba9876543210/需求说明 v3（终版）.pdf':2412000,'2026-10-15/00000000000000aa/backup.tar.gz':18600000};
 remote=async(op,args={})=>{fx.calls.push({op,args});await new Promise(r=>setTimeout(r,20));
  if(op==='status')return{agents:[fx.agent]};
  // queue.js re-checks the pane read-only before every send.
  if(op==='agents'&&args.target)return{follow:true,state:'same',agents:[fx.agent],pane:null};
  if(op==='history')return{record:fx.agent.history_ref.record,messages:fx.messages,children:[],before:0,has_more:false};
  if(op==='read')return{text:'› '};
  if(op==='fileInfo')return{files:Object.fromEntries(args.names.map(n=>[n,sizes[n]?{size:sizes[n]}:{gone:true}]))};
  if(op==='stageFile'){if(fx.stageError){const e=fx.stageError;fx.stageError=null;throw Error(e);}return{remote:false,path:'/home/yuki/.herdr-pocket/uploads/'+args.name};}
  if(op==='prompt'){if(fx.promptError){const e=fx.promptError;fx.promptError=null;throw Error(e);}return{sent:true,receipt:args.id};}
  if(op==='image')throw Error('这张图片在电脑上已经清理掉了');
  throw Error('unexpected op '+op);};
 S.demo=false;S.session='fixture';S.agents=[fx.agent];
},P);
// Thumbnails are not under test here.
await page.evaluate(()=>{imgFetch=()=>Promise.reject(new Error('这张图片在电脑上已经清理掉了'));});
await page.evaluate(()=>openAgent(fx.agent));
await page.getByText('这是线上的报错日志，帮我看看是哪里挂了',{exact:true}).waitFor();
assert.equal(await page.getByText(/herdr-pocket\/uploads/).count(),0,'upload paths are hidden behind chips');
await page.getByText('[文件] 不是上传目录里的东西 /etc/hosts',{exact:true}).waitFor();
await page.waitForFunction(()=>[...document.querySelectorAll('.file-list .file-meta')].every(m=>m.textContent));
const chips=await page.locator('.file-list .file-chip').evaluateAll(cs=>cs.map(c=>[c.querySelector('.file-name').textContent,c.querySelector('.file-meta').textContent,c.querySelector('.file-badge').textContent,c.classList.contains('gone')]));
assert.deepEqual(chips,[['server-2026-10-15.log','348 KB','LOG',false],['需求说明 v3（终版）.pdf','2.4 MB','PDF',false],['backup.tar.gz','19 MB','GZ',false],['old.yaml','已清理','YAML',true]]);
const asked=await page.evaluate(()=>fx.calls.filter(c=>c.op==='fileInfo').map(c=>c.args.names));
assert.equal(asked.length,1,'one batched lookup');assert.equal(asked[0].length,4);
assert(asked[0].every(n=>/^2026-\d\d-\d\d\/[a-f0-9]{16}\/[^/]+$/.test(n)),'only relative upload names are asked');
// Files-only prompt: no empty bubble.
assert.equal(await page.locator('.message.user').nth(1).locator('.bubble').count(),0);
await page.evaluate(()=>{document.getElementById('chat-scroll').scrollTop=0;});
await shot(path.join(folder,'files-history-390.png'));
await page.getByRole('button',{name:'文件 需求说明 v3（终版）.pdf',exact:true}).click();
const detail=page.getByRole('dialog',{name:'文件',exact:true});await detail.waitFor();
await detail.getByText(P+'fedcba9876543210/需求说明 v3（终版）.pdf',{exact:true}).waitFor();
await detail.getByText('2.4 MB',{exact:true}).waitFor();
await shot(path.join(folder,'files-detail-390.png'));
await detail.getByRole('button',{name:'复制路径',exact:true}).click();
await page.getByText('已复制',{exact:true}).waitFor();
// Re-rendering keeps sizes without asking again.
await page.evaluate(()=>paintTimeline());await page.waitForTimeout(150);
assert.equal(await page.evaluate(()=>fx.calls.filter(c=>c.op==='fileInfo').length),1);
assert.equal(await page.locator('.file-list .file-chip.gone').count(),1);
console.log('PASS: history file chips with size / cleaned up, one batched lookup, detail sheet copies the path');

// Composer: pick two, a too-big one is refused by the native side, a duplicate is skipped.
await page.evaluate(()=>{nx.picks.push({files:[['crash-report.txt',5321],['数据导出 2026Q3.xlsx',8400000]]},{files:[['crash-report.txt',5321]],failed:1,reason:'「录屏.mp4」超过 25 MB'});});
await page.getByRole('button',{name:'添加附件',exact:true}).click();
await page.getByRole('dialog',{name:'添加附件',exact:true}).getByRole('button',{name:/^文件/}).click();
const tray=page.getByRole('list',{name:'要发送的文件',exact:true});
await tray.getByRole('listitem').nth(1).waitFor();
assert.match(await tray.locator('.att-note').textContent(),/^2\/4 个 · 8\.4 MB$/);
await page.getByRole('button',{name:'添加附件',exact:true}).click();
await page.getByRole('dialog',{name:'添加附件',exact:true}).getByRole('button',{name:/^文件.*还能加 2 个/}).click();
await page.getByText('没加上：「录屏.mp4」超过 25 MB',{exact:true}).waitFor();
assert.equal(await tray.getByRole('listitem').count(),2,'duplicate skipped');
assert.deepEqual(await page.evaluate(()=>nx.calls.filter(c=>c.op==='dropFiles').map(c=>c.args.ids)),[['doc-3']]);
assert.deepEqual(await page.evaluate(()=>nx.calls.filter(c=>c.op==='pickFiles').map(c=>c.args.max)),[4,2]);
assert(!(await page.getByRole('button',{name:'发送消息',exact:true}).isDisabled()),'send enabled with files only');
await page.evaluate(()=>{nx.names={'doc-1':'crash-report.txt','doc-2':'数据导出 2026Q3.xlsx'};nx.sizes={'doc-1':5321,'doc-2':8400000};});
await page.getByRole('textbox',{name:'消息输入框',exact:true}).fill('崩溃报告和导出的数据都在这，帮我对一下');
await shot(path.join(folder,'files-composer-390.png'));
await page.setViewportSize({width:320,height:640});await page.waitForTimeout(150);
assert(await page.evaluate(()=>document.scrollingElement.scrollWidth<=innerWidth),'no sideways scroll at 320');
const sendBox=await page.getByRole('button',{name:'发送消息',exact:true}).boundingBox();assert(sendBox.x+sendBox.width<=320&&sendBox.y+sendBox.height<=640,'send visible at 320');
await shot(path.join(folder,'files-composer-320.png'));
await page.setViewportSize({width:390,height:844});
console.log('PASS: composer picks files, refuses too big and duplicates, stays inside 320 px');

// The second upload fails: nothing staged for it, nothing sent; the message waits in the send queue
// (queue.js) with its files, and the queue pauses until the person continues.
await page.evaluate(()=>nx.uploadFail.add('doc-2'));
await page.getByRole('button',{name:'发送消息',exact:true}).click();
await page.getByText(/^正在上传文件 1\/2/).first().waitFor();
await page.getByText(/上一条没发出去/).first().waitFor();
assert.equal(await page.evaluate(()=>fx.calls.filter(c=>c.op==='prompt').length),0,'no prompt after a failed upload');
// The queue retries a not-sent message by itself (or after "继续" when it paused).
const nudge=async()=>{const go=page.getByRole('button',{name:'继续',exact:true});if(await go.count())await go.first().click();};
// A pane that SSHes elsewhere refuses at staging: still nothing sent, still queued.
await page.evaluate(()=>{nx.uploadFail.delete('doc-2');fx.stageError='没发出去：这个窗格连着别的电脑，又不是 ch 路由，文件传不过去';});
await nudge();
await page.getByText(/这个窗格连着别的电脑/).first().waitFor({timeout:20000});
assert.equal(await page.evaluate(()=>fx.calls.filter(c=>c.op==='prompt').length),0);
// Next try goes through: no upload repeated, every file staged, one prompt with names and hashes.
await page.evaluate(()=>{fx.stageError='';});
await nudge();
await page.waitForFunction(()=>fx.calls.filter(c=>c.op==='prompt').length===1,null,{timeout:20000});
assert.deepEqual(await page.evaluate(()=>nx.calls.filter(c=>c.op==='uploadFile').map(c=>c.args.id)),['doc-1','doc-2','doc-2']);
const prompt=await page.evaluate(()=>fx.calls.find(c=>c.op==='prompt').args);
assert.equal(prompt.text,'崩溃报告和导出的数据都在这，帮我对一下');assert.equal(prompt.remote,false);assert.equal(prompt.images,undefined);
assert.deepEqual(prompt.files.map(f=>f.name.split('/').slice(2).join('/')),['crash-report.txt','数据导出 2026Q3.xlsx']);
assert(prompt.files.every(f=>/^2026-10-15\/[a-f0-9]{16}\/.+$/.test(f.name)&&f.sha256.startsWith(f.name.split('/')[1])));
const staged=await page.evaluate(()=>fx.calls.filter(c=>c.op==='stageFile').map(c=>[c.args.target,c.args.identity,c.args.name.split('/')[2]]));
assert.deepEqual(staged.slice(-2),[['w1:p3','id-doc','crash-report.txt'],['w1:p3','id-doc','数据导出 2026Q3.xlsx']]);
await page.waitForFunction(()=>!document.querySelector('.file-tray'));
// Files leave the composer when queued; they are released once the prompt has gone out.
await page.waitForFunction(()=>nx.calls.some(c=>c.op==='dropFiles'&&JSON.stringify(c.args.ids)===JSON.stringify(['doc-1','doc-2'])),null,{timeout:10000});
await page.getByText('已送达 Agent',{exact:true}).waitFor();
assert.equal(await page.locator('.message.pending:not(.failed) .file-chip').count(),2,'sent bubble shows the files');
console.log('PASS: failed upload / refused pane send nothing; retry reuses uploads; prompt carries names');

// Settles once the transcript shows the prompt with its file lines.
await page.evaluate(P=>{fx.messages.push({id:'900:0',kind:'user',text:'崩溃报告和导出的数据都在这，帮我对一下\n\n[文件] '+P+'1234123412341234/crash-report.txt\n[文件] '+P+'5678567856785678/数据导出 2026Q3.xlsx',timestamp:new Date().toISOString(),title:'',call_id:''});},P);
await page.evaluate(()=>fetchHistory());
await page.waitForFunction(()=>!document.querySelector('.message.pending:not(.failed)'));
for(const width of [390,320]){await page.setViewportSize({width,height:width===320?640:844});await page.waitForTimeout(200);
 assert(await page.evaluate(()=>document.scrollingElement.scrollWidth<=innerWidth),'no sideways scroll at '+width);
 const over=await page.evaluate(()=>[...document.querySelectorAll('.file-chip')].filter(c=>c.getBoundingClientRect().right>innerWidth+0.5).length);assert.equal(over,0,'chips inside at '+width);
 await page.evaluate(()=>{const n=document.getElementById('chat-scroll');n.scrollTop=n.scrollHeight;});await page.waitForTimeout(150);
 await shot(path.join(folder,`files-history-bottom-${width}.png`));}
console.log('PASS: sent prompt settles into the transcript; 390/320 without overflow');
assert.deepEqual(errors,[]);
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
