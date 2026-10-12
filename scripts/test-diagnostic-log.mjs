import { _electron as electron,expect } from 'playwright/test';
import { mkdir,mkdtemp,writeFile,readFile,readdir,stat } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { dragShot,observePointerInput } from './play-input.mjs';
import { observeRoundWrites,readRoundWrites } from './round-write-evidence.mjs';
assert(process.env.CCC_EXECUTABLE,'Set CCC_EXECUTABLE to the packaged application');
const artifacts=path.resolve('work/diagnostic-log');await mkdir(artifacts,{recursive:true});
const profile=await mkdtemp(path.join(artifacts,'profile-')),data=path.join(profile,'data'),logs=path.join(data,'diagnostics-v1');
const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:data,CCC_TEST_HOME:path.join(profile,'home')};delete env.ELECTRON_RUN_AS_NODE;
let app,page;const checks=[];
async function launch(){app=await electron.launch({executablePath:process.env.CCC_EXECUTABLE,env,timeout:30000});page=await app.firstWindow();await observePointerInput(page);await expect.poll(()=>page.evaluate(()=>window.countryClub.getState()).then(s=>s.brokerReady)).toBe(true);await observeRoundWrites(app);}
async function shot(previous){await dragShot(page,{angle:180,power:15});await expect.poll(async()=>{const r=(await page.evaluate(()=>window.countryClub.loadRound()))?.state;return r?.shotId===previous+1&&r.velocity.x===0&&r.velocity.y===0;},{timeout:15000}).toBe(true);}
try{
  await launch();await page.getByRole('button',{name:'Play local practice',exact:true}).click();await shot(0);
  const saved=(await page.evaluate(()=>window.countryClub.loadRound())).state;
  await app.evaluate(()=>{
    const broker=process._getActiveHandles().find(h=>h.constructor?.name==='ChildProcess'&&/ccc-hook(?:\.exe)?$/.test(h.spawnfile??''));
    if(!broker)throw new Error('Owned broker missing');
    broker.stdout.emit('data',Buffer.from('PRIVATE-INVALID-BROKER-PAYLOAD\n'));
  });
  await expect.poll(()=>page.evaluate(()=>window.countryClub.getState()).then(s=>s.diagnostics.some(d=>d.code==='BROKER_MESSAGE'))).toBe(true);
  await app.close();app=undefined;page=undefined;
  const files=await readdir(logs);assert(files.length>0&&files.length<=4);let totalBytes=0;
  for(const name of files){assert(/^events\.[0-3]\.json$/.test(name));const text=await readFile(path.join(logs,name),'utf8');assert(!text.includes('PRIVATE'));assert(!text.includes(profile));assert(Buffer.byteLength(text)<=1048576);totalBytes+=Buffer.byteLength(text);const chunk=JSON.parse(text);for(const e of chunk.entries){assert.deepEqual(Object.keys(e).sort(),['code','time']);assert(!e.message);}}
  assert(totalBytes<=4194304);checks.push('real packaged broker-parse diagnostic persists only code/time and clean quit leaves no stage');
  await launch();
  const host=await page.evaluate(()=>window.countryClub.getState()),restored=host.diagnostics.find(d=>d.code==='BROKER_MESSAGE');assert(restored);assert.equal(restored.message,'Previous local diagnostic; no message was retained.');
  assert.deepEqual((await page.evaluate(()=>window.countryClub.loadRound())).state,saved);
  const review=await page.evaluate(()=>window.countryClub.previewDiagnostics());assert(review.content.includes('BROKER_MESSAGE'));assert(!review.content.includes('PRIVATE'));assert(!review.content.includes(profile));
  checks.push('restart restores sanitized history for the existing reviewed export and exact saved golf state');
  await app.close();app=undefined;page=undefined;
  const privateNote=path.join(logs,'user-note.txt');await writeFile(privateNote,'PRIVATE-UNCHANGED');
  const original=await Promise.all(files.map(async name=>[name,await readFile(path.join(logs,name),'utf8')]));
  await launch();
  await expect.poll(()=>page.evaluate(()=>window.countryClub.getState()).then(s=>s.diagnostics.some(d=>d.code==='DIAGNOSTIC_LOG_UNAVAILABLE'))).toBe(true);
  await page.getByRole('button',{name:'Play local practice',exact:true}).click();await shot(saved.shotId);
  await app.close();app=undefined;page=undefined;
  assert.equal(await readFile(privateNote,'utf8'),'PRIVATE-UNCHANGED');for(const [name,text] of original)assert.equal(await readFile(path.join(logs,name),'utf8'),text);
  assert.equal((await stat(privateNote)).size,17);
  checks.push('foreign diagnostic file disables disk logging quietly, preserves every existing file and still permits an acknowledged drag shot');
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,packaged:true,checks,totalBytes,limitations:['Broker parse failure is injected into the owned child stream; no live provider data is read.','Rotation, interrupted promotion and linked/oversized-file cases use filesystem unit tests.','Power-loss durability and adversarial concurrent directory replacement are not certified.']},null,2));
  console.log('Packaged diagnostic log acceptance passed.');
}catch(error){
  const evidence=await page?.evaluate(async()=>({events:window.__dragEvidence,round:await window.countryClub.loadRound(),host:await window.countryClub.getState()})).catch(e=>({unavailable:String(e)}));
  await page?.screenshot({path:path.join(artifacts,'failure.png')}).catch(()=>{});
  const writer=await readRoundWrites(app).catch(e=>({unavailable:String(e)}));
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:false,error:String(error),checks,profile,evidence,writer},null,2));throw error;
}finally{await app?.close().catch(()=>{});}
