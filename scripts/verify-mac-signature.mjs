/**
 * Checks that a Mac build's Ensemble.app is signed as a whole bundle, as Gatekeeper checks it: the built app,
 * the app inside each disk image and the app inside each updater archive. A signature only the linker made covers
 * the executable but seals no resources, so a downloaded copy is reported as damaged.
 *
 *   node scripts/verify-mac-signature.mjs [aarch64-apple-darwin|x86_64-apple-darwin] [--bundle <bundle dir>]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAC_TARGETS = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];

function needsMac() {
  if (process.platform !== 'darwin') throw new Error('Mac signatures can only be checked on macOS.');
}

function filesEndingWith(dir, suffix) {
  return existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(suffix)).sort().map(name => join(dir, name)) : [];
}

/** The app, disk images and updater archives a Mac bundle folder holds. The app and one disk image must be there. */
export function macBundleArtifacts(bundleDir) {
  const app = join(bundleDir, 'macos', 'Ensemble.app');
  if (!existsSync(app)) throw new Error(`No Ensemble.app in ${join(bundleDir, 'macos')}.`);
  const dmgs = filesEndingWith(join(bundleDir, 'dmg'), '.dmg');
  if (!dmgs.length) throw new Error(`No disk image in ${join(bundleDir, 'dmg')}.`);
  return { app, dmgs, updates: filesEndingWith(join(bundleDir, 'macos'), '.app.tar.gz') };
}

/** Throws unless `codesign --verify --deep --strict` accepts the bundle: every file sealed and nested code valid. */
export function verifyMacApp(appPath) {
  needsMac();
  const checked = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { encoding: 'utf8', timeout: 300_000 });
  const said = `${checked.stdout ?? ''}${checked.stderr ?? ''}`.trim();
  if (checked.status !== 0) throw new Error(`The signature of ${appPath} does not verify.\n${said || checked.error?.message || 'codesign gave no answer.'}`);
  const shown = spawnSync('/usr/bin/codesign', ['--display', '--verbose=2', appPath], { encoding: 'utf8' });
  console.log(`${said}\n${`${shown.stdout ?? ''}${shown.stderr ?? ''}`.trim()}`);
}

/** Mounts the disk image read-only, checks the Ensemble.app on it, and detaches it again. */
export async function verifyMacDmg(dmgPath) {
  needsMac();
  const mount = await mkdtemp(join(tmpdir(), 'ensemble-dmg-check-'));
  try {
    execFileSync('/usr/bin/hdiutil', ['attach', dmgPath, '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 180_000 });
    try {
      verifyMacApp(join(mount, 'Ensemble.app'));
    } finally {
      try {
        execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 60_000 });
      } catch {
        execFileSync('/usr/bin/hdiutil', ['detach', '-force', mount], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 60_000 });
      }
    }
  } finally {
    await rm(mount, { recursive: true, force: true }).catch(() => {});
  }
}

/** Unpacks an updater archive and checks the app in it, which is what the in-app updater installs. */
export async function verifyMacUpdate(archivePath) {
  needsMac();
  const dir = await mkdtemp(join(tmpdir(), 'ensemble-update-check-'));
  try {
    execFileSync('/usr/bin/tar', ['-xzf', archivePath, '-C', dir], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 300_000 });
    const apps = filesEndingWith(dir, '.app');
    if (apps.length !== 1) throw new Error(`${archivePath} holds ${apps.length} apps; it must hold one.`);
    verifyMacApp(apps[0]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Every check for one bundle folder, each named in the log. */
export async function verifyMacBundle(bundleDir) {
  const { app, dmgs, updates } = macBundleArtifacts(bundleDir);
  console.log(`Checking ${app}`);
  verifyMacApp(app);
  for (const dmg of dmgs) {
    console.log(`Checking the app inside ${dmg}`);
    await verifyMacDmg(dmg);
  }
  for (const update of updates) {
    console.log(`Checking the app inside ${update}`);
    await verifyMacUpdate(update);
  }
}

/** The bundle folder named on the command line: `--bundle <dir>`, or the release bundle of a Mac target. */
export function bundleDirFromArgs(args, arch = process.arch) {
  const at = args.indexOf('--bundle');
  if (at >= 0) {
    if (!args[at + 1]) throw new Error('--bundle needs a folder.');
    return resolve(args[at + 1]);
  }
  const target = args.find(arg => !arg.startsWith('--')) ?? (arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin');
  if (!MAC_TARGETS.includes(target)) throw new Error('Choose a supported Mac architecture.');
  return join(root, 'apps/desktop/src-tauri/target', target, 'release/bundle');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await verifyMacBundle(bundleDirFromArgs(process.argv.slice(2)));
    console.log('Every Ensemble.app signature verifies.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
