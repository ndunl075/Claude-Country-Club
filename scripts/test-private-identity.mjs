import { _electron as electron,expect } from 'playwright/test';
import { mkdir,mkdtemp,readFile,writeFile,unlink } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import assert from 'node:assert/strict';
import { dragShot } from './play-input.mjs';
assert(process.env.CCC_EXECUTABLE,'Set CCC_EXECUTABLE to the packaged application');
const artifacts=path.resolve('work/private-identity');await mkdir(artifacts,{recursive:true});
const helper=process.platform==='darwin'?path.resolve(path.dirname(process.env.CCC_EXECUTABLE),'../Resources/ccc-hook'):path.join(path.dirname(process.env.CCC_EXECUTABLE),'resources','ccc-hook.exe');
const rawSession='identity-fixture-session',rawWorkspace='C:/identity-private-workspace';
let app;const checks=[];
async function launch(profile,ready=true){
  const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:path.join(profile,'data'),CCC_TEST_HOME:path.join(profile,'home')};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:process.env.CCC_EXECUTABLE,env,timeout:30000});const page=await app.firstWindow();
  if(ready)await expect.poll(async()=>(await page.evaluate(()=>window.countryClub.getState())).brokerReady).toBe(true);
  return page;
}
async function event(profile,page){
  const child=spawn(helper,['--provider','codex','--event','start','--config',path.join(profile,'data/connection.json')],{windowsHide:true,stdio:'pipe'});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  child.stdin.end(JSON.stringify({session_id:rawSession,cwd:rawWorkspace,turn_id:'identity-fixture-turn'}));
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(`Hook exit ${code}`)));});assert.equal(output,'');
  await expect.poll(async()=>(await page.evaluate(()=>window.countryClub.getState())).sessions.length).toBe(1);
  const host=await page.evaluate(()=>window.countryClub.getState());
  const key=await readFile(path.join(profile,'data/identity-key'),'utf8');
  const expected=createHmac('sha256',Buffer.from(key,'hex')).update(`codex\0${rawSession}\0${rawWorkspace}`).digest('hex').slice(0,32);
  assert.equal(host.sessions[0].key,`codex:${expected}`);
  const serialized=JSON.stringify(host);for(const secret of [key,rawSession,rawWorkspace])assert(!serialized.includes(secret));
  return {session:host.sessions[0].key,key};
}
try{
  const a=await mkdtemp(path.join(artifacts,'profile-a-')),b=await mkdtemp(path.join(artifacts,'profile-b-'));
  let page=await launch(a);const first=await event(a,page);await page.evaluate(key=>window.countryClub.selectSession(key),first.session);
  await app.close();app=undefined;
  page=await launch(a);assert.equal((await page.evaluate(()=>window.countryClub.getState())).sessions.length,0);
  const restarted=await event(a,page);assert.equal(restarted.key,first.key);assert.equal(restarted.session,first.session);
  assert.equal((await page.evaluate(()=>window.countryClub.getState())).selectedSession,first.session);
  checks.push('real native events use the expected keyed identity; restart preserves key and selection without restoring working state');
  await app.close();app=undefined;
  page=await launch(b);const other=await event(b,page);assert.notEqual(other.key,first.key);assert.notEqual(other.session,first.session);
  checks.push('identical raw provider/session/workspace metadata has different identities in independent installations');
  await app.close();app=undefined;
  // Model an older data directory that has preferences but no installation key.
  await unlink(path.join(a,'data/identity-key'));
  const db=new DatabaseSync(path.join(a,'data/country-club.sqlite'));
  try{db.prepare("UPDATE settings SET value=? WHERE key='preferences'").run(JSON.stringify({automatic:false,selectedSession:'codex:legacy-unsalted-root'}));}finally{db.close();}
  page=await launch(a);assert.equal((await page.evaluate(()=>window.countryClub.getState())).selectedSession,null);
  const migrated=await event(a,page);assert.notEqual(migrated.key,first.key);
  assert.equal((await page.evaluate(()=>window.countryClub.getState())).selectedSession,migrated.session);
  checks.push('first key creation clears incompatible legacy selection and fresh events can select a new root');
  await app.close();app=undefined;
  const invalid='x'.repeat(64);await writeFile(path.join(a,'data/identity-key'),invalid);
  page=await launch(a,false);
  await expect.poll(async()=>(await page.evaluate(()=>window.countryClub.getState())).diagnostics.some(d=>d.code==='BROKER_UNAVAILABLE')).toBe(true);
  assert.equal((await page.evaluate(()=>window.countryClub.getState())).brokerReady,false);
  assert.equal(await readFile(path.join(a,'data/identity-key'),'utf8'),invalid);
  await page.getByRole('button',{name:'Play local practice',exact:true}).click();await dragShot(page,{angle:180,power:15});
  await expect.poll(async()=>(await page.evaluate(()=>window.countryClub.loadRound()))?.state?.shotId).toBe(1);
  checks.push('invalid key is preserved; automatic connection fails closed while practice still saves');
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,packaged:true,checks,limitations:['Isolated synthetic metadata over real native IPC; no live provider configuration or signed-in client certification. Key files are access-controlled, not encrypted.']},null,2));
  console.log('Packaged private identity acceptance passed.');
}catch(error){await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:false,error:String(error),checks},null,2));throw error;}
finally{await app?.close().catch(()=>{});}
