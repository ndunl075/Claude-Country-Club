// Exercise the packaged production singleton and installer-quit branch.
// Inspector injection redirects paths before app code; no lifecycle is mocked.
import { chromium, expect } from 'playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import assert from 'node:assert/strict';
import { dragShot } from './play-input.mjs';
assert.equal(process.platform,'win32');
const executable=path.resolve(process.env.CCC_EXECUTABLE??'release/win-unpacked/Claude Country Club.exe');
const work=path.resolve('work/installer-handoff');await mkdir(work,{recursive:true});
const profile=await mkdtemp(path.join(work,'profile-'));
const paths={userData:path.join(profile,'data'),sessionData:path.join(profile,'session'),appData:path.join(profile,'appdata'),home:path.join(profile,'home'),temp:path.join(profile,'temp'),logs:path.join(profile,'logs'),crashDumps:path.join(profile,'crashes')};
await Promise.all(Object.values(paths).map(directory=>mkdir(directory,{recursive:true})));
await mkdir(path.join(paths.home,'.claude'));await mkdir(path.join(paths.home,'.codex'));
const providers=[path.join(paths.home,'.claude/settings.json'),path.join(paths.home,'.codex/hooks.json')];
for(const file of providers)await writeFile(file,'{"hooks":{},"fixture":"preserve"}\n');
const digest=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const providerHashes=await Promise.all(providers.map(digest));
const env={...process.env,HOME:paths.home,USERPROFILE:paths.home,APPDATA:paths.appData,LOCALAPPDATA:paths.appData,TEMP:paths.temp,TMP:paths.temp,PATH:''};
const legacyControllerFixture=env.CCC_LEGACY_CONTROLLER_FIXTURE==='1';
for(const key of Object.keys(env))if(key.startsWith('CCC_')||key==='ELECTRON_RUN_AS_NODE'||key==='NODE_OPTIONS')delete env[key];
if(legacyControllerFixture)env.CCC_WINDOW_WORKER='0';
const sessions=[],checks=[];let browser,phase='launch primary';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout=15000){const deadline=Date.now()+timeout;while(!await fn()){if(Date.now()>deadline)throw new Error(`Timeout: ${phase}`);await pause(50);}}
async function trace(session){return JSON.parse(await readFile(session.tracePath,'utf8'));}
async function launch(label,extra=[]){
  const session={label,tracePath:path.join(profile,`${label}.json`),pending:new Map(),sequence:0,paused:false};sessions.push(session);
  session.child=spawn(executable,['--inspect-brk=0','--remote-debugging-port=0',...extra],{cwd:paths.home,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  session.child.on('error',error=>{session.launchError=String(error);});
  session.stderr='';session.child.stderr.on('data',chunk=>{session.stderr=(session.stderr+chunk).slice(-65536);session.nodeURL??=/Debugger listening on (ws:\/\/\S+)/.exec(session.stderr)?.[1];session.chromeURL??=/DevTools listening on (ws:\/\/\S+)/.exec(session.stderr)?.[1];});
  await until(()=>{if(session.launchError)throw new Error(session.launchError);assert.equal(session.child.exitCode,null,'Owned launch exited before isolation');return session.nodeURL;});
  session.ws=new WebSocket(session.nodeURL);await new Promise((resolve,reject)=>{session.ws.addEventListener('open',resolve,{once:true});session.ws.addEventListener('error',reject,{once:true});});
  session.ws.addEventListener('message',event=>{const response=JSON.parse(event.data);if(response.method==='Debugger.paused'){session.paused=true;session.lastPause=response.params;}if(response.method==='Debugger.resumed')session.paused=false;if(response.id){const job=session.pending.get(response.id);session.pending.delete(response.id);response.error?job?.reject(new Error(response.error.message)):job?.resolve(response.result);}});
  session.send=(method,params={})=>new Promise((resolve,reject)=>{const id=++session.sequence;const timer=setTimeout(()=>{session.pending.delete(id);reject(new Error(`Inspector timeout: ${method}`));},10000);session.pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});session.ws.send(JSON.stringify({id,method,params}));});
  session.evaluate=async expression=>{const response=await session.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,includeCommandLineAPI:true});if(response.exceptionDetails)throw new Error(response.exceptionDetails.exception?.description??response.exceptionDetails.text);return response.result.value;};
  await session.send('Runtime.enable');await session.send('Debugger.enable');
  const breakpoint=await session.send('Debugger.setBreakpointByUrl',{urlRegex:'main[.]cjs$',lineNumber:0});
  await session.send('Runtime.runIfWaitingForDebugger');await until(()=>session.paused);
  if(!session.lastPause.hitBreakpoints?.includes(breakpoint.breakpointId)){session.paused=false;await session.send('Debugger.resume');await until(()=>session.paused);}
  assert(session.lastPause.hitBreakpoints?.includes(breakpoint.breakpointId),'App entry was not isolated before execution');
  const isolation=await session.send('Debugger.evaluateOnCallFrame',{callFrameId:session.lastPause.callFrames[0].callFrameId,returnByValue:true,expression:`(()=>{
    const {app}=require('electron'),fs=require('node:fs'),os=require('node:os');
    const paths=${JSON.stringify(paths)},tracePath=${JSON.stringify(session.tracePath)};
    if(process.env.CCC_TEST_MODE!==undefined||os.homedir()!==paths.home)throw Error('Production fixture isolation failed');
    for(const [name,directory] of Object.entries(paths))app.setPath(name,directory);
    const record={pid:process.pid,testMode:false,paths:Object.fromEntries(Object.keys(paths).map(name=>[name,app.getPath(name)])),events:[]};
    const save=()=>fs.writeFileSync(tracePath,JSON.stringify(record));save();
    app.on('second-instance',(_event,args)=>{record.events.push({kind:'second-instance',installerQuit:args.includes('--ccc-installer-quit')});save();});
    app.on('before-quit',()=>{record.events.push({kind:'before-quit'});save();});
    app.on('will-quit',()=>{record.events.push({kind:'will-quit'});save();});
    return record;
  })()`});
  if(isolation.exceptionDetails)throw new Error(isolation.exceptionDetails.exception?.description??'Path isolation failed');
  session.identity=isolation.result.value;assert.equal(session.identity.pid,session.child.pid);assert.deepEqual(session.identity.paths,paths);
  await session.send('Debugger.removeBreakpoint',{breakpointId:breakpoint.breakpointId});await session.send('Debugger.resume');return session;
}
function checkpoint(){const database=new DatabaseSync(path.join(paths.userData,'country-club.sqlite'),{readOnly:true});try{const row=database.prepare('SELECT revision,state FROM round_save WHERE id=1').get();return {round:{revision:row.revision,state:JSON.parse(row.state)},shots:database.prepare('SELECT round_id,shot_id,state FROM shots ORDER BY round_id,shot_id').all().map(row=>({...row}))};}finally{database.close();}}
const result={passed:false,executable,executableSha256:await digest(executable),archiveSha256:await digest(path.join(path.dirname(executable),'resources/app.asar')),profile,checks,limitations:['Private paths and lifecycle event observers are injected through owned inspectors before application code, affecting timing. Production test mode stays disabled and the singleton/quit implementations are unchanged.','The secondary carries the real installer-quit argument but is inspector-launched to establish the same private paths. Native installer dialog and normal uninstrumented launch remain separate checks.','Windows only; no signed-in clients, system integration enrollment, real-Mac behavior or physical power-loss claim.']};
try{
  const primary=await launch('primary',['--ccc-background']);
  await until(()=>primary.evaluate(`require('electron').app.isReady() && process._getActiveHandles().some(handle=>handle.constructor?.name==='ChildProcess'&&/ccc-hook[.]exe$/.test(handle.spawnfile??''))`));
  assert.equal(await primary.evaluate(`require('electron').app.hasSingleInstanceLock()`),true);
  assert.equal(await primary.evaluate(`require('electron').BrowserWindow.getAllWindows().length`),0);
  checks.push('production branch obtains real singleton lock with private paths and quiet background startup');
  await primary.evaluate(`require('electron').app.emit('activate')`);await until(()=>primary.chromeURL);
  browser=await chromium.connectOverCDP(primary.chromeURL);await until(()=>browser.contexts()[0]?.pages().some(page=>page.url().startsWith('ccc://app/')));
  let page=browser.contexts()[0].pages().find(page=>page.url().startsWith('ccc://app/'));
  await page.getByRole('button',{name:'Play local practice',exact:true}).click();await dragShot(page,{angle:180,power:70});
  await expect.poll(async()=>(await page.evaluate(()=>window.countryClub.loadRound()))?.state?.shotId).toBe(1);
  const acknowledged=checkpoint();assert.equal(acknowledged.round.state.strokes,1);assert(Math.hypot(acknowledged.round.state.velocity.x,acknowledged.round.state.velocity.y)>0);
  phase='deliver installer quit through real singleton';
  const secondary=await launch('secondary',['--ccc-installer-quit']);secondary.ws.close();
  await until(async()=>{const observed=await trace(primary);return observed.events.some(event=>event.kind==='will-quit');});
  const handoff=await trace(primary);assert(handoff.events.some(event=>event.kind==='second-instance'&&event.installerQuit));
  primary.ws.close();await until(()=>primary.child.exitCode!==null&&secondary.child.exitCode!==null);assert.equal(primary.child.exitCode,0);assert.equal(secondary.child.exitCode,0);
  const saved=checkpoint();assert.equal(saved.round.state.shotId,1);assert.equal(saved.round.state.strokes,1);assert(saved.round.revision>acknowledged.round.revision);assert(saved.round.state.tick>=acknowledged.round.state.tick);assert.deepEqual(saved.shots,acknowledged.shots);
  checks.push('real secondary delivers installer-quit to original process, saves a later checkpoint, preserves initial shot journal and both processes exit0');
  phase='reopen after installer quit';await browser.close().catch(()=>{});browser=undefined;
  const restored=await launch('restored',['--ccc-background']);await until(()=>restored.evaluate(`require('electron').app.isReady() && require('electron').app.hasSingleInstanceLock()`));
  await restored.evaluate(`require('electron').app.emit('activate')`);await until(()=>restored.chromeURL);
  browser=await chromium.connectOverCDP(restored.chromeURL);await until(()=>browser.contexts()[0]?.pages().some(candidate=>candidate.url().startsWith('ccc://app/')));
  page=browser.contexts()[0].pages().find(candidate=>candidate.url().startsWith('ccc://app/'));await expect(page.getByRole('button',{name:'Play local practice',exact:true})).toBeVisible();
  assert.deepEqual(await page.evaluate(()=>window.countryClub.loadRound()),saved.round);await expect(page.getByRole('application')).toHaveAttribute('aria-disabled','true');
  assert.deepEqual(await Promise.all(providers.map(digest)),providerHashes);
  checks.push('reopen reacquires singleton lock and restores exact acknowledged save while gameplay remains paused; provider fixtures remain unchanged');
  Object.assign(result,{passed:true,acknowledged,saved,handoff});console.log('Packaged production singleton installer handoff passed.');
}catch(error){result.error=String(error);result.phase=phase;throw error;}
finally{
  for(const session of sessions.reverse()){
    if(session.ws?.readyState===WebSocket.OPEN){if(session.paused)await session.send('Debugger.resume').catch(()=>{});await session.evaluate(`require('electron').app.quit()`).catch(()=>{});session.ws.close();}
    if(session.child?.exitCode===null&&session.child.signalCode===null){await Promise.race([new Promise(resolve=>session.child.once('exit',resolve)),pause(3000)]);if(session.child.exitCode===null)session.child.kill();}
    for(const job of session.pending.values())job.reject(new Error('Owned inspector closed'));session.pending.clear();
  }
  await browser?.close().catch(()=>{});
  result.sessions=sessions.map(session=>({label:session.label,pid:session.child?.pid,exitCode:session.child?.exitCode,signal:session.child?.signalCode,identity:session.identity,stderr:result.passed?undefined:session.stderr}));
  await writeFile(path.join(work,'result.json'),JSON.stringify(result,null,2));
}
