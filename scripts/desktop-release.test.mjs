import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { releaseVersion } from './release-version.mjs';
test('desktop manifests keep Mac architectures distinct and require every signed platform', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ensemble-release-test-'));
  const paths = ['mac-arm/aarch64-apple-darwin/release/bundle/macos/Ensemble.app.tar.gz', 'mac-intel/x86_64-apple-darwin/release/bundle/macos/Ensemble.app.tar.gz', 'windows/release/bundle/nsis/Ensemble-setup.exe', 'linux/release/bundle/appimage/Ensemble.AppImage'];
  try {
    for (const path of paths) { const file=join(root,path);await mkdir(join(file,'..'),{recursive:true});await writeFile(file,'fixture package');await writeFile(`${file}.sig`,'fixture signature'); }
    const run=()=>execFileSync(process.execPath,['scripts/desktop-release.mjs',root],{encoding:'utf8'});
    run();run();
    const data=JSON.parse(await readFile(join(root,'latest.json'),'utf8'));
    assert.equal(data.version,releaseVersion);assert.equal(Object.keys(data.platforms).length,4);
    assert.notEqual(data.platforms['darwin-aarch64'].url,data.platforms['darwin-x86_64'].url);
    await rm(join(root,`${paths[2]}.sig`));
    assert.throws(run,/Command failed/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
