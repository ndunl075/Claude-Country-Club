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
const work=path.resolve('work/installer-cancel'); await mkdir(work,{recursive:true});
const profile=await mkdtemp(path.join(work,'profile-'));
const target=path.join(profile,'Mini golf & café Ω'), executable=path.join(target,'Claude Country Club.exe');
const installer=path.resolve('release/Claude-Country-Club-Setup-0.1.0-x64.exe');
const data=path.join(profile,'data'),home=path.join(profile,'home');
const exists=p=>access(p).then(()=>true,()=>false);
const digest=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
function registration(){
  const raw=execFileSync('powershell.exe',['-NoProfile','-Command',"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^Claude Country Club(?: [0-9].*)?$' } | Select-Object PSChildName,UninstallString,DisplayVersion | ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true}).trim();
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
const checks=[];let app,installed=false;
async function run(file,args,{cancel=false}={}){
  const child=spawn(file,args,{windowsHide:!cancel,windowsVerbatimArguments:true,stdio:'inherit'});
  if(cancel){await writeFile(path.join(work,'live.json'),JSON.stringify({phase:installed?'existing-install-cancel':'fresh-install-cancel',pid:child.pid,installer,target,profile},null,2));console.log(`Native wizard ready for cancellation: ${installed?'existing install':'fresh install'} (PID ${child.pid}).`);}
  const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Native installer observation exceeded five minutes; inspect its live handle before retrying')),300000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);resolve(code);});});
  assert.equal(code,cancel?1:0,`Unexpected installer exit: ${code}`);
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
  await run(installer,['/REPAIR',`/D=${target}`],{cancel:true});
  assert.deepEqual(registration(),oldRegistration);assert.equal(await digest(executable),oldExecutable);assert.equal(await digest(path.join(data,'country-club.sqlite')),oldSave);assert(!(await exists(target+'.ccc-transaction')));await verifyPrivate();
  checks.push('native existing-install Cancel preserves executable, registration, exact SQLite bytes and fixture provider files');
  app=await electron.launch({executablePath:executable,env,timeout:30000});const restored=await app.firstWindow();
  assert.deepEqual((await restored.evaluate(()=>window.countryClub.loadRound())).state,round.state);await app.close();app=undefined;
  checks.push('existing installation remains playable with exact acknowledged drag shot after cancellation');
  await run(path.join(target,'Uninstall Claude Country Club.exe'),['/S']);installed=false;await expect.poll(()=>exists(executable),{timeout:30000}).toBe(false);assert.equal(registration(),null);await verifyPrivate();
  checks.push('fixture installs and uninstalls at a path with spaces, ampersand and accented/Greek characters');
  await writeFile(path.join(work,'result.json'),JSON.stringify({passed:true,installer,sha256:await digest(installer),checks,limitations:['Cancellation is exercised before file extraction begins; cancellation during extraction and physical disk-full/power-loss remain unverified.','Uses the current Windows account with an isolated application data/provider home fixture; this is not a clean-profile certification.']},null,2));
  console.log('Native installer cancellation acceptance passed.');
}catch(error){await writeFile(path.join(work,'result.json'),JSON.stringify({passed:false,error:String(error),checks,fixtureInstalled:installed,target},null,2));throw error;}
finally{await app?.close().catch(()=>{});}

