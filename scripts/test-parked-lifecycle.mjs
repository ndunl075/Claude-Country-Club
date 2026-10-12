import { _electron as electron,expect } from 'playwright/test';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import { spawn,execFileSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { dragShot } from './play-input.mjs';
assert(process.env.CCC_EXECUTABLE,'Set CCC_EXECUTABLE to the packaged application');
const artifacts=path.resolve('work/parked-lifecycle');await mkdir(artifacts,{recursive:true});
const profile=await mkdtemp(path.join(artifacts,'profile-')),data=path.join(profile,'data'),home=path.join(profile,'home');
const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:data,CCC_TEST_HOME:home};delete env.ELECTRON_RUN_AS_NODE;
const helper=process.platform==='darwin'?path.resolve(path.dirname(process.env.CCC_EXECUTABLE),'../Resources/ccc-hook'):path.join(path.dirname(process.env.CCC_EXECUTABLE),'resources/ccc-hook.exe');
let app;const checks=[],cycles=[];const pause=ms=>new Promise(r=>setTimeout(r,ms));
const visible=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible()));
async function hook(kind,turn){
  const child=spawn(helper,['--provider','codex','--event',kind,'--config',path.join(data,'connection.json')],{windowsHide:true,stdio:'pipe'});let output='';
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  child.stdin.end(JSON.stringify({session_id:'parked-fixture',cwd:home,turn_id:turn}));
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(`Hook exit ${code}`)));});assert.equal(output,'');
}
async function park(){await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),{timeout:35000,intervals:[250]}).toBe(0);}
async function snapshot(){return app.evaluate(({app,BrowserWindow})=>({windows:BrowserWindow.getAllWindows().length,processes:app.getAppMetrics().map(p=>({type:p.type,workingSetKiB:p.memory.workingSetSize})),helperPids:process._getActiveHandles().filter(h=>h.constructor?.name==='ChildProcess'&&/ccc-hook(?:\.exe)?$/.test(h.spawnfile??'')).map(h=>h.pid)}));}
try{
  app=await electron.launch({executablePath:process.env.CCC_EXECUTABLE,env,timeout:30000});let page=await app.firstWindow();
  await expect.poll(async()=>(await page.evaluate(()=>window.countryClub.getState())).brokerReady).toBe(true);
  await page.getByRole('button',{name:'Play local practice',exact:true}).click();await dragShot(page,{angle:180,power:15});
  await expect.poll(async()=>{const r=(await page.evaluate(()=>window.countryClub.loadRound()))?.state;return r?.shotId===1&&r.velocity.x===0&&r.velocity.y===0;},{timeout:15000}).toBe(true);
  let saved=(await page.evaluate(()=>window.countryClub.loadRound())).state;
  await page.evaluate(async()=>{await window.countryClub.setSettings({automatic:true,delayMs:1000});await window.countryClub.hide();});
  await app.evaluate(({app})=>{
    globalThis.__parkTrace={events:[],windows:[]};
    const broker=process._getActiveHandles().find(h=>h.constructor?.name==='ChildProcess'&&/ccc-hook(?:\.exe)?$/.test(h.spawnfile??''));
    if(!broker)throw Error('Owned broker missing');
    let buffer='';broker.stdout.prependListener('data',chunk=>{
      buffer+=chunk.toString();let end;
      while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const message=JSON.parse(line);if(message.event)globalThis.__parkTrace.events.push({kind:message.event.kind,turn:message.event.turnId,time:performance.now()});}catch{}}
    });
    app.on('browser-window-created',(_event,w)=>{
      const record={created:performance.now(),shows:[],hides:[]};globalThis.__parkTrace.windows.push(record);
      w.on('show',()=>record.shows.push({time:performance.now(),focused:w.isFocused()}));w.on('hide',()=>record.hides.push(performance.now()));
    });
  });
  let resources;
  for(let i=0;i<3;i++){
    await park();assert.equal(await visible(),false);
    if(i===0){
      resources=await snapshot();assert.equal(resources.windows,0);assert.equal(resources.helperPids.length,1);
      assert(resources.helperPids.every(pid=>Number.isSafeInteger(pid)&&pid>0));
      resources.helperWorkingSetKiB=process.platform==='win32'?Number(execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-Process -Id ${resources.helperPids[0]} -ErrorAction Stop).WorkingSet64 / 1024`],{encoding:'utf8',windowsHide:true}).trim()):Number(execFileSync('ps',['-o','rss=','-p',String(resources.helperPids[0])],{encoding:'utf8'}).trim());
      resources.totalWorkingSetMiB=(resources.processes.reduce((sum,p)=>sum+p.workingSetKiB,0)+resources.helperWorkingSetKiB)/1024;
      delete resources.helperPids;
    }
    const turn=`parked-${i}`,nextWindow=app.waitForEvent('window');await hook('start',turn);
    if(i===1)await hook('attention',turn);
    page=await nextWindow;await expect(page.getByRole('application')).toBeAttached();
    if(i===1){
      await pause(1250);assert.equal(await visible(),false);
      const trace=await app.evaluate(()=>globalThis.__parkTrace);assert.equal(trace.windows.at(-1).shows.length,0);
      assert.deepEqual((await page.evaluate(()=>window.countryClub.loadRound())).state,saved);
      checks.push('attention during parked renderer recreation cancels automatic show and preserves exact saved state');
      cycles.push({turn,canceled:true});continue;
    }
    await expect.poll(visible,{timeout:5000,intervals:[10]}).toBe(true);
    assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFocused()),false);
    assert.deepEqual((await page.evaluate(()=>window.countryClub.loadRound())).state,saved);
    const trace=await app.evaluate(()=>globalThis.__parkTrace),record=trace.windows.at(-1),start=trace.events.find(e=>e.turn===turn&&e.kind==='start');
    const showAfterDelayMs=record.shows[0].time-start.time-1000;
    assert(showAfterDelayMs>=-20&&showAfterDelayMs<=250,`Parked show exceeded budget: ${showAfterDelayMs}ms`);
    const previousShot=saved.shotId;await dragShot(page,{angle:180,power:15});
    await expect.poll(async()=>{const r=(await page.evaluate(()=>window.countryClub.loadRound())).state;return r.shotId===previousShot+1&&r.velocity.x===0&&r.velocity.y===0;},{timeout:15000}).toBe(true);
    saved=(await page.evaluate(()=>window.countryClub.loadRound())).state;
    const terminal=i===0?'stop':'interrupted';await hook(terminal,turn);await expect.poll(visible).toBe(false);
    assert.deepEqual((await page.evaluate(()=>window.countryClub.loadRound())).state,saved);
    const ended=await app.evaluate(()=>globalThis.__parkTrace),end=ended.events.find(e=>e.turn===turn&&e.kind===terminal),hide=ended.windows.at(-1).hides.at(-1);
    assert(hide-end.time<=200);cycles.push({turn,canceled:false,showAfterDelayMs,terminal,terminalIngressToHideMs:hide-end.time,focusedOnShow:record.shows[0].focused});
  }
  checks.push('two fully parked automatic reopens meet show budget, preserve exact state, accept actual drag shots and hide on stop/interruption within budget without focus');
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,packaged:true,checks,cycles,resources,limitations:['Three local parked cycles on one Windows reference machine, not cross-hardware certification.','Timing starts at native broker stdout ingress immediately before desktop event processing, not at provider submission.','Synthetic provider payloads over real IPC; no signed-in client, physical sleep/wake or Mac certification.','Memory includes summed Electron and owned native helper working sets; shared pages may be counted more than once. No OS working-set trimming or graphics/security changes.']},null,2));
  console.log('Packaged parked lifecycle acceptance passed.');
}catch(error){await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:false,error:String(error),checks,cycles},null,2));throw error;}
finally{await app?.close().catch(()=>{});}
