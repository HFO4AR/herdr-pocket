'use strict';
// Show-then-refresh cache for the session list, the history catalog and recent chats.
// Kept in memory and persisted per device by the native layer (LocalCache.kt, encrypted).
// Cached content is display only: nothing is sent from it, and demo mode never writes.
const CACHE={mem:new Map(),timers:new Map()};
const CACHE_CHAT_MESSAGES=80,CACHE_CHAT_CHARS=500000;
function cacheDevice(){return S.demo?'':(S.device?.id||S.connecting?.id||'');}
async function cacheGet(key,dev=cacheDevice()){
 if(!dev||S.demo)return null;const mk=dev+'\n'+key;if(CACHE.mem.has(mk))return CACHE.mem.get(mk);
 try{const r=await rpc('cacheGet',{key,device:dev});if(CACHE.mem.has(mk))return CACHE.mem.get(mk);if(r?.value)CACHE.mem.set(mk,r.value);return r?.value||null;}catch(_){return null;}}
// Writes are debounced: a chat that polls every few seconds is stored once it settles.
function cachePut(key,value,dev=cacheDevice()){
 if(!dev||S.demo||!value)return;const mk=dev+'\n'+key;CACHE.mem.set(mk,value);clearTimeout(CACHE.timers.get(mk));
 CACHE.timers.set(mk,setTimeout(()=>{CACHE.timers.delete(mk);rpc('cachePut',{key,value,device:dev}).catch(()=>{});},1200));}
// Settings → 清除缓存 wipes the native store, then calls this to drop memory and pending writes.
function cacheForget(){CACHE.timers.forEach(t=>clearTimeout(t));CACHE.timers.clear();CACHE.mem.clear();S.fromCache=false;if(S.chat)S.chat.cacheSig='';}
function cacheAge(at){if(!at)return '';const a=ago(Date.now()-at);return a==='刚刚'?a:a+'前';}

// ─── Session list ───────────────────────────────────────────────────────────
function cacheLive(){S.fromCache=false;if(!S.session)return;cachePut('live',{session:S.session,sessions:S.sessions,agents:S.agents,at:Date.now()});}
async function cacheShowLive(dev=cacheDevice()){
 const v=await cacheGet('live',dev);if(!v||!v.agents?.length||S.agents.length||cacheDevice()!==dev)return false;
 if(S.device&&!S.liveLoading)return false;
 S.session=v.session;S.sessions=v.sessions||[v.session];S.agents=v.agents;S.fromCache=v.at||Date.now();
 if(S.tab==='live'&&!S.chat)render();return true;}
// Picked a device: show what it had last time while SSH connects.
async function cacheConnecting(d){
 if(S.demo||S.agents.length)return;const [live,cat]=await Promise.all([cacheGet('live',d.id),cacheGet('catalog',d.id)]);
 if(!S.loading||S.connecting?.id!==d.id)return;
 if(cat?.records&&!S.records.length){S.catalogCached=true;S.records=cat.records;S.total=cat.total||cat.records.length;S.next=cat.next??null;}
 if(live?.agents?.length&&!S.agents.length){S.session=live.session;S.sessions=live.sessions||[live.session];S.agents=live.agents;S.fromCache=live.at||Date.now();if(S.tab==='devices')S.tab='live';}
 if(!S.chat)render();}
// Lists from the cache may be shown before SSH is up (live and history only).
function cacheBrowsing(){return !S.device&&S.loading&&(!!S.fromCache&&S.tab==='live'&&S.agents.length>0||S.tab==='history'&&!!S.catalogCached&&S.records.length>0);}
function cacheLiveNote(main){if(!S.fromCache)return;main.append(el('p','fine cache-note',(S.device?'上次读取':'正在连接 · 显示上次读取的列表')+' · '+cacheAge(S.fromCache)));}
// Connecting failed: drop what was only shown from the cache.
function cacheAbandon(){if(S.catalogCached){S.records=[];S.catalogCached=false;}if(!S.fromCache)return;S.agents=[];S.sessions=[];S.fromCache=false;if(S.chat&&(S.chat.waiting||!S.chat.record)){S.chat=null;S.chatStack=[];}}
// Connected while a cached chat was open: keep the reader there and refresh it.
function cacheResume(){
 if(!S.chat)return false;S.tab='live';loadLive();
 if(S.chat.record){S.paused=false;fetchHistory(false,true);}renderComposer();return true;}

// ─── History catalog ────────────────────────────────────────────────────────
function cacheCatalog(){S.catalogCached=false;const hidden=new Set(closeHiddenIds());cachePut('catalog',{records:S.records.filter(r=>!hidden.has(r.id)).slice(0,200),total:S.total,next:S.next??null,at:Date.now()});}
async function cacheShowCatalog(){
 const v=await cacheGet('catalog');if(!v?.records?.length||S.records.length||!S.catalogLoading)return;
 S.records=v.records;S.total=v.total||v.records.length;S.next=v.next??null;if(S.tab==='history'&&!S.chat)renderHistoryList();}

// ─── Chats ──────────────────────────────────────────────────────────────────
function cacheChatKey(record){const r=record.remote;return 'chat:'+record.id+':'+(r?typeof r==='string'?r:JSON.stringify(r):'');}
// Before the first read of a chat: paint the cached copy. Returns true when the read must wait
// for the connection (the chat then refreshes once SSH is up).
async function cacheFill(record,epoch){
 if(S.demo)return false;
 const v=S.messages.length?null:await cacheGet(cacheChatKey(record));
 if(epoch!==S.epoch||S.chat?.record!==record)return !S.device;
 if(v?.messages?.length){S.messages=v.messages;S.children=v.children||[];S.more=false;S.chat.cached=v.at||Date.now();S.stick=true;}
 if(!S.device){S.chat.waiting=true;S.more=false;return true;}
 return false;}
function cacheChat(){
 const c=S.chat;if(!c?.record||!S.messages.length||S.demo)return;
 const sig=S.messages.length+':'+(S.messages.at(-1)?.id||'')+':'+(S.messages.at(-1)?.text?.length||0)+':'+S.children.length;if(c.cacheSig===sig)return;c.cacheSig=sig;
 let messages=S.messages.slice(-CACHE_CHAT_MESSAGES);
 while(messages.length>1&&JSON.stringify(messages).length>CACHE_CHAT_CHARS)messages=messages.slice(Math.ceil(messages.length/4));
 cachePut(cacheChatKey(c.record),{messages,children:S.children,at:Date.now()});}
function cacheChatNote(list){
 const c=S.chat;if(!c?.cached)return;
 list.append(el('div','fine center cache-note',c.waiting?'正在连接 · 上次读取 '+cacheAge(c.cached)+' · 连接好后自动刷新':c.historyLoading?'上次读取 '+cacheAge(c.cached)+' · 正在更新…':'显示的是上次读取的内容（'+cacheAge(c.cached)+'）'));}
// Not connected yet: the cached chat is read-only, nothing can be sent.
function cacheOffline(footer){if(S.device||S.demo)return false;footer.replaceChildren(el('div','readonly','正在连接 · 显示的是上次的缓存，连上后才能发送'));return true;}
