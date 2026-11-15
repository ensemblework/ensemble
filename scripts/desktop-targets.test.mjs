import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopTargets } from './desktop-targets.mjs';
test('normal releases build every platform and recovery can select only Intel Mac',()=>{
 assert.deepEqual(desktopTargets().map(row=>row.name),['macos-arm64','macos-x64','windows','linux','linux-arm64','windows-arm64']);
 const [intel]=desktopTargets('macos-x64');assert.equal(intel.os,'macos-15-intel');assert.match(intel.args,/--bundles app(?: |$)/);assert.doesNotMatch(intel.args,/app,dmg/);
 const [linux]=desktopTargets('linux');assert.match(linux.args,/--bundles deb,rpm,appimage/,'Debian/Ubuntu, Fedora/RHEL/openSUSE and every other distribution');
 assert.throws(()=>desktopTargets('untrusted-target'),/supported/);
});
test('Linux on Arm builds natively on the same glibc as x64, with the same packages',()=>{
 const [x64]=desktopTargets('linux'),[arm]=desktopTargets('linux-arm64');
 assert.equal(arm.os,`${x64.os}-arm`,'an Arm runner of the same Ubuntu release, so both need glibc 2.35');
 assert.equal(arm.rust_targets,'aarch64-unknown-linux-gnu');
 assert.equal(arm.args,x64.args);assert.doesNotMatch(arm.args,/--target/,'a cross build would pack the x64 runner\'s Node into the Arm app');
});
test('Windows on Arm builds natively, NSIS only',()=>{
 const [x64]=desktopTargets('windows'),[arm]=desktopTargets('windows-arm64');
 assert.equal(arm.os,'windows-11-arm');
 assert.equal(arm.rust_targets,'aarch64-pc-windows-msvc');
 assert.equal(arm.args,'--bundles nsis','Tauri\'s MSI cannot target arm64');
 assert.match(x64.args,/--bundles msi,nsis/);
});
