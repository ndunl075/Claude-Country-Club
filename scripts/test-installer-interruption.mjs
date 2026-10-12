// Real Windows filesystem faults against the bundled transaction coordinator.
// All installations and provider homes are guarded workspace fixtures.
import { spawn,execFileSync } from 'node:child_process';
import { mkdir,mkdtemp,readFile,writeFile,access,cp,readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { _electron as electron,expect } from 'playwright/test';
import { dragShot } from './play-input.mjs';
assert.equal(process.platform,'win32');
const work=path.resolve('work/installer-interruption');await mkdir(work,{recursive:true});
const fixture=await mkdtemp(path.join(work,'fixture-')),target=path.join(fixture,'Mini golf & café Ω');
const executable=path.join(target,'Claude Country Club.exe'),transaction=target+'.ccc-transaction';
const installer=path.resolve('release/Claude-Country-Club-Setup-0.1.0-x64.exe');
const coordinator=path.resolve('release/win-unpacked/resources/ccc-installer.exe');
const home=path.join(fixture,'home'),data=path.join(fixture,'data');
const exists=p=>access(p).then(()=>true,()=>false);
const digest=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
function registration(){
  const raw=execFileSync('powershell.exe',['-NoProfile','-Command',"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^Claude Country Club(?: [0-9].*)?$' } | Select-Object PSChildName,UninstallString,DisplayVersion | ConvertTo-Json -Compress"],{windowsHide:true,encoding:'utf8'}).trim();
  if(!raw)return null;const record=JSON.parse(raw);assert(!Array.isArray(record),'Ambiguous installations preserved');
  const file=/^"([^"]+)"/.exec(record.UninstallString??'')?.[1];assert(file&&path.dirname(file).toLowerCase()===target.toLowerCase(),'Installation outside fixture preserved');return record;
}
assert.equal(registration(),null,'Start with no registered Country Club installation');
assert(!(await exists(path.join(process.env.APPDATA,'Claude Country Club/config-patches.json'))),'Live integration ledger preserved; use a disposable account');
await mkdir(path.join(home,'.codex'),{recursive:true});
const auth=path.join(home,'.codex/auth.json'),hooks=path.join(home,'.codex/hooks.json');
await writeFile(auth,'{"fixture":"private-auth-preserved"}\n');await writeFile(hooks,'{"hooks":{},"fixture":"unrelated-config-preserved"}\n');
const privateHashes=await Promise.all([auth,hooks].map(digest));
const privateUnchanged=async()=>assert.deepEqual(await Promise.all([auth,hooks].map(digest)),privateHashes);
async function run(file,args,expected=0,verbatim=false){
  await new Promise((resolve,reject)=>{const child=spawn(file,args,{windowsHide:true,windowsVerbatimArguments:verbatim,stdio:'inherit'});const timer=setTimeout(()=>{child.kill();reject(new Error('Fixture command exceeded 180 seconds'));},180000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);code===expected?resolve():reject(new Error(`${path.basename(file)} exited ${code}, expected ${expected}`));});});
}
async function partialStage(){await mkdir(path.join(transaction,'new/resources'),{recursive:true});await writeFile(path.join(transaction,'new/resources/app.asar'),'interrupted extraction fixture');}
const checks=[];let app,lockProcess;
try{
  await run(coordinator,['prepare',target]);await partialStage();await run(coordinator,['recover',target]);
  assert(!(await exists(transaction)));assert(!(await exists(target)));assert.equal(registration(),null);await privateUnchanged();
  checks.push('fresh partial extraction recovery removes only staged files and leaves no installation or registration');
  await run(installer,['/S',`/D=${target}`],0,true);assert.equal(registration().DisplayVersion,'0.1.0');
  const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:data,CCC_TEST_HOME:home};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:executable,env,timeout:30000});let page=await app.firstWindow();
  await page.getByRole('button',{name:'Play local practice',exact:true}).click();await dragShot(page,{angle:180,power:15});
  await expect.poll(async()=>{const r=await page.evaluate(()=>window.countryClub.loadRound());return r?.state?.shotId===1&&r.state.velocity.x===0&&r.state.velocity.y===0;},{timeout:15000}).toBe(true);
  await page.evaluate(()=>window.countryClub.hide());const saved=await page.evaluate(()=>window.countryClub.loadRound());
  const liveIdentity=await app.evaluate(()=>({pid:process.pid,executable:process.execPath}));
  const liveRegistration=registration();
  const files=['Claude Country Club.exe','resources/app.asar','resources/ccc-hook.exe','ccc-package.json','Uninstall Claude Country Club.exe'];
  const liveFiles=await Promise.all(files.map(name=>digest(path.join(target,name))));
  // NSIS's normal launcher reports its temporary-copy launch, not the final
  // uninstall exit. Use its documented copied-executable/_?= wait pattern.
  const uninstallProbe=path.join(fixture,'Uninstall-running-probe.exe');
  await cp(path.join(target,'Uninstall Claude Country Club.exe'),uninstallProbe);
  for(const operation of ['repair','uninstall']){
    if(operation==='repair')await run(installer,['/S','/REPAIR',`/D=${target}`],2,true);
    else await run(uninstallProbe,['/S',`_?=${target}`],2,true);
    assert.deepEqual(await app.evaluate(()=>({pid:process.pid,executable:process.execPath})),liveIdentity,`${operation} replaced the running process`);
    assert.deepEqual(await page.evaluate(()=>window.countryClub.loadRound()),saved,`${operation} changed acknowledged progress`);
    assert.deepEqual(registration(),liveRegistration);
    assert.deepEqual(await Promise.all(files.map(name=>digest(path.join(target,name)))),liveFiles);
    assert(!(await exists(transaction)));await privateUnchanged();
    checks.push(`silent ${operation} refuses the running game with exit2, preserving its PID, exact acknowledged round, registration, payload and provider fixture files`);
  }
  await app.close();app=undefined;
  const priorRegistration=registration(),priorSave=await digest(path.join(data,'country-club.sqlite'));
  const priorFiles=await Promise.all(files.map(name=>digest(path.join(target,name))));
  async function intact(){assert.deepEqual(registration(),priorRegistration);assert.deepEqual(await Promise.all(files.map(name=>digest(path.join(target,name)))),priorFiles);assert.equal(await digest(path.join(data,'country-club.sqlite')),priorSave);await privateUnchanged();}
  // The interactive template may append the product folder to a custom path.
  // Exercise the resulting mismatch separately from native page delivery.
  const nestedTarget=path.join(target,'Claude Country Club');
  assert(!(await exists(nestedTarget))&&!(await exists(nestedTarget+'.ccc-transaction')));
  await run(installer,['/S','/REPAIR',`/D=${nestedTarget}`],5,true);
  await intact();if(await exists(nestedTarget))assert.deepEqual(await readdir(nestedTarget),[],'Refused destination may contain only the empty directory NSIS initializes');assert(!(await exists(nestedTarget+'.ccc-transaction')));
  checks.push('repair at an appended product subfolder is refused with exit5 and exact prior registration, payload, SQLite and provider files preserved; native wizard causality remains unverified');
  await run(coordinator,['prepare',target]);await partialStage();await run(coordinator,['recover',target]);await intact();assert(!(await exists(transaction)));
  checks.push('existing partial extraction recovery preserves registration, application payloads, exact SQLite and fixture provider files');
  await run(coordinator,['prepare',target]);await cp(target,path.join(transaction,'new'),{recursive:true});
  const lockScript=path.join(fixture,'hold-file.ps1');
  await writeFile(lockScript,'param([string]$LockPath)\n$fixtureLock = [IO.File]::Open($LockPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)\ntry { [Console]::WriteLine("LOCK_READY"); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $fixtureLock.Dispose() }\n');
  lockProcess=spawn('powershell.exe',['-NoProfile','-File',lockScript,'-LockPath',executable],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('Fixture lock did not become ready')),10000);lockProcess.stdout.on('data',chunk=>{output+=chunk.toString();if(output.includes('LOCK_READY')){clearTimeout(timer);resolve();}});lockProcess.once('error',error=>{clearTimeout(timer);reject(error);});lockProcess.once('exit',code=>{clearTimeout(timer);reject(new Error(`Fixture lock exited early: ${code}`));});});
  await run(coordinator,['commit',target],5);await intact();assert(await exists(transaction));
  await run(coordinator,['recover',target]);await intact();assert(!(await exists(transaction)));
  lockProcess.stdin.end('\n');await new Promise(resolve=>lockProcess.once('exit',resolve));lockProcess=undefined;
  checks.push('real Windows deny-delete file handle refuses promotion and recovery preserves the entire prior installation while the lock is held');
  app=await electron.launch({executablePath:executable,env,timeout:30000});page=await app.firstWindow();assert.deepEqual((await page.evaluate(()=>window.countryClub.loadRound())).state,saved.state);await app.close();app=undefined;
  checks.push('old installed application reopens with exact acknowledged drag shot after interrupted and refused replacement');
  await run(path.join(target,'Uninstall Claude Country Club.exe'),['/S']);await expect.poll(()=>exists(executable),{timeout:30000}).toBe(false);assert.equal(registration(),null);await privateUnchanged();assert(await exists(path.join(data,'country-club.sqlite')));
  checks.push('Unicode, spaces and ampersand fixture path supports packaged launch, recovery and clean uninstall with progress retained');
  await writeFile(path.join(work,'result.json'),JSON.stringify({passed:true,installer,sha256:await digest(installer),checks,limitations:['Running-uninstall refusal is measured through a byte-identical copied uninstaller and the documented _?= target option, so the final exit is synchronous; the ordinary launcher exit is not the operation result.','The app runs with an isolated test profile; production single-instance delivery and the interactive installer close request remain separate checks.','Partial extraction is constructed through the bundled coordinator; no native wizard Cancel is clicked during extraction.','File-lock refusal is a real Windows filesystem fault; physical disk-full, power loss and a clean OS profile remain unverified.']},null,2));
  console.log('Native installer interruption acceptance passed.');
}catch(error){await writeFile(path.join(work,'result.json'),JSON.stringify({passed:false,error:String(error),checks,target},null,2));throw error;}
finally{if(lockProcess&&lockProcess.exitCode===null&&lockProcess.signalCode===null){lockProcess.stdin.end('\n');await new Promise(resolve=>{const timer=setTimeout(()=>{lockProcess.kill();resolve();},10000);lockProcess.once('exit',()=>{clearTimeout(timer);resolve();});});}await app?.close().catch(()=>{});}
