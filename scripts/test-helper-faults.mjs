import { _electron as electron, expect } from 'playwright/test';
import { mkdir, mkdtemp, cp, rename, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { dragShot } from './play-input.mjs';

assert.equal(process.platform,'win32','This damaged-executable fixture is Windows-specific');
assert(process.env.CCC_EXECUTABLE,'Set CCC_EXECUTABLE to the packaged application');
const artifacts=path.resolve('work/helper-faults');await mkdir(artifacts,{recursive:true});
const fixture=await mkdtemp(path.join(artifacts,'fixture-'));
const payload=path.join(fixture,'application'),executable=path.join(payload,path.basename(process.env.CCC_EXECUTABLE));
const helper=path.join(payload,'resources','ccc-hook.exe'),backup=`${helper}.fixture-backup`;
const checks=[];let app,helperMoved=false;
try{
  // Mutate only a private package copy; never the release or installed binary.
  await cp(path.dirname(process.env.CCC_EXECUTABLE),payload,{recursive:true});
  await rename(helper,backup);helperMoved=true;
  for(const mode of ['missing','damaged']){
    if(mode==='damaged')await writeFile(helper,Buffer.from([0,1,2,3]));
    const profile=path.join(fixture,mode);
    const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:path.join(profile,'data'),CCC_TEST_HOME:path.join(profile,'home')};delete env.ELECTRON_RUN_AS_NODE;
    app=await electron.launch({executablePath:executable,env,timeout:30000});let page=await app.firstWindow();
    await expect.poll(async()=> (await page.evaluate(()=>window.countryClub.getState())).diagnostics.some(d=>d.code==='BROKER_UNAVAILABLE'||d.code==='BROKER_STOPPED')).toBe(true);
    const host=await page.evaluate(()=>window.countryClub.getState());
    assert.equal(host.brokerReady,false);assert.equal(host.settings.automatic,false);assert.equal(host.settings.sound,false);assert.equal(host.settings.startAtLogin,false);
    await page.getByRole('button',{name:'Play local practice',exact:true}).click();await dragShot(page);
    await expect.poll(async()=> (await page.evaluate(()=>window.countryClub.loadRound()))?.state?.shotId).toBe(1);
    await page.evaluate(()=>window.countryClub.hide());
    const saved=await page.evaluate(()=>window.countryClub.loadRound());
    await app.close();app=undefined;
    if(mode==='damaged')await rm(helper);
    await rename(backup,helper);helperMoved=false;
    app=await electron.launch({executablePath:executable,env,timeout:30000});page=await app.firstWindow();
    await expect.poll(async()=> (await page.evaluate(()=>window.countryClub.getState())).brokerReady).toBe(true);
    assert.deepEqual((await page.evaluate(()=>window.countryClub.loadRound())).state,saved.state);
    assert.equal((await page.evaluate(()=>window.countryClub.getState())).sessions.length,0);
    checks.push({mode,passed:true,diagnosticCodes:host.diagnostics.map(d=>d.code),savedShotId:saved.state.shotId,restoredBroker:true});
    await app.close();app=undefined;
    await rename(helper,backup);helperMoved=true;
  }
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,packaged:true,checks,limitations:['Private package copy and isolated data only. Does not certify provider behavior when a configured hook command is missing.']},null,2));
  console.log('Packaged missing/damaged helper acceptance passed.');
}catch(error){await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:false,error:String(error),checks},null,2));throw error;}
finally{
  if(app){
    // A fatal native startup modal can block graceful close. Bound cleanup to
    // this test's own Electron child; never find or kill unrelated processes.
    const timer=setTimeout(()=>app.process().kill(),5000);
    try{await app.close().catch(()=>{});}finally{clearTimeout(timer);}
  }
  if(helperMoved)await rename(backup,helper).catch(()=>{});
  // Checked fixed child of this invocation's private fixture directory.
  assert(path.dirname(payload)===fixture&&fixture.startsWith(`${artifacts}${path.sep}`));
  await rm(payload,{recursive:true,force:true});
}
