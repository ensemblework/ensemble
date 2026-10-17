import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

test('release checks tolerate Windows checkout line endings and synchronization updates all surfaces', async () => {
  const root = await mkdtemp(join(tmpdir(),'ensemble-version-test-'));
  const files=['release.json','package.json','scripts/release-version.mjs','apps/agent-runtime/pyproject.toml','packages/shared-types/src/version.ts'];
  for(const group of ['apps','packages']) for(const name of await readdir(group)) {try{await readFile(`${group}/${name}/package.json`);files.push(`${group}/${name}/package.json`);}catch{}}
  for(const app of ['desktop','quick-capture']) for(const file of ['Cargo.toml','Cargo.lock','tauri.conf.json']) files.push(`apps/${app}/src-tauri/${file}`);
  try {
    for(const file of files) {await mkdir(dirname(join(root,file)),{recursive:true});await writeFile(join(root,file),(await readFile(file,'utf8')).replace(/\r?\n/g,'\r\n'));}
    const run=(...args)=>execFileSync(process.execPath,['scripts/release-version.mjs',...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
    assert.match(run(),/versions match/);
    await writeFile(join(root,'release.json'),JSON.stringify({version:'1.2.3'}));
    assert.throws(()=>run(),/Command failed/);
    assert.match(run('--sync'),/synchronized/);assert.match(run(),/versions match/);
    assert.equal(JSON.parse(await readFile(join(root,'apps/cli/package.json'),'utf8')).version,'1.2.3');
    assert.match(await readFile(join(root,'apps/desktop/src-tauri/Cargo.lock'),'utf8'),/name = "ensemble-desktop"\nversion = "1.2.3"/);
  } finally {await rm(root,{recursive:true,force:true});}
});
