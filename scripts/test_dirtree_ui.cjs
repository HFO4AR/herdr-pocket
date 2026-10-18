// Directory picker (dirpick.js) in both 新建 sheets: 浏览目录… opens a folder tree from 家目录 or
// 根目录 /, one level per tap, with 常用 chips, a filter, hidden folders, symlinks, locked and huge
// folders, slow / failed reads and an old bridge; the folder picked becomes the sheet's choice.
// Offline: `remote` is a recorded fake over a fake filesystem; nothing is created anywhere.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');

(async()=>{
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const folder=process.env.SHOTS||path.join(root,'ui-artifacts');fs.mkdirSync(folder,{recursive:true});
const errors=[];
async function fresh(width=390,height=844){
 const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:2});
 page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
 await page.addInitScript(()=>{window.PocketNative={request(id,op){if(!['devices','demo','disconnect','protect','watchState','cachePut','cacheGet'].includes(op))throw Error('Forbidden native call in offline UI test: '+op);setTimeout(()=>nativeResult(id,{ok:true,data:op==='devices'?{devices:[]}:op==='cacheGet'?{value:null}:{}}),0);}};});
 await page.goto(require('./ui_bundle.cjs').url(html));
 await page.getByRole('button',{name:'体验聊天演示',exact:true}).click();
 await page.getByText('离线演示 · 示例数据，不连接电脑',{exact:true}).waitFor();
 return page;}
// A connected-looking computer with Herdr and tmux, and a fake filesystem behind dirList.
async function live(page){
 await page.evaluate(()=>{
  const big=Array.from({length:1200},(_,i)=>'d'+String(i).padStart(4,'0'));
  const FS={'/':['bin','etc','home','mnt','root!','tmp','usr'],'/home':['me'],
   '/home/me':['.cache','.config','Downloads','IterxAI','big','locked!','notes','peek?','site','slow','work@/mnt/E/work','gone@/mnt/X~'],
   '/home/me/IterxAI':['stm32_host'],'/home/me/IterxAI/stm32_host':['app','bridge','docs'],'/home/me/.config':['herdr'],'/home/me/notes':[],'/home/me/Downloads':['.thumbs'],
   '/home/me/big':big,'/mnt':['E'],'/mnt/E':['project','work'],'/mnt/E/project':['ch-cli','dmimu_host_app'],'/mnt/E/work':['alpha','beta'],'/mnt/E/work/alpha':[],'/mnt/E/work/beta':[],'/mnt/E/project/ch-cli':[]};
  const real=p=>p.replace(/^\/home\/me\/work(?=\/|$)/,'/mnt/E/work');
  function listing(p,o){
   const out={path:p,home:'/home/me',...(p!=='/'?{parent:p.slice(0,p.lastIndexOf('/'))||'/'}:{})};
   if(p==='/home/me/slow')return {...out,error:'读这个目录超时了（可能是很慢或没挂上的网络盘）',code:'timeout',dirs:[]};
   if(p==='/home/me/peek')return {...out,enter:true,list:false,write:true,error:'没权限打开这个目录',code:'denied',dirs:[]};
   const r=real(p),raw=FS[r];if(!raw)return {...out,error:'这个目录不存在',code:'missing',dirs:[]};
   let dirs=raw.map(x=>{const m=x.match(/^([^@!?~]+)(?:@([^~]+))?([!?~])?$/);const d={name:m[1]};if(m[2]){d.link=m[2];d.real=m[2];}
    if(m[3]==='!')Object.assign(d,{enter:false,list:false,write:false});if(m[3]==='?')d.list=false;if(m[3]==='~')d.slow=true;if(!r.startsWith('/home/me'))d.write=false;return d;});
   const hidden=o.hidden?0:dirs.filter(d=>d.name.startsWith('.')).length;if(!o.hidden)dirs=dirs.filter(d=>!d.name.startsWith('.'));
   if(o.query)dirs=dirs.filter(d=>d.name.toLowerCase().includes(o.query.toLowerCase()));
   const total=dirs.length;
   return {...out,...(r!==p?{real:r}:{}),enter:true,list:true,write:r.startsWith('/home/me'),dirs:dirs.slice(0,500),total,truncated:total>500,hidden,partial:false};}
  window.fx={calls:[],old:false,slow:0,listing,
   info:{kinds:[{kind:'codex',found:true},{kind:'claude',found:true},{kind:'ch',found:true}],home:'/home/me',
    workspaces:[{workspace_id:'w1',label:'stm32_host',focused:true,dirs:[{path:'/home/me/IterxAI/stm32_host',agents:2,panes:3}]}],
    dirs:[{path:'/home/me/IterxAI/stm32_host',source:'pane',agents:2,workspace_id:'w1'},{path:'/home/me/notes',source:'history',modified:Date.now()/1000-86400}]}};
  fx.agent={pane_id:'w1:p1',identity:'id-old',agent:'codex',agent_status:'idle',cwd:'/home/me/IterxAI/stm32_host',terminal_title:'检查设备显示 | stm32_host',agent_session:{value:'s0'},history_ref:{status:'unavailable'}};
  remote=async(op,args={})=>{fx.calls.push({op,args:JSON.parse(JSON.stringify(args))});await new Promise(r=>setTimeout(r,30+(op==='dirList'?fx.slow:0)));
   if(op==='sessions')return{sessions:[{name:'default',running:true}]};
   if(op==='agents'||op==='status')return{agents:[fx.agent]};
   if(op==='createInfo')return fx.info;
   if(op==='tmux')return{available:true,panes:[],looked:['/tmp/tmux-1000'],skipped:[],servers:[]};
   if(op==='tmuxInfo')return{available:true,home:'/home/me',dirs:[{path:'/home/me/site',source:'tmux'}],sessions:[]};
   if(op==='create')return{created:true,kind:args.kind,cwd:args.cwd,pane_id:'w9:p1',workspace_id:'w9',new_workspace:true,state:'starting'};
   if(op==='tmuxNew')return{created:true,session:'3',cwd:args.cwd,pane:null};
   if(op==='dirList'){if(fx.old)throw Error('Unknown operation');
    if(args.paths)return{lists:args.paths.map(p=>listing(p.replace(/^~(?=\/|$)/,'/home/me'),args))};
    return listing(args.path.replace(/^~(?=\/|$)/,'/home/me'),args);}
   throw Error('unexpected op '+op);};
  try{localStorage.clear();}catch(_){}
  S.demo=false;S.device={id:'d1',name:'工作站',user:'me',host:'h',port:22};S.agents=[];S.session='';
 });
 await page.evaluate(()=>setTab('live'));
 await page.getByRole('button',{name:/检查设备显示/}).waitFor();}
const calls=(page,op)=>page.evaluate(op=>fx.calls.filter(c=>c.op===op).map(c=>c.args),op);
const overflow=page=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||[...document.querySelectorAll('.dp *')].some(n=>{const r=n.getBoundingClientRect();return r.width&&r.right>innerWidth+1;}));
const item=(scope,name)=>scope.getByRole('treeitem',{name:new RegExp('^'+name.replace(/[.*+?^${}()|[\]\\/]/g,'\\$&')+'(，|$)')});
const shot=async(page,name)=>{await page.evaluate(()=>document.getElementById('toast')?.classList.remove('show'));await page.waitForTimeout(250);await page.screenshot({path:path.join(folder,'dirtree-'+name+'.png')});};
const dark=async(page,name)=>{await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});await shot(page,name+'-dark');await page.evaluate(()=>{document.documentElement.dataset.theme='light';});};
async function openSheet(page){
 await page.getByRole('button',{name:'新建会话',exact:true}).click();
 const sheet=page.getByRole('dialog',{name:'新建会话'});
 await sheet.getByRole('radio',{name:'Codex',exact:true}).waitFor();return sheet;}

// 1. 新建会话: 浏览目录… opens the tree down to the chosen directory in one request.
{const page=await fresh();await live(page);
 const sheet=await openSheet(page);
 const browse=sheet.getByRole('button',{name:/^浏览目录…/});
 await browse.waitFor();
 assert.equal(await sheet.getByRole('radio',{name:/^其他目录/}).count(),1,'typing a path is still offered');
 await shot(page,'form-390');
 await browse.click();
 const tree=sheet.getByRole('tree',{name:'目录树'});
 await item(tree,'stm32_host').waitFor();
 assert.equal(await sheet.getByRole('heading',{name:'选起始目录'}).count(),1);
 assert.equal(await sheet.getByRole('radio',{name:'Codex',exact:true}).isVisible(),false,'the form is covered, not closed');
 assert.equal(await page.locator('.new-sheet>.new-tmux').count()?await page.locator('.new-sheet>.new-tmux').isVisible():false,false);
 const lists=await calls(page,'dirList');
 assert.equal(lists.length,1,'the way down is one request');
 assert.deepEqual(lists[0].paths,['/home/me','/home/me/IterxAI','/home/me/IterxAI/stm32_host']);
 assert.equal(await item(tree,'stm32_host').getAttribute('aria-selected'),'true');
 assert.equal(await item(tree,'IterxAI').getAttribute('aria-expanded'),'true');
 assert.equal(await sheet.locator('.dp-cur-path').textContent(),'~/IterxAI/stm32_host');
 assert.equal(await sheet.getByRole('button',{name:'家目录',exact:true}).getAttribute('aria-pressed'),'true');
 // Folders only, hidden ones left out, sorted as the bridge sent them; 常用 chips on top.
 for(const n of ['Downloads','big','notes','site','work'])await item(tree,n).waitFor();
 assert.equal(await item(tree,'.config').count(),0);
 assert.equal(await sheet.locator('.dp-chip').count(),2);
 // Rows are big enough to tap.
 const small=await page.evaluate(()=>[...document.querySelectorAll('.dp-row,.dp-roots .pill,.dp-chip,.dp-foot button,.dp-back')].filter(n=>n.getBoundingClientRect().height<44).length);
 assert.equal(small,0,'every target ≥ 44 px');
 assert.equal(await overflow(page),false);
 await shot(page,'tree-390');await dark(page,'tree-390');
 console.log('PASS: 浏览目录… opens the tree down to the chosen directory in one request, folders only');

 // 2. Symlinks, locked folders, folders that cannot be listed, a dead link, a slow mount.
 await item(tree,'work').click();
 await item(tree,'alpha').waitFor();
 assert.match(await item(tree,'work').getAttribute('aria-label'),/→ \/mnt\/E\/work/);
 assert.equal(await sheet.locator('.dp-cur-real').textContent(),'实际是 /mnt/E/work');
 await item(tree,'locked').click();
 assert.equal(await item(tree,'locked').getAttribute('aria-expanded'),null,'a locked folder has nothing to open');
 assert.match(await item(tree,'locked').getAttribute('aria-label'),/没权限进去/);
 assert.equal(await sheet.getByRole('button',{name:'选这个目录'}).isDisabled(),true);
 await sheet.getByText('没权限进这个目录，选不了',{exact:true}).waitFor();
 await item(tree,'peek').click();
 assert.match(await item(tree,'peek').getAttribute('aria-label'),/能进去，但看不到里面/);
 assert.equal(await sheet.getByRole('button',{name:'选这个目录'}).isDisabled(),false,'enterable without listing is a fine start directory');
 assert.match(await item(tree,'gone').getAttribute('aria-label'),/目标没响应/);
 await page.evaluate(()=>{fx.slow=500;});
 await item(tree,'slow').click();
 await sheet.getByText('读取中…').first().waitFor();
 await sheet.getByText('读这个目录超时了（可能是很慢或没挂上的网络盘）',{exact:true}).waitFor();
 assert.equal(await sheet.locator('.dp-note.bad .link-btn').filter({hasText:'重试'}).count(),1);
 await page.evaluate(()=>{fx.slow=0;});
 // Tapping the highlighted folder again folds it.
 await item(tree,'work').click();await item(tree,'work').click();
 assert.equal(await item(tree,'work').getAttribute('aria-expanded'),'false');
 assert.equal(await item(tree,'alpha').count(),0);
 console.log('PASS: symlinks show their target, locked / unlistable / slow / dead folders say so');

 // 3. Hidden folders, the filter, a huge folder (pages here, the bridge searches the rest).
 await item(tree,'家目录').click();
 await sheet.getByRole('button',{name:'显示隐藏目录'}).click();
 await item(tree,'.config').waitFor();
 assert.equal((await calls(page,'dirList')).at(-1).hidden,true);
 await sheet.getByRole('button',{name:'显示隐藏目录'}).click();
 await page.waitForFunction(()=>!document.querySelector('.dp-row[aria-label^=".config"]'));
 await item(tree,'Downloads').click();
 await sheet.getByText('没有子目录（有 1 个隐藏目录，点上面的「隐藏目录」看）',{exact:true}).waitFor();
 await item(tree,'家目录').click();
 const filter=sheet.getByRole('searchbox');
 assert.equal(await filter.isVisible(),false,'the filter opens from the bar');
 await sheet.getByRole('button',{name:'筛选当前目录'}).click();
 await filter.waitFor();
 await page.waitForFunction(()=>document.activeElement?.type==='search');
 assert.equal(await filter.getAttribute('placeholder'),'在「家目录」里筛选');
 await filter.fill('NO');
 await page.waitForFunction(()=>document.querySelectorAll('.dp-tree .dp-row').length===2);
 await item(tree,'notes').waitFor();
 await filter.fill('');
 await item(tree,'big').click();
 await item(tree,'d0099').waitFor();
 assert.equal(await item(tree,'d0100').count(),0,'100 at a time');
 await sheet.getByRole('button',{name:'再显示 100 个'}).click();
 await item(tree,'d0199').waitFor();
 await sheet.getByText('目录太多，只列出前 500 个；用上面的筛选找',{exact:true}).waitFor();
 await filter.fill('d119');
 await item(tree,'d1195').waitFor();
 const q=(await calls(page,'dirList')).at(-1);
 assert.deepEqual([q.path,q.query],['/home/me/big','d119'],'past the 500 listed, the bridge searches');
 assert.equal(await overflow(page),false);
 // The bar (返回, filter) stays on screen while the tree scrolls.
 assert.ok(await page.evaluate(()=>{const h=document.querySelector('.dp-head').getBoundingClientRect(),s=document.querySelector('.sheet').getBoundingClientRect();return h.top>=s.top-1&&h.bottom<=s.top+130;}),'sticky bar');
 await shot(page,'big-390');
 await sheet.getByRole('button',{name:'筛选当前目录'}).click();
 assert.equal(await filter.isVisible(),false,'closing the filter clears it');
 await item(tree,'d0000').waitFor();
 console.log('PASS: hidden folders toggle, the filter narrows one level, huge folders page and search on the computer');

 // 4. 根目录 /: from the top; pick a folder there and it becomes the sheet's choice.
 await sheet.getByRole('button',{name:'根目录 /',exact:true}).click();
 await item(tree,'mnt').waitFor();
 assert.equal(await item(tree,'根目录 /').getAttribute('aria-selected'),'true');
 assert.match(await item(tree,'root').getAttribute('aria-label'),/没权限进去/);
 await item(tree,'mnt').click();await item(tree,'E').click();await item(tree,'project').click();
 await item(tree,'ch-cli').click();
 assert.equal(await sheet.locator('.dp-cur-path').textContent(),'/mnt/E/project/ch-cli');
 await shot(page,'root-390');
 await sheet.getByRole('button',{name:'选这个目录'}).click();
 const picked=sheet.getByRole('radio',{name:/^ch-cli/});
 await picked.waitFor();
 assert.equal(await picked.getAttribute('aria-checked'),'true');
 assert.match(await picked.textContent(),/刚在目录树里选的/);
 assert.equal(await sheet.getByRole('radio',{name:'新工作区',exact:true}).getAttribute('aria-checked'),'true');
 await shot(page,'picked-390');
 await sheet.getByRole('button',{name:'开始新建',exact:true}).click();
 await page.waitForFunction(()=>fx.calls.some(c=>c.op==='create'));
 assert.equal((await calls(page,'create'))[0].cwd,'/mnt/E/project/ch-cli');
 await page.close();
 console.log('PASS: 根目录 / browses from the top; the picked folder is selected and goes out as cwd');}

// 5. Back, 返回, a missing start directory, an old bridge; demo mode has a tree too.
{const page=await fresh();await live(page);
 let sheet=await openSheet(page);
 await sheet.getByRole('button',{name:/^浏览目录…/}).click();
 await item(sheet,'stm32_host').waitFor();
 await page.evaluate(()=>pocketBack());
 await sheet.getByRole('radio',{name:'Codex',exact:true}).waitFor();
 assert.equal(await page.getByRole('dialog',{name:'新建会话'}).count(),1,'Android back leaves the picker, not the sheet');
 assert.equal(await sheet.locator('.dp').count(),0);
 await sheet.getByRole('button',{name:/^浏览目录…/}).click();
 await sheet.getByRole('button',{name:'返回，不选了'}).click();
 await sheet.getByRole('radio',{name:'Codex',exact:true}).waitFor();
 // A typed path that does not exist: the tree stops at the last folder that does, and says so.
 await sheet.getByRole('radio',{name:/^其他目录/}).click();
 await sheet.getByRole('textbox',{name:'目录路径',exact:true}).fill('~/nope/deeper');
 await sheet.getByRole('button',{name:/^浏览目录…/}).click();
 await sheet.getByText('~/nope/deeper 不存在，停在了「家目录」',{exact:true}).waitFor();
 assert.equal(await sheet.locator('.dp-cur-path').textContent(),'~');
 await sheet.getByRole('button',{name:'返回，不选了'}).click();
 // A bridge from before dirList: says what to do; typing a path still works.
 await page.evaluate(()=>{fx.old=true;});
 await sheet.getByRole('button',{name:/^浏览目录…/}).click();
 await sheet.getByText(/桥接程序太旧/).first().waitFor();
 await sheet.getByRole('button',{name:'返回，不选了'}).click();
 await sheet.getByRole('textbox',{name:'目录路径',exact:true}).waitFor();
 await page.close();
 console.log('PASS: back and 返回 return to the form; a missing start or an old bridge is explained');}
{const page=await fresh();
 await page.getByRole('button',{name:'新建会话',exact:true}).click();
 const sheet=page.getByRole('dialog',{name:'新建会话'});
 await sheet.getByRole('button',{name:/^浏览目录…/}).click();
 await item(sheet,'pocket').waitFor();
 await item(sheet,'work').click();
 await item(sheet,'client-a').waitFor();
 await page.close();
 console.log('PASS: demo mode browses a fake tree');}

// 6. 新建 tmux 会话 uses the same picker; 320 px fits, light and dark.
for(const [w,h] of [[390,844],[320,640]]){
 const page=await fresh(w,h);await live(page);
 await page.evaluate(()=>tmuxNewSheet());
 const sheet=page.getByRole('dialog',{name:'新建 tmux 会话'});
 await sheet.getByRole('button',{name:/^浏览目录…/}).click();
 const tree=sheet.getByRole('tree',{name:'目录树'});
 await item(tree,'site').waitFor();
 assert.equal(await item(tree,'家目录').getAttribute('aria-selected'),'true','starts at home (the default choice)');
 await item(tree,'work').click();await item(tree,'beta').waitFor();
 assert.equal(await overflow(page),false,'fits '+w);
 const tag=w===320?'320':'tmux-390';
 await shot(page,tag);await dark(page,tag);
 await item(tree,'beta').click();
 await sheet.getByRole('button',{name:'选这个目录'}).click();
 const row=sheet.getByRole('radio',{name:/^beta/});
 await row.waitFor();assert.equal(await row.getAttribute('aria-checked'),'true');
 assert.equal(await overflow(page),false);
 if(w===320){await shot(page,'320-form');await dark(page,'320-form');}
 await sheet.getByRole('button',{name:'开始新建 tmux 会话',exact:true}).click();
 await page.waitForFunction(()=>fx.calls.some(c=>c.op==='tmuxNew'));
 assert.equal((await calls(page,'tmuxNew'))[0].cwd,'/home/me/work/beta','the path as browsed; the bridge resolves the link');
 await page.close();}
console.log('PASS: 新建 tmux 会话 picks through the same tree; 320 and 390 wide fit, light and dark');

assert.deepEqual(errors,[]);
await browser.close();
console.log('PASS: directory tree UI');
})().catch(e=>{console.error(e);process.exit(1);});
