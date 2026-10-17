import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'ensemble-signatures-'));
try {
 await mkdir(join(dir,'src'));
 await copyFile(new URL('./verify-desktop-signatures.rs',import.meta.url),join(dir,'src/main.rs'));
 await writeFile(join(dir,'Cargo.toml'),'[package]\nname="ensemble-signatures"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nbase64="=0.22.1"\nminisign-verify="=0.2.5"\nserde_json="=1.0.151"\n');
 execFileSync('cargo',['run','--quiet','--manifest-path',join(dir,'Cargo.toml'),'--',...process.argv.slice(2)],{stdio:'inherit'});
} finally {await rm(dir,{recursive:true,force:true});}
