import { execFileSync } from 'node:child_process';
import { mkdtemp,readFile,readdir,writeFile } from 'node:fs/promises';
import { join,basename } from 'node:path';
import { tmpdir } from 'node:os';
import { releaseVersion,checkReleaseVersion } from './release-version.mjs';
const repo='ensemblework/ensemble',tag=`desktop-v${releaseVersion}`;
checkReleaseVersion();
const ids=[process.env.RECOVERY_SOURCE_RUN,process.env.RECOVERY_INTEL_RUN];
if(ids.some(id=>!/^\d{1,20}$/.test(id??'')))throw new Error('Supply both successful source and Intel recovery run IDs.');
const command=(bin,args)=>execFileSync(bin,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const gh=(args)=>JSON.parse(command('gh',args));
const git=(args)=>command('git',args);
const source=gh(['api',`repos/${repo}/actions/runs/${ids[0]}`]);
const intel=gh(['api',`repos/${repo}/actions/runs/${ids[1]}`]);
if([source,intel].some(run=>run.repository.full_name!==repo||run.head_repository?.full_name!==repo))throw new Error('Recovery requires builds from this repository.');
if(intel.conclusion!=='success'||intel.event!=='workflow_dispatch')throw new Error('The Intel recovery build must finish successfully first.');
execFileSync('git',['fetch','origin',`refs/tags/${tag}:refs/tags/${tag}`,intel.head_sha],{stdio:'inherit'});
const tagged=git(['rev-parse',`${tag}^{commit}`]);
if(source.head_sha!==tagged)throw new Error('Source artifacts do not match the immutable release tag.');
for(const revision of [intel.head_sha,'HEAD'])for(const path of ['apps','packages','release.json','package.json','pnpm-lock.yaml']) {
 if(git(['rev-parse',`${revision}:${path}`])!==git(['rev-parse',`${tagged}:${path}`]))throw new Error(`Application source changed in ${path}; recovery may only repair packaging.`);
}
let existing;try{existing=gh(['release','view',tag,'--repo',repo,'--json','isDraft']);}catch{}
if(existing&&!existing.isDraft){console.log('The complete desktop release is already published.');process.exit(0);}
const dir=await mkdtemp(join(tmpdir(),'ensemble-release-recovery-')),bundles=join(dir,'bundles');
for(const name of ['ensemble-desktop-linux','ensemble-desktop-windows','ensemble-desktop-macos-arm64','ensemble-desktop-macos-x64']) {
 const id=name==='ensemble-desktop-macos-x64'?ids[1]:ids[0];
 execFileSync('gh',['run','download',id,'--repo',repo,'--name',name,'--dir',join(bundles,name)],{stdio:'inherit'});
}
execFileSync(process.execPath,['scripts/desktop-release.mjs',bundles],{stdio:'inherit'});
async function walk(path){return(await Promise.all((await readdir(path,{withFileTypes:true})).map(entry=>entry.isDirectory()?walk(join(path,entry.name)):[join(path,entry.name)]))).flat();}
const files=await walk(bundles),manifest=JSON.parse(await readFile(join(bundles,'latest.json'),'utf8'));
const packages=Object.values(manifest.platforms).map(entry=>{
 const matches=files.filter(file=>basename(file)===basename(new URL(entry.url).pathname));
 if(matches.length!==1)throw new Error('Updater package names are not unique.');return matches[0];
});
execFileSync(process.execPath,['scripts/verify-desktop-signatures.mjs','apps/desktop/src-tauri/tauri.conf.json',...packages],{stdio:'inherit'});
const notes=join(dir,'notes.md');await writeFile(notes,`Ensemble ${releaseVersion} for Apple silicon and Intel Macs, Windows and Linux. Includes the real-world testing fixes and signed in-app updates. Intel disk-image packaging was recovered without changing application source or version. OS code-signing certificates remain unconfigured.\n`);
if(!existing)execFileSync('gh',['release','create',tag,'--repo',repo,'--verify-tag','--draft','--title',`Ensemble desktop ${releaseVersion}`,'--notes-file',notes],{stdio:'inherit'});
execFileSync(process.execPath,['scripts/desktop-release.mjs',bundles,'--upload'],{stdio:'inherit'});
execFileSync('gh',['release','edit',tag,'--repo',repo,'--draft=false'],{stdio:'inherit'});
console.log(`Published ${tag} after validating source parity and every updater signature.`);
