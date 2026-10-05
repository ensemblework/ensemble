const {chromium}=require('playwright-core');
(async()=>{const b=await chromium.launch({executablePath:'/usr/bin/google-chrome'});
const p=await b.newPage({viewport:{width:120,height:120}});p.on('pageerror',e=>console.log('ERR',e));p.on('console',m=>console.log('LOG',m.text()));
await p.setContent(`<html data-theme="dark"><head><style>${require('fs').readFileSync('../components/tokens.css')}${require('fs').readFileSync('../components/glyph/ensemble-glyph.css')} body{margin:0;background:#221e1a;display:grid;place-items:center;height:120px}</style></head><body><span id=g></span>
<script>${require('fs').readFileSync('../components/glyph/keyframes.js')}</script><script>${require('fs').readFileSync('../components/glyph/ensemble-glyph.js')}</script><script>EnsembleGlyph.mount(document.getElementById('g'),{size:96,state:'working'})</script></body></html>`);
for(let i=0;i<32;i++){await p.screenshot({path:`/tmp/s${String(i).padStart(2,'0')}.png`});await p.waitForTimeout(250);}
await b.close();})();
