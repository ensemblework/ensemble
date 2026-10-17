import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { releaseVersion, checkReleaseVersion } from './release-version.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function packageMacDmg({ target, appPath, outputPath }) {
  if (process.platform !== 'darwin') throw new Error('Mac disk images must be built on macOS.');
  if (!['aarch64-apple-darwin', 'x86_64-apple-darwin'].includes(target)) throw new Error('Choose a supported Mac architecture.');
  checkReleaseVersion();
  const version = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(appPath,'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  if (version !== releaseVersion) throw new Error('The app and installer release versions do not match.');
  const stage = await mkdtemp(join(tmpdir(), 'ensemble-dmg-'));
  try {
    execFileSync('/usr/bin/ditto', [appPath, join(stage, 'Ensemble.app')]);
    await symlink('/Applications',join(stage,'Applications'));
    const kb = Number(execFileSync('/usr/bin/du',['-sk',stage],{encoding:'utf8'}).trim().split(/\s+/)[0]);
    const megabytes = Math.max(256,Math.ceil(kb/1024*1.3+128));
    await mkdir(dirname(outputPath),{recursive:true});
    await rm(outputPath,{force:true});
    execFileSync('/usr/bin/hdiutil',['create','-volname','Ensemble','-srcfolder',stage,'-fs','APFS','-format','UDZO','-size',`${megabytes}m`,'-ov',outputPath],{stdio:'inherit',timeout:300_000});
    execFileSync('/usr/bin/hdiutil',['verify',outputPath],{stdio:'inherit',timeout:120_000});
    if ((await stat(outputPath)).size < 1024) throw new Error('The disk image is empty.');
    return outputPath;
  } finally { await rm(stage,{recursive:true,force:true}); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] ?? (process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin');
  const architecture = target === 'aarch64-apple-darwin' ? 'aarch64' : 'x64';
  const bundles = join(root,'apps/desktop/src-tauri/target',target,'release/bundle');
  await packageMacDmg({target,appPath:join(bundles,'macos/Ensemble.app'),outputPath:join(bundles,`dmg/Ensemble_${releaseVersion}_${architecture}.dmg`)});
}
