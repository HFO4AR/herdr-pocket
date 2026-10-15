// Builds the same single-page HTML as MainActivity (keep the file lists in sync).
const fs=require('node:fs'),path=require('node:path');
const CSS=['vendor/xterm.css','app.css','chat.css','timeline.css','markdown.css','follow.css','answer.css','images.css','files.css','queue.css','create.css','slash.css','close.css','settings.css','keys.css','onboard.css','native.css','lists.css'];
const JS=['markdown.js','timeline.js','images.js','files.js','answer.js','demo.js','follow.js','queue.js','create.js','slash.js','close.js','cache.js','settings.js','keys.js','onboard.js','native.js','glance.js','app.js'];
module.exports=function bundle(root){
 const ui=path.join(root,'app/src/main/assets/ui'),read=f=>fs.readFileSync(path.join(ui,f),'utf8');
 return read('index.html')
  .replace('/*BUNDLED_CSS*/',()=>CSS.map(read).join('\n'))
  .replace('/*TERMINAL_VENDOR*/',()=>read('vendor/xterm.js')+'\n'+read('vendor/addon-fit.js'))
  .replace('/*TERMINAL_APP*/',()=>read('terminals.js'))
  .replace('/*BUNDLED_JS*/',()=>JS.map(read).join('\n'));
};
