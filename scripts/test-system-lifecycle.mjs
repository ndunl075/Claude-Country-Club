import { _electron as electron,expect } from 'playwright/test';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { dragShot } from './play-input.mjs';
assert(process.env.CCC_EXECUTABLE,'Set CCC_EXECUTABLE to the packaged application');
const artifacts=path.resolve('work/system-lifecycle');await mkdir(artifacts,{recursive:true});
const profile=await mkdtemp(path.join(artifacts,'profile-')),data=path.join(profile,'data'),home=path.join(profile,'home');
const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:data,CCC_TEST_HOME:home};delete env.ELECTRON_RUN_AS_NODE;
const helper=process.platform==='darwin'?path.resolve(path.dirname(process.env.CCC_EXECUTABLE),'../Resources/ccc-hook'):path.join(path.dirname(process.env.CCC_EXECUTABLE),'resources/ccc-hook.exe');
let app;const checks=[];const pause=ms=>new Promise(r=>setTimeout(r,ms));
const visible=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible()));
const emit=name=>app.evaluate(({powerMonitor},name)=>powerMonitor.emit(name),name);
async function hook(kind,turn){
  const child=spawn(helper,['--provider','codex','--event',kind,'--config',path.join(data,'connection.json')],{windowsHide:true,stdio:'pipe'});let output='';
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  child.stdin.end(JSON.stringify({session_id:'system-fixture',cwd:home,turn_id:turn}));
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(`Hook exit ${code}`)));});assert.equal(output,'');
}
try{
  app=await electron.launch({executablePath:process.env.CCC_EXECUTABLE,env,timeout:30000});const page=await app.firstWindow();
  await expect.poll(async()=>(await page.evaluate(()=>window.countryClub.getState())).brokerReady).toBe(true);
  await page.evaluate(async()=>{await window.countryClub.setSettings({automatic:true,delayMs:1000});await window.countryClub.hide();});
  await hook('start','before-sleep');await expect.poll(visible).toBe(true);
  await dragShot(page,{angle:180,power:45});await expect.poll(async()=>(await page.evaluate(()=>window.countryClub.loadRound()))?.state.shotId).toBe(1);
  await emit('suspend');await expect.poll(visible).toBe(false);
  let frozen=(await page.evaluate(()=>window.countryClub.loadRound())).state;
  assert.equal(frozen.shotId,1);assert.equal((await page.evaluate(()=>window.countryClub.getState())).suspended,true);
  await pause(300);assert.deepEqual((await page.evaluate(()=>window.countryClub.loadRound())).state,frozen);
  checks.push('suspend freezes an acknowledged shot, saves exact state and hides');
  await hook('start','during-sleep');await pause(1250);
  assert.equal(await visible(),false,'Fresh lifecycle during system suspension reopened the game');
  assert((await page.evaluate(()=>window.countryClub.getState())).sessions.every(s=>s.state==='unknown'&&!s.reliable));
  await page.evaluate(()=>window.countryClub.practice());assert.equal(await visible(),false,'Practice reopened during system suspension');
  await emit('resume');await hook('activity','during-sleep');await hook('start','during-sleep');await pause(1250);
  assert.equal(await visible(),false,'Stale sleep turn replay reopened after resume');
  assert.deepEqual((await page.evaluate(()=>window.countryClub.loadRound())).state,frozen);
  checks.push('events and practice cannot show while suspended; resume/activity/replayed sleep-turn cannot restore eligibility');
  await hook('start','after-sleep');await expect.poll(visible).toBe(true);
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFocused()),false);
  await emit('lock-screen');await expect.poll(visible).toBe(false);frozen=(await page.evaluate(()=>window.countryClub.loadRound())).state;
  await hook('start','while-locked');await pause(1250);assert.equal(await visible(),false,'Locked session reopened');
  await emit('suspend');await emit('resume');await hook('start','awake-still-locked');await pause(1250);assert.equal(await visible(),false,'Resume cleared screen-lock hold');
  await emit('unlock-screen');await hook('start','awake-still-locked');await hook('activity','while-locked');await pause(1250);assert.equal(await visible(),false);
  assert.deepEqual((await page.evaluate(()=>window.countryClub.loadRound())).state,frozen);
  checks.push('screen lock suppresses automatic play across sleep/resume and stale-turn replay without changing saved state');
  await hook('start','after-unlock');await expect.poll(visible).toBe(true);await hook('stop','after-unlock');await expect.poll(visible).toBe(false);
  await hook('start','delay-before-sleep');assert.equal(await visible(),false);await emit('suspend');await pause(1250);assert.equal(await visible(),false);
  await emit('resume');await pause(1250);assert.equal(await visible(),false);
  checks.push('fresh post-unlock lifecycle works; suspend during eligibility delay cancels pending show across resume');
  await page.evaluate(()=>window.countryClub.practice());await expect.poll(visible).toBe(true);await emit('suspend');await expect.poll(visible).toBe(false);
  await emit('resume');assert.equal((await page.evaluate(()=>window.countryClub.getState())).practice,false);assert.equal(await visible(),false);
  checks.push('local practice also pauses on suspend and requires explicit re-entry after resume');
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,packaged:true,checks,limitations:['Electron powerMonitor events are emitted inside this isolated application; the physical OS is never suspended or locked. Physical sleep/wake and platform notification delivery remain unverified.','Synthetic provider payloads use the real native helper/IPC; signed-in client certification remains open.']},null,2));
  console.log('Packaged system lifecycle acceptance passed.');
}catch(error){await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:false,error:String(error),checks},null,2));throw error;}
finally{await app?.close().catch(()=>{});}
