import { _electron as electron,expect } from 'playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
assert(process.env.CCC_EXECUTABLE,'Set CCC_EXECUTABLE to the packaged application');
const artifacts=path.resolve('work/display-bounds');await mkdir(artifacts,{recursive:true});
const profile=await mkdtemp(path.join(artifacts,'profile-')),data=path.join(profile,'data');
const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:data,CCC_TEST_HOME:path.join(profile,'home')};delete env.ELECTRON_RUN_AS_NODE;
let app;const checks=[];const pause=ms=>new Promise(r=>setTimeout(r,ms));
const primary={x:0,y:0,width:800,height:600},left={x:-1280,y:-160,width:1280,height:984};
const snapshot=()=>app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return {bounds:w.getBounds(),minimum:w.getMinimumSize(),visible:w.isVisible(),focused:w.isFocused()};});
function inside(bounds,area){assert(bounds.x>=area.x&&bounds.y>=area.y&&bounds.x+bounds.width<=area.x+area.width&&bounds.y+bounds.height<=area.y+area.height,`Window outside work area: ${JSON.stringify({bounds,area})}`);}
async function displays(areas,event){await app.evaluate(({screen},{areas,event})=>{
  const list=areas.map((workArea,id)=>({id,workArea,bounds:workArea,scaleFactor:1}));
  screen.getAllDisplays=()=>list;screen.getPrimaryDisplay=()=>list[0];
  if(event)screen.emit(event,{},list[0],['workArea','bounds','scaleFactor']);
},{areas,event});}
try{
  app=await electron.launch({executablePath:process.env.CCC_EXECUTABLE,env,timeout:30000});const page=await app.firstWindow();
  await expect(page.getByRole('application')).toBeVisible();await pause(350);
  await displays([primary,left]);
  const candidate={x:-1000,y:-80,width:620,height:600};
  const db=new DatabaseSync(path.join(data,'country-club.sqlite'));
  try{db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('window:dashboard',JSON.stringify(candidate));}finally{db.close();}
  await app.evaluate(({app})=>app.emit('activate'));
  await expect.poll(async()=>(await snapshot()).bounds).toEqual(candidate);
  checks.push('actual native window restores saved negative-coordinate secondary-display placement');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].blur());
  let before=await snapshot();await displays([primary],'display-removed');
  let after=await snapshot();inside(after.bounds,primary);assert.equal(after.focused,before.focused);assert.equal(after.visible,before.visible);
  checks.push('display removal restores full containment without showing or focusing the window');
  const small={x:0,y:0,width:400,height:300};before=after;await displays([small],'display-metrics-changed');
  after=await snapshot();inside(after.bounds,small);assert(after.minimum[0]<=400&&after.minimum[1]<=300);assert.equal(after.focused,before.focused);
  checks.push('work-area shrink lowers native minimums so all window edges remain reachable');
  await page.evaluate(()=>window.countryClub.hide());before=await snapshot();
  await displays([primary],'display-metrics-changed');after=await snapshot();inside(after.bounds,primary);assert.equal(after.visible,false);assert.equal(after.focused,false);
  assert.deepEqual(after.minimum,[520,480]);
  checks.push('hidden-window display changes remain hidden and normal work-area minimums are restored');
  await pause(350);
  const checkDb=new DatabaseSync(path.join(data,'country-club.sqlite'),{readOnly:true});
  try{assert.deepEqual(JSON.parse(checkDb.prepare("SELECT value FROM settings WHERE key='window:dashboard'").get().value),after.bounds);}finally{checkDb.close();}
  checks.push('corrected current-mode bounds persist to the actual SQLite settings');
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,packaged:true,checks,limitations:['Display metadata and notifications are stubbed inside the isolated Electron host; real native window bounds/minimums, focus and SQLite persistence are checked. Physical multi-monitor unplug, DPI changes and Mac behavior remain unverified.']},null,2));
  console.log('Packaged display bounds acceptance passed.');
}catch(error){await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:false,error:String(error),checks},null,2));throw error;}
finally{await app?.close().catch(()=>{});}
