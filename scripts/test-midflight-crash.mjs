// Packaged Windows durability acceptance. Only owned fixture processes are killed.
import { _electron as electron, expect } from 'playwright/test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import path from 'node:path';
import { dragShot } from './play-input.mjs';
import { observeRoundWrites, readRoundWrites } from './round-write-evidence.mjs';

assert.equal(process.platform,'win32','Owned process-tree termination is Windows-specific');
const executable=path.resolve(process.env.CCC_EXECUTABLE??'release/win-unpacked/Claude Country Club.exe');
const artifacts=path.resolve('work/midflight-crash');await mkdir(artifacts,{recursive:true});
const sha256=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const evidence={passed:false,executable,executableSha256:await sha256(executable),archiveSha256:await sha256(path.join(path.dirname(executable),'resources/app.asar')),cases:[],limitations:['The renderer is debugger-paused after an acknowledged moving shot to make the durable checkpoint comparison deterministic.','Forced process termination exercises SQLite WAL recovery; it does not simulate physical power loss or disk failure.','Private profiles and provider homes only; no real signed-in client or native Mac behavior is certified.']};
let application,cdp,ownedProcess,ownedIdentity;
async function launch(data,home){
  const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:data,CCC_TEST_HOME:home};delete env.ELECTRON_RUN_AS_NODE;
  application=await electron.launch({executablePath:executable,env,timeout:30000});ownedProcess=application.process();
  ownedIdentity=await application.evaluate(()=>({pid:process.pid,executable:process.execPath,data:process.env.CCC_DATA_DIR,testMode:process.env.CCC_TEST_MODE}));
  assert.equal(ownedIdentity.testMode,'1');assert.equal(ownedIdentity.data,data);
  assert.equal(path.resolve(ownedIdentity.executable).toLowerCase(),executable.toLowerCase());
  const page=await application.firstWindow();
  await expect(page.getByRole('button',{name:'Play local practice',exact:true})).toBeVisible();
  return page;
}
function durable(data){
  const database=new DatabaseSync(path.join(data,'country-club.sqlite'),{readOnly:true});
  try{const row=database.prepare('SELECT revision,state FROM round_save WHERE id=1').get();return {revision:row.revision,state:JSON.parse(row.state)};}finally{database.close();}
}
function journal(data){
  const database=new DatabaseSync(path.join(data,'country-club.sqlite'),{readOnly:true});
  try{return database.prepare('SELECT round_id,shot_id,state FROM shots ORDER BY round_id,shot_id').all().map(row=>({...row}));}finally{database.close();}
}
async function terminateOwned(){
  assert(ownedProcess&&ownedProcess.pid>0&&ownedProcess.exitCode===null,'No live owned process');
  // Playwright may own a cmd.exe launcher on Windows. Target only the actual
  // Electron PID obtained from its private, identity-checked inspector.
  assert.deepEqual(await application.evaluate(()=>({pid:process.pid,executable:process.execPath,data:process.env.CCC_DATA_DIR,testMode:process.env.CCC_TEST_MODE})),ownedIdentity);
  const exited=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned process did not exit')),10000);ownedProcess.once('exit',()=>{clearTimeout(timer);resolve();});});
  execFileSync('taskkill.exe',['/PID',String(ownedIdentity.pid),'/T','/F'],{windowsHide:true,stdio:'pipe',timeout:10000});
  await exited;
  application=undefined;ownedProcess=undefined;cdp=undefined;
}
try{
  for(const kind of ['renderer-crash','process-tree-kill']){
    const fixture=await mkdtemp(path.join(artifacts,'profile-')),data=path.join(fixture,'data'),home=path.join(fixture,'home');await mkdir(home,{recursive:true});
    let page=await launch(data,home);await observeRoundWrites(application);
    await page.getByRole('button',{name:'Play local practice',exact:true}).click();
    await dragShot(page,{angle:180,power:70});
    await expect.poll(async()=>(await page.evaluate(()=>window.countryClub.loadRound()))?.state?.shotId).toBe(1);
    cdp=await page.context().newCDPSession(page);await cdp.send('Debugger.enable');
    const paused=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Renderer pause was not observed')),10000);cdp.once('Debugger.paused',()=>{clearTimeout(timer);resolve();});});await cdp.send('Debugger.pause');await paused;
    const before=durable(data),writes=await readRoundWrites(application),initialJournal=journal(data);
    assert.equal(before.state.shotId,1);assert.equal(before.state.strokes,1);
    assert(Math.hypot(before.state.velocity.x,before.state.velocity.y)>0,'Fixture settled before failure; mid-flight coverage not achieved');
    assert.equal(writes.dropped,0);assert(writes.writes.some(write=>write.acknowledgedRevision===before.revision),'Checkpoint lacks observed acknowledgement');
    assert.equal(initialJournal.length,1);assert.equal(initialJournal[0].shot_id,1);assert.equal(JSON.parse(initialJournal[0].state).strokes,1);
    if(kind==='renderer-crash'){
      await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());cdp=undefined;
      await expect.poll(()=>application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible()))).toBe(true);
      assert.deepEqual(durable(data),before,'Renderer failure altered durable progress');
      const reopened=application.waitForEvent('window');await application.evaluate(({app})=>app.emit('activate'));page=await reopened;
      await expect(page.getByRole('button',{name:'Play local practice',exact:true})).toBeVisible();
    }else{
      await terminateOwned();assert.deepEqual(durable(data),before,'Forced termination altered acknowledged progress');page=await launch(data,home);
    }
    assert.deepEqual(await page.evaluate(()=>window.countryClub.loadRound()),before,'Reopen failed exact checkpoint recovery');
    assert.deepEqual(journal(data),initialJournal,'Failure altered the initial shot journal');
    await expect(page.getByRole('application')).toHaveAttribute('aria-disabled','true');
    await page.getByRole('button',{name:'Play local practice',exact:true}).click();
    await expect.poll(async()=>{const saved=await page.evaluate(()=>window.countryClub.loadRound());return saved.state.velocity.x===0&&saved.state.velocity.y===0;},{timeout:20000}).toBe(true);
    const settled=await page.evaluate(()=>window.countryClub.loadRound());assert.equal(settled.state.shotId,1);assert.equal(settled.state.strokes,1);assert(settled.revision>before.revision);
    assert.deepEqual(journal(data),initialJournal,'Resume duplicated or replaced the initial shot journal');
    evidence.cases.push({kind,fixture,before,settled,writes,journal:{count:initialJournal.length,sha256:createHash('sha256').update(JSON.stringify(initialJournal)).digest('hex')},checks:['real pointer shot acknowledged while moving','exact durable checkpoint retained across failure','reopen stays frozen until explicit practice','resumed shot settles without duplicate stroke','initial shot journal remains byte-exact without duplication']});
    await application.close();application=undefined;ownedProcess=undefined;
    await writeFile(path.join(artifacts,'result.json'),JSON.stringify(evidence,null,2));
  }
  evidence.passed=true;console.log('Packaged mid-flight renderer/process crash recovery passed.');
}catch(error){evidence.error=String(error);throw error;}
finally{
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify(evidence,null,2));
  await cdp?.send('Debugger.resume').catch(()=>{});
  if(application)await application.close().catch(()=>{});
}
