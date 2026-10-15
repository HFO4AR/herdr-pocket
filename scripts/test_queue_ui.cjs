// Send queue: messages written while the agent is busy (or refused before sending) wait and go out
// when it stops. Offline: native SSH is a strict fake that records every request; nothing leaves the page.
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
 const now=Date.now()/1000,iso=s=>new Date((now-s)*1000).toISOString();
 const rec=(id,thread,title)=>({id,thread,title,provider:'claude',parent:null,cwd:'/work/proj',modified:now-60});
 const R={r1:rec('r1','t1','整理发布脚本'),r2:rec('r2','t2','另一段对话')};
 let n=50;const msg=(kind,text,age=30)=>({id:(++n)+':0',kind,text,title:'',call_id:'',timestamp:iso(age)});
 const H={r1:[msg('user','把发布脚本整理一下',300),msg('assistant','好，我先看看现在的脚本。',290)],r2:[msg('user','新对话的问题',20),msg('assistant','新对话的回答。',10)]};
 const ref=r=>({status:'matched',source:'native-process',record_id:r.id,thread:r.thread,record:r});
 const A1={pane_id:'w1:p1',terminal_id:'term1',agent:'claude',agent_status:'working',identity:'id-1',cwd:'/work/proj',title:'整理发布脚本',history_ref:ref(R.r1)};
 window.fx={R,H,A1,ref,list:[A1],follow:null,calls:[],attempts:[],prompts:[],promptErrors:[],nx:[],
  say(text,rid='r1',pic=false){H[rid].push(msg('user',text+(pic?'\n\n[图片] /home/u/.herdr-pocket/uploads/2026-10-15/'+'e'.repeat(64)+'.jpg':''),1));},
  pic(label){const c=document.createElement('canvas');c.width=240;c.height=180;const g=c.getContext('2d');const gr=g.createLinearGradient(0,0,240,180);gr.addColorStop(0,'hsl(200,55%,62%)');gr.addColorStop(1,'hsl(240,60%,38%)');g.fillStyle=gr;g.fillRect(0,0,240,180);g.fillStyle='#fff';g.font='600 26px sans-serif';g.fillText(label,20,100);return c.toDataURL('image/jpeg',0.8);}};
 const device={id:'fx',name:'测试电脑',user:'u',host:'fixture.invalid',port:22,remember:true};
 const strip=a=>{const {history_ref,...rest}=a;return rest;};
 let att=0;
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);let data={};fx.nx.push({op,args:a});
  try{
  if(op==='devices')data={devices:[device],version:'test',connected:device};
  else if(op==='remote'){fx.calls.push({op:a.op,target:a.target||''});
   if(a.op==='sessions')data={sessions:[{name:'fx',running:true}]};
   else if(a.op==='agents'){if(a.target){const row=fx.list.find(x=>x.pane_id===a.target);data=fx.follow?JSON.parse(JSON.stringify(fx.follow)):row?{follow:true,state:'same',agents:[row],pane:null}:{follow:true,state:'gone',agents:[],pane:null};}else data={agents:fx.list};}
   else if(a.op==='status')data={agents:fx.list.map(strip)};
   else if(a.op==='history')data={record:Object.values(R).find(r=>r.id===a.record_id),messages:H[a.record_id]||[],before:0,has_more:false,children:[]};
   else if(a.op==='read')data={text:'$ '};
   else if(a.op==='catalog')data={records:[],total:0,next:null};
   else if(a.op==='prompt'){fx.attempts.push(a);const e=fx.promptErrors.shift();if(e)throw Error(e);fx.prompts.push(a);data={sent:true,receipt:a.id};}
   else if(a.op==='account')data={ssh_user:'u',hostname:'fx'};
   else throw Error('unexpected remote op '+a.op);}
  else if(op==='pickImages')data={images:[{id:'att-'+(++att),thumb:fx.pic('截图'),width:800,height:600,bytes:40000,type:'jpg'}],failed:0};
  else if(op==='image')data={url:fx.pic('截图'),width:240,height:180};
  else if(op==='uploadImage')data={name:'2026-10-15/'+'e'.repeat(64)+'.jpg',sha256:'e'.repeat(64),bytes:40000};
  else if(!['watchState','protect','setAlerts','dropImages'].includes(op))throw Error('unexpected native op '+op);
  }catch(e){setTimeout(()=>nativeResult(id,{ok:false,error:e.message}),10);return;}
  setTimeout(()=>nativeResult(id,{ok:true,data}),10);}};
});
await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
await page.evaluate(()=>{window.followInterval=()=>1e9;});
const shot=async name=>{await page.evaluate(()=>document.getElementById('toast').classList.remove('show'));await page.waitForTimeout(250);await page.screenshot({path:path.join(shots,'queue-'+name+'.png')});};
const box=()=>page.getByRole('textbox',{name:'消息输入框',exact:true});
const send=async text=>{await box().fill(text);await page.getByRole('button',{name:'发送消息',exact:true}).click();};
// Herdr reports a status; the UI notices it like a regular poll would.
const status=async st=>{await page.evaluate(async st=>{fx.list=fx.list.map(a=>({...a,agent_status:st}));S.statusBusy=false;await refreshStatus();},st);};
const prompts=()=>page.evaluate(()=>fx.prompts.map(p=>p.text));
const attempts=()=>page.evaluate(()=>fx.attempts.length);
const bubble=text=>page.locator('.message.queued').filter({hasText:text});

await page.getByRole('button',{name:/整理发布脚本/}).click();
await page.getByText('好，我先看看现在的脚本。').first().waitFor();
assert.match(await box().getAttribute('placeholder'),/写好会排队/);

// 1. Busy agent: messages queue up in order instead of being refused.
await send('第一条：先跑测试');
await bubble('第一条：先跑测试').getByText('排队中 · 等它停下再发',{exact:true}).waitFor();
assert.equal(await box().inputValue(),'','composer is cleared once queued');
await page.getByRole('button',{name:'添加附件',exact:true}).click();
await page.getByRole('button',{name:/从相册选/}).click();
await page.locator('.att-tray .att').first().waitFor();
await send('第二条：看看这张截图');
await bubble('第二条').getByText('排队中 · 第 2 条',{exact:true}).waitFor();
assert.equal(await page.locator('.att-tray').count(),0,'the picture moved into the queue');
assert.equal(await bubble('第二条').locator('.img-tile img').count(),1);
assert.equal(await attempts(),0,'nothing is sent while the agent works');
await shot('busy-390');
await page.setViewportSize({width:320,height:640});await page.waitForTimeout(200);
assert(await page.evaluate(()=>document.scrollingElement.scrollWidth<=innerWidth),'no sideways scroll at 320');
for(const b of await page.locator('.queue-actions button').all()){const r=await b.boundingBox();assert(r.height>=44&&r.x>=0&&r.x+r.width<=320,'action fits and is tall enough');}
await shot('busy-320');
await page.setViewportSize({width:390,height:844});
// Edit moves a queued message back into the (empty) composer.
await send('写错了的一条');
await bubble('写错了的一条').getByRole('button',{name:'修改',exact:true}).click();
assert.equal(await box().inputValue(),'写错了的一条');
assert.equal(await bubble('写错了的一条').count(),0);
await box().fill('');await page.evaluate(()=>{S.drafts.delete(draftKey());});
// The queue survives leaving the chat; the list shows it.
await page.getByRole('button',{name:'返回列表',exact:true}).click();
await page.getByText('排队 2',{exact:true}).waitFor();
await shot('list-390');
await page.getByRole('button',{name:/整理发布脚本/}).click();
await bubble('第一条').waitFor();assert.equal(await page.locator('.message.queued').count(),2);
console.log('PASS: busy agent queues messages in order, with pictures; edit; survives leaving; list badge; 390/320');

// 2. Not in the foreground: nothing goes out even when the agent stops.
await page.evaluate(()=>setForeground(false));
await status('idle');
await page.waitForTimeout(3200);
assert.equal(await attempts(),0,'never sends in the background');
// Foreground again: a fresh read-only pane check, then the head goes out alone.
await page.evaluate(()=>{fx.calls.length=0;setForeground(true);});
await page.waitForFunction(()=>fx.prompts.length===1,null,{timeout:8000});
assert.deepEqual(await prompts(),['第一条：先跑测试']);
const calls=await page.evaluate(()=>fx.calls.map(c=>c.op+(c.target?'@'+c.target:'')));
assert(calls.indexOf('agents@w1:p1')>=0&&calls.indexOf('agents@w1:p1')<calls.indexOf('prompt@w1:p1'),'pane re-checked before sending: '+calls.join(','));
await page.getByText('已送达 Agent',{exact:true}).waitFor();
await page.waitForTimeout(3200);
assert.equal(await attempts(),1,'the next one waits until the first was taken up');
// Herdr reports it working, the transcript shows the prompt, then it stops: the second goes out with its picture.
await status('working');await page.evaluate(()=>{fx.say('第一条：先跑测试');});await page.evaluate(()=>fetchHistory());
await status('idle');
await page.waitForFunction(()=>fx.prompts.length===2,null,{timeout:8000});
const p2=await page.evaluate(()=>fx.prompts[1]);
assert.equal(p2.text,'第二条：看看这张截图');assert.equal(p2.images.length,1);assert.match(p2.images[0].name,/^2026-10-15\/e{64}\.jpg$/);
const nx=await page.evaluate(()=>fx.nx.map(x=>x.op==='remote'?x.args.op:x.op));
assert(nx.indexOf('uploadImage')>=0&&nx.indexOf('uploadImage')<nx.lastIndexOf('prompt'));
await page.waitForFunction(()=>!document.querySelector('.message.queued'));
console.log('PASS: only in the foreground; pane re-checked; one at a time; picture uploaded before its prompt');

// 3. Refused before sending (agent_blocked): it stays queued with the reason and goes out later, with a new request id.
await status('working');await page.evaluate(()=>{fx.say('第二条：看看这张截图','r1',true);});await page.evaluate(()=>fetchHistory());
await send('第三条：顺便更新文档');
await page.evaluate(()=>{fx.promptErrors.push('没发出去：Agent 正停在一个提问或授权框上，先处理它');});
await status('idle');
await bubble('第三条').getByText(/上次没发出去：Agent 正停在一个提问或授权框上/).waitFor({timeout:8000});
assert.equal(await bubble('第三条').count(),1,'refused message is still queued');
await shot('rejected-390');
await page.waitForFunction(()=>fx.prompts.length===3,null,{timeout:12000});
const a3=await page.evaluate(()=>fx.attempts.filter(x=>x.text==='第三条：顺便更新文档').map(x=>x.id));
assert.equal(a3.length,2);assert.notEqual(a3[0],a3[1],'fresh request id per attempt');
console.log('PASS: NOT_SENT refusal stays queued with its reason and is sent later with a fresh id');

// 4. Unknown outcome: marked, the queue stops, nothing is retried.
await status('working');await page.evaluate(()=>{fx.say('第三条：顺便更新文档');});await page.evaluate(()=>fetchHistory());
await send('第四条：结果会未知');await send('第五条：排在后面');
await page.evaluate(()=>{fx.promptErrors.push('等了 35 秒还没有回应；请求已经发出，结果未知。');});
await status('idle');
await bubble('第四条').getByText('结果未知 · 不会自动重发',{exact:true}).waitFor({timeout:8000});
assert.equal(await page.locator('.queue-bar').count(),0,'the unknown bubble itself says why; no resume while it is first');
await shot('unknown-390');
const before=await attempts();await page.waitForTimeout(5500);
assert.equal(await attempts(),before,'never retried, nothing behind it sent');
await bubble('第四条').getByRole('button',{name:'删掉',exact:true}).click();
await page.locator('.queue-bar').getByText('上一条发送结果未知，没有自动重发').waitFor();
await page.waitForTimeout(3000);assert.equal(await attempts(),before,'still paused after removing the unknown one');
await page.locator('.queue-bar').getByRole('button',{name:'继续',exact:true}).click();
await page.waitForFunction(()=>fx.prompts.at(-1)?.text==='第五条：排在后面',null,{timeout:8000});
assert.equal(await page.evaluate(()=>fx.attempts.filter(x=>x.text==='第四条：结果会未知').length),1,'unknown one attempted once only');
console.log('PASS: unknown outcome stops the queue, never retried; delete + 继续 sends the next');

// 5. A direct send at idle refused as not sent goes into the queue instead of only a toast.
await status('working');await page.evaluate(()=>{fx.say('第五条：排在后面');});await page.evaluate(()=>fetchHistory());await status('idle');
await page.evaluate(()=>{fx.promptErrors.push('没发出去：Agent 还没准备好，等它空闲了再发');});
await send('第六条：直接发');
await bubble('第六条').getByText(/上次没发出去：Agent 还没准备好/).waitFor();
assert.equal(await box().inputValue(),'');
await page.waitForFunction(()=>fx.prompts.at(-1)?.text==='第六条：直接发',null,{timeout:12000});
console.log('PASS: direct send refused as not sent is queued and goes out later');

// 6. The pane's conversation changes (/clear): the queue pauses and only continues on request.
await status('working');await page.evaluate(()=>{fx.say('第六条：直接发');});await page.evaluate(()=>fetchHistory());
await send('第七条：发给原来的对话');
await page.evaluate(()=>{const a={...fx.list[0],title:'另一段对话',history_ref:fx.ref(fx.R.r2)};fx.list=[a];});
const follow=()=>page.evaluate(async()=>{FOLLOW.last=0;await followRun();});
await follow();await follow();
await page.getByText('新对话的回答。').first().waitFor();
await page.locator('.queue-bar').getByText(/窗格里换了一段对话/).waitFor();
await status('idle');
const b7=await attempts();await page.waitForTimeout(3500);
assert.equal(await attempts(),b7,'never sent to a conversation the person has not confirmed');
await shot('switched-390');
await page.locator('.queue-bar').getByRole('button',{name:'继续',exact:true}).click();
await page.waitForFunction(()=>fx.prompts.at(-1)?.text==='第七条：发给原来的对话',null,{timeout:8000});
console.log('PASS: a conversation switch pauses the queue until the person continues');

// 7. The agent exits: the queue stops for good; copy and delete still work.
await status('working');
await send('第八条：它会退出');
await page.evaluate(()=>{fx.follow={follow:true,state:'exited',agents:[],pane:{pane_id:'w1:p1',terminal_id:'term1',identity:'pane-1',cwd:'/work/proj'}};fx.list=[];});
await page.evaluate(async()=>{S.statusBusy=false;await refreshStatus();FOLLOW.last=0;await followRun();});
await page.locator('.queue-bar').getByText(/已退出，排队的消息不会再发/).waitFor({timeout:8000});
assert.equal(await page.locator('.queue-bar').getByRole('button',{name:'继续'}).count(),0);
assert.equal(await bubble('第八条').getByRole('button',{name:'复制',exact:true}).count(),1);
const b8=await attempts();await page.waitForTimeout(3000);assert.equal(await attempts(),b8);
await shot('exited-390');
console.log('PASS: exited agent stops the queue for good');

const ids=await page.evaluate(()=>fx.attempts.map(x=>x.id));
assert.equal(new Set(ids).size,ids.length,'every attempt has its own id');
assert(ids.every(x=>/^[a-f0-9-]{36}$/.test(x)));
assert.deepEqual(errors,[]);
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
