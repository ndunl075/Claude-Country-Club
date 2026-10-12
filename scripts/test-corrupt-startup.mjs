// Interactive packaged acceptance: a human or native UI test driver must press
// the real recovery dialog buttons. There is deliberately no auto-reset flag.
import { _electron as electron, expect } from 'playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),artifacts=path.join(root,'work/corrupt-startup');await mkdir(artifacts,{recursive:true});
const fixture=await mkdtemp(path.join(artifacts,'profile-')),data=path.join(fixture,'data'),home=path.join(fixture,'home');
await mkdir(data);await mkdir(home);
const originals=new Map(['country-club.sqlite','country-club.sqlite-wal','country-club.sqlite-shm'].map(name=>[name,Buffer.from(`damaged-fixture:${name}`)]));
for(const [name,bytes]of originals)await writeFile(path.join(data,name),bytes);
await writeFile(path.join(data,'unrelated-config.json'),'preserve unrelated configuration');
await mkdir(path.join(home,'.codex'));await writeFile(path.join(home,'.codex/auth.json'),'fixture-auth-never-read');
const executablePath=process.env.CCC_EXECUTABLE||path.join(root,'release/win-unpacked/Claude Country Club.exe');
const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:data,CCC_TEST_HOME:home};delete env.ELECTRON_RUN_AS_NODE;
const checks=[];let application,child;
async function phase(value){await writeFile(path.join(artifacts,'phase.json'),JSON.stringify({phase:value,fixture,executablePath,time:new Date().toISOString()},null,2));console.log(value);}
async function rawLaunch(args){
  child=spawn(executablePath,args,{env,windowsHide:args.includes('--ccc-background'),stdio:'ignore'});
  const owned=child;
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Native startup test exceeded 120 seconds')),120_000);owned.once('error',e=>{clearTimeout(timer);reject(e);});owned.once('exit',code=>{clearTimeout(timer);child=undefined;code===0?resolve():reject(new Error(`App exited ${code}`));});});
}
async function originalFiles(){for(const [name,bytes]of originals)assert((await readFile(path.join(data,name))).equals(bytes),`${name} changed before confirmation`);}
async function noRecovery(){assert(!(await readdir(data)).some(name=>name.startsWith('database-recovery-')||name.startsWith('.storage-check-')||name==='storage-recovery.json'),'Recovery artifacts created before confirmation');}
try {
  await phase('background-start');await rawLaunch(['--ccc-background']);await originalFiles();
  await noRecovery();
  checks.push('background corruption exits without dialogs, recovery folders or original database changes (Electron may create its normal caches)');
  await phase('awaiting-native-cancel');await rawLaunch([]);await originalFiles();
  await noRecovery();
  checks.push('real native cancel preserves the complete damaged SQLite family');
  await phase('awaiting-native-confirm');
  application=await electron.launch({executablePath,args:[],env,timeout:120_000});
  const page=await application.firstWindow();
  await expect(page.getByRole('region',{name:'Mini golf game',exact:true})).toBeVisible({timeout:120_000});
  const state=await page.evaluate(()=>window.countryClub.getState());assert.equal(state.settings.automatic,false);assert.equal(state.settings.sound,false);assert.equal(state.settings.startAtLogin,false);
  assert.equal(await page.evaluate(()=>window.countryClub.loadRound()),null);
  assert(state.diagnostics.some(entry=>entry.code==='STORAGE_RECOVERED'));
  const folders=(await readdir(data)).filter(name=>name.startsWith('database-recovery-'));assert.equal(folders.length,1);
  for(const [name,bytes]of originals)assert((await readFile(path.join(data,folders[0],name))).equals(bytes),`${name} archive changed`);
  assert.equal(await readFile(path.join(data,'unrelated-config.json'),'utf8'),'preserve unrelated configuration');
  assert.equal(await readFile(path.join(home,'.codex/auth.json'),'utf8'),'fixture-auth-never-read');
  await page.getByRole('button',{name:'Play local practice',exact:true}).click();
  await page.evaluate(()=>window.countryClub.hide());assert.equal((await page.evaluate(()=>window.countryClub.loadRound())).state.strokes,0);
  checks.push('real native confirmation preserves every original file and starts a usable quiet fresh store');
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,packaged:true,time:new Date().toISOString(),executablePath,checks},null,2));
  await phase('passed');
}catch(error){await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:false,time:new Date().toISOString(),checks,error:String(error)},null,2));throw error;}
finally {if(application)await application.close().catch(()=>{});child?.kill();}
