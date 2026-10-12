import { _electron as electron,expect } from 'playwright/test';
import { mkdir,mkdtemp,writeFile,readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { dragShot,observePointerInput } from './play-input.mjs';
import { observeRoundWrites,readRoundWrites } from './round-write-evidence.mjs';
assert(process.env.CCC_EXECUTABLE,'Set CCC_EXECUTABLE to the packaged application');
const artifacts=path.resolve('work/progress-files');await mkdir(artifacts,{recursive:true});
const profile=await mkdtemp(path.join(artifacts,'profile-')),data=path.join(profile,'data');
const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:data,CCC_TEST_HOME:path.join(profile,'home')};delete env.ELECTRON_RUN_AS_NODE;
const checks=[];let app;
const load=page=>page.evaluate(()=>window.countryClub.loadRound());
async function pick(file,canceled=false){await app.evaluate(({dialog},{file,canceled})=>{dialog.showOpenDialog=async()=>({canceled,filePaths:canceled?[]:[file]});},{file,canceled});}
async function importFromSettings(page){await page.getByRole('button',{name:'Import progress',exact:true}).click();await page.getByRole('button',{name:'Choose progress file',exact:true}).click();}
async function shot(page){
  const shotId=(await load(page))?.state?.shotId??0;
  await page.getByRole('button',{name:'Play',exact:true}).click();
  await dragShot(page,{angle:180,power:15});
  await expect.poll(async()=>{const r=(await load(page))?.state;return r?.shotId===shotId+1&&r?.velocity.x===0&&r?.velocity.y===0;},{timeout:15000}).toBe(true);
  await page.getByRole('button',{name:'Settings',exact:true}).click();
}
try{
  app=await electron.launch({executablePath:process.env.CCC_EXECUTABLE,env,timeout:30000});let page=await app.firstWindow();
  await observePointerInput(page);await observeRoundWrites(app);
  await page.getByRole('button',{name:'Play local practice',exact:true}).click();
  await page.getByRole('button',{name:'Settings',exact:true}).click();await shot(page);
  const exported=path.join(profile,'round.json');
  await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},exported);
  await page.getByRole('button',{name:'Export progress',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Progress exported'})).toBeVisible();
  const backup=JSON.parse(await readFile(exported,'utf8'));assert.equal(backup.format,'claude-country-club');assert.equal(backup.version,1);
  assert.deepEqual(backup.round.state,(await load(page)).state);checks.push('UI export writes the actual acknowledged round to selected file');
  await shot(page);const current=await load(page);assert.notDeepEqual(current.state,backup.round.state);
  const exportedBytes=await readFile(exported);
  await app.evaluate(({dialog})=>{dialog.showSaveDialog=async()=>({canceled:true});});
  await page.getByRole('button',{name:'Export progress',exact:true}).click();
  await expect(page.getByRole('button',{name:'Export progress',exact:true})).toBeEnabled();
  assert.deepEqual(await readFile(exported),exportedBytes);assert.deepEqual((await load(page)).state,current.state);
  checks.push('canceled export preserves existing file and round');
  await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},path.join(profile,'missing-directory','round.json'));
  await page.getByRole('button',{name:'Export progress',exact:true}).click();
  await expect(page.getByRole('alert')).toBeVisible();
  assert.deepEqual((await load(page)).state,current.state);assert.deepEqual(await readFile(exported),exportedBytes);
  checks.push('unwritable export destination reports failure without changing round or previous export');
  const invalids=[['malformed','{'],['wrong-format',JSON.stringify({...backup,format:'other'})],['future-format',JSON.stringify({...backup,version:99})],['invalid-physics',JSON.stringify({...backup,round:{...backup.round,state:{...backup.round.state,physicsVersion:99}}})],['oversized','x'.repeat(300001)]];
  for(const [name,text] of invalids){
    const file=path.join(profile,`${name}.json`);await writeFile(file,text);await pick(file);
    await importFromSettings(page);await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
    assert.deepEqual((await load(page)).state,current.state,`${name} changed progress`);
    await page.getByRole('button',{name:'Close dialog',exact:true}).click();
    checks.push(`${name} import rejected without changing round`);
  }
  await pick('',true);await importFromSettings(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);assert.deepEqual((await load(page)).state,current.state);
  checks.push('canceled file choice preserves round');
  await pick(exported);
  await Promise.all([page.waitForEvent('domcontentloaded',{timeout:30000}),importFromSettings(page)]);
  await expect.poll(async()=> (await load(page)).state).toEqual(backup.round.state);
  await expect(page.getByRole('region',{name:'Mini golf game',exact:true})).toBeVisible();
  const imported=await load(page);assert(imported.revision>current.revision);
  const db=new DatabaseSync(path.join(data,'country-club.sqlite.before-import'),{readOnly:true});
  try{assert.deepEqual(JSON.parse(db.prepare('SELECT state FROM round_save WHERE id=1').get().state),current.state);}finally{db.close();}
  checks.push('valid import restores exported state at new local revision and retains previous database backup');
  await app.close();app=await electron.launch({executablePath:process.env.CCC_EXECUTABLE,env,timeout:30000});page=await app.firstWindow();
  await expect(page.getByRole('region',{name:'Mini golf game',exact:true})).toBeVisible();assert.deepEqual((await load(page)).state,backup.round.state);
  checks.push('imported round survives packaged restart');
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,packaged:true,checks,limitations:['Native file picker result is stubbed in the test main process; OS chooser interaction is not certified.']},null,2));
  console.log('Packaged progress file acceptance passed.');
}catch(error){
  const page=app?.windows()[0];
  const evidence=await page?.evaluate(async()=>({events:window.__dragEvidence,round:await window.countryClub.loadRound(),host:await window.countryClub.getState(),visibility:document.visibilityState,focused:document.hasFocus(),scroll:{x:scrollX,y:scrollY},canvas:{disabled:document.querySelector('canvas')?.getAttribute('aria-disabled'),description:document.querySelector('canvas')?.getAttribute('aria-description'),bounds:document.querySelector('canvas')?.getBoundingClientRect().toJSON()}})).catch(e=>({unavailable:String(e)}));
  await page?.screenshot({path:path.join(artifacts,'failure.png')}).catch(()=>{});
  const writer=await readRoundWrites(app).catch(e=>({unavailable:String(e)}));
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:false,error:String(error),checks,profile,evidence,writer},null,2));throw error;
}
finally{await app?.close().catch(()=>{});}


