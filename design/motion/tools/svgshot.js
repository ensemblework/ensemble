const {chromium}=require('playwright-core');
(async()=>{const [,,file,out,ms]=process.argv;const b=await chromium.launch({executablePath:'/usr/bin/google-chrome'});
const p=await b.newPage({viewport:{width:400,height:240}});
await p.setContent(`<body style="margin:0;background:#221e1a">${require('fs').readFileSync(file)}</body>`);
await p.waitForTimeout(+ms||1000);await p.screenshot({path:out});await b.close();})();
