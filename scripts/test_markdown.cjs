// Unit tests for the transcript markdown renderer (app/src/main/assets/ui/markdown.js).
// Dependency-free: runs markdown.js against a tiny fake DOM and checks a compact serialization.
// Run: node scripts/test_markdown.cjs
'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');

class Node{constructor(name){this.nodeName=name;this.childNodes=[];this.parentNode=null;}
 get firstChild(){return this.childNodes[0]||null;}
 get lastChild(){return this.childNodes.at(-1)||null;}
 get nextSibling(){const p=this.parentNode;if(!p)return null;return p.childNodes[p.childNodes.indexOf(this)+1]||null;}
 get textContent(){return this.childNodes.map(c=>c.textContent).join('');}
 set textContent(v){this.childNodes=[];if(v!=='')this.append(new Text(String(v)));}
 _adopt(n){if(typeof n==='string')n=new Text(n);if(n.parentNode)n.parentNode.childNodes.splice(n.parentNode.childNodes.indexOf(n),1);n.parentNode=this;return n;}
 append(...ns){for(const n of ns)this.childNodes.push(this._adopt(n));}
 prepend(...ns){this.childNodes.unshift(...ns.map(n=>this._adopt(n)));}
 appendChild(n){this.append(n);return n;}
 replaceChildren(...ns){this.childNodes=[];this.append(...ns);}
 get isConnected(){return false;}}
class Text extends Node{constructor(t){super('#text');this.data=t;}get textContent(){return this.data;}}
class Element extends Node{constructor(tag){super(tag.toUpperCase());this.tag=tag;this.attrs={};this.style={};this.className='';}
 get classList(){const self=this;const list=()=>self.className.split(/\s+/).filter(Boolean);
  return{add(...c){self.className=[...new Set([...list(),...c])].join(' ');},remove(...c){self.className=list().filter(x=>!c.includes(x)).join(' ');},
   contains(c){return list().includes(c);},toggle(c,force){const on=force===undefined?!list().includes(c):force;on?this.add(c):this.remove(c);return on;}};}
 setAttribute(k,v){this.attrs[k]=String(v);}
 addEventListener(){}
 get childElementCount(){return this.childNodes.filter(c=>c instanceof Element).length;}}

const document={createElement:t=>new Element(t),createTextNode:t=>new Text(t),createElementNS:(_,t)=>new Element(t),documentElement:new Element('html')};
const copied=[];
const ctx={document,copied,console,URL,getSelection:()=>'',requestAnimationFrame:()=>0,
 el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;},
 icon(name){const n=new Element('svg');n.className='icon-'+name;return n;},
 copyText(t){copied.push(t);}};
ctx.btn=function(text,cls,fn){const n=ctx.el('button',cls);if(text)n.append(document.createTextNode(text));n.onclick=fn;return n;};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../app/src/main/assets/ui/markdown.js'),'utf8'),ctx);

// <tag.class>children</tag>; text is shown verbatim.
function ser(n){if(n instanceof Text)return n.data;const c=n.className?'.'+n.className.split(' ').join('.'):'';const inner=n.childNodes.map(ser).join('');
 return n.tag==='br'||n.tag==='hr'?'<'+n.tag+'>':'<'+n.tag+c+'>'+inner+'</'+n.tag+'>';}
const md=(t,o)=>ser(ctx.markdown(t,o||{fold:false}));
const find=(n,pred,out=[])=>{if(n instanceof Element){if(pred(n))out.push(n);n.childNodes.forEach(c=>find(c,pred,out));}return out;};
const tests=[];const test=(name,fn)=>tests.push([name,fn]);

test('CJK punctuation next to bold markers',()=>{
 assert.equal(md('**可以，**而且能用'),'<div.md><p.md-lead><strong>可以，</strong>而且能用</p></div>');
 assert.equal(md('结论：**不行。**原因如下'),'<div.md><p>结论：<strong>不行。</strong>原因如下</p></div>');});
test('leading bold sentence becomes the takeaway',()=>{
 const out=md('**可以，能做成。** 我查了一下。\n\n第二段');
 assert.match(out,/^<div\.md><p\.md-lead><strong\.md-takeaway>可以，能做成。<\/strong> 我查了一下。<\/p><p>第二段<\/p>/);
 assert.doesNotMatch(md('前言\n\n**加粗**后'),/md-lead/);});
test('machine citation blocks are removed, but not inside code',()=>{
 const t='正文\n\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[x]\n</citation_entries>\n</oai-mem-citation>\n';
 assert.equal(md(t),'<div.md><p>正文</p></div>');
 assert.match(md('```\n<oai-mem-citation>x</oai-mem-citation>\n```'),/&?<oai-mem-citation>x<\/oai-mem-citation>|oai-mem-citation/);});
test('hr vs table separator vs paragraph',()=>{
 assert.equal(md('a\n\n---\n\nb'),'<div.md><p>a</p><hr><p>b</p></div>');
 const t=md('| a | b |\n|---|---:|\n| 1 | 2 |');
 assert.match(t,/<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table>/);
 assert.match(md('a | b\n--- | ---\nc | d'),/<th>a<\/th>/);});
test('table cells keep escaped pipes and pipes inside code',()=>{
 const t=md('| k | v |\n|---|---|\n| `a|b` | x \\| y |');
 assert.match(t,/<td><code>a\|b<\/code><\/td><td>x \| y<\/td>/);});
test('wide tables also render as cards with a badge column',()=>{
 const t=md('| 优先级 | 项 | 为什么 |\n|---|---|---|\n| ★★★ | **XY/ZX 垂直度校正（`skew_correction`）** | 我们完全没有这个能力，双面套刻直接受害，而代价只有三行坐标变换 |');
 assert.match(t,/<div\.table-box\.wide>/);
 assert.match(t,/<div\.md-card><div\.md-card-title><span\.md-card-badge>★★★<\/span><strong>XY\/ZX 垂直度校正（<code>skew_correction<\/code>）<\/strong><\/div><dl><dt>为什么<\/dt><dd>我们完全/);
 assert.doesNotMatch(md('| a | b |\n|---|---|\n| 1 | 2 |'),/md-cards/);
 const two=md('| 工具 | 用途 |\n|---|---|\n| `scripts/parsedump.py` | 把批处理输出的二进制 MCU 指令流解成可读文本，这是唯一能看步进时序的手段 |');
 assert.match(two,/<div\.md-card><div\.md-card-title><code\.md-file>scripts\/parsedump\.py<\/code><\/div><div\.md-card-body>把批处理/);});
test('nested lists, continuation and numbering across paragraphs',()=>{
 const t=md('1. 第一步\n   - 子项 a\n   - 子项 b\n2. 第二步\n\n中间说明\n\n3. 第三步');
 assert.equal(t,'<div.md><ol><li>第一步<ul><li>子项 a</li><li>子项 b</li></ul></li><li>第二步</li></ol><p>中间说明</p><ol><li>第三步</li></ol></div>');
 const c=ctx.markdown('3. 第三步',{fold:false});assert.equal(find(c,n=>n.tag==='ol')[0].start,3);
 assert.equal(md('- a\n  续行\n- b'),'<div.md><ul><li>a<br>续行</li><li>b</li></ul></div>');
 assert.equal(md('- a\nlazy\n- b'),'<div.md><ul><li>a<br>lazy</li><li>b</li></ul></div>');});
test('loose lists keep every item and mark spacing',()=>{
 assert.equal(md('- a\n\n- b'),'<div.md><ul.loose><li>a</li><li>b</li></ul></div>');});
test('headings inside list items and heading levels',()=>{
 assert.equal(md('- ## 标题\n  正文'),'<div.md><ul><li><h4.md-h.md-h2>标题</h4><p>正文</p></li></ul></div>');
 assert.equal(md('# 一、结论'),'<div.md><h3.md-h.md-h1>一、结论</h3></div>');
 assert.equal(md('#hashtag'),'<div.md><p>#hashtag</p></div>');});
test('task list items',()=>{
 assert.equal(md('- [x] 完成\n- [ ] 待办'),'<div.md><ul><li.task><span.box.done>✓</span>完成</li><li.task><span.box></span>待办</li></ul></div>');});
test('escapes and stray asterisks',()=>{
 assert.equal(md('\\*不是斜体\\* 和 \\`x\\`'),'<div.md><p>*不是斜体* 和 `x`</p></div>');
 assert.equal(md('2*3*4 与 a * b'),'<div.md><p>2*3*4 与 a * b</p></div>');
 assert.equal(md('匹配 file_*.py 和 *.js'),'<div.md><p>匹配 file_*.py 和 *.js</p></div>');
 assert.equal(md('*斜体* 和 ***都有***'),'<div.md><p><em>斜体</em> 和 <strong><em>都有</em></strong></p></div>');
 assert.equal(md('~~旧~~'),'<div.md><p><del>旧</del></p></div>');});
test('code spans, including double backticks',()=>{
 assert.equal(md('运行 `npm test` 或 ``a`b``'),'<div.md><p>运行 <code>npm test</code> 或 <code>a`b</code></p></div>');});
test('URLs stop at CJK text and trailing punctuation; tap copies',()=>{
 const root=ctx.markdown('见 https://github.com/larksuite/oapi-sdk-python。还有(https://a.b/c_(d))，完',{fold:false});
 const links=find(root,n=>n.className==='md-link');
 assert.deepEqual(links.map(l=>l.title),['https://github.com/larksuite/oapi-sdk-python','https://a.b/c_(d)']);
 links[0].onclick({stopPropagation(){}});assert.equal(copied.at(-1),'https://github.com/larksuite/oapi-sdk-python');
 assert.match(ser(root),/<\/span>。还有\(<span/);});
test('markdown links: web vs local file references',()=>{
 const root=ctx.markdown('[SDK](https://example.com/x) 和 [app.js](/home/u/p/app.js#L12) 和 [x](javascript:alert(1))',{fold:false});
 const s=ser(root);
 assert.match(s,/<span\.md-link>SDK<\/span>/);assert.match(s,/<span\.md-file>app\.js<\/span>/);
 assert.equal(find(root,n=>n.className==='md-file')[0].title,'/home/u/p/app.js:12');
 assert.doesNotMatch(s,/javascript/);assert.match(s,/ 和 x\)<\/p>/);});
test('file:line references in text and inline code',()=>{
 const s=md('看 stm32f4xx_hal_conf.h:58 和 `Dal/BoardPins.hpp` 以及 klippy/extras/skew_correction.py，版本 v0.5.0 不算');
 assert.match(s,/<span\.md-file>stm32f4xx_hal_conf\.h:58<\/span>/);
 assert.match(s,/<code\.md-file>Dal\/BoardPins\.hpp<\/code>/);
 assert.match(s,/<span\.md-file>klippy\/extras\/skew_correction\.py<\/span>，/);
 assert.doesNotMatch(s,/md-file>v0/);
 assert.doesNotMatch(md('TCP/IP 和 e.g. 以及 14:28'),/md-file/);});
test('fenced code: language, line count, diff colouring, unclosed fence, indented fence in list',()=>{
 assert.match(md('```python\nx = 1\n```'),/<span\.code-lang>python<\/span>.*<pre><code>x = 1<\/code><\/pre>/);
 assert.match(md('```diff\n@@ -1 +1 @@\n-a\n+b\n```'),/<span\.d-hunk>@@ -1 \+1 @@<\/span>\n<span\.d-del>-a<\/span>\n<span\.d-add>\+b<\/span>/);
 assert.match(md('```\nnever closed'),/<code>never closed<\/code>/);
 assert.match(md('1. 运行：\n   ```bash\n   make\n   ```\n2. 完成'),/<li>运行：<div\.code-block>.*<code>make<\/code>.*<\/li><li>完成<\/li>/);
 const long=md('```\n'+Array.from({length:30},(_,k)=>'line '+k).join('\n')+'\n```');
 assert.match(long,/<div\.code-block\.clipped>[\s\S]*<button\.code-more>展开 30 行<\/button>/);});
test('blank lines collapse and <br> in cells',()=>{
 assert.equal(md('a\n\n\n\n\nb'),'<div.md><p>a</p><p>b</p></div>');
 assert.match(md('| a | b |\n|---|---|\n| x<br>y | z |'),/<td>x<br>y<\/td>/);});
test('blockquotes nest markdown',()=>{
 assert.equal(md('> **注意**\n> - 一\n> - 二'),'<div.md><blockquote><p><strong>注意</strong></p><ul><li>一</li><li>二</li></ul></blockquote></div>');});
test('long messages fold, short ones do not',()=>{
 assert.equal(ctx.markdown('短消息').className,'md');
 const long=ctx.markdown(Array.from({length:40},(_,k)=>'第 '+k+' 段内容。').join('\n\n'));
 assert.ok(long.classList.contains('md-fold'));assert.equal(long.firstChild.className,'md');
 const btn=long.lastChild;assert.match(btn.textContent,/^展开全文 · 约 \d+ 字$/);
 btn.onclick();assert.ok(long.classList.contains('open'));assert.equal(btn.textContent,'收起');
 // expanded state survives a re-render of the same text
 assert.ok(ctx.markdown(Array.from({length:40},(_,k)=>'第 '+k+' 段内容。').join('\n\n')).classList.contains('open'));});
test('never produces script-capable markup from text',()=>{
 const s=md('<img src=x onerror=alert(1)> <script>alert(1)</script>');
 assert.equal(s,'<div.md><p><img src=x onerror=alert(1)> <script>alert(1)</script></p></div>');});

let failed=0;for(const[name,fn]of tests){try{fn();console.log('ok   '+name);}catch(e){failed++;console.log('FAIL '+name+'\n     '+e.message.split('\n').join('\n     '));}}
if(failed){console.log(failed+' failed');process.exit(1);}console.log('PASS: markdown '+tests.length+' tests');
