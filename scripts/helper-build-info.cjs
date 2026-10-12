const { spawnSync } = require('node:child_process');
function validateBuildInfo(text, manifest, platform, arch) {
  let info;
  try { info = JSON.parse(text); } catch { throw new Error('Packaged helper build information is malformed.'); }
  const expected={kind:'ccc-hook',schemaVersion:manifest.schemaVersion,protocolVersion:manifest.protocolVersion,adapterVersion:manifest.adapterVersion,sessionIdentity:'hmac-sha256-128',os:platform==='win32'?'windows':platform,arch:arch==='x64'?'amd64':arch};
  if (!info || typeof info!=='object' || Array.isArray(info) || Object.keys(info).length!==Object.keys(expected).length || Object.entries(expected).some(([key,value])=>info[key]!==value)) throw new Error('Packaged native helper metadata differs from the reviewed protocol, adapter, identity or architecture.');
  return info;
}
function verifyHelperBuildInfo(file, manifest, platform, arch) {
  const result=spawnSync(file,['--build-info'],{encoding:'utf8',windowsHide:true,timeout:2000,maxBuffer:4096,stdio:['ignore','pipe','pipe']});
  if(result.error || result.status!==0 || result.signal || result.stderr) throw new Error('Packaged native helper build-information probe failed.');
  return validateBuildInfo(result.stdout,manifest,platform,arch);
}
module.exports={validateBuildInfo,verifyHelperBuildInfo};
