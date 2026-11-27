import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fixtureApp } from './mac-test-app.mjs';
import { bundleDirFromArgs, macBundleArtifacts, verifyMacApp, verifyMacUpdate } from './verify-mac-signature.mjs';

const onMac = { skip: process.platform !== 'darwin' };

test('a bundle folder lists its app, disk images and updater archives', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ensemble-bundle-test-'));
  try {
    await mkdir(join(dir, 'macos/Ensemble.app'), { recursive: true });
    await writeFile(join(dir, 'macos/Ensemble.app.tar.gz'), '');
    await writeFile(join(dir, 'macos/Ensemble.app.tar.gz.sig'), '');
    assert.throws(() => macBundleArtifacts(dir), /No disk image/);
    await mkdir(join(dir, 'dmg'));
    await writeFile(join(dir, 'dmg/Ensemble_1.0.0_x64.dmg'), '');
    await writeFile(join(dir, 'dmg/bundle_dmg.sh'), '');
    assert.deepEqual(macBundleArtifacts(dir), {
      app: join(dir, 'macos/Ensemble.app'),
      dmgs: [join(dir, 'dmg/Ensemble_1.0.0_x64.dmg')],
      updates: [join(dir, 'macos/Ensemble.app.tar.gz')],
    });
    await rm(join(dir, 'macos/Ensemble.app'), { recursive: true });
    assert.throws(() => macBundleArtifacts(dir), /No Ensemble\.app/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the bundle folder comes from --bundle or a Mac target', () => {
  assert.equal(bundleDirFromArgs(['--bundle', 'some/bundle']), resolve('some/bundle'));
  assert.match(bundleDirFromArgs(['x86_64-apple-darwin']), /apps\/desktop\/src-tauri\/target\/x86_64-apple-darwin\/release\/bundle$/);
  assert.match(bundleDirFromArgs([], 'arm64'), /target\/aarch64-apple-darwin\/release\/bundle$/);
  assert.throws(() => bundleDirFromArgs(['x86_64-pc-windows-msvc']), /supported Mac architecture/);
  assert.throws(() => bundleDirFromArgs(['--bundle']), /needs a folder/);
});

test('a sealed app verifies; a changed or unsealed one does not', onMac, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ensemble-sign-test-'));
  try {
    const sealed = await fixtureApp(join(dir, 'sealed'));
    verifyMacApp(sealed);
    await appendFile(join(sealed, 'Contents/Resources/readme.txt'), 'changed after signing\n');
    assert.throws(() => verifyMacApp(sealed), /does not verify/);
    const unsealed = await fixtureApp(join(dir, 'unsealed'), { sign: false });
    assert.throws(() => verifyMacApp(unsealed), /does not verify/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the app inside an updater archive is checked', onMac, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ensemble-update-test-'));
  try {
    await fixtureApp(join(dir, 'signed'));
    execFileSync('/usr/bin/tar', ['-czf', join(dir, 'signed.app.tar.gz'), '-C', join(dir, 'signed'), 'Ensemble.app']);
    await verifyMacUpdate(join(dir, 'signed.app.tar.gz'));
    await fixtureApp(join(dir, 'unsigned'), { sign: false });
    execFileSync('/usr/bin/tar', ['-czf', join(dir, 'unsigned.app.tar.gz'), '-C', join(dir, 'unsigned'), 'Ensemble.app']);
    await assert.rejects(verifyMacUpdate(join(dir, 'unsigned.app.tar.gz')), /does not verify/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
