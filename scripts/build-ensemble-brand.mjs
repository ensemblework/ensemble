/** Generate all shipped Ensemble identity assets from packages/brand. */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const require = createRequire(resolve(root, 'packages/brand/package.json'));
const manifestPath = 'packages/brand/assets/generated.json';
const inputs = ['scripts/build-ensemble-brand.mjs', 'packages/brand/artwork.json', 'packages/brand/assets/woven-satin.svg', 'packages/brand/assets/woven-micro.svg', 'packages/brand/index.js', 'packages/brand/motion.js', 'packages/brand/geometry.js', 'packages/brand/motion-data.json', 'packages/brand/motion.css', 'apps/hub-web/components/brand/brand-pages.css'];
// Simplify only the sampled polylines, within .025 master pixels (under .01px
// at ordinary logo sizes). The approved master assets remain unmodified.
function simplify(points) {
  if (points.length < 3) return points;
  const a = points[0], b = points.at(-1), dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
  let furthest = 0, split = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i], t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
    const distance = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
    if (distance > furthest) { furthest = distance; split = i; }
  }
  return furthest > .025 ? [...simplify(points.slice(0, split + 1)).slice(0, -1), ...simplify(points.slice(split))] : [a, b];
}
function body(svg) {
  return svg.replace(/^<svg[^>]*>/, '').replace(/<title>.*?<\/title>/, '').replace(/<\/svg>\s*$/, '').replace(/d="([ML\d.\s,-]+)"/g, (whole, d) => {
    const numbers = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
    if (!numbers || numbers.length < 6) return whole;
    const points = []; for (let i = 0; i < numbers.length; i += 2) points.push([numbers[i], numbers[i + 1]]);
    return `d="M${simplify(points).map(point => point.join(' ')).join('L')}"`;
  });
}
if (!process.argv.includes('--check')) {
  const art = { body: body(await readFile(resolve(root, 'packages/brand/assets/woven-satin.svg'), 'utf8')), micro: body(await readFile(resolve(root, 'packages/brand/assets/woven-micro.svg'), 'utf8')) };
  await writeFile(resolve(root, 'packages/brand/artwork.json'), JSON.stringify(art) + '\n');
}
const { staticSVG, svgBody } = require('./index.js');
const hash = value => createHash('sha256').update(value).digest('hex');
const sources = Object.fromEntries(await Promise.all(inputs.map(async path => [path, hash(await readFile(resolve(root, path)))])));
if (process.argv.includes('--check')) {
  const manifest = JSON.parse(await readFile(resolve(root, manifestPath), 'utf8'));
  const failures = Object.keys(sources).filter(path => sources[path] !== manifest.sources[path]);
  for (const [path, digest] of Object.entries(manifest.outputs)) {
    try { if (hash(await readFile(resolve(root, path))) !== digest) failures.push(path); } catch { failures.push(path); }
  }
  if (failures.length) throw new Error(`Brand assets are stale or missing. Run pnpm brand:build.\n${failures.join('\n')}`);
  console.log(`Brand sources and ${Object.keys(manifest.outputs).length} generated assets verified.`);
  process.exit(0);
}
const sharp = require('sharp');
const esbuild = require('esbuild');
const outputs = {};
async function save(path, value) {
  await mkdir(dirname(resolve(root, path)), { recursive: true });
  await writeFile(resolve(root, path), value); outputs[path] = hash(value);
}
function tile(macos = false, opaque = false) {
  const rect = macos ? '<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#tile)"/><rect x="102" y="102" width="820" height="820" rx="183" fill="none" stroke="#F2F0E9" stroke-opacity=".11" stroke-width="2"/>' : `<rect width="1024" height="1024" rx="${opaque ? 0 : 216}" fill="url(#tile)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs><linearGradient id="tile" x2="1" y2="1"><stop stop-color="#213E42"/><stop offset="1" stop-color="#10282B"/></linearGradient></defs>${rect}<svg x="164" y="156" width="704" height="704" viewBox="0 0 320 320">${svgBody({id:'app'})}</svg></svg>`;
}
const png = (svg, size, opaque = false) => { let img = sharp(Buffer.from(svg)).resize(size, size); if (opaque) img = img.flatten({background:'#10282B'}).removeAlpha(); return img.png().toBuffer(); };
function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({size, data}, i) => { const at = 6 + i * 16; header[at] = header[at + 1] = size === 256 ? 0 : size; header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6); header.writeUInt32LE(data.length, at + 8); header.writeUInt32LE(offset, at + 12); offset += data.length; });
  return Buffer.concat([header, ...images.map(image => image.data)]);
}
function icns(images) {
  const chunks = images.map(({type, data}) => { const header = Buffer.alloc(8); header.write(type, 0, 'ascii'); header.writeUInt32BE(data.length + 8, 4); return Buffer.concat([header, data]); });
  const header = Buffer.alloc(8); header.write('icns'); header.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4); return Buffer.concat([header, ...chunks]);
}
const nativeIco = ico(await Promise.all([16,24,32,48,64,128,256].map(async size => ({size, data:await png(tile(), size)}))));
const nativeIcns = icns(await Promise.all([['icp4',16],['icp5',32],['ic07',128],['ic08',256],['ic09',512],['ic10',1024],['ic11',32],['ic12',64],['ic13',256],['ic14',512]].map(async ([type,size]) => ({type,data:await png(tile(true),size)}))));
const favicon = ico(await Promise.all([16,32,48,256].map(async size => ({size, data:await png(staticSVG(size),size)}))));
const webIcon = staticSVG(64,{label:'Ensemble'});
const appleIcon = await png(tile(false,true),180,true);
const favicon32 = await png(staticSVG(32),32);
const iconPaths = {
  ico: `/brand/favicon-${hash(favicon).slice(0,12)}.ico`,
  png: `/brand/favicon-${hash(favicon32).slice(0,12)}.png`,
  svg: `/brand/mark-${hash(webIcon).slice(0,12)}.svg`,
  apple: `/brand/apple-${hash(appleIcon).slice(0,12)}.png`,
};
const icons = {
  icon: [
    {url:iconPaths.png,sizes:'32x32',type:'image/png'},
    {url:iconPaths.ico,sizes:'16x16 32x32 48x48 256x256',type:'image/x-icon'},
    {url:iconPaths.svg,sizes:'any',type:'image/svg+xml'},
  ],
  shortcut: iconPaths.ico,
  apple: [{url:iconPaths.apple,sizes:'180x180',type:'image/png'}],
};
await save('packages/brand/icons.js', `// Generated by pnpm brand:build. Content hashes change the browser icon URL.\nmodule.exports = ${JSON.stringify({icons},null,2)};\n`);
for (const app of ['hub-web','landing']) {
  await save(`apps/${app}/app/icon.svg`,webIcon);
  await save(`apps/${app}/app/apple-icon.png`,appleIcon);
  // Keep the conventional URL as a fallback, without Next emitting it into metadata.
  await rm(resolve(root,`apps/${app}/app/favicon.ico`),{force:true});
  await save(`apps/${app}/public/favicon.ico`,favicon);
  for (const [key,bytes] of [['ico',favicon],['png',favicon32],['svg',webIcon],['apple',appleIcon]]) await save(`apps/${app}/public${iconPaths[key]}`,bytes);
}
for (const app of ['desktop','quick-capture']) {
  const dir = `apps/${app}/src-tauri/icons`;
  for (const [name,size] of [['32x32',32],['128x128',128],['128x128@2x',256],['icon',512]]) await save(`${dir}/${name}.png`,await png(tile(),size));
  await save(`${dir}/icon.ico`,nativeIco); await save(`${dir}/icon.icns`,nativeIcns);
  await save(`${dir}/SOURCE.txt`,'Generated by pnpm brand:build from packages/brand: Woven Chorus / Satin Gold / Deep Petrol.\n');
}
await save('apps/desktop/src-tauri/icons/source/woven-chorus-macos.svg',tile(true));
await save('apps/desktop/src-tauri/icons/source/woven-chorus.svg',tile());
for (const size of [16,20,24,32,48,64,128,256,512,1024]) {
  for (const [name,mac] of [['macos',true],['fullbleed',false]]) await save(`design/icons/app-icon/png/recommended/ensemble-${name}-${size}.png`,await png(tile(mac),size));
}
await save('design/icons/app-icon/png/recommended/ensemble.ico',nativeIco);
await save('design/icons/app-icon/png/recommended/ensemble.icns',nativeIcns);
await save('design/icons/ui-icons/svg/ensemble.svg',staticSVG(24,{tone:'mono'}));
for (const size of [192,512]) {
  await save(`apps/hub-web/public/icon-${size}.png`,await png(tile(),size));
  await save(`apps/hub-web/public/icon-maskable-${size}.png`,await png(tile(false,true),size,true));
}
for (const size of [128,512]) await save(`apps/hub-web/public/brand-icon-${size}.png`,await png(staticSVG(size),size));
await save('apps/hub-web/public/apple-touch-icon.png',await png(tile(false,true),180,true));
const social = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#10282B"/><path d="M0 490Q300 360 600 490T1200 490" stroke="#D7B56F" opacity=".15" fill="none" stroke-width="2"/><svg x="825" y="130" width="300" height="300" viewBox="0 0 320 320">${svgBody({id:'social'})}</svg><g font-family="sans-serif"><text x="80" y="120" font-size="32" fill="#F2F0E9">Ensemble</text><text x="80" y="275" font-size="60" fill="#F2F0E9">Humans and agents.</text><text x="80" y="355" font-size="60" fill="#D7B56F">Stronger together.</text><text x="80" y="560" font-size="22" fill="#AEC3BF">ensemblework.com</text></g></svg>`;
const socialPng = await sharp(Buffer.from(social)).png().toBuffer();
for (const name of ['og-image','twitter-image']) await save(`apps/hub-web/public/${name}.png`,socialPng);
const trayDir = 'apps/quick-capture/src-tauri/icons';
for (const [name,tone] of [['tray-template','ink'],['tray-accent','gold'],['tray-accent-light','ink']]) {
  const physical = name === 'tray-template' ? 32 : 44;
  const svg = staticSVG(physical,{tone,micro:true});
  const rgba = await sharp(Buffer.from(svg)).resize(physical,physical).ensureAlpha().raw().toBuffer();
  await save(`${trayDir}/${name}.rgba`,rgba);
  const base = name === 'tray-template' ? 'trayTemplate' : `${name}-22`;
  for (const [suffix,size] of [['',physical / 2],['@2x',physical]]) await save(`${trayDir}/tray/${base}${suffix}.png`,await png(svg,size));
  if (name !== 'tray-template') await save(`${trayDir}/tray/${name}.ico`,ico(await Promise.all([16,32,48,256].map(async size=>({size,data:await png(svg,size)})))));
}
await save(`${trayDir}/tray-symbolic.svg`,staticSVG(22,{tone:'mono',micro:true}));
await save('apps/quick-capture/ui/ensemble-lockup-16-dark.svg',`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 112 24" width="112" height="24"><svg width="24" height="24" viewBox="0 0 320 320">${svgBody({id:'capture',micro:true})}</svg><text x="31" y="17" fill="#F2F0E9" font-family="system-ui,sans-serif" font-size="14">Ensemble</text></svg>`);
const bundle = await esbuild.build({entryPoints:[resolve(root,'packages/brand/motion.js')],bundle:true,write:false,format:'iife',globalName:'EnsembleMorph',platform:'browser',target:'es2020',minify:true});
for (const [name,tone] of [['ensemble-mark','gold'],['ensemble-icon','gold'],['ensemble-icon-light','ink'],['ensemble-loader','gold']]) await save(`design/brand/${name}.svg`,staticSVG(320,{tone,label:'Ensemble Woven Chorus'}));
const galleryCSS = await readFile(resolve(root,'packages/brand/motion.css'),'utf8');
await save('design/brand/index.html',`<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ensemble · Woven Chorus</title><style>${galleryCSS}
*{box-sizing:border-box}body{margin:0;padding:48px;background:#10282B;color:#F2F0E9;font:15px/1.55 system-ui,sans-serif}body.aubergine{background:#231B2A}header{max-width:1120px;margin:0 auto 36px}h1{font:500 48px/1.1 Georgia,serif;letter-spacing:-.03em;margin:12px 0}p{color:#AEC3BF;max-width:640px}nav{display:flex;align-items:center;gap:10px;flex-wrap:wrap}button{font:inherit;color:inherit;padding:9px 16px;border:1px solid #D7B56F55;background:transparent;border-radius:10px;cursor:pointer}button:hover,button:focus-visible{background:#D7B56F22;outline:2px solid #D7B56F}main{max-width:1120px;margin:auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px}article{border:1px solid #D7B56F33;border-radius:24px;padding:24px;text-align:center;background:#ffffff05}article p{font-size:13px}article h2{font-size:17px}.signature{display:flex;gap:20px;align-items:center;margin-top:36px}.mono{background:white;color:#1C1915;border-radius:16px;padding:12px}small{letter-spacing:.12em;color:#D7B56F;text-transform:uppercase}@media(max-width:600px){body{padding:24px}h1{font-size:38px}}</style></head><body><header><small>Ensemble · production brand library</small><h1>Stronger together.</h1><p>Woven Chorus, in Satin Gold. The same controller used by the web app, landing page and native startup shell.</p><nav><button id="play">Play all</button><button id="settle">Settle to logo</button><button id="palette">Switch dark palette</button><label><input id="reduce" type="checkbox"> Reduce motion</label></nav></header><main>${[['unfurl','Unfurl','Opening the assistant'],['infinity','Infinity weave','Assistant working'],['relay','Relay','Agent task execution'],['threadline','Threadline','Page and document waits'],['beacon','Beacon','Background activity']].map(([kind,name,detail])=>`<article><span class="u-morph" data-size="128" data-kind="${kind}"></span><h2>${name}</h2><p>${detail}</p></article>`).join('')}</main><header class="signature">${staticSVG(64,{id:'gallery-gold'})}${staticSVG(64,{id:'gallery-white',tone:'white'})}<span class="mono">${staticSVG(64,{id:'gallery-ink',tone:'ink'})}</span><span>Satin Gold · White · Ink</span></header><script>${bundle.outputFiles[0].text}</script><script>const actors=[...document.querySelectorAll('article .u-morph')].map(el=>({kind:el.dataset.kind,ctl:EnsembleMorph.mount(el,{size:128,kind:el.dataset.kind})}));document.getElementById('play').onclick=()=>actors.forEach(a=>a.kind==='unfurl'?a.ctl.once():a.ctl.loop({kind:a.kind}));document.getElementById('settle').onclick=()=>actors.forEach(a=>a.ctl.settle());document.getElementById('palette').onclick=()=>document.body.classList.toggle('aubergine');document.getElementById('reduce').onchange=e=>document.documentElement.dataset.reduceMotion=String(e.target.checked);</script></body></html>`);
for (const app of ['desktop','quick-capture']) {
  await save(`apps/${app}/ui/ensemble-morph.js`,bundle.outputFiles[0].contents);
  await save(`apps/${app}/ui/morph.css`,await readFile(resolve(root,'packages/brand/motion.css')));
  await save(`apps/${app}/ui/woven-satin.svg`,staticSVG(160,{label:'Ensemble'}));
}
const css = await readFile(resolve(root,'apps/hub-web/components/brand/brand-pages.css'),'utf8');
for (const [name,title,heading,body] of [['404','Page not found','This thread doesn’t lead anywhere.','The page may have moved, or the link was cut short.'],['500','Something went wrong','We dropped a stitch.','Something broke on our side. Try again in a moment.'],['offline','Offline','You’re offline.','Check your connection, then try again.']]) {
 const boot = `try{var raw=JSON.parse(localStorage.getItem('ensemble.appearance')||'{}');var d=document.documentElement;d.dataset.theme=raw.theme==='light'||(raw.theme==='system'&&matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark';d.dataset.motionTheme='expressive';d.dataset.reduceMotion=String(!!raw.reduceMotion||matchMedia('(prefers-reduced-motion: reduce)').matches);}catch(e){}`;
 await save(`apps/hub-web/public/${name}.html`,`<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="theme-color" content="#10282B"><title>${title} · Ensemble</title><link rel="icon" href="${iconPaths.svg}" type="image/svg+xml"><style>${css}</style><script>${boot}</script></head><body class="ub"><header class="ub-top"><a class="ub-brand" href="/today">${staticSVG(24,{id:'header',tone:'auto'})}<span>Ensemble</span></a></header><main class="ub-main"><div class="ub-card"><div class="ub-art">${staticSVG(160,{id:'status',tone:'auto'})}</div><p class="ub-code">${name}</p><h1 class="ub-h">${heading}</h1><p class="ub-p">${body}</p><div class="ub-act"><a class="ub-btn pri" href="${name==='404'?'/today':''}">${name==='404'?'Go to Today':'Try again'}</a></div></div></main><footer class="ub-foot">Ensemble · Humans and agents, stronger together.</footer></body></html>\n`);
}
await writeFile(resolve(root,manifestPath),JSON.stringify({sources,outputs},null,2)+'\n');
console.log(`Generated ${Object.keys(outputs).length} shared brand assets.`);
