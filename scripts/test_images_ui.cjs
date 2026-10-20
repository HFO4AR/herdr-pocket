// Sending pictures and seeing them in history. Offline: the native layer is a strict fake that
// "picks" generated pictures and records uploads; `remote` is a recorded fake. Nothing is sent anywhere.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const SHA='a'.repeat(64),SHA2='b'.repeat(64);

(async()=>{
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});
const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
await page.addInitScript(()=>{
 // Generated stand-ins for photos: a gradient with a label, as a JPEG data URL.
 window.pic=(w,h,hue,label)=>{const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');const gr=g.createLinearGradient(0,0,w,h);gr.addColorStop(0,`hsl(${hue},55%,62%)`);gr.addColorStop(1,`hsl(${hue+40},60%,38%)`);g.fillStyle=gr;g.fillRect(0,0,w,h);g.fillStyle='#fff';g.font=`600 ${Math.round(h/7)}px sans-serif`;g.fillText(label,w*0.08,h*0.58);return c.toDataURL('image/jpeg',0.8);};
 window.nx={calls:[],picks:[],uploadFail:new Set(),served:[]};let n=0;
 window.PocketNative={request(id,op,raw){const args=JSON.parse(raw);nx.calls.push({op,args});
  const ok=data=>setTimeout(()=>nativeResult(id,{ok:true,data}),20),fail=error=>setTimeout(()=>nativeResult(id,{ok:false,error}),20);
  if(['devices','demo','disconnect','protect','watchState'].includes(op))return ok(op==='devices'?{devices:[]}:{});
  if(op==='pickImages'){let batch=nx.picks.shift()||[];if(args.max>0)batch=batch.slice(0,args.max);return ok({images:batch.map(([w,h,hue,label])=>({id:'att-'+(++n),thumb:pic(Math.round(w/8),Math.round(h/8),hue,label),width:w,height:h,bytes:w*h/6|0,type:'jpg'})),failed:0});}
  if(op==='dropImages')return ok({});
  if(op==='uploadImage'){if(nx.uploadFail.has(args.id)){nx.uploadFail.delete(args.id);return fail('SFTP 写入失败');}return ok({name:'2026-10-15/'+args.id.padEnd(64,'0').replace(/[^a-f0-9]/g,'c')+'.jpg',sha256:args.id.padEnd(64,'0').replace(/[^a-f0-9]/g,'c'),bytes:1000});}
  if(op==='image'){nx.served.push(args);const key=args.kind+':'+(args.name||args.address||args.block);
   if((args.name||'').startsWith('2026-09-01/'))return fail('这张图片在电脑上已经清理掉了');
   const hue={upload:12,ch:200,transcript:140}[args.kind]||60;const full=args.variant==='full';
   return ok({url:pic(full?1200:360,full?900:270,hue+(args.block||0)*30,args.kind==='transcript'?'截图 '+(args.block+1):args.kind==='ch'?'远端':'照片'),width:360,height:270});}
  throw Error('Forbidden native call in offline UI test: '+op);}};});
await page.goto(require('./ui_bundle.cjs').url(html));
const folder=path.join(root,'ui-artifacts');
// Screenshots without a leftover toast from an earlier step.
const shot=async file=>{await page.evaluate(()=>document.getElementById('toast').classList.remove('show'));await page.waitForTimeout(250);await page.screenshot({path:file});};fs.mkdirSync(folder,{recursive:true});
await page.getByRole('button',{name:'体验聊天演示',exact:true}).click();

// Demo mode never picks pictures.
await page.getByRole('button',{name:/重构登录|清理构建缓存/}).first().click();
await page.getByRole('button',{name:'添加附件',exact:true}).click();
await page.getByRole('button',{name:/从相册选/}).click();
await page.getByText('演示模式：不能添加图片',{exact:true}).waitFor();
assert(!(await page.evaluate(()=>nx.calls.some(c=>c.op==='pickImages'))),'demo must not open a picker');
await page.getByRole('button',{name:'返回列表',exact:true}).click();
console.log('PASS: demo refuses pictures');

await page.evaluate(({SHA,SHA2})=>{
 const t=n=>new Date(Date.UTC(2026,9,15,9,n)).toISOString();
 const msg=(n,kind,text,extra={})=>({id:n*100+':0',kind,text,title:'',call_id:'',timestamp:t(n),...extra});
 window.fx={calls:[],promptError:null,messages:[
  msg(1,'user','登录页在手机上错位了，你看下截图\n\n[图片] /home/yuki/.herdr-pocket/uploads/2026-10-15/'+SHA+'.jpg'),
  msg(2,'assistant','看到了：按钮被软键盘顶出了视口。我改一下 `min-height`。'),
  msg(3,'user','[Image #1] [Image #2] 这两张对比一下',{images:[{block:0},{block:1}]}),
  msg(4,'assistant','左边是旧版，右边是改过的。'),
  msg(5,'user','[图片 · ch-local fetch] ch-file://'+SHA2+'.png'),
  msg(6,'assistant','远端那张也收到了。'),
  msg(7,'user','这张早就清理了\n[图片] /home/yuki/.herdr-pocket/uploads/2026-09-01/'+'c'.repeat(64)+'.jpg'),
  msg(8,'assistant','嗯，那张已经不在电脑上了。')]};
 fx.agent={pane_id:'w1:p3',identity:'id-img',agent:'claude',agent_status:'idle',cwd:'/home/demo/site',terminal_title:'登录页修复',agent_session:{value:'s1'},
  history_ref:{status:'matched',record:{id:'rec-img',thread:'s1',provider:'claude',title:'登录页修复',cwd:'/home/demo/site',modified:Date.now()/1000}}};
 remote=async(op,args={})=>{fx.calls.push({op,args});await new Promise(r=>setTimeout(r,20));
  if(op==='status')return{agents:[fx.agent]};
  if(op==='agents'&&args.target)return{follow:true,state:'same',agents:[fx.agent],pane:null};
  if(op==='history')return{record:fx.agent.history_ref.record,messages:fx.messages,children:[],before:0,has_more:false};
  if(op==='read')return{text:'❯ '};
  if(op==='prompt'){if(fx.promptError){const e=fx.promptError;fx.promptError=null;throw Error(e);}return{sent:true,receipt:args.id};}
  throw Error('unexpected op '+op);};
 S.demo=false;S.session='fixture';S.agents=[fx.agent];
},{SHA,SHA2});
await page.evaluate(()=>openAgent(fx.agent));
await page.getByText('登录页在手机上错位了，你看下截图',{exact:true}).waitFor();
// Reference lines turn into thumbnails; the text keeps only the person's words.
assert.equal(await page.getByText(/herdr-pocket\/uploads|ch-file:/).count(),0,'reference lines are hidden');
assert.equal(await page.getByText(/\[Image #\d+\]/).count(),0,'Claude picture markers are hidden');
await page.waitForFunction(()=>document.querySelectorAll('.img-tile img').length>=4);
await page.locator('.img-tile.broken').first().waitFor();
assert.match(await page.locator('.img-tile.broken').first().textContent(),/已清理/);
const served=await page.evaluate(()=>nx.served.filter(x=>x.variant==='thumb'));
assert(served.some(x=>x.kind==='upload'&&x.name==='2026-10-15/'+'a'.repeat(64)+'.jpg'),'upload thumb by name');
assert(served.some(x=>x.kind==='ch'&&x.address==='ch-file://'+'b'.repeat(64)+'.png'),'ch thumb by address');
assert(served.some(x=>x.kind==='transcript'&&x.record_id==='rec-img'&&x.item==='300:0'&&x.block===1),'transcript picture by record/item/block');
assert(served.every(x=>!('path' in x)),'never an arbitrary path');
// Image-only prompt: no empty bubble.
assert.equal(await page.locator('.message.user').nth(2).locator('.bubble').count(),0);
// The newer ch format: a note after the address (no pasted line ending in "….png"), here the way
// Claude keeps a collapsed paste, and a picture-only prompt. The note goes with the picture line.
await page.evaluate(sha=>{const t=new Date(Date.UTC(2026,9,15,9,20)).toISOString(),m=(n,kind,text)=>({id:n*100+':0',kind,text,title:'',call_id:'',timestamp:t});
 fx.messages.push(m(9,'user','<pasted_content id="c1">\n远端截图里的报错\n\n[图片 · ch-local fetch] ch-file://'+sha+'.png （用 ch-local fetch 取回再看）\n</pasted_content id="c1">'),
  m(10,'assistant','新格式的那张也看到了。'),m(11,'user','[图片 · ch-local fetch] ch-file://'+sha+'.png （用 ch-local fetch 取回再看）'),m(12,'assistant','只有图的那条也收到了。'));
 return fetchHistory();},SHA2);
await page.getByText('远端截图里的报错',{exact:true}).waitFor();
assert.equal(await page.getByText(/ch-local fetch/).count(),0,'the ch line and its note are hidden');
assert.equal(await page.locator('.message.user').nth(5).locator('.bubble').count(),0,'picture + note only: no empty bubble');
assert.deepEqual(await page.evaluate(sha=>{const L='[图片 · ch-local fetch] ch-file://'+sha+'.png',N=' （用 ch-local fetch 取回再看）';
 const a=imgSplit({text:'看图\n\n'+L+N}),b=imgSplit({text:'看图\n\n'+L});
 return [a.text,a.specs.map(x=>x.address),msgSig(a.text)===msgSig(b.text),imgSplit({text:'看图\n\n'+L+' 还有别的话'}).specs.length];},SHA2),
 ['看图',['ch-file://'+SHA2+'.png'],true,0],'old and new lines read the same; other words after it keep the line');
await page.evaluate(()=>{document.getElementById('chat-scroll').scrollTop=0;});
await shot(path.join(folder,'images-history-390.png'));
await page.locator('.img-tile.broken').scrollIntoViewIfNeeded();await page.waitForTimeout(200);await shot(path.join(folder,'images-history-mid-390.png'));
await page.getByRole('button',{name:'图片 2 / 2',exact:true}).click();
const viewer=page.getByRole('dialog',{name:'查看图片',exact:true});await viewer.waitFor();
await page.waitForFunction(()=>nx.served.some(x=>x.variant==='full'&&x.block===1));
await viewer.getByText('2 / 2',{exact:true}).waitFor();await page.waitForTimeout(350);
await shot(path.join(folder,'images-viewer-390.png'));
await viewer.getByRole('button',{name:'上一张',exact:true}).click();await viewer.getByText('1 / 2',{exact:true}).waitFor();
await viewer.getByRole('button',{name:'关闭',exact:true}).click();
assert.equal(await viewer.count(),0);
// Re-rendering keeps loaded thumbnails without asking again.
const thumbs=await page.evaluate(()=>nx.served.filter(x=>x.variant==='thumb').length);
await page.evaluate(()=>paintTimeline());await page.waitForTimeout(100);
assert.equal(await page.evaluate(()=>nx.served.filter(x=>x.variant==='thumb').length),thumbs);
assert.equal(await page.locator('.img-tile.loading').count(),0,'cached thumbnails render at once');
console.log('PASS: history thumbnails for uploads, ch addresses and transcript pictures; viewer; cleaned-up picture');

// Composer: gallery (2) + camera (1), remove one.
await page.evaluate(()=>{nx.picks.push([[4032,3024,20,'相册 1'],[3024,4032,180,'相册 2']],[[4000,3000,300,'拍照']]);});
await page.getByRole('button',{name:'添加附件',exact:true}).click();
await page.getByRole('button',{name:/从相册选/}).click();
const tray=page.getByRole('list',{name:'要发送的图片',exact:true});
await tray.getByRole('listitem').nth(1).waitFor();
await page.getByRole('button',{name:'添加附件',exact:true}).click();
await page.getByRole('button',{name:/拍照/}).click();
await tray.getByRole('listitem').nth(2).waitFor();
assert.match(await tray.locator('.att-note').textContent(),/^3 张 · /);
assert.deepEqual(await page.evaluate(()=>nx.calls.filter(c=>c.op==='pickImages').map(c=>c.args.source)),['gallery','camera']);
assert.equal(await page.evaluate(()=>nx.calls.filter(c=>c.op==='pickImages').every(c=>c.args.max===undefined)),true,'pictures are requested without a count limit');
await tray.getByRole('button',{name:'删掉图片 2',exact:true}).click();
await page.waitForFunction(()=>document.querySelectorAll('.att').length===2);
assert.deepEqual(await page.evaluate(()=>nx.calls.filter(c=>c.op==='dropImages').map(c=>c.args.ids)),[['att-2']]);
// Pictures alone can be sent.
assert(!(await page.getByRole('button',{name:'发送消息',exact:true}).isDisabled()),'send enabled with pictures only');
await page.getByRole('textbox',{name:'消息输入框',exact:true}).fill('这两张是改之前的样子');
await shot(path.join(folder,'images-composer-390.png'));
await page.setViewportSize({width:320,height:640});await page.waitForTimeout(150);
assert(await page.evaluate(()=>document.scrollingElement.scrollWidth<=innerWidth),'no sideways scroll at 320');
const sendBox=await page.getByRole('button',{name:'发送消息',exact:true}).boundingBox();assert(sendBox.x+sendBox.width<=320&&sendBox.y+sendBox.height<=640,'send visible at 320');
await shot(path.join(folder,'images-composer-320.png'));
await page.setViewportSize({width:390,height:844});
console.log('PASS: composer picks from gallery and camera, removes, stays inside 320 px');

// Second upload fails: nothing is sent; the message and its pictures wait in the send queue; trying again uploads only the missing one.
await page.evaluate(()=>nx.uploadFail.add('att-3'));
await page.getByRole('button',{name:'发送消息',exact:true}).click();
const queued=page.locator('.message.queued');
await queued.getByText(/上次没发出去：图片没传上去/).waitFor();
assert.equal(await page.evaluate(()=>fx.calls.filter(c=>c.op==='prompt').length),0,'no prompt after a failed upload');
assert.equal(await queued.locator('.img-tile').count(),2,'pictures stay with the queued message');
assert.equal(await page.getByRole('textbox',{name:'消息输入框',exact:true}).inputValue(),'');
// Unknown outcome of the prompt itself: shown, never resent.
await page.evaluate(()=>{fx.promptError='等了 35 秒还没有回应；请求已经发出，结果未知。';});
await queued.getByRole('button',{name:'立即发送',exact:true}).click();
await queued.getByText('结果未知 · 不会自动重发',{exact:true}).waitFor();
let prompts=await page.evaluate(()=>fx.calls.filter(c=>c.op==='prompt').map(c=>c.args));
assert.equal(prompts.length,1);
assert.deepEqual(await page.evaluate(()=>nx.calls.filter(c=>c.op==='uploadImage').map(c=>c.args.id)),['att-1','att-3','att-3']);
await page.waitForTimeout(3000);
assert.equal(await page.evaluate(()=>fx.calls.filter(c=>c.op==='prompt').length),1,'never auto-resent');
// The person sends again on purpose: a new request id, the same uploaded names, no new uploads.
await queued.getByRole('button',{name:'修改',exact:true}).click();
assert.equal(await tray.getByRole('listitem').count(),2);
await page.getByRole('button',{name:'发送消息',exact:true}).click();
await page.waitForFunction(()=>fx.calls.filter(c=>c.op==='prompt').length===2);
prompts=await page.evaluate(()=>fx.calls.filter(c=>c.op==='prompt').map(c=>c.args));
assert.notEqual(prompts[0].id,prompts[1].id);
assert.deepEqual(prompts[1].images,prompts[0].images);
assert.equal(prompts[1].images.length,2);
assert(prompts[1].images.every(x=>/^2026-10-15\/[a-f0-9]{64}\.jpg$/.test(x.name)&&/^[a-f0-9]{64}$/.test(x.sha256)));
assert.equal(prompts[1].remote,false);assert.equal(prompts[1].text,'这两张是改之前的样子');
assert.equal(await page.evaluate(()=>nx.calls.filter(c=>c.op==='uploadImage').length),3);
await page.waitForFunction(()=>!document.querySelector('.att-tray'));
assert.equal(await page.getByRole('textbox',{name:'消息输入框',exact:true}).inputValue(),'');
assert.deepEqual(await page.evaluate(()=>nx.calls.filter(c=>c.op==='dropImages').map(c=>c.args.ids).at(-1)),['att-1','att-3']);
await page.getByText('已送达 Agent',{exact:true}).waitFor();
assert(await page.locator('.message.pending .img-tile img').count()>=2,'sent bubble shows the pictures');
console.log('PASS: upload failure sends nothing; unknown outcome is never resent; send carries uploaded names');

// The pending bubble settles once the transcript shows the prompt with its pictures, in the form
// Claude Code writes them: "[Image #1]" before the words and a bare "[图片]" line after them.
await page.evaluate(()=>{fx.messages.push({id:'900:0',kind:'user',text:'[Image #1]这两张是改之前的样子\n[图片]',images:[{block:0},{block:1}],timestamp:new Date().toISOString(),title:'',call_id:''});fx.agent={...fx.agent,agent_status:'idle'};});
await page.evaluate(()=>fetchHistory());
await page.waitForFunction(()=>!document.querySelector('.message.pending:not(.failed)'));
for(const width of [390,320]){await page.setViewportSize({width,height:width===320?640:844});await page.waitForTimeout(150);
 assert(await page.evaluate(()=>document.scrollingElement.scrollWidth<=innerWidth),'no sideways scroll at '+width);
 await page.evaluate(()=>{document.getElementById('chat-scroll').scrollTop=0;});await page.waitForTimeout(150);
 await shot(path.join(folder,`images-history-top-${width}.png`));
 await page.evaluate(()=>{const n=document.getElementById('chat-scroll');n.scrollTop=n.scrollHeight;});await page.waitForTimeout(150);
 await shot(path.join(folder,`images-history-bottom-${width}.png`));}
console.log('PASS: sent prompt settles into the transcript; 390/320 without overflow');
assert.deepEqual(errors,[]);
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
