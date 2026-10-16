'use strict';
// Jump hosts (跳板机): the 「通过跳板机连接」 part of 添加/编辑设备, the route shown on device cards and
// the hop wording used by the host-key sheets. Loaded before onboard.js; declarations only.
// Security: a hop password goes to native only inside saveDevice and never comes back (the list says
// `remember` per hop). Each hop's SSH fingerprint is checked and trusted on its own (trustSheet).

const HOP_MAX=3;
function hopIcons(){if(paths.route)return;Object.assign(paths,{
 route:'M6 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 18h8a3 3 0 0 0 0-6H8a3 3 0 0 1 0-6h8',
 up:'M12 19V5M6 11l6-6 6 6',dn:'M12 5v14M6 13l6 6 6-6'});}

// "jump1 → jump2", for cards and the connected-device panel.
function hopRoute(d){return (d?.jumps||[]).map(h=>h.host).join(' → ');}
function hopLine(d){hopIcons();const line=el('div','device-line hop-line');line.append(icon('route'),el('span','truncate','经 '+hopRoute(d)));line.title='经 '+hopRoute(d)+' → '+d.host;return line;}
// Where a host-key sheet is about: "跳板机 a:22（第 1 跳）", "b:22（经 a）" or plain "b:22".
function hopWhere(i,d){const at=(i.host||d.host)+':'+(i.port||d.port);
 if(i.jump)return '跳板机 '+at+'（第 '+i.hop+' 跳）';return i.via?at+'（经 '+i.via+'）':at;}

// The "path|user" a saved hop password is tied to (mirrors JumpHosts.normalize).
function hopKeys(list){let p='';return list.map(h=>{p+='>'+String(h.host).trim()+':'+(Number(h.port)||22);return p+'|'+String(h.user).trim();});}

// Mounts the editor before `before`; target() names the device for the route preview.
// Returns {check(): jumps payload or null (errors shown), path(), wipe()}.
function hopEditor(box,d,before,target=()=>d.name||d.host||''){
 hopIcons();
 const orig=d.jumps||[];const savedKeys=new Set(hopKeys(orig).filter((k,i)=>orig[i].auth!=='key'&&orig[i].remember));
 // Working copy; typed passwords stay here (memory only) until the form is saved or closed.
 const hops=orig.map(h=>({host:h.host,port:String(h.port||22),user:h.user,auth:h.auth==='key'?'key':'password',password:''}));
 const wrap=el('section','hop-box');wrap.setAttribute('aria-label','通过跳板机连接');box.insertBefore(wrap,before);
 const head=el('div','hop-head');const ttl=el('div','grow');ttl.append(el('div','hop-title','通过跳板机连接'),el('div','hop-sub','先 SSH 到跳板机，再从那里连这台电脑（和 ssh -J 一样）。可选，最多 '+HOP_MAX+' 台。'));
 const badge=el('span','hop-glyph');badge.append(icon('route'));head.append(badge,ttl);wrap.append(head);
 const list=el('div','hop-list');const route=el('div','hop-route');const add=btn('','secondary small hop-add',()=>{read();hops.push({host:'',port:'22',user:'',auth:'password',password:''});draw(hops.length-1);},'plus');
 const note=el('p','fine hop-note','跳板机的密码和设备资料一起加密保存在这台手机上。每台跳板机第一次连都要核对指纹。');
 wrap.append(list,route,add,note);
 let rows=[];
 const read=()=>rows.forEach((r,i)=>Object.assign(hops[i],{host:r.host.value.trim(),port:r.port.value.trim(),user:r.user.value.trim(),password:r.pass.value}));
 function move(i,to){read();const [h]=hops.splice(i,1);hops.splice(to,0,h);draw(to,true);}
 function card(h,i){
  const c=el('div','hop-card');const n=i+1;
  const top=el('div','hop-card-head');top.append(el('span','hop-num',String(n)),el('span','hop-card-title grow','第 '+n+' 跳'));
  const up=ib('up','跳板机 '+n+' 往前挪',()=>move(i,i-1));up.disabled=i===0;
  const dn=ib('dn','跳板机 '+n+' 往后挪',()=>move(i,i+1));dn.disabled=i===hops.length-1;
  const rm=ib('x','删除跳板机 '+n,()=>{read();hops.splice(i,1);draw(Math.min(i,hops.length-1));});
  if(hops.length>1)top.append(up,dn);top.append(rm);c.append(top);
  const grid=el('div','form-grid');c.append(grid);
  const host=obField(grid,'地址',{value:h.host,placeholder:'跳板机的域名或 IP',mode:'url',enter:'next'});
  const port=obField(grid,'端口',{value:h.port,mode:'numeric',enter:'next'});port.maxLength=5;
  const user=obField(c,'用户名',{value:h.user,placeholder:'登录跳板机用的用户名',enter:'next'});
  [[host,'地址'],[port,'端口'],[user,'用户名']].forEach(([f,t])=>f.setAttribute('aria-label','跳板机 '+n+' '+t));
  const saved=savedKeys.has(hopKeys(hops.slice(0,i+1))[i]);
  const pass=obField(c,'密码',{type:'password',value:h.password,placeholder:saved?'已保存；留空保留原密码':'跳板机的 SSH 密码',enter:'next'});pass.setAttribute('aria-label','跳板机 '+n+' 密码');
  const passLabel=pass.closest('label');
  // Same two choices as the device: 密码, or this phone's key (installed on the jump host first).
  const authRow=el('div','hop-auth');authRow.append(el('span','hop-auth-label','登录方式'));
  const g=el('div','seg');g.setAttribute('role','radiogroup');g.setAttribute('aria-label','跳板机 '+n+' 登录方式');
  const keyNote=el('p','fine hop-key-note','用这台手机的密钥登录跳板机。先把公钥装到跳板机的 ~/.ssh/authorized_keys（设备页 → 这台手机的密钥）。');
  const opts=[['password','密码'],['key','密钥']].map(([v,t])=>{const b=btn(t,'seg-opt',()=>set(v));b.setAttribute('role','radio');g.append(b);return [v,b];});
  function set(v){h.auth=v;for(const [k,b] of opts){b.classList.toggle('on',k===v);b.setAttribute('aria-checked',String(k===v));}passLabel.classList.toggle('hidden',v==='key');keyNote.classList.toggle('hidden',v!=='key');}
  authRow.append(g);c.insertBefore(authRow,passLabel);c.append(keyNote);set(h.auth);
  // Pasted "user@host:port" fills the three fields, like the device address.
  const split=()=>{const s=obSplitAddress(host.value);if(!s)return;host.value=s.host;if(s.port)port.value=s.port;if(s.user&&!user.value.trim())user.value=s.user;};
  host.addEventListener('change',split);host.addEventListener('paste',()=>setTimeout(split,0));
  [host,port,user].forEach((f,k,all)=>f.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();(all[k+1]||(h.auth==='key'?null:pass))?.focus();}}));
  host.addEventListener('input',paint);
  return {c,host,port,user,pass,h};}
 function paint(){
  read();route.replaceChildren();route.classList.toggle('hidden',!hops.length);
  if(hops.length){const parts=['手机',...hops.map((h,i)=>h.host||'跳板机 '+(i+1)),target()||'这台电脑'];
   parts.forEach((p,i)=>{if(i)route.append(el('span','hop-arrow','→'));route.append(el('span','hop-stop'+(i===0||i===parts.length-1?' end':''),p));});}
  add.replaceChildren(icon('plus'),document.createTextNode(hops.length>=HOP_MAX?'最多 '+HOP_MAX+' 台跳板机':hops.length?'再加一台跳板机':'添加跳板机'));add.disabled=hops.length>=HOP_MAX;
  note.classList.toggle('hidden',!hops.length);wrap.classList.toggle('has-hops',!!hops.length);}
 function draw(focus,keepFocus){
  rows=hops.map(card);list.replaceChildren(...rows.map(r=>r.c));paint();
  if(focus!==undefined&&focus>=0&&rows[focus]){const r=rows[focus];setTimeout(()=>{if(!r.c.isConnected)return;if(!keepFocus)r.host.focus();r.c.scrollIntoView({block:'nearest',behavior:document.documentElement.classList.contains('reduce-motion')?'auto':'smooth'});},30);}}
 draw();
 // The device's own fields change the last stop of the preview.
 box.addEventListener('input',e=>{if(hops.length&&!wrap.contains(e.target))paint();});
 return {
  path(){read();return hops.map(h=>h.host+':'+(Number(h.port)||22)).join('>');},
  check(){read();let first=null;const keys=hopKeys(hops);
   rows.forEach((r,i)=>{const h=hops[i];const e=obValidate({host:h.host,port:h.port,user:h.user});
    if(!h.host)e.host='填跳板机的地址';else if(e.host==='用户名填到下面的「SSH 用户名」里')e.host='用户名填到下面的「用户名」里';
    if(!h.user)e.user='填登录跳板机的用户名';
    const pw=h.auth==='password'&&!h.password&&!savedKeys.has(keys[i])?(orig[i]?.remember&&orig[i].auth!=='key'?'改了地址、用户名或顺序，要重新输入密码':'填跳板机的密码'):'';
    obError(r.host,e.host);obError(r.port,e.port);obError(r.user,e.user);obError(r.pass,pw);
    if(!first)first=[[e.host,r.host],[e.port,r.port],[e.user,r.user],[pw,r.pass]].find(([m])=>m)?.[1]||null;});
   if(first){first.focus();first.scrollIntoView({block:'center'});return null;}
   return hops.map(h=>({host:h.host,port:Number(h.port),user:h.user,auth:h.auth,password:h.auth==='key'?'':h.password}));},
  wipe(){hops.forEach(h=>h.password='');rows.forEach(r=>r.pass.value='');}};}
