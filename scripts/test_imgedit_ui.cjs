// Editing a picture before it is sent (imgedit.js): pen, arrow, box, crop, rotate, undo; 完成 replaces
// the attachment through native, nothing else leaves the page. Offline: native is a strict fake.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');

(async()=>{
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const folder=path.join(root,'ui-artifacts');fs.mkdirSync(folder,{recursive:true});
const errors=[];
async function fresh(width=390,height=844){
 const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:2});
 page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
 await page.addInitScript(()=>{
  window.pic=(w,h,type='image/jpeg')=>{const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');g.fillStyle='#808890';g.fillRect(0,0,w,h);g.fillStyle='#fff';g.font='600 60px sans-serif';g.fillText('照片',w*.1,h*.2);return c.toDataURL(type,.9);};
  window.nx={calls:[],saves:[],saveFail:0,sourceFail:0,n:0};
  window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);nx.calls.push({op,a});
   const ok=data=>setTimeout(()=>nativeResult(id,{ok:true,data}),10),fail=error=>setTimeout(()=>nativeResult(id,{ok:false,error}),10);
   if(op==='inputInfo')return ok({physicalKeyboard:false});
   if(['devices','demo','disconnect','protect','watchState','settings','cachePut'].includes(op))return ok(op==='devices'?{devices:[]}:{});
   if(op==='cacheGet')return ok({value:null});
   if(op==='imageEditSource'){if(nx.sourceFail){nx.sourceFail--;return fail('这张图片已失效，删掉重新选一下');}return ok({url:pic(800,600)});}
   if(op==='imageEditSave'){if(nx.saveFail){nx.saveFail--;return fail('内存不够');}nx.saves.push(a);nx.n++;return ok({id:'edited-'+nx.n,thumb:pic(100,75),width:800,height:600,bytes:1000,type:'jpg'});}
   throw Error('Forbidden native call in offline UI test: '+op);}};});
 await page.goto(require('./ui_bundle.cjs').url(html));
 await page.getByRole('button',{name:'体验聊天演示',exact:true}).click();
 await page.getByRole('button',{name:/重构登录|清理构建缓存/}).first().click();
 await page.getByRole('textbox',{name:'消息输入框',exact:true}).waitFor();
 await attach(page);
 return page;}
const attach=(page,type='jpg')=>page.evaluate(type=>{imgSet(draftKey(),[{id:'att-1',thumb:pic(100,75),width:800,height:600,bytes:50000,type}]);renderComposer();},type);
const dialog=page=>page.getByRole('dialog',{name:'编辑图片',exact:true});
async function open(page){await page.getByRole('button',{name:'编辑图片 1',exact:true}).click();await page.waitForFunction(()=>IE?.done&&IE.root.isConnected);}
// Drag on the picture, in fractions of it.
async function drag(page,x1,y1,x2,y2){const b=await page.locator('.ie-live').boundingBox();
 await page.mouse.move(b.x+b.width*x1,b.y+b.height*y1);await page.mouse.down();await page.mouse.move(b.x+b.width*x2,b.y+b.height*y2,{steps:8});await page.mouse.up();await page.waitForTimeout(40);}
const pixel=(page,x,y)=>page.evaluate(([x,y])=>{const c=IE.done;return [...c.getContext('2d').getImageData(Math.round(c.width*x),Math.round(c.height*y),1,1).data].slice(0,3);},[x,y]);
const near=(got,want,tag)=>assert.ok(got.every((v,i)=>Math.abs(v-want[i])<14),tag+': '+got+' vs '+want);
const size=page=>page.evaluate(()=>[IE.done.width,IE.done.height]);
const ops=page=>page.evaluate(()=>IE.ops.map(o=>o.t));
const tool=(page,name)=>page.getByRole('toolbar',{name:'编辑工具',exact:true}).getByRole('button',{name,exact:true}).click();
const RED=[229,56,59],BLUE=[47,128,237],GREY=[128,136,144];

// 1. A thumbnail opens the editor; leaving it untouched saves nothing.
{const page=await fresh();
 await page.locator('.att .att-pen').waitFor();await open(page);
 assert.deepEqual(await size(page),[800,600]);
 assert.equal(await dialog(page).getByRole('button',{name:'撤销',exact:true}).isDisabled(),true,'nothing to undo yet');
 assert.equal(await page.getByRole('button',{name:'画笔',exact:true}).getAttribute('aria-pressed'),'true');
 await dialog(page).getByRole('button',{name:'完成',exact:true}).click();
 await dialog(page).waitFor({state:'detached'});
 assert.deepEqual(await page.evaluate(()=>nx.saves.length),0,'nothing changed, nothing saved');
 console.log('PASS: thumbnail opens the editor; untouched, nothing is saved');

 // 2. Pen, arrow, box: each lands in the picture, undo takes the last one back.
 await open(page);
 await drag(page,.1,.5,.9,.5);
 assert.deepEqual(await ops(page),['pen']);near(await pixel(page,.5,.5),RED,'pen');near(await pixel(page,.5,.8),GREY,'only the stroke');
 await dialog(page).getByRole('button',{name:'撤销',exact:true}).click();
 assert.deepEqual(await ops(page),[]);near(await pixel(page,.5,.5),GREY,'undone');
 await page.getByRole('button',{name:'蓝色',exact:true}).click();
 await page.getByRole('button',{name:'粗线',exact:true}).click();
 await tool(page,'箭头');await drag(page,.2,.6,.8,.6);
 assert.deepEqual(await ops(page),['arrow']);near(await pixel(page,.5,.6),BLUE,'arrow shaft');near(await pixel(page,.785,.6),BLUE,'arrow head');
 await page.mouse.click((await page.locator('.ie-live').boundingBox()).x+30,(await page.locator('.ie-live').boundingBox()).y+30);
 assert.deepEqual(await ops(page),['arrow'],'a tap with the arrow draws nothing');
 await page.getByRole('button',{name:'红色',exact:true}).click();
 await tool(page,'方框');await drag(page,.2,.1,.6,.4);
 near(await pixel(page,.2,.25),RED,'box edge');near(await pixel(page,.4,.25),GREY,'box is hollow');
 await page.screenshot({path:path.join(folder,'imgedit-draw-390.png')});
 console.log('PASS: pen, arrow and box draw in the chosen colour; undo; a tap draws nothing');

 // 3. Crop: back leaves the crop first; drag a corner, apply; undo brings the whole picture back.
 await tool(page,'裁切');await page.locator('.ie-crop').waitFor();
 await page.evaluate(()=>pocketBack());await page.locator('.ie-crop').waitFor({state:'hidden'});
 assert.equal(await dialog(page).count(),1,'back only left the crop');
 await tool(page,'裁切');await page.locator('.ie-crop').waitFor();
 const f=await page.locator('.ie-frame').boundingBox();
 await page.mouse.move(f.x+f.width-2,f.y+f.height-2);await page.mouse.down();await page.mouse.move(f.x+f.width/2,f.y+f.height/2,{steps:6});await page.mouse.up();
 await page.screenshot({path:path.join(folder,'imgedit-crop-390.png')});
 await page.getByRole('button',{name:'确定裁切',exact:true}).click();
 const cropped=await size(page);assert.ok(Math.abs(cropped[0]-400)<8&&Math.abs(cropped[1]-300)<8,'cropped to '+cropped);
 const b0=await page.locator('.ie-frame').boundingBox();assert.ok(Math.abs(b0.width/b0.height-4/3)<.03,'still the shape of the crop');
 near(await pixel(page,.4,.5),RED,'the drawing survives, in the cropped picture');
 await dialog(page).getByRole('button',{name:'撤销',exact:true}).click();
 assert.deepEqual(await size(page),[800,600],'undo takes back the crop');near(await pixel(page,.2,.25),RED,'and keeps the drawing');
 // Rotate: a quarter turn, right way round.
 await tool(page,'旋转');assert.deepEqual(await size(page),[600,800]);near(await pixel(page,1-.25,.2),RED,'turned clockwise');
 await dialog(page).getByRole('button',{name:'撤销',exact:true}).click();assert.deepEqual(await size(page),[800,600]);
 console.log('PASS: crop by corner, drawing survives, rotate, undo takes them back');

 // 4. Leaving with edits asks once, by × or back, and then saves nothing.
 await dialog(page).getByRole('button',{name:'关闭',exact:true}).click();
 await page.getByText('还没保存，再按一次放弃修改',{exact:true}).waitFor();assert.equal(await dialog(page).count(),1,'still here');
 await page.evaluate(()=>pocketBack());await dialog(page).waitFor({state:'detached'});
 assert.equal(await page.evaluate(()=>imgAttached()[0].id),'att-1','the picture is untouched');assert.equal(await page.evaluate(()=>nx.saves.length),0);
 console.log('PASS: unsaved edits ask once, then the picture stays as it was');

 // 5. 完成: native gets the edited pixels, the attachment is replaced; a failure keeps the editor.
 await open(page);await drag(page,.1,.5,.9,.5);await tool(page,'旋转');
 await page.evaluate(()=>{nx.saveFail=1;});
 await dialog(page).getByRole('button',{name:'完成',exact:true}).click();
 await page.getByText('没存上：内存不够',{exact:true}).waitFor();assert.deepEqual(await ops(page),['pen','rot'],'a failed save keeps the work');
 await dialog(page).getByRole('button',{name:'完成',exact:true}).click();await dialog(page).waitFor({state:'detached'});
 const saved=await page.evaluate(async()=>{const s=nx.saves[0],i=new Image();i.src='data:image/jpeg;base64,'+s.data;await i.decode();return {id:s.id,w:i.naturalWidth,h:i.naturalHeight,jpeg:s.data.startsWith('/9j/')};});
 assert.deepEqual(saved,{id:'att-1',w:600,h:800,jpeg:true});
 assert.equal(await page.evaluate(()=>imgAttached().map(a=>a.id).join()),'edited-1','the new picture took its place');
 assert.equal(await page.locator('.att').count(),1);
 console.log('PASS: 完成 sends the edited pixels once and replaces the attachment; failure keeps the work');

 // 6. A PNG stays a PNG; a picture that cannot be read closes with the reason.
 await attach(page,'png');await open(page);await drag(page,.1,.5,.9,.5);await dialog(page).getByRole('button',{name:'完成',exact:true}).click();await dialog(page).waitFor({state:'detached'});
 assert.ok(await page.evaluate(()=>nx.saves.at(-1).data.startsWith('iVBOR')),'png');
 await attach(page);await page.evaluate(()=>{nx.sourceFail=1;});
 await page.getByRole('button',{name:'编辑图片 1',exact:true}).click();
 await page.getByText('这张图片已失效，删掉重新选一下',{exact:true}).waitFor();await dialog(page).waitFor({state:'detached'});
 assert.deepEqual(await page.evaluate(()=>nx.calls.map(c=>c.op).filter(op=>!['devices','demo','settings','cacheGet','cachePut','watchState','protect','inputInfo','imageEditSource','imageEditSave'].includes(op))),[],'nothing else reached native');
 await page.close();
 console.log('PASS: PNG stays PNG; an unreadable picture says why');}

// 7. Small and sideways: everything stays on screen, and the picture refits.
for(const [w,h] of [[320,640],[844,390]]){const page=await fresh();await open(page);await page.setViewportSize({width:w,height:h});await page.waitForTimeout(150);
 const out=await page.evaluate(()=>[...document.querySelectorAll('.ie button')].filter(n=>{const r=n.getBoundingClientRect();return r.right>innerWidth+1||r.bottom>innerHeight+1||r.left<-1;}).map(n=>n.getAttribute('aria-label')||n.textContent));
 assert.deepEqual(out,[],'all controls on screen at '+w);
 const tall=await page.evaluate(()=>[...document.querySelectorAll('.ie-tool,.ie-swatch,.ie-size')].map(n=>n.getBoundingClientRect().height));assert.ok(Math.min(...tall)>=44,'touch targets '+tall);
 const f=await page.locator('.ie-frame').boundingBox();assert.ok(f.width>100&&f.height>60&&f.x>=0&&f.x+f.width<=w,'picture fits at '+w+': '+JSON.stringify(f));
 await drag(page,.1,.5,.9,.5);await page.screenshot({path:path.join(folder,'imgedit-'+w+'.png')});
 if(w===320){await page.setViewportSize({width:640,height:320});await page.waitForTimeout(120);const g=await page.locator('.ie-frame').boundingBox();assert.ok(g.width/g.height>1.2&&g.height<=320,'refits after rotating the phone');}
 await page.close();}
console.log('PASS: fits 320 px and landscape, targets stay 44 px, refits on rotation');

await browser.close();
assert.deepEqual(errors,[],'no page errors');
console.log('ALL PASS: picture editor');
})().catch(e=>{console.error(e);process.exit(1);});
