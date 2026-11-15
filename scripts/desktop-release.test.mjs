import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { releaseVersion } from './release-version.mjs';
// The files each build job uploads, as the publish job downloads them (one folder per artifact).
const v = releaseVersion;
const updaters = { 'darwin-aarch64': 'mac-arm/aarch64-apple-darwin/release/bundle/macos/Ensemble.app.tar.gz', 'darwin-x86_64': 'mac-intel/x86_64-apple-darwin/release/bundle/macos/Ensemble.app.tar.gz', 'windows-x86_64': `windows/release/bundle/nsis/Ensemble_${v}_x64-setup.exe`, 'windows-aarch64': `windows-arm64/release/bundle/nsis/Ensemble_${v}_arm64-setup.exe`, 'linux-x86_64': `linux/release/bundle/appimage/Ensemble_${v}_amd64.AppImage`, 'linux-aarch64': `linux-arm64/release/bundle/appimage/Ensemble_${v}_aarch64.AppImage` };
const installers = [`windows/release/bundle/msi/Ensemble_${v}_x64_en-US.msi`, `linux/release/bundle/deb/Ensemble_${v}_amd64.deb`, `linux/release/bundle/rpm/Ensemble-${v}-1.x86_64.rpm`, `linux-arm64/release/bundle/deb/Ensemble_${v}_arm64.deb`, `linux-arm64/release/bundle/rpm/Ensemble-${v}-1.aarch64.rpm`];
test('desktop manifests keep Mac, Windows and Linux architectures distinct and require every signed platform', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ensemble-release-test-'));
  try {
    for (const path of [...Object.values(updaters), ...installers]) { const file=join(root,path);await mkdir(join(file,'..'),{recursive:true});await writeFile(file,'fixture package');await writeFile(`${file}.sig`,`signature of ${path}`); }
    const run=()=>execFileSync(process.execPath,['scripts/desktop-release.mjs',root],{encoding:'utf8',stdio:'pipe'});
    run();run();
    const data=JSON.parse(await readFile(join(root,'latest.json'),'utf8'));
    assert.equal(data.version,releaseVersion);assert.deepEqual(Object.keys(data.platforms).sort(),Object.keys(updaters).sort());
    assert.notEqual(data.platforms['darwin-aarch64'].url,data.platforms['darwin-x86_64'].url);
    for (const target of ['windows-x86_64','windows-aarch64','linux-x86_64','linux-aarch64']) {
      assert.equal(data.platforms[target].url,`https://github.com/ensemblework/ensemble/releases/download/desktop-v${v}/${updaters[target].split('/').pop()}`);
      assert.equal(data.platforms[target].signature,`signature of ${updaters[target]}`);
    }
    const armSetup=join(root,updaters['windows-aarch64']);await rename(armSetup,`${armSetup}.held`);
    assert.throws(run,/Expected one update package for .*arm64-setup/,'a release without the Windows Arm installer does not publish');
    await rename(`${armSetup}.held`,armSetup);
    await rm(join(root,`${updaters['linux-aarch64']}.sig`));
    assert.throws(run,/Command failed/,'an unsigned Arm AppImage blocks the release');
    await rm(join(root,'linux-arm64'),{recursive:true});
    assert.throws(run,/Expected one update package for .*aarch64/,'a release without the Arm build does not publish');
  } finally { await rm(root,{recursive:true,force:true}); }
});
