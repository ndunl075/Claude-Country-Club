// Validates the default packaged renderer worker without exposing any debug
// route outside isolated test mode. The controller stays windowless.
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
assert(process.env.CCC_EXECUTABLE,'Set CCC_EXECUTABLE to a packaged executable.');
const executable=path.resolve(process.env.CCC_EXECUTABLE), data=await mkdtemp(path.join(os.tmpdir(),'ccc-worker-package-'));
const root=spawn(executable,['--inspect=0','--ccc-background'],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,CCC_TEST_MODE:'1',CCC_TEST_WORKER_INSPECT:'1',CCC_DATA_DIR:data,CCC_WINDOW_WORKER:'1'}});
let out='',endpoint;root.stderr.on('data',b=>{const s=String(b);out+=s;endpoint??=/Debugger listening on (ws:\/\/\S+)/.exec(s)?.[1];});root.stdout.on('data',b=>out+=b);const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+20000;while(!await fn()){if(root.exitCode!==null)throw Error(`Controller exited during ${label}: ${out}`);if(Date.now()>end)throw Error(`Timeout: ${label}: ${out}`);await pause(25);}}
let ws,seq=0;const jobs=new Map();
async function call(expression){const id=++seq;const value=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Inspector timeout')),10000);jobs.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true,includeCommandLineAPI:true}}));});if(value.exceptionDetails)throw Error(value.exceptionDetails.exception?.description??value.exceptionDetails.text);return value.result.value;}
try {
 await until(()=>endpoint,'controller inspector');ws=new WebSocket(endpoint);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});ws.addEventListener('message',e=>{const m=JSON.parse(e.data),job=jobs.get(m.id);if(job){jobs.delete(m.id);clearTimeout(job.timer);job.resolve(m.result);}});
 await call("require('electron').app.emit('activate')");await until(()=>call("typeof globalThis.__cccWindowWorkerInspector==='string'"),'worker inspector');
 const worker=await call('globalThis.__cccWindowWorkerInspector');const ww=new WebSocket(worker);await new Promise((r,j)=>{ww.addEventListener('open',r,{once:true});ww.addEventListener('error',j,{once:true});});let wn=0;const pending=new Map();const workerCall=expression=>new Promise((resolve,reject)=>{const id=++wn;pending.set(id,{resolve,reject});ww.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true,includeCommandLineAPI:true}}));});ww.addEventListener('message',e=>{const m=JSON.parse(e.data),job=pending.get(m.id);if(job){pending.delete(m.id);m.result.exceptionDetails?job.reject(Error(m.result.exceptionDetails.exception?.description??m.result.exceptionDetails.text)):job.resolve(m.result.result.value);}});
 await until(()=>workerCall("require('electron').BrowserWindow.getAllWindows().length===1"),'worker window');
 const security=await workerCall("(()=>{const p=require('electron').BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return {sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration,webSecurity:p.webSecurity}})()");assert.deepEqual(security,{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true});
 assert.equal(await workerCall("require('electron').BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('window.countryClub.practice().then(()=>!!document.querySelector(\\\"canvas\\\"))')"),true);
 await workerCall("require('electron').BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('window.countryClub.hide()')");
 console.log('Packaged default controller/window-worker renderer acceptance passed.');
} finally { if(ws?.readyState===WebSocket.OPEN){await call("require('electron').app.quit()").catch(()=>{});ws.close();}if(root.exitCode===null)root.kill(); }
