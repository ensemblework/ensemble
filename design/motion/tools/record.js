const {chromium}=require('playwright-core');const fs=require('fs');
(async()=>{const b=await chromium.launch({executablePath:'/usr/bin/google-chrome'});
const ctx=await b.newContext({viewport:{width:1280,height:800},recordVideo:{dir:'/tmp/uvid',size:{width:1280,height:800}}});
const p=await ctx.newPage();const errs=[];p.on('console',m=>{if(m.type()==='error')errs.push(m.text())});p.on('pageerror',e=>errs.push(String(e)));
await p.goto('file:///workspace/ensemble-animations/index.html?tour&dwell=2500');
await p.waitForFunction(()=>window.__tourDone===true,null,{timeout:90000});
await p.waitForTimeout(400);
const v=p.video();await ctx.close();const path=await v.path();fs.copyFileSync(path,'/workspace/ensemble-animations/media/ensemble-animations-tour.webm');
console.log('errors:',JSON.stringify(errs));await b.close();})();
