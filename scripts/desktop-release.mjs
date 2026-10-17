import { readdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { releaseVersion, checkReleaseVersion } from './release-version.mjs';
checkReleaseVersion();
async function walk(dir) { const rows = await readdir(dir, { withFileTypes: true }); return (await Promise.all(rows.map(row => row.isDirectory() ? walk(join(dir,row.name)) : [join(dir,row.name)]))).flat(); }
const files = await walk(process.argv[2]);
let artifacts = files.filter(file => /\.(dmg|msi|exe|deb|AppImage|tar\.gz|sig)$/.test(file));
const choose = (pattern) => { const found = artifacts.filter(file => pattern.test(file) && !file.endsWith('.sig')); if (found.length !== 1) throw new Error(`Expected one update package for ${pattern}, got ${found.length}`); return found[0]; };
const targets = { 'darwin-aarch64': choose(/aarch64.*\/bundle\/macos\/.*\.app\.tar\.gz$/), 'darwin-x86_64': choose(/x86_64.*\/bundle\/macos\/.*\.app\.tar\.gz$/), 'windows-x86_64': choose(/\/nsis\/.*\.exe$/), 'linux-x86_64': choose(/\/appimage\/.*\.AppImage$/) };
const platforms = {};
for (const [target,original] of Object.entries(targets)) {
  let file = original;
  if (target.startsWith('darwin-')) {
    const name = `Ensemble_${releaseVersion}_${target}.app.tar.gz`;
    file = join(process.argv[2], name);
    await copyFile(original, file); await copyFile(`${original}.sig`,`${file}.sig`);
    artifacts = artifacts.filter(row => row !== original && row !== `${original}.sig`);
    artifacts.push(file,`${file}.sig`);
  }
  const signature = (await readFile(`${file}.sig`, 'utf8')).trim();
  if (!signature) throw new Error(`Missing signature for ${target}`);
  platforms[target] = { signature, url: `https://github.com/ensemblework/ensemble/releases/download/desktop-v${releaseVersion}/${basename(file)}` };
}
const manifest = join(process.argv[2], 'latest.json');
await writeFile(manifest, JSON.stringify({ version: releaseVersion, notes: 'A new Ensemble release is ready. Your work and settings are kept.', pub_date: new Date().toISOString(), platforms }, null, 2));
if (process.argv.includes('--upload')) execFileSync('gh', ['release', 'upload', `desktop-v${releaseVersion}`, ...new Set(artifacts), manifest, '--clobber'], { stdio: 'inherit' });
else console.log(`Verified signed updates for ${Object.keys(platforms).join(', ')}`);
