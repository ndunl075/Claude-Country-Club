import { spawn } from 'node:child_process';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const artifacts=path.resolve('work/startup-ordering');await mkdir(artifacts,{recursive:true});const results=[];
if(!process.env.CCC_EXECUTABLE)throw new Error('Set CCC_EXECUTABLE to the packaged application');
const executableSha256=createHash('sha256').update(await readFile(process.env.CCC_EXECUTABLE)).digest('hex');
for(const scenario of ['activate','latest-practice','lock','failed-load']){
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['scripts/test-startup-ordering.mjs',scenario],{env:process.env,windowsHide:true,stdio:'inherit'});
    const timer=setTimeout(()=>{child.kill();reject(new Error('Startup ordering test timed out'));},90000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);resolve(code);});
  });
  const result=JSON.parse(await readFile(path.join(artifacts,`${scenario}.json`),'utf8'));results.push(result);
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:code===0&&results.length===4&&results.every(r=>r.passed),packaged:true,executableSha256,results},null,2));
  if(code!==0)process.exit(code??1);
}
console.log('All four packaged startup ordering cases passed.');
