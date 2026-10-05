const {chromium}=require('playwright-core');
(async()=>{const b=await chromium.launch({executablePath:'/usr/bin/google-chrome'});
const p=await b.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1.5});
await p.goto('file:///workspace/ensemble-animations/index.html');await p.waitForTimeout(2600);
await p.screenshot({path:'../media/screenshot-overview.png'});
const el=await p.$('#s-agent');await el.scrollIntoViewIfNeeded();await p.waitForTimeout(5200);await el.screenshot({path:'../media/screenshot-agent-streaming.png'});
const n=await p.$('#s-needs');await n.scrollIntoViewIfNeeded();await p.waitForTimeout(1200);
await b.close();})();
