import { dragShot } from './play-input.mjs';
import { _electron as electron, expect } from 'playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import path from 'node:path';

// Exercise the actual packaged renderer/main IPC with a separate SQLite writer.
// All mutations are confined to a newly created fixture profile.
const root=process.cwd(), artifacts=path.join(root,'work/save-faults');
await mkdir(artifacts,{recursive:true});
const fixture=await mkdtemp(path.join(artifacts,'profile-'));
const data=path.join(fixture,'data'),home=path.join(fixture,'home');await mkdir(home,{recursive:true});
const executablePath=process.env.CCC_EXECUTABLE||path.join(root,'release/win-unpacked/Claude Country Club.exe');
const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:data,CCC_TEST_HOME:home};delete env.ELECTRON_RUN_AS_NODE;
let application, database, locked=false;
const checks=[];
async function launch(){
  application=await electron.launch({executablePath,args:[],env,timeout:30_000});
  const page=await application.firstWindow();
  await expect(page.getByRole('region',{name:'Mini golf game',exact:true})).toBeVisible({timeout:15_000});
  return page;
}
async function load(page){return page.evaluate(()=>window.countryClub.loadRound());}
try {
  let page=await launch();
  await page.getByRole('button',{name:'Play local practice',exact:true}).click();
  await page.evaluate(()=>window.countryClub.hide()); // acknowledge the initial zero-stroke round
  const baseline=await load(page);assert.equal(baseline.state.strokes,0);
  await page.evaluate(()=>window.countryClub.practice());
  
  database=new DatabaseSync(path.join(data,'country-club.sqlite'));
  database.exec('BEGIN IMMEDIATE');locked=true;
  await dragShot(page);
  await expect(page.getByRole('alert')).toContainText(/locked/);
  await expect(page.getByRole('application')).toHaveAttribute('aria-disabled','true');
  assert.deepEqual(await load(page),baseline,'Locked write replaced acknowledged state');
  assert.equal((await page.evaluate(()=>window.countryClub.getState())).suspended,true);
  await page.screenshot({path:path.join(artifacts,'locked-save.png')});
  checks.push('external writer lock pauses gameplay and preserves acknowledged state');
  database.exec('ROLLBACK');locked=false;
  await page.getByRole('button',{name:'Retry save',exact:true}).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  assert.deepEqual((await load(page)).state,baseline.state,'Retry invented a stroke');
  await page.getByRole('button',{name:'Play local practice',exact:true}).click();
  await expect(page.getByRole('application')).toHaveAttribute('aria-disabled','false');
  checks.push('explicit retry after unlock retains the zero-stroke round');

  database.exec("CREATE TRIGGER rollback_fixture BEFORE INSERT ON shots BEGIN SELECT RAISE(ROLLBACK,'storage transaction canceled'); END;");
  await dragShot(page);
  await expect(page.getByRole('alert')).toContainText('storage transaction canceled');
  await expect(page.getByRole('application')).toHaveAttribute('aria-disabled','true');
  assert.deepEqual((await load(page)).state,baseline.state);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM shots').get().n,0);
  checks.push('SQLite automatic rollback retains original failure and no phantom stroke');
  database.exec('DROP TRIGGER rollback_fixture;');database.close();database=undefined;
  await page.getByRole('button',{name:'Retry save',exact:true}).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button',{name:'Play local practice',exact:true}).click();
  await dragShot(page);
  await expect.poll(async()=>(await load(page)).state.strokes).toBe(1);
  await page.evaluate(()=>window.countryClub.hide());
  const acknowledged=await load(page);
  await application.close();application=undefined;
  // Normal quit can acknowledge another frozen checkpoint at a new revision.
  database=new DatabaseSync(path.join(data,'country-club.sqlite'));
  const finalRow=database.prepare('SELECT revision,state FROM round_save WHERE id=1').get();
  const finalSave={revision:finalRow.revision,state:JSON.parse(finalRow.state)};
  assert.deepEqual(finalSave.state,acknowledged.state);assert(finalSave.revision>=acknowledged.revision);
  database.close();database=undefined;
  page=await launch();assert.deepEqual(await load(page),finalSave);
  checks.push('normal shot after recovery survives packaged restart exactly');
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,packaged:true,time:new Date().toISOString(),executablePath,checks,limitations:['SQLite page exhaustion is tested in the Store suite; this packaged test injects locking and automatic rollback, not physical disk exhaustion.']},null,2));
  console.log('Packaged save-fault tests passed.');
} catch(error){
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:false,time:new Date().toISOString(),checks,error:String(error)},null,2));throw error;
} finally {
  if(locked)try{database.exec('ROLLBACK');}catch{}
  database?.close();
  if(application)await application.close().catch(()=>{});
}

