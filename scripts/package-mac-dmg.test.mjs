import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir,mkdtemp,writeFile,rm,stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { packageMacDmg } from './package-mac-dmg.mjs';
import { releaseVersion } from './release-version.mjs';
test('Mac installer is created and verified without Finder automation',{skip:process.platform!=='darwin'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ensemble-dmg-test-'));
 try {
  const app=join(dir,'Ensemble.app');await mkdir(join(app,'Contents/MacOS'),{recursive:true});
  await writeFile(join(app,'Contents/Info.plist'),`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${releaseVersion}</string></dict></plist>`);
  await writeFile(join(app,'Contents/MacOS/fixture'),'installer fixture');
  const output=join(dir,'Ensemble.dmg');await packageMacDmg({target:'x86_64-apple-darwin',appPath:app,outputPath:output});assert.ok((await stat(output)).size>1024);
 }finally{await rm(dir,{recursive:true,force:true});}
});
