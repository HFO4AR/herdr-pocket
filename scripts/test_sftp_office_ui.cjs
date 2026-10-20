// 文件 → Office reading view (office.js): Word continuous blocks with chunk loading, Excel sheet
// tabs + virtual rows + merged cells, PowerPoint slide canvas. Offline: native is a fake returning
// structured office JSON; office images are served from a routed https://pocket.invalid URL (never
// data:). Asserts no document text becomes HTML, no script runs, legacy/encrypted fallbacks work,
// zoom/navigation/scroll behave, and the page has no CSP or runtime errors.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
const root=path.resolve(__dirname,'..');
const html=require('./ui_bundle.cjs')(root);
const shots=path.join(root,'ui-artifacts');fs.mkdirSync(shots,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});
const errors=[];const cspViolations=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
page.on('console',m=>{if(m.type()==='error'&&/Content Security Policy/i.test(m.text()))cspViolations.push(m.text());});
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lZq2AAAAAElFTkSuQmCC','base64');
await page.route('https://pocket.invalid/preview/office/**',route=>route.fulfill({status:200,contentType:'image/png',body:PNG}));
await page.addInitScript(()=>{
 const now=Math.floor(Date.now()/1000);
 const D={A:{id:'A',name:'家里的电脑',user:'u',host:'home.invalid',port:22,remember:true}};
 const T=new Map();const mk=(p,type,size=0)=>T.set(p,{type,size,mtime:now-60});
 mk('/','dir');mk('/home','dir');mk('/home/u','dir');
 mk('/home/u/report.docx','file',1200);mk('/home/u/budget.xlsx','file',2400);mk('/home/u/deck.pptx','file',3200);
 mk('/home/u/old.doc','file',800);mk('/home/u/secret.docx','file',900);
 const base=p=>p.slice(p.lastIndexOf('/')+1),kids=p=>[...T.keys()].filter(k=>k!==p&&k.slice(0,k.lastIndexOf('/')||1)===p);
 const resolve=p=>!p||p==='~'?'/home/u':p;
 const DOCX=[
  {t:'p',p:{runs:[{t:'季度报告'}],h:1}},
  {t:'p',p:{runs:[{t:'加粗',b:true},{t:'普通'}],marker:'1.',ord:true,lvl:0}},
  {t:'table',rows:[{cells:[{c:0,cs:2,rs:1,blocks:[{t:'p',p:{runs:[{t:'合并单元格'}]}}]}]}]},
  {t:'img',asset:'b'.repeat(40),w:120,h:80,name:'图'},
  {t:'p',p:{runs:[{t:'链接',link:'https://example.com/a',u:true}]}},
  {t:'p',p:{runs:[{t:'<script>window.__pwn=1</script><img src=x onerror="window.__pwn=2">'}]}}
 ];
 const XROWS0=[
  {i:0,cells:[{c:0,v:'项目',s:1},{c:1,v:'金额',s:1}]},
  {i:1,cells:[{c:0,v:'合计'},{c:1,v:'1234.5',t:'n'},{c:2,v:'备注'}]},
  {i:2,cells:[{c:2,v:'跨行'}]},
  {i:3,cells:[{c:0,v:'日期'},{c:1,v:'2024-01-31',t:'d'}]}
 ];
 const XROWS1={i:0,cells:[{c:0,v:'汇总页'},{c:1,v:'99',t:'n'}]};
 const PPT0={index:0,w:12192000,h:6858000,bg:'#EEF2FF',title:'封面',shapes:[
  {k:'text',x:914400,y:457200,w:10058400,h:1143000,ps:[{al:'center',runs:[{t:'季度报告',sz:40,b:true,color:'#112233'}]}]},
  {k:'image',x:6000000,y:4000000,w:3000000,h:1500000,asset:'c'.repeat(40),name:'图'},
  {k:'placeholder',x:1000000,y:5000000,w:2000000,h:1000000,label:'图表'}
 ]};
 const PPT1={index:1,w:12192000,h:6858000,bg:'#FFFFFF',title:'第二张',shapes:[{k:'text',x:914400,y:457200,w:10058400,h:1143000,ps:[{runs:[{t:'第二张',sz:32}]}]}]};
 const PPT2={index:2,w:12192000,h:6858000,bg:'#FFFFFF',title:'第三张',shapes:[{k:'text',x:914400,y:457200,w:10058400,h:1143000,ps:[{runs:[{t:'第三张',sz:32}]}]}]};
 window.ofx={D,T,calls:[],unnamed:[],sessions:{},closed:[],cancelled:[],previews:[],errors:[],docxCalls:[],sheetCalls:[],slideCalls:[]};
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);let data={};ofx.calls.push({op,a});
  const fail=(msg,code)=>{setTimeout(()=>nativeResult(id,{ok:false,error:msg,...(code?{code}:{})}),10);};
  const ok=d=>setTimeout(()=>nativeResult(id,{ok:true,data:d}),10);
  try{
   if(op==='devices')data={devices:[D.A],version:'test',connected:D.A,connections:[D.A]};
   else if(op==='remote'){if(a.op==='sessions')data={sessions:[{name:'main',running:true}]};else if(a.op==='agents')data={agents:[]};else if(a.op==='status')data={agents:[]};else if(a.op==='panes')data={panes:[]};else if(a.op==='catalog')data={records:[],total:0,next:null};else if(a.op==='hello')data={version:'0.6.0',protocol:1};else data={};}
   else if(op==='cacheGet')data={value:null};
   else if(op==='cachePut')data={saved:true};
   else if(op==='settings')data={};
   else if(op.startsWith('sftp')){
    if(!['sftpTransfers','sftpCancel','sftpForget','sftpOpen','sftpPickUpload','sftpDropPicks','sftpPreviewOpen','sftpPreviewCancel','sftpOfficeClose','sftpOfficeCancel','sftpOfficeChunk','sftpOfficeSheet','sftpOfficeSlide'].includes(op)&&a.device!=='A'){ofx.unnamed.push(op);return fail('request without device: '+op);}
    if(op==='sftpList'){const p=resolve(a.path);const n=T.get(p);if(!n)return fail('这个文件夹不在了','sftp_missing');
     data={path:p,home:'/home/u',parent:p==='/'?null:p.slice(0,p.lastIndexOf('/'))||'/',downloads:true,truncated:false,
      entries:kids(p).map(k=>{const e=T.get(k);return {name:base(k),type:e.type,size:e.size,mtime:e.mtime,perm:'-rw-r--r--'};})};}
    else if(op==='sftpOfficeOpen'){
     ofx.previews.push(a);const name=base(a.path);
     if(name==='secret.docx')return fail('这个文档有密码，手机上不能实时预览；可以下载后用其他应用打开','office_encrypted');
     if(/\.doc$/.test(name))return fail('legacy should not be requested','office_legacy');
     setTimeout(()=>nativeProgress(id,'600'),8);
     if(/\.docx$/.test(name)){
      const s='d1';ofx.sessions[s]={kind:'docx',offset:4,blocks:DOCX};
      return setTimeout(()=>nativeResult(id,{ok:true,data:{session:s,kind:'docx',name,size:1200,mtime:now,key:'a'.repeat(40),
       blocks:DOCX.slice(0,4),next:4,total:DOCX.length,done:false,truncated:false}}),20);
     }
     if(/\.xlsx$/.test(name)){
      const s='x1';ofx.sessions[s]={kind:'xlsx'};
      return setTimeout(()=>nativeResult(id,{ok:true,data:{session:s,kind:'xlsx',name,size:2400,mtime:now,key:'d'.repeat(40),
       sheets:[{index:0,name:'数据',hidden:false},{index:1,name:'汇总',hidden:false}],
       styles:[{},{b:true,fill:'#FFFF00',al:'center'},{color:'#FF0000'}],
       sheet:{session:s,sheet:0,name:'数据',start:0,count:200,totalRows:420,cols:5,widths:[120,90,90,90,90],
        merges:[{r1:1,c1:0,r2:2,c2:1}],rows:XROWS0,truncated:false}}}),20);
     }
     if(/\.pptx$/.test(name)){
      const s='p1';ofx.sessions[s]={kind:'pptx'};
      return setTimeout(()=>nativeResult(id,{ok:true,data:{session:s,kind:'pptx',name,size:3200,mtime:now,key:'e'.repeat(40),
       slides:3,width:12192000,height:6858000,slide:PPT0}}),20);
     }
     return fail('unsupported','office_unsupported');
    }
    else if(op==='sftpOfficeChunk'){
     ofx.docxCalls.push(a);const s=ofx.sessions[a.session];if(!s)return fail('预览已过期','office_gone');
     const from=Math.max(0,Math.min(a.from,s.blocks.length)),count=Math.min(a.count||80,s.blocks.length-from);
     data={session:a.session,from,next:from+count,total:s.blocks.length,done:from+count>=s.blocks.length,truncated:false,blocks:s.blocks.slice(from,from+count)};
     setTimeout(()=>nativeResult(id,{ok:true,data}),10);return;
    }
    else if(op==='sftpOfficeSheet'){
     ofx.sheetCalls.push(a);if(!ofx.sessions[a.session])return fail('预览已过期','office_gone');
     if(a.sheet===1){data={session:a.session,sheet:1,name:'汇总',start:0,count:1,totalRows:1,cols:2,widths:[120,90],merges:[],rows:[XROWS1],truncated:false};}
     else{
      const start=a.start||0,rows=[];
      if(start===0)rows.push(...XROWS0);
      else for(let i=start;i<Math.min(start+(a.count||200),420);i+=1)rows.push({i,cells:[{c:0,v:'第 '+(i+1)+' 行'},{c:1,v:String(i*2),t:'n'}]});
      data={session:a.session,sheet:0,name:'数据',start,count:rows.length,totalRows:420,cols:5,widths:[120,90,90,90,90],
       merges:start===0?[{r1:1,c1:0,r2:2,c2:1}]:[],rows,truncated:false};
     }
     setTimeout(()=>nativeResult(id,{ok:true,data}),10);return;
    }
    else if(op==='sftpOfficeSlide'){
     ofx.slideCalls.push(a);if(!ofx.sessions[a.session])return fail('预览已过期','office_gone');
     data=a.index===1?PPT1:PPT2;
    }
    else if(op==='sftpOfficeClose'){ofx.closed.push(a.session);delete ofx.sessions[a.session];data={};}
    else if(op==='sftpOfficeCancel'){ofx.cancelled.push(a.token);data={};}
    else if(op==='sftpTransfers')data={transfers:[]};
    else if(op==='sftpCancel'||op==='sftpForget'||op==='sftpOpen'||op==='sftpPreviewOpen')data={};
    else if(op==='sftpPickUpload')data={files:[],cancelled:true};
    else if(op==='sftpDropPicks')data={};
    else throw Error('unexpected '+op);
   }
   else if(!['protect','setAlerts','watchState','activate','inputInfo'].includes(op))throw Error('unexpected native op '+op);
  }catch(e){return fail(e.message);}
  if(!['sftpOfficeChunk','sftpOfficeSheet','sftpOfficeOpen'].includes(op))setTimeout(()=>nativeResult(id,{ok:true,data}),10);
 }};
});
await page.goto(require('./ui_bundle.cjs').url(html));
const calls=op=>page.evaluate(o=>ofx.calls.filter(c=>c.op===o).map(c=>c.a),op);
const theme=t=>page.evaluate(t=>{document.documentElement.dataset.theme=t;},t);
const shot=async name=>{await page.evaluate(()=>document.getElementById('toast').classList.remove('show'));await page.waitForTimeout(250);await page.screenshot({path:path.join(shots,'office-'+name+'.png')});};
const row=name=>page.locator('#files-list .file-row-wrap').filter({has:page.locator('.file-name',{hasText:new RegExp('^'+name.replace(/[.*?()[\]]/g,'\\$&')+'$')})});
const back=()=>page.getByRole('button',{name:'返回文件列表',exact:true}).click();
const title=t=>page.locator('.fx-title').filter({hasText:new RegExp('^'+t.replace(/[.*?()[\]]/g,'\\$&')+'$')}).waitFor();
const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
const toastSeen=text=>page.waitForFunction(t=>document.getElementById('toast').textContent.includes(t),text);

// ── Open 文件 ───────────────────────────────────────────────────────────────
await page.locator('.files-entry').waitFor();
await page.locator('.files-entry').click();
await page.getByRole('heading',{name:'文件',exact:true}).waitFor();
await row('report.docx').waitFor();
assert.equal(await page.evaluate(()=>fxKindLabel({name:'report.docx',type:'file'})),'Word 文档');
assert.equal(await page.evaluate(()=>fxKindLabel({name:'budget.xlsx',type:'file'})),'Excel 表格');
assert.equal(await page.evaluate(()=>fxKindLabel({name:'deck.pptx',type:'file'})),'演示文稿');
assert.equal(await page.evaluate(()=>fxKindLabel({name:'old.doc',type:'file'})),'旧版 Office');
console.log('PASS: office files are labelled in 文件');

// ── Word: continuous blocks, table, image, link, chunk on sentinel ──────────
await row('report.docx').locator('.file-row').click();
await title('report.docx');
await page.locator('#fx-docx').waitFor();
await page.locator('.fx-docx-h.h1').filter({hasText:'季度报告'}).waitFor();
assert.equal(await page.locator('.fx-docx-list .fx-docx-marker').innerText(),'1.');
const bold=page.locator('.fx-docx-run').filter({hasText:'加粗'}).first();
assert.equal(await bold.evaluate(n=>getComputedStyle(n).fontWeight),'700');
assert.equal(await page.locator('.fx-docx-table td').first().innerText(),'合并单元格');
assert.equal(await page.locator('.fx-docx-table td').first().getAttribute('colspan'),'2');
// The inline image uses the asset URL, never data:.
await page.waitForFunction(()=>{const i=document.querySelector('.fx-docx-img');return i&&i.complete&&i.naturalWidth>0;});
const docImgSrc=await page.locator('.fx-docx-img').getAttribute('src');
assert.ok(docImgSrc.startsWith('https://pocket.invalid/preview/office/'),docImgSrc);
assert.ok(!docImgSrc.startsWith('data:'));
// The sentinel pulls the second chunk automatically.
await page.waitForFunction(()=>document.getElementById('fx-docx')?.textContent.includes('链接'),null,{timeout:5000});
const chunks=await calls('sftpOfficeChunk');
assert.deepEqual(chunks.map(c=>[c.session,c.from,c.count]),[['d1',4,80]],'one follow-up chunk from block 4');
const link=page.locator('.fx-docx-link').filter({hasText:'链接'}).first();
await link.waitFor();
assert.equal(await link.getAttribute('title'),'https://example.com/a');
// Document text is text: scripts/event attributes did not become elements or run.
assert.equal(await page.evaluate(()=>window.__pwn),undefined,'document script did not run');
assert.equal(await page.locator('#fx-docx script').count(),0,'document script is not an element');
assert.match(await page.locator('#fx-docx').innerText(),/<script>window\.__pwn=1<\/script>/);
// Zoom.
await page.getByRole('button',{name:'放大',exact:true}).click();
assert.equal(await page.evaluate(()=>getComputedStyle(document.getElementById('fx-docx')).getPropertyValue('--oz').trim()),'1.25');
await page.getByRole('button',{name:'适应屏幕',exact:true}).click();
assert.equal(await page.evaluate(()=>getComputedStyle(document.getElementById('fx-docx')).getPropertyValue('--oz').trim()),'1');
await shot('docx-light');await theme('dark');await shot('docx-dark');await theme('light');
await back();
console.log('PASS: Word blocks, table/span, link, asset image, auto chunk, inert text, zoom');

// ── Excel: tabs, sticky headers, styles, merge, virtual rows, tabs, zoom ────
await row('budget.xlsx').locator('.file-row').click();
await title('budget.xlsx');
await page.locator('.fx-xl').waitFor();
assert.deepEqual(await page.locator('.fx-xl-tab').allTextContents(),['数据','汇总']);
assert.deepEqual((await page.locator('.fx-xl-ch').allTextContents()).slice(0,3),['A','B','C']);
const firstCell=page.locator('.fx-xl-cell').filter({hasText:'项目'}).first();
assert.equal(await firstCell.evaluate(n=>getComputedStyle(n).fontWeight),'700');
assert.equal(await firstCell.evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(255, 255, 0)');
const merged=page.locator('.fx-xl-cell.merged').filter({hasText:'合计'}).first();
await merged.waitFor();
assert.ok((await merged.evaluate(n=>n.style.height)).includes('60'),'merged cell spans two rows');
assert((await page.locator('.fx-xl-row').count())<40,'only a window of rows is in the DOM');
assert.match(await page.locator('#fx-xl-status').innerText(),/420 行/);
// Scroll down: the grid asks native for the next bucket and shows later rows.
await page.evaluate(()=>{const s=document.getElementById('fx-xl-scroll');s.scrollTop=6000;});
await page.waitForFunction(()=>document.getElementById('fx-xl-scroll')?.textContent.includes('第 201 行'),null,{timeout:4000});
const sheetCalls=await calls('sftpOfficeSheet');
assert.ok(sheetCalls.some(c=>c.sheet===0&&c.start===200),'requested the 200-row bucket');
assert((await page.locator('.fx-xl-row').count())<40,'still virtualised after scrolling');
// A cell copies its text.
await page.locator('.fx-xl-cell').filter({hasText:'第 201 行'}).first().click();
await toastSeen('已复制');
// Sheet tab.
await page.locator('.fx-xl-tab').filter({hasText:'汇总'}).click();
await page.waitForFunction(()=>document.getElementById('fx-xl-scroll')?.textContent.includes('汇总页'));
assert.ok((await calls('sftpOfficeSheet')).some(c=>c.sheet===1),'sheet 1 requested');
// Zoom changes the row scale, not the document.
await page.locator('.fx-xl-tab').filter({hasText:'数据'}).click();
await page.waitForFunction(()=>document.getElementById('fx-xl-scroll')?.textContent.includes('项目'));
await page.getByRole('button',{name:'放大',exact:true}).click();
assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.fx-xl')).getPropertyValue('--oz').trim()),'1.25');
await page.setViewportSize({width:320,height:640});
assert.equal(await overflow(),false,'grid fits 320 px (it scrolls inside)');
await shot('xlsx-320');
await page.setViewportSize({width:390,height:844});
await shot('xlsx-light');
await back();
console.log('PASS: Excel tabs/headers/styles/merge/virtual rows/chunk/scroll/copy/zoom, 320 px');

// ── PowerPoint: canvas, text/image/placeholder, navigation, zoom ────────────
await row('deck.pptx').locator('.file-row').click();
await title('deck.pptx');
await page.locator('#fx-ppt-canvas').waitFor();
assert.equal(await page.locator('#fx-ppt-canvas').evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(238, 242, 255)');
await page.getByText('季度报告',{exact:true}).waitFor();
assert.equal(await page.getByText('图表',{exact:true}).count(),1,'chart placeholder is labelled');
await page.waitForFunction(()=>{const i=document.querySelector('.fx-ppt-img');return i&&i.complete&&i.naturalWidth>0;});
const pptImgSrc=await page.locator('.fx-ppt-img').getAttribute('src');
assert.ok(pptImgSrc.startsWith('https://pocket.invalid/preview/office/'));
assert.ok(!pptImgSrc.startsWith('data:'));
assert.match(await page.locator('.fx-page-n').innerText(),/第 1 \/ 3 张/);
const w0=(await page.locator('#fx-ppt-canvas').boundingBox()).width;
await page.getByRole('button',{name:'下一张',exact:true}).click();
await page.getByText('第二张',{exact:true}).waitFor();
assert.match(await page.locator('.fx-page-n').innerText(),/第 2 \/ 3 张/);
assert.deepEqual((await calls('sftpOfficeSlide')).map(c=>c.index),[1]);
await page.getByRole('button',{name:'放大',exact:true}).click();
const w1=(await page.locator('#fx-ppt-canvas').boundingBox()).width;
assert.ok(w1>w0,'zoom enlarges the slide');
await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})));
await page.getByText('第三张',{exact:true}).waitFor();
assert.match(await page.locator('.fx-page-n').innerText(),/第 3 \/ 3 张/);
await page.getByRole('button',{name:'上一张',exact:true}).click();
await page.getByText('第二张',{exact:true}).waitFor();
await shot('pptx-light');
await back();
console.log('PASS: PowerPoint canvas, title/image/chart, page buttons/arrows/counter, zoom');

// ── Legacy and encrypted fallbacks ──────────────────────────────────────────
const before=(await calls('sftpOfficeOpen')).length;
await row('old.doc').locator('.file-row').click();
await title('old.doc');
await page.getByText('旧版或加密的 Office 文档',{exact:true}).waitFor();
assert.equal((await calls('sftpOfficeOpen')).length,before,'legacy .doc is not read or parsed');
const fb=page.locator('.fx-fallback');
for(const b of ['下载到手机','另存为…','复制路径'])await fb.getByRole('button',{name:b,exact:true}).waitFor();
await back();
await row('secret.docx').locator('.file-row').click();
await title('secret.docx');
await page.getByRole('alert').filter({hasText:'有密码'}).waitFor().catch(()=>{});
await page.locator('.fx-fallback').filter({hasText:'有密码'}).waitFor();
assert.equal((await calls('sftpOfficeOpen')).at(-1).path,'/home/u/secret.docx');
await page.locator('.fx-fallback').getByRole('button',{name:'重试',exact:true}).waitFor();
await back();
console.log('PASS: legacy .doc and encrypted .docx fall back to download/open without parsing');

// ── No data: images, no CSP/runtime errors, all requests named their computer ──
const srcs=await page.evaluate(()=>[...document.querySelectorAll('img')].map(n=>n.src));
assert(srcs.every(s=>!s.startsWith('data:')),'no data: image URLs in the UI');
const csp=await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
assert.match(csp,/img-src data: https:\/\/pocket\.invalid/);
assert.match(csp,/default-src 'none'/);
assert.match(csp,/script-src 'unsafe-inline'/);
assert.deepEqual(await page.evaluate(()=>ofx.unnamed),[],'office requests carry the device');
assert.deepEqual(errors,[],'no page errors');
assert.deepEqual(cspViolations,[],'no CSP violations');
console.log('PASS: asset URLs only, CSP allows the preview origin, no page errors');
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
