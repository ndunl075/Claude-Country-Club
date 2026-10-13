// Native wizard cancellation acceptance. UI actions are performed separately
// through the Computer Use skill; this harness owns only the workspace fixture.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { _electron as electron, expect } from 'playwright/test';
import { dragShot } from './play-input.mjs';
assert.equal(process.platform,'win32');
assert(process.argv.includes('--manual'),'Manual-only candidate: run with --manual and observe each native wizard. Not a CI acceptance gate.');
const repairComplete=process.argv.includes('--repair-complete');
const work=path.resolve('work/installer-cancel'); await mkdir(work,{recursive:true});
const profile=await mkdtemp(path.join(work,'profile-'));
const target=path.join(profile,'Mini golf & café Ω'), executable=path.join(target,'Claude Country Club.exe');
const installer=path.resolve('release/Claude-Country-Club-Setup-0.1.0-x64.exe');
const data=path.join(profile,'data'),home=path.join(profile,'home');
const exists=p=>access(p).then(()=>true,()=>false);
const digest=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
function registration(){
  const raw=execFileSync('powershell.exe',['-NoProfile','-Command',"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^Claude Country Club(?: [0-9].*)?$' } | Select-Object PSChildName,UninstallString,DisplayVersion | ConvertTo-Json -Compress; exit 0"],{encoding:'utf8',windowsHide:true}).trim();
  if(!raw)return null;
  const record=JSON.parse(raw);assert(!Array.isArray(record),'Ambiguous existing installation preserved');
  const uninstall=/^"([^"]+)"/.exec(record.UninstallString??'')?.[1];
  assert(uninstall&&path.dirname(uninstall).toLowerCase()===target.toLowerCase(),'Existing installation outside fixture preserved');return record;
}
assert.equal(registration(),null,'Start with no registered Country Club installation');
assert(!(await exists(path.join(process.env.APPDATA,'Claude Country Club','config-patches.json'))),'Live ledger exists; use a disposable account');
assert(!(await exists(target))&&!(await exists(target+'.ccc-transaction')),'Existing fixture preserved; use a fresh target');
await mkdir(path.join(home,'.codex'),{recursive:true});await mkdir(path.join(home,'.claude'),{recursive:true});
const fixtures=[path.join(home,'.codex','auth.json'),path.join(home,'.codex','hooks.json'),path.join(home,'.claude','settings.json')];
await writeFile(fixtures[0],'{"fixture-auth":"never-read-by-installer"}\n');
await writeFile(fixtures[1],'{"hooks":{},"fixture":"keep-byte-exact"}\n');
await writeFile(fixtures[2],'{"fixture":"keep-byte-exact"}\n');
const fixtureHashes=await Promise.all(fixtures.map(digest));
async function verifyPrivate(){assert.deepEqual(await Promise.all(fixtures.map(digest)),fixtureHashes);}
const checks=[],outcomes=[];let app,installed=false,reference;
async function run(file,args,{cancel=false,expectedCode=cancel?1:0}={}){
  const child=spawn(file,args,{windowsHide:!cancel,windowsVerbatimArguments:true,stdio:'inherit'});
  if(cancel){await writeFile(path.join(work,'live.json'),JSON.stringify({phase:installed?(repairComplete?'existing-install-repair':'existing-install-cancel'):'fresh-install-cancel',pid:child.pid,installer,target,profile},null,2));console.log(`Native wizard ready: ${installed?(repairComplete?'complete repair':'existing-install cancellation'):'fresh-install cancellation'} (PID ${child.pid}).`);}
  const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Native installer observation exceeded five minutes; inspect its live handle before retrying')),300000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);resolve(code);});});
  outcomes.push({pid:child.pid,code,cancel,expectedCode,existingInstall:installed,time:new Date().toISOString()});
  await writeFile(path.join(profile,'native-outcomes.json'),JSON.stringify(outcomes,null,2));
  assert.equal(code,expectedCode,`Unexpected installer exit: ${code}`);
}
try{
  await run(installer,[`/D=${target}`],{cancel:true});
  assert.equal(registration(),null);assert(!(await exists(executable)));assert(!(await exists(target+'.ccc-transaction')));await verifyPrivate();
  checks.push('native fresh-install Cancel exits 1 without installing, registering or touching fixture provider files');
  await run(installer,['/S',`/D=${target}`]);installed=true;assert.equal(registration().DisplayVersion,'0.1.0');
  const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:data,CCC_TEST_HOME:home};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:executable,env,timeout:30000});const page=await app.firstWindow();
  await page.getByRole('button',{name:'Play local practice',exact:true}).click();await dragShot(page,{angle:180,power:15});
  await expect.poll(async()=>{const saved=await page.evaluate(()=>window.countryClub.loadRound());return saved?.state?.shotId===1&&saved.state.velocity.x===0&&saved.state.velocity.y===0;},{timeout:15000}).toBe(true);
  await page.evaluate(()=>window.countryClub.hide());const round=await page.evaluate(()=>window.countryClub.loadRound());await app.close();app=undefined;
  const oldRegistration=registration(),oldExecutable=await digest(executable),oldSave=await digest(path.join(data,'country-club.sqlite'));
  reference={registration:oldRegistration,executableSha256:oldExecutable,saveSha256:oldSave,providerSha256:fixtureHashes};
  await writeFile(path.join(profile,'reference.json'),JSON.stringify(reference,null,2));
  await run(installer,['/REPAIR',`/D=${target}`],{cancel:true,expectedCode:repairComplete?0:1});
  assert.deepEqual(registration(),oldRegistration);assert.equal(await digest(executable),oldExecutable);assert.equal(await digest(path.join(data,'country-club.sqlite')),oldSave);assert(!(await exists(target+'.ccc-transaction')));await verifyPrivate();
  checks.push(repairComplete?'native same-version repair completes and preserves executable, registration, exact SQLite bytes and fixture provider files':'native existing-install Cancel preserves executable, registration, exact SQLite bytes and fixture provider files');
  app=await electron.launch({executablePath:executable,env,timeout:30000});const restored=await app.firstWindow();
  assert.deepEqual((await restored.evaluate(()=>window.countryClub.loadRound())).state,round.state);await app.close();app=undefined;
  checks.push(`existing installation remains playable with exact acknowledged drag shot after ${repairComplete?'native repair':'cancellation'}`);
  await run(path.join(target,'Uninstall Claude Country Club.exe'),['/S']);installed=false;await expect.poll(()=>exists(executable),{timeout:30000}).toBe(false);assert.equal(registration(),null);await verifyPrivate();
  checks.push('fixture installs and uninstalls at a path with spaces, ampersand and accented/Greek characters');
  await writeFile(path.join(work,repairComplete?'repair-result.json':'result.json'),JSON.stringify({passed:true,mode:repairComplete?'native-repair':'native-cancel',installer,sha256:await digest(installer),profile,outcomes,reference,checks,limitations:['Cancellation is exercised before file extraction begins; cancellation during extraction and physical disk-full/power-loss remain unverified.','Uses the current Windows account with an isolated application data/provider home fixture; this is not a clean-profile certification.']},null,2));
  console.log(`Native installer ${repairComplete?'repair':'cancellation'} acceptance passed.`);
}catch(error){
  const postFailure=reference?{registration:registration(),executableSha256:await digest(executable).catch(()=>null),saveSha256:await digest(path.join(data,'country-club.sqlite')).catch(()=>null),providerSha256:await Promise.all(fixtures.map(file=>digest(file).catch(()=>null)))}:null;
  await writeFile(path.join(work,repairComplete?'repair-result.json':'result.json'),JSON.stringify({passed:false,mode:repairComplete?'native-repair':'native-cancel',error:String(error),checks,fixtureInstalled:installed,target,profile,outcomes,reference,postFailure},null,2));throw error;
}
finally{await app?.close().catch(()=>{});}

