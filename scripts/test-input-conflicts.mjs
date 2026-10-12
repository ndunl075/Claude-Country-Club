import { _electron as electron, expect } from 'playwright/test';
import { mkdir,mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pullAim,dragShot,observePointerInput } from './play-input.mjs';
import { observeRoundWrites,readRoundWrites } from './round-write-evidence.mjs';
assert(process.env.CCC_EXECUTABLE);
const artifacts=path.resolve('work/input-conflicts');await mkdir(artifacts,{recursive:true});
const results=[];
for(const kind of ['space-during-pull','enter-during-pull','escape-repeat']){
 let app,page,phase='launch';const profile=await mkdtemp(path.join(artifacts,'profile-'));
 const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:path.join(profile,'data'),CCC_TEST_HOME:path.join(profile,'home')};delete env.ELECTRON_RUN_AS_NODE;
 try{
  app=await electron.launch({executablePath:process.env.CCC_EXECUTABLE,env,timeout:30000});page=await app.firstWindow();await observePointerInput(page);await observeRoundWrites(app);
  const shown=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible()));
  const load=()=>page.evaluate(()=>window.countryClub.loadRound());
  const settled=id=>expect.poll(async()=>{const r=(await load()).state;return r.shotId===id&&r.velocity.x===0&&r.velocity.y===0;},{timeout:15000}).toBe(true);
  await page.getByRole('button',{name:'Play local practice',exact:true}).click();await page.evaluate(()=>window.countryClub.hide());await expect.poll(shown).toBe(false);
  await app.evaluate(({app})=>app.emit('activate'));await page.getByRole('button',{name:'Play local practice',exact:true}).click();
  const before=(await load()).state,canvas=page.getByRole('application'),aim=await canvas.getAttribute('aria-description');
  await pullAim(page,{angle:180,power:15});await expect(canvas).not.toHaveAttribute('aria-description',aim);
  if(kind==='escape-repeat'){
   phase='first Escape cancels pull';await page.keyboard.down('Escape');await expect(canvas).toHaveAttribute('aria-description',aim);assert.equal(await shown(),true);
   phase='same physical Escape press repeats';await page.keyboard.down('Escape');await page.waitForTimeout(100);assert.equal(await shown(),true,'Repeated Escape hid after canceling the same pull');
   await page.mouse.up();assert.deepEqual((await load()).state,before);await page.keyboard.up('Escape');
   phase='separate Escape press hides';await page.keyboard.press('Escape');await expect.poll(shown).toBe(false);assert.deepEqual((await load()).state,before);
   await app.evaluate(({app})=>app.emit('activate'));await page.getByRole('button',{name:'Play local practice',exact:true}).click();await dragShot(page,{angle:180,power:15});await settled(1);
  }else{
   const pullDescription=await canvas.getAttribute('aria-description');
   phase='keyboard aim during active pointer pull';for(const key of ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown']){await page.keyboard.press(key);assert.equal(await canvas.getAttribute('aria-description'),pullDescription,'Keyboard changed aim during active pointer pull');}
   const key=kind.startsWith('space')?'Space':'Enter';phase='keyboard while pointer remains held';await page.keyboard.press(key);await page.waitForTimeout(100);
   assert.deepEqual((await load()).state,before,'Keyboard fired before the active pointer pull was released');
   phase='pointer release fires exactly once';await page.mouse.up();await settled(1);assert.equal((await load()).state.strokes,1);
   phase='idle keyboard control remains usable';await canvas.press(key);await settled(2);assert.equal((await load()).state.strokes,2);
  }
  results.push({kind,passed:true,events:await page.evaluate(()=>window.__dragEvidence),writer:await readRoundWrites(app)});
 }catch(error){results.push({kind,passed:false,phase,error:String(error),profile,evidence:await page?.evaluate(async()=>({events:window.__dragEvidence,round:await window.countryClub.loadRound(),host:await window.countryClub.getState()})).catch(()=>null),writer:app?await readRoundWrites(app).catch(()=>null):null});}
 finally{await page?.keyboard.up('Escape').catch(()=>{});await app?.close().catch(()=>{});}
}
const passed=results.every(r=>r.passed);await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed,executableSha256:createHash('sha256').update(await readFile(process.env.CCC_EXECUTABLE)).digest('hex'),results,limitations:['Browser-dispatched pointer/keyboard events and repeated keydown; physical keyboard/OS repeat delivery is not certified.','Test-only input/save observation can affect timing. These conflicts do not establish the cause of either historical input observation.']},null,2));
assert(passed,'Packaged input conflicts failed; inspect retained per-case evidence');console.log('Packaged pointer/keyboard conflict acceptance passed.');
