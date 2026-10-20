// 文件 → 视频/音频: cache a whole file with real progress, show a poster/metadata card, then hand
// playback to the native PlayerActivity (sftpMediaPlay). The page never creates a <video>/<audio>
// element or receives a media URL, so this suite asserts that explicitly. Offline: native is a strict
// fake with an in-memory file tree; nothing reaches a computer or a real player.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
const root=path.resolve(__dirname,'..');
const html=require('./ui_bundle.cjs')(root);
const shots=path.join(root,'ui-artifacts');fs.mkdirSync(shots,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});
const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
await page.addInitScript(()=>{
 const now=Math.floor(Date.now()/1000);
 const D={A:{id:'A',name:'家里的电脑',user:'u',host:'home.invalid',port:22,remember:true}};
 const T=new Map();const mk=(p,type,size=0,extra={})=>T.set(p,{type,size,mtime:now-120,...extra});
 mk('/','dir');mk('/home','dir');mk('/home/u','dir');
 mk('/home/u/clip.mp4','file',12_000_000,{key:'a'.repeat(40),durationMs:65_000,width:1920,height:1080,title:'演示视频'});
 mk('/home/u/song.mp3','file',3_000_000,{key:'b'.repeat(40),audio:true,durationMs:185_000,title:'示例歌曲',artist:'测试歌手',album:'测试专辑'});
 mk('/home/u/huge.mp4','file',30_000_000,{key:'d'.repeat(40),durationMs:90_000});
 mk('/home/u/no-player.mp4','file',4_000_000,{key:'c'.repeat(40),durationMs:12_000});
 mk('/home/u/broken.mkv','file',5_000_000,{key:'e'.repeat(40)});
 const P1='data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';
 const base=p=>p.slice(p.lastIndexOf('/')+1),parent=p=>p.slice(0,p.lastIndexOf('/'))||'/';
 const resolve=p=>!p||p==='~'?'/home/u':p.startsWith('~/')?'/home/u'+p.slice(1):p;
 const kids=p=>[...T.keys()].filter(k=>k!==p&&k.slice(0,k.lastIndexOf('/')||1)===p);
 window.fx={D,T,P1,calls:[],mediaOpened:[],mediaCancelled:[],mediaPlayed:[],mediaExternal:[],previews:[],transfers:[],
  openFail:false,playFailKey:'',mediaDelay:350};
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);let data={};fx.calls.push({op,a});
  const fail=(msg,code,info)=>{setTimeout(()=>nativeResult(id,{ok:false,error:msg,...(code?{code}:{}),...(info?{info}:{})}),10);};
  try{
   if(op==='devices')data={devices:[D.A],version:'test',connected:D.A,connections:[D.A]};
   else if(op==='remote'){if(a.op==='sessions')data={sessions:[{name:'main',running:true}]};else if(a.op==='agents')data={agents:[]};
    else if(a.op==='status')data={agents:[]};else if(a.op==='panes')data={panes:[]};else if(a.op==='catalog')data={records:[],total:0,next:null};
    else if(a.op==='account')data={ssh_user:'u',hostname:'box'};else if(a.op==='hello')data={version:'0.6.0',protocol:1};
    else if(a.op==='doctor')data={herdr:true,running:1};else if(a.op==='glance')data={previews:{}};else if(a.op==='tmux')data={available:false,panes:[]};else data={};}
   else if(op==='sftpList'){
    const p=resolve(a.path),n=T.get(p);if(!n)return fail('这个文件夹不在了：'+p,'sftp_missing');
    if(n.type!=='dir')return fail('这不是文件夹：'+p,'sftp_not_dir');
    data={path:p,home:'/home/u',parent:p==='/'?null:parent(p),downloads:true,truncated:false,
     entries:kids(p).map(k=>{const e=T.get(k);return {name:base(k),type:e.type,size:e.size,mtime:e.mtime,perm:'-rw-r--r--'};})};
    setTimeout(()=>nativeResult(id,{ok:true,data}),10);return;}
   else if(op==='sftpMediaOpen'){
    if(a.device!=='A')return fail('request without device: '+op);
    const p=resolve(a.path),e=T.get(p);if(!e)return fail('找不到这个文件','sftp_missing');if(e.type!=='file')return fail('只能缓存普通文件','sftp_not_file');
    fx.mediaOpened.push(a);
    if(fx.openFail)return fail('这个视频读不出来（测试）','sftp_failed');
    if(e.size>20e6&&!a.allowLarge)return fail('文件有 30 MB，要先把整份缓存到手机才能播放','media_large',{size:e.size,max:20_000_000});
    const result={key:e.key,name:base(p),mime:e.audio?'audio/mpeg':'video/mp4',size:e.size,mtime:e.mtime,cached:!!e.cached,complete:true,path:p,
     media:{kind:e.audio?'audio':'video',durationMs:e.durationMs,width:e.width,height:e.height,title:e.title,artist:e.artist,album:e.album}};
    if(e.audio&&e.artist)result.media.artist=e.artist;
    if(e.title)result.media.title=e.title;
    if(!e.audio){result.media.width=e.width||1280;result.media.height=e.height||720;}
    if(!e.noPoster)result.poster=fx.P1;
    setTimeout(()=>window.nativeProgress(id,String(Math.floor(e.size/2))),8);
    setTimeout(()=>window.nativeProgress(id,String(e.size)),Math.max(30,Math.round(fx.mediaDelay*.7)));
    setTimeout(()=>nativeResult(id,{ok:true,data:result}),fx.mediaDelay);return;}
   else if(op==='sftpMediaCancel'){fx.mediaCancelled.push(a.token);data={};}
   else if(op==='sftpMediaPlay'){fx.mediaPlayed.push(a);if(a.key===fx.playFailKey)return fail('播放器打不开这个缓存文件','media_play');data={};}
   else if(op==='sftpMediaExternal'){fx.mediaExternal.push(a);data={};}
   else if(op==='sftpPreview'){fx.previews.push(a);return fail('媒体不该走 sftpPreview','media_wrong_op');}
   else if(op==='sftpPreviewCancel'){data={};}
   else if(op==='sftpPreviewOpen'){data={};}
   else if(op==='sftpTransfers')data={transfers:fx.transfers};
   else if(op==='sftpDownload'){const t={id:'t'+(fx.transfers.length+1),device:'A',deviceName:'家里的电脑',kind:'down',name:base(a.path),remote:a.path,size:a.size,done:0,state:'running',phase:'copy',error:'',where:'',canOpen:false};fx.transfers.push(t);data=t;}
   else if(op==='sftpOpen'||op==='sftpCancel'||op==='sftpForget'||op==='sftpDropPicks')data={};
   else if(!['protect','settings','cacheGet','cachePut','setAlerts','watchState','activate'].includes(op))throw Error('unexpected native op '+op);
   if(op==='cacheGet')data={value:null};
  }catch(e){return fail(e.message);}
  setTimeout(()=>nativeResult(id,{ok:true,data}),10);}};
});
await page.goto(require('./ui_bundle.cjs').url(html));
await page.locator('.files-entry').waitFor();
await page.waitForFunction(()=>S.device?.id==='A');
const calls=op=>page.evaluate(o=>fx.calls.filter(c=>c.op===o).map(c=>c.a),op);
const theme=t=>page.evaluate(t=>{document.documentElement.dataset.theme=t;},t);
const shot=async name=>{await page.evaluate(()=>document.getElementById('toast').classList.remove('show'));await page.waitForTimeout(300);await page.screenshot({path:path.join(shots,'sftp-media-'+name+'.png')});};
// .fx-tools is a deliberate horizontal scroller; everything else must fit.
const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||[...document.querySelectorAll('.main,.files-dock,.chat-head,.fx-body,.fx-media,.fx-media-info,.fx-media-acts')].some(n=>n.scrollWidth>n.clientWidth+1));
const row=name=>page.locator('#files-list .file-row-wrap').filter({has:page.locator('.file-name',{hasText:new RegExp('^'+name.replace(/[.*?()[\]]/g,'\\$&')+'$')})});
const title=t=>page.locator('.fx-title').filter({hasText:new RegExp('^'+t.replace(/[.*?()[\]]/g,'\\$&')+'$')}).waitFor();
const back=()=>page.getByRole('button',{name:'返回文件列表',exact:true}).click();
const noMediaElement=()=>page.evaluate(()=>document.querySelectorAll('video,audio,source').length);
await page.evaluate(()=>filesOpen());
await row('clip.mp4').waitFor();

// ── Listing: video/audio are their own kind, not text ──
assert.equal(await row('clip.mp4').locator('.file-icon-badge.kind-media').count(),1);
assert.equal(await row('song.mp3').locator('.file-icon-badge.kind-media').count(),1);
assert.deepEqual(await page.evaluate(()=>[fxKindLabel({name:'clip.mp4',type:'file'}),fxKindLabel({name:'song.mp3',type:'file'}),fxPreviewKind({name:'clip.mp4'})]),['视频','音频','media']);
console.log('PASS: video/audio files are listed as media');

// ── Video: real progress, poster, metadata, no WebView media element ──
await row('clip.mp4').locator('.file-row').click();
await title('clip.mp4');
await page.waitForFunction(()=>document.querySelector('.fx-read-bytes')?.textContent.includes('6.0 MB'));
assert.match(await page.locator('.fx-read-bytes').innerText(),/^6\.0 MB \/ 12 MB$/);
await page.locator('#fx-media').waitFor();
assert.deepEqual((await calls('sftpMediaOpen')).at(-1),{device:'A',path:'/home/u/clip.mp4',allowLarge:false,token:await page.evaluate(()=>FX.pv.token)});
assert.equal((await calls('sftpPreview')).length,0,'media never uses the text/image/PDF preview op');
assert.equal(await page.locator('#fx-media .fx-media-art img').getAttribute('src'),await page.evaluate(()=>fx.P1));
assert.equal(await page.locator('#fx-media .fx-media-title').innerText(),'演示视频');
assert.match(await page.locator('#fx-media .fx-media-meta').innerText(),/1:05/);
assert.match(await page.locator('#fx-media .fx-media-meta').innerText(),/12 MB/);
assert.match(await page.locator('#fx-media .fx-media-meta').innerText(),/1920×1080/);
assert.match(await page.locator('.fx-sub').innerText(),/1:05/);
assert.equal(await noMediaElement(),0,'no <video>/<audio> element is created');
await shot('card-light');await theme('dark');await shot('card-dark');await theme('light');

// Play hands the key to the native player; the page invents no URL.
await page.locator('#fx-media .fx-media-play').click();
await page.waitForFunction(()=>fx.mediaPlayed.length===1);
assert.deepEqual(await page.evaluate(()=>fx.mediaPlayed),[{key:'a'.repeat(40)}]);
assert.equal(await noMediaElement(),0);
console.log('PASS: video caches with real bytes, shows poster/duration/size, play calls sftpMediaPlay, no media element');

// ── Cache hit: reopen paints at once and reads nothing again ──
const opens=(await calls('sftpMediaOpen')).length;
await back();await row('clip.mp4').waitFor();
await row('clip.mp4').locator('.file-row').click();await title('clip.mp4');
await page.locator('#fx-media').waitFor();
await page.locator('.fx-cache-chip').filter({hasText:'已缓存'}).waitFor({timeout:500});
assert.equal((await calls('sftpMediaOpen')).length,opens,'the second open did not read the file again');
await back();
console.log('PASS: a cached media open is instant and does not re-read');

// ── Audio: artwork/artist/album, same native play path ──
await row('song.mp3').locator('.file-row').click();await title('song.mp3');
await page.locator('#fx-media .fx-media-art.audio').waitFor();
assert.equal(await page.locator('#fx-media .fx-media-title').innerText(),'示例歌曲');
assert.match(await page.locator('#fx-media .fx-media-sub').innerText(),/测试歌手 · 测试专辑/);
assert.match(await page.locator('#fx-media .fx-media-meta').innerText(),/3:05/);
await page.locator('#fx-media .fx-media-play').click();
await page.waitForFunction(()=>fx.mediaPlayed.length===2);
assert.deepEqual((await page.evaluate(()=>fx.mediaPlayed)).at(-1),{key:'b'.repeat(40)});
await back();
console.log('PASS: audio card shows title/artist/album and plays through the native op');

// ── Large media asks first, then retries with allowLarge ──
const beforeBig=(await calls('sftpMediaOpen')).length;
await row('huge.mp4').locator('.file-row').click();
const big=page.getByRole('dialog',{name:/^缓存 30 MB 后播放？/});await big.waitFor();
assert.equal((await calls('sftpMediaOpen')).length,beforeBig,'nothing is read before the confirmation');
await big.getByRole('button',{name:'缓存并播放'}).click();
await page.locator('#fx-media').waitFor();
assert.equal((await calls('sftpMediaOpen')).at(-1).allowLarge,true);
await back();
console.log('PASS: media above 20 MB asks before the whole file is cached; the retry sets allowLarge');

// ── Unsupported playback: clear message, fallback actions keep working ──
await page.evaluate(()=>{fx.playFailKey='c'.repeat(40);});
await row('no-player.mp4').locator('.file-row').click();await title('no-player.mp4');
await page.locator('#fx-media .fx-media-play').click();
await page.locator('#fx-media .fx-media-error').filter({hasText:'播放器打不开'}).waitFor();
await page.locator('#fx-media').getByRole('button',{name:'用其他应用打开',exact:true}).click();
await page.locator('#fx-media').getByRole('button',{name:'分享',exact:true}).click();
await page.waitForFunction(()=>fx.mediaExternal.length===2);
assert.deepEqual(await page.evaluate(()=>fx.mediaExternal),[{key:'c'.repeat(40),share:false},{key:'c'.repeat(40),share:true}]);
assert.equal(await noMediaElement(),0);
await back();
console.log('PASS: playback failure is explained inline; 用其他应用打开/分享 still work and no media element exists');

// ── A read error is a normal fallback with retry/download ──
await page.evaluate(()=>{fx.openFail=true;});
await row('broken.mkv').locator('.file-row').click();await title('broken.mkv');
await page.locator('.fx-fallback').waitFor();
assert.match(await page.locator('.fx-fallback').innerText(),/打不开这个文件|这个视频读不出来/);
for(const b of ['重试','下载到手机'])await page.locator('.fx-fallback').getByRole('button',{name:b,exact:true}).waitFor();
await page.evaluate(()=>{fx.openFail=false;});
await back();
console.log('PASS: a media cache error falls back to 重试 / 下载到手机');

// ── Leaving while the cache read runs cancels it natively ──
await page.evaluate(()=>{fx.T.set('/home/u/slow.mp3',{type:'file',size:2_000_000,mtime:Math.floor(Date.now()/1000),key:'f'.repeat(40),audio:true,durationMs:30_000});fx.mediaDelay=900;filesLoad(filesHere());});
await row('slow.mp3').waitFor();
await row('slow.mp3').locator('.file-row').click();await title('slow.mp3');
await page.waitForFunction(()=>FX.pv?.token);
const token=await page.evaluate(()=>FX.pv.token);
await back();
await page.waitForFunction(t=>fx.mediaCancelled.includes(t),token);
await page.evaluate(()=>{fx.mediaDelay=350;});
console.log('PASS: leaving the preview cancels the media cache read by token');

// ── Narrow layout ──
await row('clip.mp4').locator('.file-row').click();await title('clip.mp4');await page.locator('#fx-media').waitFor();
await page.setViewportSize({width:320,height:640});assert.equal(await overflow(),false,'media card fits 320 px');await shot('card-320');
await page.setViewportSize({width:390,height:844});
assert.deepEqual(errors,[]);
console.log('PASS: media card fits 320 px; no page errors');
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
