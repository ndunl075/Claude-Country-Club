import { expect,test } from 'vitest';
import { createRequire } from 'node:module';
const {validateBuildInfo}=createRequire(import.meta.url)('../scripts/helper-build-info.cjs');
const manifest={schemaVersion:1,protocolVersion:1,adapterVersion:'1.2'};
const info={kind:'ccc-hook',...manifest,sessionIdentity:'hmac-sha256-128',os:'windows',arch:'amd64'};
test('accepts matching native metadata for Windows and both Mac architectures',()=>{
  expect(validateBuildInfo(JSON.stringify(info),manifest,'win32','x64')).toEqual(info);
  for(const arch of ['arm64','x64'])expect(validateBuildInfo(JSON.stringify({...info,os:'darwin',arch:arch==='x64'?'amd64':arch}),manifest,'darwin',arch).os).toBe('darwin');
});
test.each([{adapterVersion:'1.1'},{protocolVersion:2},{schemaVersion:2},{os:'darwin'},{arch:'arm64'},{sessionIdentity:'sha256-128'},{kind:'other'},{extra:true}])('rejects incompatible helper metadata %j',patch=>{
  expect(()=>validateBuildInfo(JSON.stringify({...info,...patch}),manifest,'win32','x64')).toThrow('differs');
});
test.each(['','{','null','[]','{}'])('rejects missing or malformed helper information %j',text=>{
  expect(()=>validateBuildInfo(text,manifest,'win32','x64')).toThrow();
});
