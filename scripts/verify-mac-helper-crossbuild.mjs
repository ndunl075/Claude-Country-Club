// Cross-compilation evidence only. Does not run a Mac binary or build a PKG.
import { spawnSync } from 'node:child_process';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),work=path.resolve('work/mac-helper-crossbuild');await mkdir(work,{recursive:true});
const results=[];
const run=(args,options={})=>{
 const r=spawnSync('go',args,{encoding:'utf8',windowsHide:true,timeout:120000,...options});
 assert(!r.error&&r.status===0,`Go ${args[0]} failed: ${r.error?.message??r.stderr}`);return r.stdout;
};
try{
 for(const [arch,cpu] of [['arm64',0x0100000c],['amd64',0x01000007]]){
  const output=path.join(work,`ccc-hook-darwin-${arch}`);
  run(['build','-trimpath','-ldflags=-s -w','-o',output,'.'],{cwd:path.join(root,'native/ccc-hook'),env:{...process.env,GOOS:'darwin',GOARCH:arch,CGO_ENABLED:'0',GOCACHE:path.join(root,'work/go-cache'),GOMODCACHE:path.join(root,'work/go-modcache')}});
  const bytes=await readFile(output),metadata=run(['version','-m',output]);
  assert.equal(bytes.readUInt32LE(0),0xfeedfacf,'Expected a 64-bit little-endian Mach-O');
  assert.equal(bytes.readUInt32LE(4),cpu,'Mach-O architecture mismatch');
  assert.equal(bytes.readUInt32LE(12),2,'Expected an executable Mach-O');
  assert(metadata.includes('GOOS=darwin')&&metadata.includes(`GOARCH=${arch}`)&&metadata.includes('CGO_ENABLED=0'),'Embedded build target mismatch');
  results.push({architecture:arch==='amd64'?'x64':arch,compiled:true,machOExecutable:true,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),buildInfo:metadata});
 }
}finally{
 await writeFile(path.join(work,'result.json'),JSON.stringify({passed:results.length===2,host:process.platform,results,limitations:['Cross-compilation and static Mach-O/build-info inspection only; neither binary was executed.','No Electron Mac bundle, PKG, codesign, notarization, Installer, socket permissions or native focus behavior is certified.','Hosted native Mac CI and real-Mac acceptance remain required.']},null,2));
}
console.log('Apple Silicon and Intel native helpers cross-compiled with matching Mach-O/build metadata; Mac execution remains unverified.');
