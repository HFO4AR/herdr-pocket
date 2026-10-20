// 文件 motion: folder slide out/in + skeleton, crumb step, staggered first load, press feedback,
// selection checkboxes + sliding action bar, transfer dock (queued → transferring → verifying →
// done/failed), entry badge, real-progress interpolation (never invented bytes), and reduced motion
// (prefers-reduced-motion and .reduce-motion) disabling every animation and transition.
// Offline: native SFTP is an in-memory fake; nothing leaves the page.
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
await page.route('https://pocket.invalid/preview/**',route=>route.fulfill({status:200,contentType:'image/png',body:png()}));
await page.addInitScript(()=>{window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push({directive:e.violatedDirective,blocked:e.blockedURI}));});
await page.addInitScript(()=>{
 const now=Math.floor(Date.now()/1000);
 const T=new Map(),mk=(p,t,s=0)=>T.set(p,{type:t,size:s,mtime:now-30});
 mk('/','dir');mk('/home','dir');mk('/home/u','dir');mk('/home/u/src','dir');mk('/home/u/src/x.txt','file',500);
 mk('/home/u/a.txt','file',1000);mk('/home/u/b.txt','file',2000);
 const C={'/home/u/src/x.txt':'one\ntwo\nthree\n','/home/u/a.txt':'alpha\n','/home/u/b.txt':'beta\n'};
 const IMG='https://pocket.invalid/preview/'+'c'.repeat(40),PAGE='https://pocket.invalid/preview/page/'+'d'.repeat(40);
 const D={id:'A',name:'动画测试电脑',user:'u',host:'motion.invalid',port:22,remember:true};
 const kids=p=>[...T.keys()].filter(k=>k!==p&&k.slice(0,k.lastIndexOf('/')||1)===p);
 const base=p=>p.slice(p.lastIndexOf('/')+1),parent=p=>p.slice(0,p.lastIndexOf('/'))||'/';
 const resolve=p=>!p||p==='~'?'/home/u':p.startsWith('~/')?'/home/u'+p.slice(1):p;
 window.fx={T,C,IMG,PAGE,calls:[],transfers:[],seq:0,listDelay:0,previews:[],previewDelay:30,opened:[]};
 const fail=(id,msg,code)=>setTimeout(()=>nativeResult(id,{ok:false,error:msg,code}),10);
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);fx.calls.push({op,a});
  try{
   if(op==='devices'){setTimeout(()=>nativeResult(id,{ok:true,data:{devices:[D],version:'t',connected:D}}),10);return;}
   if(op==='remote'){const data=a.op==='sessions'?{sessions:[{name:'m',running:true}]}:a.op==='agents'?{agents:[]}:a.op==='status'?{agents:[]}:a.op==='catalog'?{records:[],total:0,next:null}:a.op==='account'?{ssh_user:'u',hostname:'box'}:a.op==='glance'?{previews:{}}:a.op==='tmux'?{available:false,panes:[]}:{};setTimeout(()=>nativeResult(id,{ok:true,data}),10);return;}
   if(op==='cacheGet'){setTimeout(()=>nativeResult(id,{ok:true,data:{value:null}}),5);return;}
   if(op==='cachePut'||op==='protect'||op==='setAlerts'||op==='watchState'||op==='activate'||op==='settings'){setTimeout(()=>nativeResult(id,{ok:true,data:{}}),5);return;}
   if(op==='sftpList'){
    const answer=()=>{const p=resolve(a.path),n=T.get(p);if(!n)return fail(id,'没有这个文件夹','sftp_missing');
     const data={path:p,home:'/home/u',parent:p==='/'?null:parent(p),downloads:true,truncated:false,entries:kids(p).map(k=>{const e=T.get(k);return {name:base(k),type:e.type,size:e.size,mtime:e.mtime,perm:e.type==='dir'?'drwxr-xr-x':'-rw-r--r--'};})};
     nativeResult(id,{ok:true,data});};
    if(fx.listDelay){const d=fx.listDelay;fx.listDelay=0;setTimeout(answer,d);}else setTimeout(answer,10);
    return;}
   if(op==='sftpDownload'){const t={id:'t'+(++fx.seq),device:'A',deviceName:'动画测试电脑',kind:'down',name:base(a.path),remote:a.path,size:a.size,done:0,state:'queued',phase:'copy',error:'',where:'',canOpen:false};fx.transfers.push(t);setTimeout(()=>nativeResult(id,{ok:true,data:{...t}}),10);return;}
   if(op==='sftpTransfers'){setTimeout(()=>nativeResult(id,{ok:true,data:{transfers:fx.transfers.map(t=>({...t}))}}),5);return;}
   if(op==='sftpCancel'){const t=fx.transfers.find(x=>x.id===a.transfer);t.state='cancelled';setTimeout(()=>nativeResult(id,{ok:true,data:{...t}}),5);return;}
   if(op==='sftpForget'){fx.transfers=fx.transfers.filter(t=>t.state==='running'||t.state==='queued');setTimeout(()=>nativeResult(id,{ok:true,data:{transfers:fx.transfers}}),5);return;}
   if(op==='sftpOpen'){fx.opened.push(a);setTimeout(()=>nativeResult(id,{ok:true,data:{}}),5);return;}
   if(op==='sftpPreview'){fx.previews.push(a);const p=resolve(a.path),e=T.get(p),key='b'.repeat(40);
    setTimeout(()=>window.nativeProgress(id,String(Math.floor((e?.size||0)/2))),8);
    const result={key,name:base(p),mime:a.kind==='pdf'?'application/pdf':a.kind==='image'?'image/png':'text/plain',size:e.size,mtime:e.mtime,cached:false,complete:true,path:p};
    const data=a.kind==='image'?{...result,url:fx.IMG,width:2400,height:3200,origWidth:2400,origHeight:3200}
      :a.kind==='pdf'?{...result,page:{url:fx.PAGE,width:3200,height:2400,index:0,pages:2}}
      :{...result,binary:false,text:fx.C[p]||'',encoding:'UTF-8',shown:(fx.C[p]||'').length,truncated:false,tail:false,offset:0};
    setTimeout(()=>nativeResult(id,{ok:true,data}),fx.previewDelay);return;}
   if(op==='sftpPreviewPage'){setTimeout(()=>nativeResult(id,{ok:true,data:{url:fx.PAGE,width:3200,height:2400,index:a.page,pages:2}}),5);return;}
   if(op==='sftpPreviewCancel'||op==='sftpPreviewOpen'){setTimeout(()=>nativeResult(id,{ok:true,data:{}}),5);return;}
   throw Error('unexpected '+op);
  }catch(e){fail(id,e.message);}}};
 window.fxStep=(id,done,state,extra={})=>{const t=fx.transfers.find(x=>x.id===id);t.done=done;if(state)t.state=state;Object.assign(t,extra);};
});
await page.goto(require('./ui_bundle.cjs').url(html));
const row=name=>page.locator('#files-list .file-row-wrap').filter({has:page.locator('.file-name',{hasText:new RegExp('^'+name.replace(/[.*?()[\]]/g,'\\$&')+'$')})});
const theme=t=>page.evaluate(t=>{document.documentElement.dataset.theme=t;},t);
const shot=async name=>{await page.evaluate(()=>document.getElementById('toast').classList.remove('show'));await page.waitForTimeout(60);await page.screenshot({path:path.join(shots,'sftp-'+name+'.png')});};
const anim=sel=>page.evaluate(s=>{const n=document.querySelector(s);return n?getComputedStyle(n).animationName:null;},sel);
const dur=sel=>page.evaluate(s=>{const n=document.querySelector(s);if(!n)return null;const c=getComputedStyle(n);return {a:c.animationName,ad:c.animationDuration,t:c.transitionDuration};},sel);
const dockShot=async n=>{await page.evaluate(()=>document.getElementById('toast').classList.remove('show'));if(await page.locator('#overlay .sheet').count())await page.waitForTimeout(420);await page.screenshot({path:path.join(shots,'sftp-'+n+'.png')});};

// ── Open and first load: staggered rows once ──
await page.locator('.files-entry').waitFor();
await page.locator('.files-entry').click();
await row('src').waitFor();
assert.equal(await page.locator('.files-card.fx-stagger').count(),1,'the first listing staggers');
assert.equal(await anim('.files-card.fx-stagger .file-row-wrap'),'fx-row-in');
assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.files-card.fx-stagger .file-row-wrap')).animationDuration),'0.2s');
await shot('frames-nav-1-home');

// ── Folder forward: old level slides out, skeleton rows while the listing reads, new level slides in ──
await page.evaluate(()=>{fx.listDelay=350;});
await row('src').locator('.file-row').click();
await page.waitForTimeout(50);
assert.equal(await page.locator('.files-skeleton .skeleton-row').count(),5,'skeleton rows replace the blank wait');
const ghost=await dur('.fx-ghost');
assert.equal(ghost.a,'fx-ghost-fwd');
assert(parseFloat(ghost.ad)>=.15&&parseFloat(ghost.ad)<=.25,'slide-out is 150–250 ms');
assert.equal(await page.evaluate(()=>document.querySelector('.fx-ghost')?.getAttribute('aria-hidden')),'true');
await shot('frames-nav-2-skeleton');
await row('x.txt').waitFor();
await page.waitForTimeout(30);
assert.equal(await anim('.files-list'),'fx-slide-fwd');
assert(parseFloat(await page.evaluate(()=>getComputedStyle(document.querySelector('.files-list')).animationDuration))<=.25);
assert.equal(await page.locator('.files-crumb.here').innerText(),'src');
assert.equal(await anim('.files-crumb.here'),'fx-crumb-in');
await page.waitForTimeout(240);await shot('frames-nav-3-loaded');
// Back direction slides the other way.
await page.evaluate(()=>{fx.listDelay=250;pocketBack();});
await page.waitForTimeout(50);
assert.equal(await anim('.fx-ghost'),'fx-ghost-back');
await row('src').waitFor();
assert.equal(await anim('.files-list'),'fx-slide-back');
await page.waitForTimeout(240);
console.log('PASS: folder slide fwd/back + skeleton + breadcrumb step + staggered first load (all 150–250 ms)');

// ── Selection: checkboxes animate in, action bar slides up ──
await page.getByRole('button',{name:'文件选项',exact:true}).click();
await page.getByRole('dialog',{name:'文件选项'}).getByRole('button',{name:/^多选/}).click();
await page.locator('.files-select-bar').waitFor();
assert.equal(await anim('.files-dock'),'fx-dock-up');
assert.equal(await anim('.file-check'),'fx-check-in');
await row('a.txt').locator('.file-row').click();
await row('b.txt').locator('.file-row').click();
assert.equal(await page.locator('.file-check').count(),3,'every row (folders too) gets a checkbox');
assert.equal(await row('a.txt').locator('.file-row').getAttribute('aria-pressed'),'true');
assert.equal(await row('src').locator('.file-row').getAttribute('aria-pressed'),'false');
await shot('motion-selection');
await page.getByRole('button',{name:'不选了',exact:true}).click();
console.log('PASS: selection checkboxes and the bottom action bar animate');

// ── Transfer dock: queued → transferring → verifying → done, real bytes only ──
await row('a.txt').locator('.file-more').click();
await page.getByRole('dialog',{name:'a.txt'}).getByRole('button',{name:/^下载到手机/}).click();
await page.locator('.files-dock.show').waitFor();
assert.equal(await anim('.files-dock'),'fx-dock-up');
await page.waitForTimeout(60);await dockShot('frames-dock-1-queued');
await page.getByRole('button',{name:'传输列表',exact:true}).click();
await page.getByRole('dialog',{name:'传输'}).getByText('排队中').waitFor();
await page.getByRole('button',{name:'关闭',exact:true}).click();
// First real sample at 0, then real movement.
await page.evaluate(()=>fxStep('t1',0,'running'));
await page.waitForTimeout(1000);
const width0=await page.evaluate(()=>getComputedStyle(document.querySelector('.files-dock .files-progress>span')).width);
await page.evaluate(()=>fxStep('t1',400,'running'));
await page.waitForFunction(()=>document.querySelector('.files-dock .files-progress')?.getAttribute('aria-valuenow')==='400');
await page.waitForTimeout(500);
const width40=await page.evaluate(()=>parseFloat(getComputedStyle(document.querySelector('.files-dock .files-progress>span')).width));
assert(width40>0,'progress moves after real bytes arrive');
const ring=await page.locator('#files-list .fx-ring').getAttribute('aria-valuenow');
assert.equal(ring,'40','the row ring shows the same real percentage');
// No update, no movement: wait a full poll cycle with the same counters.
const inline40=await page.evaluate(()=>document.querySelector('.files-dock .files-progress>span').style.width);
await page.waitForTimeout(1000);
assert.equal(await page.evaluate(()=>document.querySelector('.files-dock .files-progress>span').style.width),inline40,'no invented progress without a real update');
assert.equal(await page.evaluate(()=>FX.transfers[0].done),400);
// Speed and ETA come from two real samples.
await page.waitForFunction(()=>/B\/s|KB\/s|MB\/s/.test(document.querySelector('.files-dock')?.innerText||''));
assert.match(await page.locator('.files-dock').innerText(),/还剩/);
// Interpolation: after a real update the bar animates toward the new value, never past it.
await page.evaluate(()=>fxStep('t1',700,'running'));
await page.waitForFunction(()=>document.querySelector('.files-dock .files-progress')?.getAttribute('aria-valuenow')==='700');
const mid=await page.evaluate(()=>parseFloat(getComputedStyle(document.querySelector('.files-dock .files-progress>span')).width));
await page.waitForTimeout(400);
const end=await page.evaluate(()=>parseFloat(getComputedStyle(document.querySelector('.files-dock .files-progress>span')).width));
assert(mid<=end+1,'the bar only moves toward the real value');
assert(end>width40,'the bar reaches the newest real value');
await dockShot('frames-dock-2-progress');
// Verifying is a real phase from native (all bytes moved, size check / move into place).
await page.evaluate(()=>fxStep('t1',1000,'running',{phase:'verify'}));
await page.waitForFunction(()=>/正在核对/.test(document.querySelector('.files-dock')?.innerText||''));
assert.match(await page.locator('.files-dock').innerText(),/正在核对/);
await page.getByRole('button',{name:'传输列表',exact:true}).click();
assert.equal(await page.locator('.transfer-row.verify').count(),1);
const vbar=page.locator('.transfer-row.verify .files-progress');
assert.equal(await vbar.getAttribute('aria-valuenow'),'1000');
assert.equal(await vbar.getAttribute('aria-valuemax'),'1000');
assert.equal(await vbar.locator('span').getAttribute('style'),'width: 100%;');
await dockShot('frames-dock-3-verify');
await page.getByRole('button',{name:'关闭',exact:true}).click();
// Done: completion toast carries 打开 / 分享 and the dock settles.
await page.evaluate(()=>fxStep('t1',1000,'done',{where:'下载/Herdr Pocket',canOpen:true}));
await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('下载好了'));
await page.getByRole('button',{name:'打开',exact:true}).waitFor();
await page.getByRole('button',{name:'分享',exact:true}).waitFor();
await page.locator('.files-dock').getByText('都传完了').waitFor();
await dockShot('frames-dock-4-done');

// ── Failed state: words, not a shake ──
await row('b.txt').locator('.file-more').click();
await page.getByRole('dialog',{name:'b.txt'}).getByRole('button',{name:/^下载到手机/}).click();
await page.waitForFunction(()=>FX.states.get('t2')==='queued');
await page.evaluate(()=>fxStep('t2',100,'failed',{error:'SSH 连接断了'}));
await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('没成功'));
await page.getByRole('button',{name:'传输列表',exact:true}).click();
const failRow=page.locator('.transfer-row.failed');await failRow.waitFor();
assert.match(await failRow.innerText(),/失败：SSH 连接断了/);
assert.equal(await anim('.transfer-row.failed'),'none','failed rows do not shake');
await page.getByRole('button',{name:'关闭',exact:true}).click();
console.log('PASS: dock phases queued→transferring→verifying→done/failed; speed/ETA and bars use real bytes only');

// ── Entry badge while away: count + subtle pulse, then it disappears ──
await row('a.txt').locator('.file-more').click();
await page.getByRole('dialog',{name:'a.txt'}).getByRole('button',{name:/^下载到手机/}).click();
await page.waitForFunction(()=>FX.transfers.some(t=>t.state==='queued'));
await page.locator('.files-head').getByRole('button',{name:'返回',exact:true}).click();
await page.locator('.files-entry-badge').filter({hasText:'1'}).waitFor();
assert.equal(await anim('.files-entry-badge'),'fx-pulse');
await page.screenshot({path:path.join(shots,'sftp-entry-badge.png')});
await page.evaluate(()=>fxStep('t3',1000,'done',{where:'下载/Herdr Pocket'}));
await page.waitForFunction(()=>!document.querySelector('.files-entry-badge'),null,{timeout:5000});
console.log('PASS: 文件 entry badge shows active transfers, pulses, and clears when they finish');

// ── Reduced motion: every new animation/transition is off ──
await page.emulateMedia({reducedMotion:'reduce'});
await page.locator('.files-entry').click();
await row('src').waitFor();
await page.evaluate(()=>{fx.listDelay=250;});
await row('src').locator('.file-row').click();
await page.waitForTimeout(40);
assert.equal(await page.locator('.fx-ghost').count(),0,'no slide-out ghost under reduced motion');
assert((await page.locator('.files-skeleton .skeleton-row').count())>=4);
assert.equal(await anim('.skeleton-row'),'none');
await row('x.txt').waitFor();
assert.equal(await page.locator('.files-list.fx-in-fwd').count(),0,'no slide-in under reduced motion');
await page.evaluate(()=>{fx.listDelay=200;pocketBack();});
await row('a.txt').waitFor();
assert.equal(await page.locator('.fx-ghost').count(),0);
assert.equal(await page.locator('.files-list.fx-in-back').count(),0);
// Selection dock: still usable, no slide.
await page.getByRole('button',{name:'文件选项',exact:true}).click();
await page.getByRole('dialog',{name:'文件选项'}).getByRole('button',{name:/^多选/}).click();
await page.locator('.files-select-bar').waitFor();
assert.equal(await page.locator('.files-dock.fx-dock-in').count(),0);
assert.equal(await anim('.files-dock'),'none');
await page.getByRole('button',{name:'不选了',exact:true}).click();
// Download dock under reduced motion.
await row('a.txt').locator('.file-more').click();
await page.getByRole('dialog',{name:'a.txt'}).getByRole('button',{name:/^下载到手机/}).click();
await page.locator('.files-dock.show').waitFor();
assert.equal(await page.locator('.files-dock.fx-dock-in').count(),0);
assert.equal(await anim('.files-dock'),'none');
assert.equal((await dur('.files-dock .files-progress>span')).t,'0s');
await page.evaluate(()=>fxStep('t4',500,'done',{where:'下载/Herdr Pocket'}));
await page.waitForTimeout(1100);
// .reduce-motion class path works the same as the media query.
await page.emulateMedia({reducedMotion:'no-preference'});
await page.evaluate(()=>{FX.transfers=[];filesLeave();render();document.documentElement.classList.add('reduce-motion');filesOpen();});
await row('src').waitFor();
await page.evaluate(()=>{fx.listDelay=220;});
await row('src').locator('.file-row').click();
await page.waitForTimeout(40);
assert.equal(await page.locator('.fx-ghost').count(),0,'class path also disables the slide');
await row('x.txt').waitFor();
await page.evaluate(()=>document.documentElement.classList.remove('reduce-motion'));
console.log('PASS: prefers-reduced-motion and .reduce-motion disable slides, dock, pulse and bar transitions');

// ── Screenshots: 320 px dark + tablet light ──
await page.evaluate(()=>{fx.transfers=[];FX.transfers=[];paintDock();fxPaintEntry();});
await page.setViewportSize({width:320,height:640});await theme('dark');
await page.evaluate(()=>document.getElementById('toast').classList.remove('show'));await page.waitForTimeout(350);
await page.screenshot({path:path.join(shots,'sftp-320-dark.png')});
await page.setViewportSize({width:1024,height:768});await theme('light');
await page.evaluate(()=>{filesLeave();setTab('live');filesOpen();});
await row('src').waitFor();await page.waitForTimeout(300);
await shot('tablet-list');
await row('a.txt').locator('.file-row').click();
await page.locator('.fx-code').waitFor();await page.waitForTimeout(200);
await shot('tablet-preview');
await theme('dark');await page.waitForTimeout(120);
await page.screenshot({path:path.join(shots,'sftp-tablet-preview-dark.png')});
assert.deepEqual(await page.evaluate(()=>window.__csp),[],'no CSP violations');
assert.deepEqual(errors,[]);
console.log('PASS: 320 px dark and tablet (list + preview) screenshots, no page errors');
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
