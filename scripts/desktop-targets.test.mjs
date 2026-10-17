import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopTargets } from './desktop-targets.mjs';
test('normal releases build every platform and recovery can select only Intel Mac',()=>{
 assert.deepEqual(desktopTargets().map(row=>row.name),['macos-arm64','macos-x64','windows','linux']);
 const [intel]=desktopTargets('macos-x64');assert.equal(intel.os,'macos-15-intel');assert.match(intel.args,/--bundles app(?: |$)/);assert.doesNotMatch(intel.args,/app,dmg/);
 assert.throws(()=>desktopTargets('untrusted-target'),/supported/);
});
