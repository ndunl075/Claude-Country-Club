import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir,mkdtemp,readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
const {verifyHelperBuildInfo}=createRequire(import.meta.url)('./helper-build-info.cjs');
assert(process.env.CCC_EXECUTABLE,'Set CCC_EXECUTABLE to the packaged application');
const artifacts=path.resolve('work/helper-build-info');await mkdir(artifacts,{recursive:true});
const resources=process.platform==='darwin'?path.resolve(path.dirname(process.env.CCC_EXECUTABLE),'../Resources'):path.join(path.dirname(process.env.CCC_EXECUTABLE),'resources');
const file=path.join(resources,process.platform==='win32'?'ccc-hook.exe':'ccc-hook');
const manifest=JSON.parse(await readFile('packages/adapters/compatibility.json','utf8'));
const checks=[];
try{
  const info=verifyHelperBuildInfo(file,manifest,process.platform,process.arch);checks.push('actual packaged helper reports matching reviewed metadata');
  assert.throws(()=>verifyHelperBuildInfo(file,{...manifest,adapterVersion:'incompatible'},process.platform,process.arch),/differs/);
  assert.throws(()=>verifyHelperBuildInfo(file,{...manifest,protocolVersion:99},process.platform,process.arch),/differs/);
  assert.throws(()=>verifyHelperBuildInfo(file,manifest,process.platform,process.arch==='arm64'?'x64':'arm64'),/differs/);
  checks.push('actual executable is rejected against mismatched adapter, protocol and architecture expectations');
  const fixture=await mkdtemp(path.join(artifacts,'invalid-')),invalid=path.join(fixture,process.platform==='win32'?'invalid.exe':'invalid');
  await writeFile(invalid,'not an executable',{mode:0o700});assert.throws(()=>verifyHelperBuildInfo(invalid,manifest,process.platform,process.arch),/probe failed/);
  assert.throws(()=>verifyHelperBuildInfo(path.join(fixture,'missing'),manifest,process.platform,process.arch),/probe failed/);
  checks.push('damaged and missing executable probes fail closed');
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,packaged:true,helper:info,checks,limitations:['Metadata checks detect stale or incompatible build outputs; they are not publisher signatures or independent proof of the identity algorithm. Native HMAC and packaged lifecycle tests cover actual behavior.']},null,2));
  console.log('Packaged native helper metadata acceptance passed.');
}catch(error){await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:false,error:String(error),checks},null,2));throw error;}
