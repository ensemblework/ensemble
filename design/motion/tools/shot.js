const {chromium}=require('playwright-core');
(async()=>{const [,,url,out,w,h,wait]=process.argv;const b=await chromium.launch({executablePath:'/usr/bin/google-chrome'});
const p=await b.newPage({viewport:{width:+w||1000,height:+h||400}});const errs=[];p.on('console',m=>{if(m.type()==='error')errs.push(m.text())});p.on('pageerror',e=>errs.push(String(e)));
await p.goto(url);await p.waitForTimeout(+wait||300);await p.screenshot({path:out,fullPage:true});console.log('errors:',JSON.stringify(errs));await b.close();})();
