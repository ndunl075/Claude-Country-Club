// Bounded reproduction investigation, not a replacement for native acceptance.
import { spawn,execFileSync } from 'node:child_process';
import { mkdir,readdir,readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
assert.equal(process.platform,'win32');assert(process.env.CCC_EXECUTABLE);
const attempts=Number(process.env.CCC_DISCOVERY_ATTEMPTS??12);assert(Number.isInteger(attempts)&&attempts>0&&attempts<=20);
const artifacts=path.resolve('work/client-discovery-repeat');await mkdir(artifacts,{recursive:true});
const source=path.resolve('work/client-discovery');await mkdir(source,{recursive:true});const results=[];
for(let attempt=1;attempt<=attempts;attempt++){
 const prior=new Set(await readdir(source));const start=performance.now();let timedOut=false,output='';
 const outcome=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['scripts/test-client-discovery.mjs'],{env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',c=>{output=(output+c.toString()).slice(-8192);});child.stderr.on('data',c=>{output=(output+c.toString()).slice(-8192);});
  const timer=setTimeout(()=>{
   timedOut=true;
   // Only the freshly spawned owned test subtree; never a name-based kill.
   try{execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'pipe',timeout:10000});}catch{}
  },45000);
  child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});
 });
 const fixtures=[];for(const name of await readdir(source))if(!prior.has(name)&&name.startsWith('fixture-')){
  const dir=path.join(source,name),read=file=>readFile(path.join(dir,file),'utf8').then(JSON.parse).catch(()=>null);
  fixtures.push({directory:dir,phase:await read('phase.json'),timeline:await read('timeline.json')});
 }
 const result={attempt,...outcome,timedOut,elapsedMs:performance.now()-start,output,fixtures};results.push(result);
 await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:results.length===attempts&&results.every(r=>r.code===0&&!r.timedOut),requested:attempts,completed:results.length,executableSha256:createHash('sha256').update(await readFile(process.env.CCC_EXECUTABLE)).digest('hex'),results,limitations:['Fresh fixture homes and packaged native version checks only; no signed-in provider or live configuration.','Durable phase observation affects timing. Passing repetitions do not explain the prior timeout.','Watchdog ends only its owned test subtree after45seconds and retains the last recorded stage.']},null,2));
 console.log(`Discovery investigation ${attempt}/${attempts}: ${outcome.code===0&&!timedOut?'passed':'failed'} (${Math.round(result.elapsedMs)}ms)`);
 assert(!timedOut&&outcome.code===0,'Discovery reproduction failed; retained stage evidence must be investigated before another run');
}
