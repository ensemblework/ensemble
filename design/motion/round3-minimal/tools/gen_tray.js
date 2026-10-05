// node tools/gen_tray.js -> components/tray/svg/ensemble-minimal-<quiet|dot>-<state>-<template|accent>.svg (static poses, round 5: U in every state)
const fs = require('fs'), path = require('path');
const UM = require('../components/tray/tray.js');
const out = path.join(__dirname, '../components/tray/svg'); fs.mkdirSync(out, { recursive: true });
let n = 0;
for (const fl of ['quiet', 'dot']) for (const st of UM.TRAY_STATES) {
  fs.writeFileSync(`${out}/ensemble-minimal-${fl}-${st}-template.svg`, UM.trayIcon(fl, st, { tpl: true, inline: true, ink: '#000' }).replace(/ class="mt[^"]*"/, '') + '\n'); n++;
  fs.writeFileSync(`${out}/ensemble-minimal-${fl}-${st}-accent.svg`, UM.trayIcon(fl, st, { inline: true, ink: '#1c1915', accent: '#7c6af7', err: '#b5564b' }).replace(/ class="mt[^"]*"/, '') + '\n'); n++;
}
console.log(n, 'svgs ->', out);
