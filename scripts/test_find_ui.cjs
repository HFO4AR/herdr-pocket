// Search in a conversation and the read-only file viewer. Offline: native SSH is a strict fake
// that serves three history pages and fileView answers; nothing is sent to an agent.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
const root=path.resolve(__dirname,'..');
const html=require('./ui_bundle.cjs')(root);
const shots=path.join(root,'ui-artifacts');fs.mkdirSync(shots,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const errors=[];

// Text nodes only: the new modules never build HTML from strings.
for(const f of ['find.js','fileview.js']){const src=fs.readFileSync(path.join(root,'app/src/main/assets/ui',f),'utf8');assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src),f+' must not use HTML strings');}

async function fresh(width=390,height=844,dark=false){
 const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:2,colorScheme:dark?'dark':'light'});
 page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
 await page.addInitScript(()=>{
  const now=Date.now()/1000,iso=s=>new Date((now-s)*1000).toISOString();
  const r1={id:'a'.repeat(64),thread:'t1',title:'修登录页',provider:'claude',parent:null,cwd:'/work/proj',modified:now-60};
  const m=(n,kind,text,extra={})=>({id:n+':0',kind,text,title:'',call_id:'',timestamp:iso(5000-n*20),...extra});
  const tool=(n,name,input,call)=>m(n,'tool',typeof input==='string'?input:JSON.stringify(input,null,2),{title:name,call_id:call});
  const out=(n,text,call)=>m(n,'result',text,{title:'执行结果',call_id:call});
  const oldest=[m(1,'user','先修一下登录页'),m(2,'assistant','我先看看 OLDWORD 在哪里定义。'),tool(3,'Bash','rg -n OLDWORD app','o1'),out(4,'app/login.js:3: const OLDWORD = 1','o1'),m(5,'assistant','找到了，在 login.js 里。')];
  const middle=[m(6,'user','顺便看看注册页'),m(7,'assistant','注册页没问题。'),m(8,'user','好的'),m(9,'assistant','嗯，继续。')];
  const filler=[];for(let k=0;k<6;k++)filler.push(m(30+k*2,'user','第 '+k+' 个问题'),m(31+k*2,'assistant','第 '+k+' 个回答，'+'很长的一段解释。'.repeat(10)));
  const newer=[m(10,'user','登录页超时了，帮我看看'),m(11,'assistant','我先跑一下测试，看看登录超时。','',),
   tool(12,'Bash','cd /work/proj && npm test -- --grep 登录','b1'),out(13,'PASS: a\nFAIL: 登录超时 needle-in-output\nExit code 1','b1'),
   m(14,'assistant','改好了，`app/login.js:12` 已更新，登录不再超时。'),...filler,
   m(60,'user','再跑一下失败的测试'),tool(61,'Bash','npm test','b2'),out(62,'PASS: a\nPASS: 登录\nExit code 0','b2'),
   m(63,'assistant','**都过了：** 登录流程正常。\n\n看 `app/login.js:12` 和 `~/.env`。')];
  window.fx={pages:{newer,middle,oldest},calls:[],copied:[],files:[]};
  const A1={pane_id:'w1:p1',terminal_id:'term1',agent:'claude',agent_status:'idle',identity:'id-1',cwd:'/work/proj',title:'修登录页',history_ref:{status:'matched',source:'native-process',record_id:r1.id,thread:'t1',record:r1}};
  const device={id:'fx',name:'测试电脑',user:'u',host:'fixture.invalid',port:22,remember:true};
  const code=Array.from({length:40},(_,i)=>i===11?'  if (elapsed > TIMEOUT) throw new Error("登录超时");':'line '+(i+1)+' of login.js').join('\n')+'\n';
  window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);let data={};
   try{
   if(op==='devices')data={devices:[device],version:'test',connected:device};
   else if(op==='remote'){fx.calls.push(a.op);
    if(a.op==='sessions')data={sessions:[{name:'fx',running:true}]};
    else if(a.op==='agents')data=a.target?{follow:true,state:'same',agents:[A1],pane:null}:{agents:[A1]};
    else if(a.op==='status'){const {history_ref,...rest}=A1;data={agents:[rest]};}
    else if(a.op==='history'){data=a.before===undefined?{record:r1,messages:fx.pages.newer,before:9,has_more:true,children:[]}:a.before===9?{record:r1,messages:fx.pages.middle,before:5,has_more:true,children:[]}:{record:r1,messages:fx.pages.oldest,before:0,has_more:false,children:[]};}
    else if(a.op==='read')data={text:'$ '};
    else if(a.op==='catalog')data={records:[],total:0,next:null};
    else if(a.op==='fileView'){fx.files.push(a);
     if(/\.env/.test(a.path))throw Error('这是密钥、凭据或 .env 一类的敏感文件，不在手机上显示');
     if(/big/.test(a.path))data={path:'/work/proj/big.log',name:'big.log',size:900000,shown:524288,truncated:true,binary:false,text:'x\n'.repeat(50)};
     else if(/\.bin$/.test(a.path))data={path:'/work/proj/a.bin',name:'a.bin',size:4000,shown:4000,truncated:false,binary:true};
     else data={path:'/work/proj/'+a.path,name:'login.js',size:code.length,shown:code.length,truncated:false,binary:false,text:code,mtime:now-120};}
    else throw Error('blocked remote op '+a.op);}
   else if(!['watchState','protect','setAlerts','cacheGet','cachePut'].includes(op))throw Error('unexpected native op '+op);
   }catch(e){setTimeout(()=>nativeResult(id,{ok:false,error:e.message}),10);return;}
   setTimeout(()=>nativeResult(id,{ok:true,data}),10);}};});
 await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
 if(dark)await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
 await page.evaluate(()=>{window.followInterval=()=>1e9;window.copyText=t=>{fx.copied.push(t);toast('已复制');};S.paused=true;});
 await page.getByRole('button',{name:/修登录页/}).click();
 await page.getByText('登录流程正常。',{exact:false}).waitFor();
 await page.evaluate(()=>{S.paused=true;});
 return page;}
const shot=async(page,name)=>{await page.evaluate(()=>document.getElementById('toast').classList.remove('show'));await page.waitForTimeout(300);await page.screenshot({path:path.join(shots,'find-'+name+'.png')});};
const count=page=>page.locator('.find-count').textContent();
const openFind=async page=>{await page.getByRole('button',{name:'更多操作',exact:true}).click();await page.locator('.menu-item',{hasText:'在对话里搜索'}).click();await page.getByRole('textbox',{name:'搜索对话'}).waitFor();};
const search=async(page,q)=>{const box=page.getByRole('textbox',{name:'搜索对话'});await box.fill(q);await page.waitForFunction(q=>FIND.finder&&FIND.finder.q===q&&!FIND.finder.busy,q);await page.waitForTimeout(80);};
const timelineText=page=>page.$eval('#chat-scroll',n=>n.innerText);
const overflow=page=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);

// 1. Search in the loaded pages, hits inside folded 「工作过程」 and tool output; Enter = next (further back).
{const page=await fresh();
 const before=await timelineText(page);
 assert.equal(await page.locator('details.work[open]').count(),0,'work blocks start folded');
 await openFind(page);
 await search(page,'needle-in-output');
 assert.equal(await count(page),'1/1');
 const cur=page.locator('mark.find-hit.current');
 assert.equal(await cur.textContent(),'needle-in-output');
 assert.ok(await cur.isVisible(),'hit inside a folded tool output is shown');
 assert.equal(await page.locator('details.work[open]').count(),1,'only the work block holding the hit opened');
 assert.ok(await page.locator('details.tool-row[open] pre.output mark.find-hit').count()===1);
 // Many hits: counted from the newest; Enter goes further back; buttons move up/down.
 await search(page,'登录');
 const total=Number((await count(page)).split('/')[1]);assert.ok(total>=8,'hits: '+total);
 assert.equal(await count(page),'1/'+total);
 const y=()=>page.$eval('mark.find-hit.current',n=>n.getBoundingClientRect().top+document.getElementById('chat-scroll').scrollTop);
 const y1=await y();
 await page.getByRole('textbox',{name:'搜索对话'}).press('Enter');
 assert.equal(await count(page),'2/'+total);assert.ok(await y()<=y1,'next hit is earlier in the chat');
 await page.getByRole('button',{name:'下一处',exact:true}).click();assert.equal(await count(page),'1/'+total);
 await page.getByRole('button',{name:'上一处',exact:true}).click();await page.getByRole('button',{name:'上一处',exact:true}).click();assert.equal(await count(page),'3/'+total);
 // Hits span inline pieces of one paragraph (bold + text), not across paragraphs.
 await search(page,'都过了： 登录');assert.equal(await count(page),'1/1');assert.equal(await page.locator('mark.find-hit').count(),2);
 await search(page,'登录页 OLDWORD');assert.equal(await count(page),'无结果');
 // Repaints (polls) keep the hits and the current position.
 await search(page,'登录');await page.getByRole('textbox',{name:'搜索对话'}).press('Enter');
 await page.evaluate(()=>{TL_KEEP.nodes=new Map();renderTimeline();});
 await page.waitForFunction(()=>document.querySelectorAll('mark.find-hit').length>0&&!FIND.finder.busy);await page.waitForTimeout(450);
 assert.equal(await count(page),'2/'+total,'position kept across a full repaint');
 await shot(page,'chat-390');
 assert.ok(await overflow(page)<=0);
 // Closing removes every mark, folds back what search opened and leaves the text as it was.
 await page.getByRole('button',{name:'关闭搜索',exact:true}).click();
 assert.equal(await page.locator('mark').count(),0);assert.equal(await page.locator('.find-bar').count(),0);
 assert.equal(await page.locator('details.work[open]').count(),0,'search-opened blocks fold back');
 assert.equal(await timelineText(page),before);
 // Escape closes; Ctrl+F reopens.
 await page.keyboard.press('Control+f');await page.getByRole('textbox',{name:'搜索对话'}).waitFor();
 await page.getByRole('textbox',{name:'搜索对话'}).press('Escape');assert.equal(await page.locator('.find-bar').count(),0);
 await page.close();}

// 2. Not in the loaded pages: offers earlier pages and loads until found (two pages here).
{const page=await fresh();
 await openFind(page);await search(page,'OLDWORD');
 assert.equal(await count(page),'无结果');
 const more=page.getByRole('button',{name:'加载更早的记录继续找'});await more.waitFor();
 assert.ok(await page.getByText('已加载的记录里没找到').isVisible());
 await shot(page,'more-390');
 const asked=await page.evaluate(()=>fx.calls.filter(c=>c==='history').length);
 await more.click();
 await page.waitForFunction(()=>document.querySelector('.find-count')?.textContent.includes('/'));
 await page.waitForFunction(()=>!FIND.finder.loading);
 assert.equal(await page.evaluate(()=>fx.calls.filter(c=>c==='history').length)-asked,2,'two earlier pages loaded');
 const c=await count(page);assert.match(c,/^1\/\d+$/,c);assert.ok(+c.split('/')[1]>=3,c);
 assert.ok(await page.locator('mark.find-hit.current').isVisible(),'the found hit is shown');
 assert.equal(await page.getByRole('button',{name:'加载更早的记录继续找'}).count(),0,'record start reached');
 await page.close();}

// 3. File viewer: only on the tap, scoped request, line numbers, target line, wrap, copy, search.
{const page=await fresh();
 assert.equal(await page.evaluate(()=>fx.files.length),0,'nothing read before a tap');
 await page.locator('.reply .md-file',{hasText:'app/login.js:12'}).first().click();
 const open=page.getByRole('button',{name:'查看文件内容'});await open.waitFor();
 assert.equal(await page.evaluate(()=>fx.files.length),0,'the path sheet alone reads nothing');
 await shot(page,'sheet-390');
 await open.click();
 await page.locator('.fv-line').first().waitFor();
 const req=await page.evaluate(()=>fx.files[0]);
 assert.equal(req.path,'app/login.js');assert.equal(req.cwd,'/work/proj');assert.equal(req.record_id,'a'.repeat(64));assert.equal(req.provider,'claude');assert.ok(!('remote' in req));
 assert.equal(await page.locator('.fv-line').count(),40);
 assert.equal(await page.locator('.fv-line.target .fv-no').textContent(),'12');
 assert.ok(await page.locator('.fv-line.target').isVisible(),'jumps to the line');
 assert.match(await page.locator('.fv-status').textContent(),/40 行/);
 const wrap=page.getByRole('button',{name:'自动换行'});
 const pressed=await wrap.getAttribute('aria-pressed');await wrap.click();
 assert.notEqual(await wrap.getAttribute('aria-pressed'),pressed);
 assert.equal(await page.locator('.fv-lines.wrap').count(),pressed==='true'?0:1);
 await wrap.click();
 await page.getByRole('button',{name:/^复制全部$/}).click();assert.match(await page.evaluate(()=>fx.copied.at(-1)),/^line 1 of login\.js\n/);
 // Line numbers are not selectable text and not searched.
 assert.equal(await page.$eval('.fv-no',n=>getComputedStyle(n).userSelect),'none');
 await page.getByRole('button',{name:'搜索',exact:true}).click();
 const fbox=page.getByRole('textbox',{name:'在文件里搜索'});await fbox.fill('login');
 await page.waitForFunction(()=>/\/39$/.test(document.querySelector('.fv-sheet .find-count')?.textContent||''));
 await fbox.press('Enter');assert.equal(await page.locator('.fv-sheet .find-count').textContent(),'2/39');
 await fbox.fill('12');await page.waitForFunction(()=>document.querySelector('.fv-sheet .find-count')?.textContent==='无结果');// line numbers are not searched
 await fbox.fill('登录超时');await page.waitForFunction(()=>document.querySelector('.fv-sheet .find-count')?.textContent==='1/1');
 assert.ok(await page.locator('.fv-sheet mark.find-hit.current').isVisible());
 await shot(page,'viewer-390');
 assert.ok(await overflow(page)<=0);
 // Refusals come back as a clear message; truncated and binary files say so.
 await page.evaluate(()=>fileView('~/.env'));await page.locator('.fv-error').waitFor();
 assert.match(await page.locator('.fv-error').textContent(),/敏感文件/);
 assert.ok(await page.getByRole('button',{name:'重试'}).isVisible());
 await page.evaluate(()=>fileView('big.log'));await page.getByText('只显示前',{exact:false}).waitFor();
 assert.match(await page.locator('.fv-cut').textContent(),/文件有 900 KB，只显示前 524 KB/);
 assert.ok(await page.getByRole('button',{name:'复制已显示的部分'}).isVisible());
 await page.evaluate(()=>fileView('a.bin'));await page.getByText('二进制文件，不显示内容。').waitFor();
 assert.equal(await page.locator('.fv-line').count(),0);
 // A ch (remote) chat sends the route context; the far side applies the same rules.
 await page.evaluate(()=>{S.chat.record={...S.chat.record,remote:{session:'fx',target:'w1:p1',identity:'id-1',provider:'claude'}};closeSheet();fileView('src/x.js');});
 await page.locator('.fv-line').first().waitFor();
 assert.deepEqual((await page.evaluate(()=>fx.files.at(-1))).remote,{session:'fx',target:'w1:p1',identity:'id-1',provider:'claude'});
 for(const op of ['prompt','key','answer','paneRun','paneText','paneKey'])assert.ok(!(await page.evaluate(()=>fx.calls)).includes(op),op);
 await page.close();}

// 4. Small screens, dark theme.
for(const [w,h,dark] of [[320,640,false],[320,640,true],[390,844,true]]){
 const page=await fresh(w,h,dark);const tag=(dark?'dark-':'light-')+w;
 await openFind(page);await search(page,'登录');
 const bar=await page.$eval('.find-bar',n=>{const r=n.getBoundingClientRect();return {right:r.right,h:r.height,btns:[...n.querySelectorAll('button')].filter(b=>b.offsetParent).map(b=>{const q=b.getBoundingClientRect();return Math.min(q.width,q.height);})};});
 assert.ok(bar.right<=w+0.5&&bar.h<=60,'bar fits: '+JSON.stringify(bar));
 assert.ok(bar.btns.every(x=>x>=40),'touch targets: '+bar.btns);
 const [hit,curr]=await page.evaluate(()=>[getComputedStyle(document.querySelector('mark.find-hit:not(.current)')).backgroundColor,getComputedStyle(document.querySelector('mark.find-hit.current')).backgroundColor]);
 assert.notEqual(hit,curr);
 assert.ok(await overflow(page)<=0,tag+' overflow');
 await shot(page,'chat-'+tag);
 await page.getByRole('button',{name:'关闭搜索',exact:true}).click();
 await page.locator('.reply .md-file',{hasText:'app/login.js:12'}).first().click();
 await page.getByRole('button',{name:'查看文件内容'}).click();await page.locator('.fv-line').first().waitFor();
 await page.getByRole('button',{name:'搜索',exact:true}).click();await page.getByRole('textbox',{name:'在文件里搜索'}).fill('登录');
 await page.waitForFunction(()=>document.querySelector('.fv-sheet .find-count')?.textContent==='1/1');
 assert.ok(await overflow(page)<=0,tag+' viewer overflow');
 await shot(page,'viewer-'+tag);
 await page.close();}

await browser.close();
assert.deepEqual(errors,[]);
console.log('find UI checks passed');
})().catch(e=>{console.error(e);process.exit(1);});
