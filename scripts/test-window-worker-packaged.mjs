// Validates the default packaged renderer worker without exposing any debug
// route outside isolated test mode. The controller stays windowless.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
assert(process.env.CCC_EXECUTABLE,'Set CCC_EXECUTABLE to a packaged executable.');
const executable=path.resolve(process.env.CCC_EXECUTABLE), data=await mkdtemp(path.join(os.tmpdir(),'ccc-worker-package-'));
const root=spawn(executable,['--inspect=0','--ccc-background'],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,CCC_TEST_MODE:'1',CCC_TEST_CONTROLLER_INSPECT:'1',CCC_DATA_DIR:data,CCC_WINDOW_WORKER:'1'}});
let out='',endpoint;root.stderr.on('data',b=>{const s=String(b);out+=s;endpoint??=/Debugger listening on (ws:\/\/\S+)/.exec(s)?.[1];});root.stdout.on('data',b=>out+=b);const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+20000;while(!await fn()){if(root.exitCode!==null)throw Error(`Controller exited during ${label}: ${out}`);if(Date.now()>end)throw Error(`Timeout: ${label}: ${out}`);await pause(25);}}
function ownedProcesses(){
 const script=path.join(process.cwd(),'scripts','owned-process-snapshot.ps1');
 const raw=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-RootProcessId',String(root.pid)],{encoding:'utf8',windowsHide:true}).trim();
 const records=JSON.parse(raw);return Array.isArray(records)?records:[records];
}
function remainingProcesses(records){
 const probe=records.map(record=>`$p=Get-Process -Id ${record.pid} -ErrorAction SilentlyContinue;if($p -and $p.StartTime.ToUniversalTime().ToString('o') -eq '${record.created}'){$items+=[pscustomobject]@{pid=${record.pid};name='${record.name}'}}`).join(';');
 const raw=execFileSync('powershell.exe',['-NoProfile','-Command',`$items=@();${probe};$items|ConvertTo-Json -Compress`],{encoding:'utf8',windowsHide:true}).trim();
 if(!raw)return [];const result=JSON.parse(raw);return Array.isArray(result)?result:[result];
}
let ws,seq=0;const jobs=new Map();
async function call(expression){const id=++seq;const value=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Inspector timeout')),10000);jobs.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true,includeCommandLineAPI:true}}));});if(value.exceptionDetails)throw Error(value.exceptionDetails.exception?.description??value.exceptionDetails.text);return value.result.value;}
try {
 await until(()=>endpoint,'controller inspector');ws=new WebSocket(endpoint);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});ws.addEventListener('message',e=>{const m=JSON.parse(e.data),job=jobs.get(m.id);if(job){jobs.delete(m.id);clearTimeout(job.timer);job.resolve(m.result);}});
 await call("require('electron').app.emit('activate')");console.log('worker: activation requested');await until(()=>call("typeof globalThis.__cccWindowWorkerTestRequest==='function'"),'worker bridge');console.log('worker: bridge ready');
 const security=await call("globalThis.__cccWindowWorkerTestRequest('test-security')");assert.deepEqual(security,{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true});
 console.log('worker: security verified');assert.equal(await call("globalThis.__cccWindowWorkerTestRequest('test-practice')"),true);console.log('worker: practice verified');
 await call("globalThis.__cccWindowWorkerTestRequest('hide')");
 console.log('worker: hidden');const owned=ownedProcesses();assert(owned.length>1,'Default packaged launch did not create a worker-owned process tree.');console.log('worker: ownership captured');
 const rootRecord=owned.find(record=>record.pid===root.pid);assert(rootRecord,'Owned process snapshot omitted the controller.');
 // Let the inspector acknowledge this request before app.quit tears it down.
 await call("setTimeout(()=>globalThis.__cccControllerQuit(),0);true");
 ws.close();
 const deadline=Date.now()+20_000;while(remainingProcesses([rootRecord]).length){if(Date.now()>deadline)throw Error(`Timeout: controller shutdown: ${out}`);await pause(50);}
 console.log('worker: controller exited');
 await pause(500);
 assert.deepEqual(remainingProcesses(owned),[],'Normal quit left an owned Country Club process running.');
 console.log('Packaged default controller/window-worker renderer acceptance passed.');
} finally { if(ws?.readyState===WebSocket.OPEN){ws.close();}if(root.exitCode===null)root.kill(); }
