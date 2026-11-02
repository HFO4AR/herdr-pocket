'use strict';
// Editing a picture before it is sent: pen, arrow, box, crop and rotate, with undo. Tap a thumbnail in
// the composer (images.js). The drawing stays in this page; 完成 hands the result to the native side,
// which decodes and re-encodes it like any picture (ImagePrep: no metadata, ≤ 2048 px). Nothing leaves
// the phone until the message is sent. Every edit is an op replayed over the picture, so undo also
// takes back a crop or a rotation.
const IE_COLORS=[['#E5383B','红'],['#FFC300','黄'],['#2DBE60','绿'],['#2F80ED','蓝'],['#FFFFFF','白'],['#111111','黑']];
const IE_SIZES=[[3,'细'],[5,'中'],[9,'粗']];
const IE_TOOLS=[['pen','画笔','pen'],['arrow','箭头','ieArrow'],['box','方框','ieBox']];
let IE=null;
function ieCanvas(w,h){const c=document.createElement('canvas');c.width=w;c.height=h;return c;}

// ─── Drawing ────────────────────────────────────────────────────────────────
function ieDraw(g,op){
 g.strokeStyle=g.fillStyle=op.c;g.lineWidth=op.w;g.lineCap='round';g.lineJoin='round';g.beginPath();
 if(op.t==='pen'){const p=op.p;g.moveTo(p[0],p[1]);
  // Through the midpoints, so a fast stroke stays round.
  for(let i=2;i<p.length-2;i+=2)g.quadraticCurveTo(p[i],p[i+1],(p[i]+p[i+2])/2,(p[i+1]+p[i+3])/2);
  g.lineTo(p[p.length-2]+(p.length===2?.01:0),p[p.length-1]);g.stroke();return;}
 if(op.t==='box'){g.rect(Math.min(op.x1,op.x2),Math.min(op.y1,op.y2),Math.abs(op.x2-op.x1),Math.abs(op.y2-op.y1));g.stroke();return;}
 const a=Math.atan2(op.y2-op.y1,op.x2-op.x1),head=Math.min(Math.hypot(op.x2-op.x1,op.y2-op.y1)*.6,op.w*3+10*op.u);
 g.moveTo(op.x1,op.y1);g.lineTo(op.x2-Math.cos(a)*head*.7,op.y2-Math.sin(a)*head*.7);g.stroke();
 g.beginPath();g.moveTo(op.x2,op.y2);g.lineTo(op.x2-head*Math.cos(a-.45),op.y2-head*Math.sin(a-.45));g.lineTo(op.x2-head*Math.cos(a+.45),op.y2-head*Math.sin(a+.45));g.closePath();g.fill();}
function ieApply(c,op){
 if(op.t==='crop'){const n=ieCanvas(op.w,op.h);n.getContext('2d').drawImage(c,-op.x,-op.y);return n;}
 if(op.t==='rot'){const n=ieCanvas(c.height,c.width),g=n.getContext('2d');g.translate(n.width,0);g.rotate(Math.PI/2);g.drawImage(c,0,0);return n;}
 ieDraw(c.getContext('2d'),op);return c;}
function ieReplay(E){
 let c=ieCanvas(E.img.naturalWidth,E.img.naturalHeight);c.getContext('2d').drawImage(E.img,0,0);
 for(const op of E.ops)c=ieApply(c,op);
 E.done=c;E.view.width=E.live.width=c.width;E.view.height=E.live.height=c.height;E.view.getContext('2d').drawImage(c,0,0);ieLayout(E);iePaintTools(E);}
function ieCommit(E,op){E.ops.push(op);if(op.t==='pen'||op.t==='arrow'||op.t==='box'){ieDraw(E.done.getContext('2d'),op);ieDraw(E.view.getContext('2d'),op);iePaintTools(E);}else ieReplay(E);}
function ieUndo(E){if(!E.ops.length)return;E.ops.pop();E.leaving=false;ieReplay(E);}
// The picture as large as the stage allows.
function ieLayout(E){
 const box=E.stage.getBoundingClientRect(),c=E.done;if(!c||!box.width)return;
 const s=Math.min((box.width-24)/c.width,(box.height-12)/c.height),w=Math.max(1,Math.round(c.width*s)),h=Math.max(1,Math.round(c.height*s));
 E.frame.style.width=w+'px';E.frame.style.height=h+'px';
 if(E.crop){E.crop={x:0,y:0,w,h};ieCropPaint(E);}}

// ─── Pointer: draw ──────────────────────────────────────────────────────────
function iePoint(E,e){const r=E.live.getBoundingClientRect(),s=E.live.width/r.width;return [(e.clientX-r.left)*s,(e.clientY-r.top)*s];}
function ieLivePaint(E){E.frameReq=0;const g=E.live.getContext('2d');g.clearRect(0,0,E.live.width,E.live.height);if(E.stroke)ieDraw(g,E.stroke);}
function ieLiveSoon(E){if(!E.frameReq)E.frameReq=requestAnimationFrame(()=>ieLivePaint(E));}
function ieBind(E){
 const n=E.live;
 n.addEventListener('pointerdown',e=>{
  // A second finger is not a stroke: drop what the first one started.
  if(!e.isPrimary){E.stroke=null;ieLiveSoon(E);return;}
  if(e.button>0)return;e.preventDefault();n.setPointerCapture?.(e.pointerId);
  const [x,y]=iePoint(E,e),u=E.live.width/E.live.getBoundingClientRect().width,w=E.size*u;
  E.stroke=E.tool==='pen'?{t:'pen',c:E.color,w,p:[x,y]}:{t:E.tool,c:E.color,w,u,x1:x,y1:y,x2:x,y2:y};ieLiveSoon(E);});
 n.addEventListener('pointermove',e=>{const s=E.stroke;if(!s||!e.isPrimary)return;
  if(s.t==='pen'){const all=e.getCoalescedEvents?.();for(const ev of all?.length?all:[e]){const [x,y]=iePoint(E,ev);s.p.push(x,y);}}
  else [s.x2,s.y2]=iePoint(E,e);
  ieLiveSoon(E);});
 const end=e=>{const s=E.stroke;if(!s||!e.isPrimary)return;E.stroke=null;ieLivePaint(E);if(e.type==='pointercancel')return;
  // A tap with the arrow or box draws nothing.
  if(s.t!=='pen'&&Math.hypot(s.x2-s.x1,s.y2-s.y1)<4*s.u)return;
  E.leaving=false;ieCommit(E,s);};
 n.addEventListener('pointerup',end);n.addEventListener('pointercancel',end);
 // Crop: a corner or an edge resizes, inside moves.
 const c=E.cropBox;let drag=null;
 c.addEventListener('pointerdown',e=>{if(!e.isPrimary||!E.crop)return;e.preventDefault();c.setPointerCapture?.(e.pointerId);
  const r=E.frame.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top,b=E.crop,m=24;
  const l=Math.abs(x-b.x)<m,rt=Math.abs(x-b.x-b.w)<m,t=Math.abs(y-b.y)<m,bo=Math.abs(y-b.y-b.h)<m;
  drag={x,y,from:{...b},l:l&&!rt||l&&x<b.x+b.w/2,r:rt&&!l||rt&&x>=b.x+b.w/2,t:t&&!bo||t&&y<b.y+b.h/2,b:bo&&!t||bo&&y>=b.y+b.h/2};});
 c.addEventListener('pointermove',e=>{if(!drag||!e.isPrimary)return;
  const r=E.frame.getBoundingClientRect(),dx=e.clientX-r.left-drag.x,dy=e.clientY-r.top-drag.y,f=drag.from,W=r.width,H=r.height,min=40;
  let x1=f.x,y1=f.y,x2=f.x+f.w,y2=f.y+f.h;
  if(!drag.l&&!drag.r&&!drag.t&&!drag.b){const mx=Math.max(-f.x,Math.min(W-x2,dx)),my=Math.max(-f.y,Math.min(H-y2,dy));x1+=mx;x2+=mx;y1+=my;y2+=my;}
  else{if(drag.l)x1=Math.max(0,Math.min(x2-min,x1+dx));if(drag.r)x2=Math.min(W,Math.max(x1+min,x2+dx));if(drag.t)y1=Math.max(0,Math.min(y2-min,y1+dy));if(drag.b)y2=Math.min(H,Math.max(y1+min,y2+dy));}
  E.crop={x:x1,y:y1,w:x2-x1,h:y2-y1};ieCropPaint(E);});
 const stop=()=>{drag=null;};c.addEventListener('pointerup',stop);c.addEventListener('pointercancel',stop);}

// ─── Crop ───────────────────────────────────────────────────────────────────
function ieCropPaint(E){const b=E.crop,s=E.cropBox.style;s.left=b.x+'px';s.top=b.y+'px';s.width=b.w+'px';s.height=b.h+'px';}
function ieCropOpen(E){const r=E.frame.getBoundingClientRect();E.crop={x:0,y:0,w:r.width,h:r.height};E.cropBox.hidden=false;E.live.hidden=true;ieCropPaint(E);iePaintTools(E);}
function ieCropClose(E){E.crop=null;E.cropBox.hidden=true;E.live.hidden=false;iePaintTools(E);}
function ieCropApply(E){
 const b=E.crop,r=E.frame.getBoundingClientRect(),s=E.done.width/r.width,c=E.done;
 const x=Math.max(0,Math.round(b.x*s)),y=Math.max(0,Math.round(b.y*s)),w=Math.min(c.width-x,Math.round(b.w*s)),h=Math.min(c.height-y,Math.round(b.h*s));
 ieCropClose(E);if(w>=1&&h>=1&&(w<c.width||h<c.height)){E.leaving=false;ieCommit(E,{t:'crop',x,y,w,h});}}

// ─── The screen ─────────────────────────────────────────────────────────────
function iePaintTools(E){
 const p=E.panel;p.replaceChildren();E.undo.disabled=!E.ops.length;
 if(E.crop){const row=el('div','ie-crop-row');row.append(btn('取消','secondary small',()=>ieCropClose(E)),el('span','ie-hint','拖动四边或四角'),btn('确定裁切','primary small',()=>ieCropApply(E)));p.append(row);return;}
 const tools=el('div','ie-tools');tools.setAttribute('role','toolbar');tools.setAttribute('aria-label','编辑工具');
 for(const [id,label,name] of IE_TOOLS){const b=btn(label,'ie-tool'+(E.tool===id?' on':''),()=>{E.tool=id;iePaintTools(E);},name);b.setAttribute('aria-pressed',String(E.tool===id));tools.append(b);}
 tools.append(btn('裁切','ie-tool',()=>ieCropOpen(E),'ieCrop'),btn('旋转','ie-tool',()=>{E.leaving=false;ieCommit(E,{t:'rot'});},'ieRot'));
 const look=el('div','ie-look');
 for(const [c,label] of IE_COLORS){const b=btn('','ie-swatch'+(E.color===c?' on':''),()=>{E.color=c;iePaintTools(E);});b.style.setProperty('--c',c);b.setAttribute('aria-label',label+'色');b.setAttribute('aria-pressed',String(E.color===c));look.append(b);}
 look.append(el('span','ie-gap'));
 for(const [w,label] of IE_SIZES){const b=btn('','ie-size'+(E.size===w?' on':''),()=>{E.size=w;iePaintTools(E);});b.style.setProperty('--w',w+'px');b.setAttribute('aria-label',label+'线');b.setAttribute('aria-pressed',String(E.size===w));look.append(b);}
 p.append(look,tools);}
// × or back with edits asks once, so a stray tap does not lose them.
function ieLeave(E){if(E.ops.length&&!E.leaving){E.leaving=true;toast('还没保存，再按一次放弃修改');return true;}return false;}
function ieBack(E){if(E.crop){ieCropClose(E);return true;}return ieLeave(E);}
async function ieDone(E,b){
 if(!E.ops.length){closeSheet();return;}
 b.disabled=true;
 try{const data=E.done.toDataURL(E.a.type==='png'?'image/png':'image/jpeg',.92).split(',')[1];
  const got=await rpc('imageEditSave',{id:E.a.id,data});
  imgSet(E.key,imgAttached(E.key).map(x=>x.id===E.a.id?got:x));closeSheet();renderComposer();}
 catch(e){b.disabled=false;toast('没存上：'+(e.message||e));}}
async function imgEdit(key,a){
 Object.assign(paths,{ieArrow:'M5 19L19 5M9 5h10v10',ieBox:'M4 6h16v12H4z',ieCrop:'M7 2v15h15M2 7h15v15',ieRot:'M4 12a8 8 0 1 0 2.5-5.8M4 4v5h5',ieUndo:'M9 6L4 11l5 5M4 11h11a5 5 0 0 1 0 10h-3'});
 overlay.replaceChildren();
 const root=el('div','img-viewer ie');root.setAttribute('role','dialog');root.setAttribute('aria-modal','true');root.setAttribute('aria-label','编辑图片');
 const E=IE={key,a,ops:[],tool:'pen',color:IE_COLORS[0][0],size:5,crop:null,stroke:null,leaving:false,root};
 const bar=el('div','img-bar');bar.append(ib('close','关闭',()=>{if(!ieLeave(E))closeSheet();}),el('span','img-count grow','编辑图片'));
 E.undo=ib('ieUndo','撤销',()=>ieUndo(E));E.undo.disabled=true;const ok=btn('完成','primary small ie-ok',()=>ieDone(E,ok));bar.append(E.undo,ok);
 E.stage=el('div','ie-stage');E.frame=el('div','ie-frame');E.view=el('canvas','ie-view');E.live=el('canvas','ie-live');E.cropBox=el('div','ie-crop');E.cropBox.hidden=true;
 for(const k of ['tl','tr','bl','br'])E.cropBox.append(el('i','ie-corner '+k));
 const wait=el('span','spinner');E.frame.append(E.view,E.live,E.cropBox);E.stage.append(wait,E.frame);E.panel=el('div','ie-panel');
 root.append(bar,E.stage,E.panel);root.onBack=()=>ieBack(E);overlay.append(root);iePaintTools(E);
 try{const r=await rpc('imageEditSource',{id:a.id});
  E.img=await new Promise((ok,no)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=()=>no(new Error('图片打不开'));i.src=r.url;});
  if(IE!==E||!root.isConnected)return;
  wait.remove();ieBind(E);ieReplay(E);new ResizeObserver(()=>ieLayout(E)).observe(E.stage);}
 catch(e){if(root.isConnected){closeSheet();toast(e.message||String(e));}}}
