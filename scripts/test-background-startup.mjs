import { _electron as electron,expect } from 'playwright/test';
import { mkdir,mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { spawn,execFileSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { dragShot } from './play-input.mjs';
assert(process.env.CCC_EXECUTABLE,'Set CCC_EXECUTABLE to the packaged application');
const artifacts=path.resolve('work/background-startup');await mkdir(artifacts,{recursive:true});
const profile=await mkdtemp(path.join(artifacts,'profile-')),data=path.join(profile,'data'),home=path.join(profile,'home');
const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:data,CCC_TEST_HOME:home};delete env.ELECTRON_RUN_AS_NODE;
const helper=process.platform==='darwin'?path.resolve(path.dirname(process.env.CCC_EXECUTABLE),'../Resources/ccc-hook'):path.join(path.dirname(process.env.CCC_EXECUTABLE),'resources/ccc-hook.exe');
let app;const checks=[],measurements=[];const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const windowCount=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length);
const visible=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible()));
async function launch(){
  app=await electron.launch({executablePath:process.env.CCC_EXECUTABLE,args:['--ccc-background'],env,timeout:30000});
  await expect.poll(()=>app.evaluate(({app})=>{
    const broker=process._getActiveHandles().find(h=>h.constructor?.name==='ChildProcess'&&/ccc-hook(?:\.exe)?$/.test(h.spawnfile??''));
    if(typeof broker?.stdout?.prependListener!=='function')return false;
    if(!globalThis.__backgroundTrace){
      globalThis.__backgroundTrace={events:[],windows:[]};let buffer='';
      broker.stdout.prependListener('data',chunk=>{buffer+=chunk.toString();let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const message=JSON.parse(line);if(message.event)globalThis.__backgroundTrace.events.push({kind:message.event.kind,turn:message.event.turnId,time:performance.now()});}catch{}}});
      app.on('browser-window-created',(_event,w)=>{const record={created:performance.now(),shows:[],hides:[]};globalThis.__backgroundTrace.windows.push(record);w.on('show',()=>record.shows.push({time:performance.now(),focused:w.isFocused()}));w.on('hide',()=>record.hides.push(performance.now()));});
    }
    return true;
  })).toBe(true);
  assert.equal(await windowCount(),0,'Background startup created a BrowserWindow before use');
}
async function hook(kind,turn){
  const child=spawn(helper,['--provider','codex','--event',kind,'--config',path.join(data,'connection.json')],{windowsHide:true,stdio:'pipe'});let output='';
  child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);child.stdin.end(JSON.stringify({session_id:'background-fixture',cwd:home,turn_id:turn}));
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`Hook exited ${code}`)));});assert.equal(output,'');
  await expect.poll(()=>app.evaluate(({},{kind,turn})=>globalThis.__backgroundTrace.events.some(e=>e.kind===kind&&e.turn===turn),{kind,turn})).toBe(true);
}
async function resources(phase){
  const snapshot=await app.evaluate(({app,BrowserWindow})=>({windows:BrowserWindow.getAllWindows().length,processes:app.getAppMetrics().map(p=>({type:p.type,workingSetKiB:p.memory.workingSetSize})),helperPids:process._getActiveHandles().filter(h=>h.constructor?.name==='ChildProcess'&&/ccc-hook(?:\.exe)?$/.test(h.spawnfile??'')).map(h=>h.pid)}));
  assert.equal(snapshot.helperPids.length,1);const pid=snapshot.helperPids[0];assert(Number.isSafeInteger(pid)&&pid>0);
  snapshot.helperWorkingSetKiB=process.platform==='win32'?Number(execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64 / 1024`],{windowsHide:true,encoding:'utf8'}).trim()):Number(execFileSync('ps',['-o','rss=','-p',String(pid)],{encoding:'utf8'}).trim());
  snapshot.totalWorkingSetMiB=(snapshot.processes.reduce((sum,p)=>sum+p.workingSetKiB,0)+snapshot.helperWorkingSetKiB)/1024;delete snapshot.helperPids;measurements.push({phase,...snapshot});
}
async function shot(page,previous){await dragShot(page,{angle:180,power:15});await expect.poll(async()=>{const r=(await page.evaluate(()=>window.countryClub.loadRound()))?.state;return r?.shotId===previous+1&&r.velocity.x===0&&r.velocity.y===0;},{timeout:15000}).toBe(true);}
try{
  await launch();await hook('start','automatic-off');await hook('stop','automatic-off');await pause(1200);assert.equal(await windowCount(),0);
  await resources('fresh background, automatic off, before first window');
  checks.push('fresh background host and broker remain ready with zero windows through native start/stop while automatic mode is off');
  const opened=app.waitForEvent('window');await app.evaluate(({app})=>app.emit('activate'));let page=await opened;
  await expect(page.getByRole('button',{name:'Play local practice',exact:true})).toBeVisible();await page.getByRole('button',{name:'Play local practice',exact:true}).click();await shot(page,0);
  await page.evaluate(async()=>{await window.countryClub.setSettings({automatic:true,delayMs:1000});await window.countryClub.hide();});let saved=(await page.evaluate(()=>window.countryClub.loadRound())).state;await app.close();app=undefined;
  checks.push('explicit activation creates the first window and local practice saves an actual drag shot');
  await launch();await resources('restored background, automatic on, before first window');
  const firstWait=app.waitForEvent('window');await hook('start','first-eligible');page=await firstWait;
  await expect.poll(visible,{timeout:5000,intervals:[10]}).toBe(true);assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFocused()),false);
  assert.deepEqual((await page.evaluate(()=>window.countryClub.loadRound())).state,saved);
  const trace=await app.evaluate(()=>globalThis.__backgroundTrace),start=trace.events.find(e=>e.kind==='start'&&e.turn==='first-eligible'),record=trace.windows.at(-1);
  const showAfterDelayMs=record.shows[0].time-start.time-1000;assert(showAfterDelayMs>=-20&&showAfterDelayMs<=250,`First background show exceeded budget: ${showAfterDelayMs}ms`);
  await shot(page,saved.shotId);saved=(await page.evaluate(()=>window.countryClub.loadRound())).state;
  await hook('stop','first-eligible');await expect.poll(visible).toBe(false);assert.deepEqual((await page.evaluate(()=>window.countryClub.loadRound())).state,saved);
  checks.push('first eligible native wait creates an inactive window within the delay budget, restores exact state, accepts a real drag shot and stops quietly');
  await expect.poll(windowCount,{timeout:35000,intervals:[250]}).toBe(0);await resources('after first game and normal 30-second renderer parking');await app.close();app=undefined;
  await launch();await hook('start','canceled-first-use');await hook('attention','canceled-first-use');await pause(1250);assert.equal(await visible(),false);
  const canceled=await app.evaluate(()=>globalThis.__backgroundTrace);assert(canceled.windows.every(w=>w.shows.length===0));await app.close();app=undefined;
  checks.push('attention during first background renderer creation prevents every automatic show');
  await launch();await app.evaluate(({powerMonitor})=>powerMonitor.emit('lock-screen'));await hook('start','held-first-use');await pause(1100);assert.equal(await windowCount(),0);
  await app.evaluate(({powerMonitor})=>powerMonitor.emit('unlock-screen'));await hook('start','held-first-use');await pause(1100);assert.equal(await windowCount(),0);
  const afterHold=app.waitForEvent('window');await hook('start','fresh-after-hold');page=await afterHold;await expect.poll(visible).toBe(true);assert.deepEqual((await page.evaluate(()=>window.countryClub.loadRound())).state,saved);await hook('stop','fresh-after-hold');await expect.poll(visible).toBe(false);
  checks.push('headless lock hold and held-turn replay cannot create a window; fresh post-unlock native turn restores exact progress');
  await app.close();app=undefined;await launch();
  await app.evaluate(()=>{const broker=process._getActiveHandles().find(h=>h.constructor?.name==='ChildProcess'&&/ccc-hook(?:\.exe)?$/.test(h.spawnfile??''));if(!broker)throw new Error('Owned broker missing');broker.kill();});
  await pause(300);assert.equal(await windowCount(),0);
  const repairOpen=app.waitForEvent('window');await app.evaluate(({app})=>app.emit('activate'));page=await repairOpen;
  await expect.poll(async()=>(await page.evaluate(()=>window.countryClub.getState())).diagnostics.some(d=>d.code==='BROKER_STOPPED')).toBe(true);
  await page.getByRole('button',{name:'Play local practice',exact:true}).click();await shot(page,saved.shotId);
  checks.push('headless broker failure stays quiet; explicit opening exposes diagnostics and local saving practice remains usable');
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,packaged:true,checks,showAfterDelayMs,measurements,limitations:['Initial background and post-game parked memory are reported separately; this is not a claim to meet the post-game200MiB budget.','Summed Electron and native helper working sets may double-count shared pages; the metric is unchanged.','Synthetic native hook payloads and injected lock notifications do not certify signed-in clients or physical platform delivery.']},null,2));
  console.log('Packaged background startup acceptance passed.');
}catch(error){await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:false,error:String(error),checks,measurements},null,2));throw error;}
finally{await app?.close().catch(()=>{});}
