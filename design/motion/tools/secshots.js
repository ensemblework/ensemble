const {chromium}=require('playwright-core');
(async()=>{const b=await chromium.launch({executablePath:'/usr/bin/google-chrome'});
const p=await b.newPage({viewport:{width:1280,height:900}});const errs=[];p.on('console',m=>{if(m.type()==='error'||m.type()==='warning')errs.push(m.type()+': '+m.text())});p.on('pageerror',e=>errs.push(String(e)));
await p.goto('file:///workspace/ensemble-animations/index.html'+(process.argv[2]||''));await p.waitForTimeout(+process.argv[3]||3000);
const ids=await p.$$eval('.sec',s=>s.map(x=>x.id));
for(const id of ids){const el=await p.$('#'+id);await el.scrollIntoViewIfNeeded();await p.waitForTimeout(150);await el.screenshot({path:`/tmp/sec-${id}.png`});}
await p.screenshot({path:'/tmp/top.png'});
console.log('errors:',JSON.stringify(errs));await b.close();})();
