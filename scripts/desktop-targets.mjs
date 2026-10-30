import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export const DESKTOP_TARGETS = [
  { name: 'macos-arm64', os: 'macos-15', rust_targets: 'aarch64-apple-darwin', args: '--target aarch64-apple-darwin --bundles app,dmg' },
  { name: 'macos-x64', os: 'macos-15-intel', rust_targets: 'x86_64-apple-darwin', args: '--target x86_64-apple-darwin --bundles app --verbose' },
  { name: 'windows', os: 'windows-latest', rust_targets: 'x86_64-pc-windows-msvc', args: '--bundles msi,nsis' },
  { name: 'linux', os: 'ubuntu-22.04', rust_targets: 'x86_64-unknown-linux-gnu', args: '--bundles deb,rpm,appimage' },
];
export function desktopTargets(name = 'all') {
  if (name === 'all') return DESKTOP_TARGETS;
  const target = DESKTOP_TARGETS.find(row => row.name === name);
  if (!target) throw new Error('Choose a supported desktop target.');
  return [target];
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(desktopTargets(process.argv[2])));
