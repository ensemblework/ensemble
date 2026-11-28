import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,rm,stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureApp } from './mac-test-app.mjs';
import { packageMacDmg } from './package-mac-dmg.mjs';
import { releaseVersion } from './release-version.mjs';
import { verifyMacDmg } from './verify-mac-signature.mjs';
test('Mac installer is created and verified without Finder automation',{skip:process.platform!=='darwin'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ensemble-dmg-test-'));
 try {
  const app=await fixtureApp(dir,{version:releaseVersion});
  const output=join(dir,'Ensemble.dmg');await packageMacDmg({target:'x86_64-apple-darwin',appPath:app,outputPath:output});assert.ok((await stat(output)).size>1024);
  await verifyMacDmg(output);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('an app whose bundle is not sealed gets no installer',{skip:process.platform!=='darwin'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ensemble-dmg-test-'));
 try {
  const app=await fixtureApp(dir,{version:releaseVersion,sign:false});
  const output=join(dir,'Ensemble.dmg');
  await assert.rejects(packageMacDmg({target:'x86_64-apple-darwin',appPath:app,outputPath:output}),/not signed as a whole bundle/);
  await assert.rejects(stat(output),{code:'ENOENT'});
 }finally{await rm(dir,{recursive:true,force:true});}
});
