import { _electron as electron, expect } from 'playwright/test';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { dragShot } from './play-input.mjs';
assert(process.env.CCC_EXECUTABLE,'Set CCC_EXECUTABLE to the packaged application');
const artifacts=path.resolve('work/broker-crash');await mkdir(artifacts,{recursive:true});
const profile=await mkdtemp(path.join(artifacts,'profile-')),data=path.join(profile,'data'),home=path.join(profile,'home');
const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:data,CCC_TEST_HOME:home};delete env.ELECTRON_RUN_AS_NODE;
const helper=process.platform==='darwin'?path.resolve(path.dirname(process.env.CCC_EXECUTABLE),'../Resources/ccc-hook'):path.join(path.dirname(process.env.CCC_EXECUTABLE),'resources','ccc-hook.exe');
let app;const checks=[];
const visible=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]?.isVisible()??false);
async function crashBroker(){
  const terminated=await app.evaluate((_electron,helper)=>{
    const matches=process._getActiveHandles().filter(h=>h.spawnfile===helper&&h.spawnargs?.includes('--serve'));
    if(matches.length!==1)throw Error(`Expected one owned broker; found ${matches.length}`);
    return matches[0].kill();
  },helper);assert.equal(terminated,true);
}
async function hook(kind,turn='before-crash'){
  const child=spawn(helper,['--provider','codex','--event',kind,'--config',path.join(data,'connection.json')],{windowsHide:true,stdio:'pipe'});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  child.stdin.end(JSON.stringify({session_id:'broker-crash-fixture',turn_id:turn,cwd:home}));
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(`Hook exit ${code}`)));});assert.equal(output,'');
}
try{
  app=await electron.launch({executablePath:process.env.CCC_EXECUTABLE,env,timeout:30000});let page=await app.firstWindow();
  await expect.poll(async()=>(await page.evaluate(()=>window.countryClub.getState())).brokerReady).toBe(true);
  await page.evaluate(async()=>{await window.countryClub.setSettings({automatic:true,delayMs:1000});await window.countryClub.selectSession(null);await window.countryClub.hide();});
  await hook('start');await expect.poll(visible).toBe(true);
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFocused()),false);
  await dragShot(page,{angle:180,power:45});
  await expect.poll(async()=>(await page.evaluate(()=>window.countryClub.loadRound()))?.state?.shotId).toBe(1);
  const inFlight=(await page.evaluate(()=>window.countryClub.loadRound())).state;
  assert(Math.hypot(inFlight.velocity.x,inFlight.velocity.y)>0,'Crash must occur during an in-flight shot');
  // Select only the actual ChildProcess owned by this isolated Electron host.
  // No PID scanning or production test hook is needed to crash its broker.
  await crashBroker();
  await expect.poll(visible).toBe(false);
  const host=await page.evaluate(()=>window.countryClub.getState());
  assert.equal(host.brokerReady,false);assert(host.sessions.every(s=>s.state==='unknown'));
  assert(host.diagnostics.some(d=>d.code==='BROKER_STOPPED'));
  const frozen=(await page.evaluate(()=>window.countryClub.loadRound())).state;
  assert.equal(frozen.shotId,1);assert.equal(frozen.strokes,1);
  await new Promise(r=>setTimeout(r,350));assert.deepEqual((await page.evaluate(()=>window.countryClub.loadRound())).state,frozen);
  checks.push('actual owned broker termination freezes, saves and hides active automatic play');
  await hook('activity');await hook('stop');assert.equal(await visible(),false);
  checks.push('disconnected hook invocations exit zero silently and cannot reopen the game');
  await app.close();app=await electron.launch({executablePath:process.env.CCC_EXECUTABLE,env,timeout:30000});page=await app.firstWindow();
  await expect.poll(async()=>(await page.evaluate(()=>window.countryClub.getState())).brokerReady).toBe(true);
  assert.deepEqual((await page.evaluate(()=>window.countryClub.loadRound())).state,frozen);
  const restarted=await page.evaluate(()=>window.countryClub.getState());assert.equal(restarted.sessions.length,0);assert.equal(restarted.suspended,true);
  await page.evaluate(()=>window.countryClub.hide());await new Promise(r=>setTimeout(r,1250));assert.equal(await visible(),false);
  checks.push('restart restores the exact saved round without restoring working-session eligibility');
  await hook('start','fresh-after-crash');await expect.poll(visible).toBe(true);
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFocused()),false);
  await hook('stop','fresh-after-crash');await expect.poll(visible).toBe(false);
  checks.push('fresh native lifecycle after restart shows inactive and stops normally');
  await hook('start','crash-during-delay');
  await expect.poll(async()=>(await page.evaluate(()=>window.countryClub.getState())).sessions.some(s=>s.state==='working')).toBe(true);
  assert.equal(await visible(),false,'Eligibility-delay crash fixture must begin hidden');
  await crashBroker();
  await expect.poll(async()=>(await page.evaluate(()=>window.countryClub.getState())).brokerReady).toBe(false);
  await new Promise(r=>setTimeout(r,1250));assert.equal(await visible(),false,'Stale eligibility timer reopened after broker failure');
  assert((await page.evaluate(()=>window.countryClub.getState())).sessions.every(s=>s.state==='unknown'));
  checks.push('broker crash during eligibility delay cancels the pending automatic show');
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,packaged:true,checks,limitations:['Synthetic provider payloads over real IPC; no signed-in provider certification or physical OS crash/power-loss certification.']},null,2));
  console.log('Packaged broker crash acceptance passed.');
}catch(error){await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:false,error:String(error),checks},null,2));throw error;}
finally{await app?.close().catch(()=>{});}
