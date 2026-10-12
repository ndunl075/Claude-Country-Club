// Native fixture version probes through the packaged app's real IPC boundary.
// No real provider binary, account, configuration, or inference is used here.
import { _electron as electron } from 'playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, copyFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
assert.equal(process.platform, 'win32'); assert(process.env.CCC_EXECUTABLE);
const artifacts=path.resolve('work/client-discovery');await mkdir(artifacts,{recursive:true});
const root=await mkdtemp(path.join(artifacts,'fixture-'));
const timeline=[];
const phase=async(layout,stage)=>{
 const entry={layout,stage,time:new Date().toISOString(),elapsedMs:performance.now()};timeline.push(entry);
 await writeFile(path.join(root,'phase.json'),JSON.stringify(entry));
 await writeFile(path.join(root,'timeline.json'),JSON.stringify(timeline,null,2));
};
const source=path.join(root,'probe.go'),binary=path.join(root,'probe.exe');
await writeFile(source,`package main
import("encoding/json";"fmt";"os")
func main(){cwd,_:=os.Getwd();record:=map[string]interface{}{"args":os.Args[1:],"cwd":cwd,"home":os.Getenv("HOME"),"userprofile":os.Getenv("USERPROFILE"),"codexHome":os.Getenv("CODEX_HOME"),"claudeHome":os.Getenv("CLAUDE_CONFIG_DIR"),"openaiKey":os.Getenv("OPENAI_API_KEY"),"anthropicKey":os.Getenv("ANTHROPIC_API_KEY")};b,_:=json.Marshal(record);os.WriteFile("invocation.json",b,0600);fmt.Println("codex-cli 0.0.7\\nPRIVATE-FIXTURE-OUTPUT")}
`);
execFileSync('go',['build','-trimpath','-ldflags=-s -w -H=windowsgui','-o',binary,source],{windowsHide:true,timeout:60000,env:{...process.env,GOOS:'windows',GOARCH:process.arch==='arm64'?'arm64':'amd64',CGO_ENABLED:'0'}});
const exists=p=>access(p).then(()=>true,()=>false),checks=[];let app;
try{
 for(const layout of ['nested','hoisted','legacy','nested-long']){
  const home=path.join(root,layout,layout==='nested-long'?'long-prefix-'.repeat(20):'home'),data=path.join(root,layout,'data'),prefix=path.join(home,'.local','bin');
  const packageRoot=path.join(prefix,'node_modules','@openai','codex'),arch=process.arch;
  const vendor=layout.startsWith('nested')?path.join(packageRoot,'node_modules','@openai',`codex-win32-${arch}`,'vendor'):layout==='hoisted'?path.join(prefix,'node_modules','@openai',`codex-win32-${arch}`,'vendor'):path.join(packageRoot,'vendor');
  const executable=path.join(vendor,`${arch==='arm64'?'aarch64':'x86_64'}-pc-windows-msvc`,'bin','codex.exe');await mkdir(path.dirname(executable),{recursive:true});await copyFile(binary,executable);
  if(layout==='nested-long')assert(executable.length>260,'Long-path regression must exceed MAX_PATH even on a short CI checkout');
  await writeFile(path.join(prefix,'codex.ps1'),'throw "wrapper must never run"');await writeFile(path.join(prefix,'codex.cmd'),'exit /b 98');
  const config=path.join(home,'.codex','hooks.json'),configBytes='{"hooks":{},"fixture":"keep-exact"}\n';await mkdir(path.dirname(config),{recursive:true});await writeFile(config,configBytes);
  const env={...process.env,CCC_TEST_MODE:'1',CCC_TEST_HOME:home,CCC_DATA_DIR:data,OPENAI_API_KEY:'fixture-openai-secret',ANTHROPIC_API_KEY:'fixture-anthropic-secret'};delete env.ELECTRON_RUN_AS_NODE;
  await phase(layout,'launch');app=await electron.launch({executablePath:process.env.CCC_EXECUTABLE,env,timeout:30000});
  await phase(layout,'first-window');const page=await app.firstWindow();
  await phase(layout,'get-state');
  const before=await page.evaluate(()=>window.countryClub.getState());assert.equal(before.integrations.find(i=>i.provider==='codex').client.status,'not-checked');
  assert(!await exists(path.join(data,'client-probe','invocation.json')),'Client ran before explicit check');
  await phase(layout,'inspect-client');const state=await page.evaluate(()=>window.countryClub.inspectClient('codex'));
  await phase(layout,'verify-client');
  const client=state.integrations.find(i=>i.provider==='codex').client;assert.equal(client.status,'found');assert.equal(client.executable,executable);assert.equal(client.version,'0.0.7');assert(!JSON.stringify(client).includes('PRIVATE-FIXTURE-OUTPUT'));
  const record=JSON.parse(await readFile(path.join(data,'client-probe','invocation.json'),'utf8'));assert.deepEqual(record.args,['--version']);assert.equal(record.cwd,path.join(data,'client-probe'));assert.equal(record.home,record.cwd);assert.equal(record.userprofile,record.cwd);assert.equal(record.codexHome,path.join(record.cwd,'codex'));assert.equal(record.claudeHome,path.join(record.cwd,'claude'));assert.equal(record.openaiKey,'');assert.equal(record.anthropicKey,'');assert.equal(await readFile(config,'utf8'),configBytes);
  await phase(layout,'close');await app.close();app=undefined;await phase(layout,'complete');checks.push(`${layout}: explicit packaged IPC discovers native fixture, probes only --version with private home/no keys, retains version only and preserves provider bytes`);
 }
 await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,executableSha256:createHash('sha256').update(await readFile(process.env.CCC_EXECUTABLE)).digest('hex'),checks,limitations:['Uses a native fixture executable; does not certify installed provider versions, hook schema, trust, signed-in delivery or subscription status.','Windows fixed npm layouts only; other package managers retain manual native executable selection.']},null,2));console.log('Packaged native client discovery acceptance passed.');
}catch(error){await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:false,error:String(error),checks},null,2));throw error;}
finally{await app?.close().catch(()=>{});}
