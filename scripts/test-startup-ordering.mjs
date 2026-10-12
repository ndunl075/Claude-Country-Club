import { chromium,expect } from 'playwright/test';
import { spawn } from 'node:child_process';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { dragShot,observePointerInput } from './play-input.mjs';
assert(process.env.CCC_EXECUTABLE,'Set CCC_EXECUTABLE to the packaged application');
const artifacts=path.resolve('work/startup-ordering');await mkdir(artifacts,{recursive:true});
const scenario=process.argv[2]??'activate';assert(['activate','latest-practice','lock','failed-load'].includes(scenario));
const profile=await mkdtemp(path.join(artifacts,'profile-'));
const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:path.join(profile,'data'),CCC_TEST_HOME:path.join(profile,'home')};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
let child,ws,browser;const checks=[],pending=new Map();let sequence=0,nodeURL,chromeURL,paused=false,lastPause;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function send(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Inspector timeout: ${method}`));},10000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const response=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,includeCommandLineAPI:true});if(response.exceptionDetails)throw new Error(response.exceptionDetails.text+': '+response.exceptionDetails.exception?.description);return response.result.value;}
let evidence,phase='launch';
try{
  child=spawn(process.env.CCC_EXECUTABLE,['--inspect-brk=0','--remote-debugging-port=0','--ccc-background'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;nodeURL??=/Debugger listening on (ws:\/\/\S+)/.exec(stderr)?.[1];chromeURL??=/DevTools listening on (ws:\/\/\S+)/.exec(stderr)?.[1];});
  await expect.poll(()=>nodeURL,{timeout:15000}).toBeTruthy();
  ws=new WebSocket(nodeURL);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  ws.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.method==='Debugger.paused'){paused=true;lastPause=message.params;}if(message.method==='Debugger.resumed')paused=false;if(message.id){const job=pending.get(message.id);pending.delete(message.id);message.error?job?.reject(new Error(message.error.message)):job?.resolve(message.result);}});
  await send('Runtime.enable');await send('Debugger.enable');
  const breakpoint=await send('Debugger.setBreakpointByUrl',{urlRegex:'main[.]cjs$',lineNumber:0});
  await send('Runtime.runIfWaitingForDebugger');await expect.poll(()=>paused).toBe(true);
  if(!lastPause.hitBreakpoints?.includes(breakpoint.breakpointId)){
    paused=false;await send('Debugger.resume');await expect.poll(()=>paused,{timeout:10000}).toBe(true);
    assert(lastPause.hitBreakpoints?.includes(breakpoint.breakpointId),'Did not pause at the owned packaged entry point');
  }
  phase='inject at packaged entry';
  const injection=await send('Debugger.evaluateOnCallFrame',{callFrameId:lastPause.callFrames[0].callFrameId,returnByValue:true,includeCommandLineAPI:true,expression:`(()=>{
    globalThis.__startupOrder={entered:false,errors:[],created:0,practice:()=>startPractice()};
    require('electron').app.on('browser-window-created',()=>globalThis.__startupOrder.created++);
    process.on('unhandledRejection',error=>globalThis.__startupOrder.errors.push(String(error)));
    const fs=require('node:fs').promises,original=fs.readdir.bind(fs);
    fs.readdir=async(directory,...args)=>{
      if(String(directory).endsWith('diagnostics-v1')&&!globalThis.__startupOrder.entered){globalThis.__startupOrder.entered=true;await new Promise(resolve=>globalThis.__startupOrder.release=resolve);}
      return original(directory,...args);
    };
    return true;
  })()`});if(injection.exceptionDetails)throw new Error(injection.exceptionDetails.exception?.description??'Startup injection failed');
  await send('Debugger.removeBreakpoint',{breakpointId:breakpoint.breakpointId});await send('Debugger.resume');
  phase='wait for startup I/O hold';
  await expect.poll(()=>evaluate('globalThis.__startupOrder.entered'),{timeout:10000}).toBe(true);
  assert.equal(await evaluate(`require('electron').BrowserWindow.getAllWindows().length`),0);
  if(scenario==='failed-load')await evaluate(`(()=>{const proto=require('electron').BrowserWindow.prototype,original=proto.loadURL;proto.loadURL=function(url,...args){if(String(url).startsWith('ccc://app/')&&!globalThis.__startupOrder.failed){globalThis.__startupOrder.failed=true;return Promise.reject(new Error('Controlled first course load failure'));}return original.call(this,url,...args);};})()`);
  phase='early explicit activation';await evaluate(`require('electron').app.emit('activate')`);
  if(scenario==='latest-practice')await evaluate(`void globalThis.__startupOrder.practice().catch(error=>globalThis.__startupOrder.errors.push(String(error)))`);
  if(scenario==='lock')await evaluate(`require('electron').powerMonitor.emit('lock-screen');require('electron').app.emit('activate')`);
  // The explicit request has run; no transport is registered while I/O is held.
  await pause(100);
  evidence=await evaluate(`({windows:require('electron').BrowserWindow.getAllWindows().length,errors:globalThis.__startupOrder.errors})`);
  assert.equal(evidence.windows,0,'Early explicit open created a window before protocol and IPC readiness');
  checks.push('explicit activation during startup I/O queues intent without creating an unready window');
  await evaluate('globalThis.__startupOrder.release()');
  if(scenario==='lock'||scenario==='failed-load'){
    phase='wait for headless startup completion';
    await expect.poll(()=>evaluate(`process._getActiveHandles().some(h=>h.constructor?.name==='ChildProcess'&&/ccc-hook(?:\\.exe)?$/.test(h.spawnfile??'')&&!!h.stdout)`),{timeout:10000}).toBe(true);
    assert.equal(await evaluate(`require('electron').BrowserWindow.getAllWindows().length`),0);
    if(scenario==='lock'){
      await evaluate(`require('electron').powerMonitor.emit('unlock-screen')`);await pause(100);
      assert.equal(await evaluate(`require('electron').BrowserWindow.getAllWindows().length`),0,'Unlock resurrected an early explicit request');
      checks.push('startup lock drops early and held explicit intents; unlock stays windowless');
    }else{
      assert.equal(await evaluate('globalThis.__startupOrder.failed'),true);
      checks.push('failed queued first load clears its window and allows the headless host to finish startup');
    }
    await evaluate(`require('electron').app.emit('activate')`);
  }
  await expect.poll(()=>chromeURL,{timeout:10000}).toBeTruthy();browser=await chromium.connectOverCDP(chromeURL);
  const context=browser.contexts()[0];await expect.poll(()=>context.pages().filter(p=>p.url().startsWith('ccc://app/')).length,{timeout:10000}).toBe(1);
  const page=context.pages().find(p=>p.url().startsWith('ccc://app/'));await observePointerInput(page);
  phase='usable course and durable drag';
  if(scenario==='latest-practice'){
    await expect.poll(()=>page.evaluate(()=>window.countryClub.getState()).then(s=>s.practice)).toBe(true);
    checks.push('latest queued practice intent wins over earlier dashboard intent');
  }else await page.getByRole('button',{name:'Play local practice',exact:true}).click();
  await dragShot(page,{angle:180,power:15});
  await expect.poll(async()=>{const saved=await page.evaluate(()=>window.countryClub.loadRound());return saved?.state.shotId===1&&saved.state.velocity.x===0&&saved.state.velocity.y===0;},{timeout:15000}).toBe(true);
  assert.deepEqual(await evaluate('globalThis.__startupOrder.errors'),[]);
  assert.equal(await evaluate(`require('electron').BrowserWindow.getAllWindows().length`),1);
  assert.equal(await evaluate('globalThis.__startupOrder.created'),scenario==='failed-load'?2:1);
  checks.push('queued explicit activation opens one usable course after readiness and a real drag shot settles durably without unhandled rejection');
  await writeFile(path.join(artifacts,`${scenario}.json`),JSON.stringify({passed:true,packaged:true,scenario,checks,evidence,limitations:['Startup filesystem wait and explicit activation are injected through the owned main-process inspector before application loading.','No signed-in provider, physical platform activation or Mac delivery is certified.']},null,2));
  console.log('Packaged startup ordering acceptance passed.');
}catch(error){await writeFile(path.join(artifacts,`${scenario}.json`),JSON.stringify({passed:false,error:String(error),scenario,phase,checks,evidence,profile},null,2));throw error;}
finally{
  if(paused&&ws?.readyState===WebSocket.OPEN)await send('Debugger.resume').catch(()=>{});
  if(ws?.readyState===WebSocket.OPEN){await evaluate('globalThis.__startupOrder?.release?.()').catch(()=>{});await evaluate(`require('electron').app.quit()`).catch(()=>{});ws.close();}
  await browser?.close().catch(()=>{});
  if(child&&child.exitCode===null){await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(3000)]);if(child.exitCode===null)child.kill();}
  for(const job of pending.values())job.reject(new Error('Owned inspector closed'));pending.clear();
}
