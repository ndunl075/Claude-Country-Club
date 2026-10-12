import { _electron as electron, expect } from 'playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { dragShot } from './play-input.mjs';
assert(process.env.CCC_EXECUTABLE,'Set CCC_EXECUTABLE to the packaged application');
const artifacts=path.resolve('work/history-retention');await mkdir(artifacts,{recursive:true});
const profile=await mkdtemp(path.join(artifacts,'profile-')),data=path.join(profile,'data');
const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:data,CCC_TEST_HOME:path.join(profile,'home')};delete env.ELECTRON_RUN_AS_NODE;
let app,db;const checks=[];
try{
  app=await electron.launch({executablePath:process.env.CCC_EXECUTABLE,env,timeout:30000});
  let page=await app.firstWindow();await expect(page.getByRole('application')).toBeVisible();
  await app.close();app=undefined;
  db=new DatabaseSync(path.join(data,'country-club.sqlite'));
  const original=JSON.parse(db.prepare('SELECT state FROM round_save WHERE id=1').get().state);
  db.exec('BEGIN');const insert=db.prepare('INSERT INTO shots VALUES(?,?,?)');
  for(let i=0;i<200;i++){
    const historic={...original,id:`legacy-${i}`,shotId:1,strokes:1,velocity:{x:100,y:0}};
    insert.run(historic.id,1,JSON.stringify(historic));
  }
  db.exec('COMMIT');db.close();db=undefined;
  app=await electron.launch({executablePath:process.env.CCC_EXECUTABLE,env,timeout:30000});page=await app.firstWindow();
  assert.deepEqual((await page.evaluate(()=>window.countryClub.loadRound())).state,original);
  await page.getByRole('button',{name:'Play local practice',exact:true}).click();await dragShot(page,{angle:180,power:15});
  await expect.poll(async()=>(await page.evaluate(()=>window.countryClub.loadRound()))?.state?.shotId).toBe(1);
  await page.evaluate(()=>window.countryClub.hide());
  const acknowledged=(await page.evaluate(()=>window.countryClub.loadRound())).state;
  db=new DatabaseSync(path.join(data,'country-club.sqlite'),{readOnly:true});
  const stats=db.prepare('SELECT COUNT(*) AS n,SUM(length(CAST(state AS BLOB))) AS bytes FROM shots').get();
  assert.equal(stats.n,128);assert(stats.bytes<=4*1024*1024);
  assert.equal(db.prepare('SELECT round_id FROM shots ORDER BY rowid LIMIT 1').get().round_id,'legacy-73');
  const initial=JSON.parse(db.prepare('SELECT state FROM shots ORDER BY rowid DESC LIMIT 1').get().state);
  assert.equal(initial.id,acknowledged.id);assert.equal(initial.shotId,1);assert.equal(initial.strokes,1);
  assert(Math.abs(initial.velocity.x+176)<.02);assert(Math.abs(initial.velocity.y)<.02);
  db.close();db=undefined;
  checks.push('packaged SQLite trims legacy entries to 128 newest records and retains the new initial impulse');
  await app.close();app=await electron.launch({executablePath:process.env.CCC_EXECUTABLE,env,timeout:30000});page=await app.firstWindow();
  assert.deepEqual((await page.evaluate(()=>window.countryClub.loadRound())).state,acknowledged);
  db=new DatabaseSync(path.join(data,'country-club.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shots').get().n,128);
  checks.push('hidden checkpoint and restart preserve exact progress without duplicating retained shot history');
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,packaged:true,checks,stats,limitations:['History payload limits do not bound total SQLite file size; freed pages may be retained for reuse. Physical disk exhaustion remains unverified.']},null,2));
  console.log('Packaged history retention acceptance passed.');
}catch(error){await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:false,error:String(error),checks},null,2));throw error;}
finally{db?.close();await app?.close().catch(()=>{});}
