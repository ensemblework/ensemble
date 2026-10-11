import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { importColorThemes } from "./import-theme.js";

const color = JSON.stringify({ name:"My theme", colors:{"editor.background":"#101020","editor.foreground":"#eeeeee"}, tokenColors:[{scope:"string",settings:{foreground:"#88ccaa"}}] });
test("a Marketplace VSIX imports color data and resolves includes without reading extension scripts", () => {
  const bytes = zipSync({
    "extension/package.json":strToU8(JSON.stringify({contributes:{themes:[{label:"My theme",uiTheme:"vs-dark",path:"themes/main.json"}]}})),
    "extension/themes/main.json":strToU8(JSON.stringify({include:"base.json",colors:{"editor.background":"#101020"}})),
    "extension/themes/base.json":strToU8(color),
    "extension/run.js":strToU8("throw new Error('must never run');"),
  });
  const themes = importColorThemes(bytes,"sample.vsix","abc");
  assert.equal(themes.length,1); assert.equal(themes[0].id,"import:abc:0"); assert.equal(themes[0].editor?.background,"#101020");
});
test("standalone JSONC color themes import; invalid files and unresolved includes explain themselves", () => {
  assert.equal(importColorThemes(strToU8(color),"theme.json","abc")[0].label,"My theme");
  assert.throws(()=>importColorThemes(strToU8('{"include":"base.json"}'),"theme.json","abc"),/VSIX/);
  assert.throws(()=>importColorThemes(strToU8("no"),"theme.txt","abc"),/VSIX package/);
  assert.throws(()=>importColorThemes(new Uint8Array(12*1024*1024+1),"theme.vsix","abc"),/12 MB/);
});
