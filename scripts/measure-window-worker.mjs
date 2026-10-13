import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// This fixture measures the real opt-in controller/worker tree. It only uses
// the controller's test-only inspector to advance the probe; the worker is
// observed through the read-only owned-process snapshot and receives no debug
// port or testing API.
assert.equal(process.platform, 'win32', 'The owned-process collector is Windows-only.');
const root=process.cwd(), artifacts=path.join(root,'work/window-worker-resources');
await mkdir(artifacts,{recursive:true});
const profile=await mkdtemp(path.join(artifacts,'profile-'));
const electron=path.resolve('node_modules/electron/dist/electron.exe');
const executable=process.env.CCC_EXECUTABLE ? path.resolve(process.env.CCC_EXECUTABLE) : electron;
const child=spawn(executable,['--inspect=0',...(process.env.CCC_EXECUTABLE?[]:['.']),'--ccc-background'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,CCC_TEST_MODE:'1',CCC_WINDOW_WORKER:'1',CCC_WINDOW_WORKER_RESOURCE_PROBE:'1',CCC_DATA_DIR:path.join(profile,'data'),CCC_TEST_HOME:path.join(profile,'home')}});
let output='', endpoint, launchError;
child.stdout.on('data',bytes=>{output+=bytes;});
child.stderr.on('data',bytes=>{const text=String(bytes);output+=text;endpoint??=/Debugger listening on (ws:\/\/\S+)/.exec(text)?.[1];});
child.on('error',error=>{launchError=error;});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,label,timeout=20_000){const end=Date.now()+timeout;while(!await predicate()){if(launchError)throw launchError;if(child.exitCode!==null)throw Error(`Controller exited during ${label}: ${output}`);if(Date.now()>end)throw Error(`Timed out during ${label}: ${output}`);await pause(25);}}
async function snapshot(label){
  // Chromium may retire a just-created utility process between the Tool Help
  // enumeration and counter read. Retry a whole sample; never silently omit it.
  let lastError;
  for(let attempt=0;attempt<3;attempt++)try {
    const raw=execFileSync('powershell.exe',['-NoProfile','-File',path.join(root,'scripts/owned-process-snapshot.ps1'),'-RootProcessId',String(child.pid)],{encoding:'utf8',windowsHide:true,timeout:20_000});
    const processes=JSON.parse(raw); const list=Array.isArray(processes)?processes:[processes];
    return {label,time:new Date().toISOString(),attempt:attempt+1,processes:list,totalWorkingSetMiB:list.reduce((sum,p)=>sum+p.workingSetKiB,0)/1024,totalPrivateMiB:list.reduce((sum,p)=>sum+p.privateKiB,0)/1024};
  } catch(error) { lastError=error; await pause(250); }
  throw lastError;
}
let ws, sequence=0; const pending=new Map();
async function evaluate(expression){
  const id=++sequence;
  const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('Controller inspector timeout'));},10_000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true}}));});
  if(result.exceptionDetails)throw Error(result.exceptionDetails.text);return result.result.value;
}
try {
  await until(()=>endpoint,'controller inspector');
  ws=new WebSocket(endpoint);
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  ws.addEventListener('message',event=>{const response=JSON.parse(event.data), job=pending.get(response.id);if(job){pending.delete(response.id);clearTimeout(job.timer);response.error?job.reject(Error(response.error.message)):job.resolve(response.result);}});
  await until(()=>output.includes('CCC_WINDOW_WORKER_RESOURCE_ACTIVE'),'active worker');
  const active=await snapshot('active');
  const workerPid=Number(execFileSync('powershell.exe',['-NoProfile','-Command',`$p=Get-CimInstance Win32_Process -Filter 'ParentProcessId=${child.pid}' | Where-Object { $_.CommandLine -match '--ccc-window-worker' };if(@($p).Count-ne1){throw 'Expected exactly one owned window worker'};$p.ProcessId`],{encoding:'utf8',windowsHide:true}).trim());
  const worker=active.processes.find(process=>process.pid===workerPid);
  assert(worker,'The controller did not own an Electron window worker.');
  await evaluate("globalThis.__cccWindowWorkerMeasure='park'");
  await until(()=>output.includes('CCC_WINDOW_WORKER_RESOURCE_HIDDEN'),'worker hide acknowledgement');
  await until(()=>{
    const status=execFileSync('powershell.exe',['-NoProfile','-Command',`if(Get-Process -Id ${worker.pid} -ErrorAction SilentlyContinue){'alive'}else{'gone'}`],{encoding:'utf8',windowsHide:true}).trim();
    return status==='gone';
  },'worker parking',35_000);
  await pause(1_000);
  const parked=await snapshot('parked');
  assert(!parked.processes.some(process=>process.pid===worker.pid),'The parked process tree still contains the window worker.');
  const result={measured:true,time:new Date().toISOString(),packaged:!!process.env.CCC_EXECUTABLE,active,parked,workerPid:worker.pid,targetMiB:200,scope:'Read-only Tool Help descendant snapshot rooted at the controller. The worker is identified only among that controller’s direct children by its private launch marker; helper and Chromium descendants are included. Shared pages can be counted more than once.',budgetMet:parked.totalWorkingSetMiB<=200};
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} catch(error) {
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({measured:false,time:new Date().toISOString(),error:String(error),output},null,2));
  throw error;
} finally {
  if(ws?.readyState===WebSocket.OPEN){await evaluate("require('electron').app.quit()").catch(()=>undefined);ws.close();}
  if(child.exitCode===null)await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(5_000)]);
  if(child.exitCode===null)child.kill();
}
