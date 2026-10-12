import { _electron as electron, expect } from 'playwright/test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

assert(process.env.CCC_EXECUTABLE, 'Set CCC_EXECUTABLE to the packaged executable');
const artifacts=path.resolve('work/ui');
await mkdir(artifacts,{recursive:true});
const profile=await mkdtemp(path.join(artifacts,'profile-'));
const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:path.join(profile,'data'),CCC_TEST_HOME:path.join(profile,'home')};
delete env.ELECTRON_RUN_AS_NODE;
let app;
const checks=[],errors=[],layouts=[];
try {
  app=await electron.launch({executablePath:process.env.CCC_EXECUTABLE,env,timeout:30000});
  const page=await app.firstWindow();
  page.on('pageerror',e=>errors.push(e.message));
  await expect(page.getByRole('button',{name:'Play local practice',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Play local practice',exact:true}).click();
  for(const zoom of [1,1.25,1.5,2]) {
    await app.evaluate(({BrowserWindow},z)=>{const w=BrowserWindow.getAllWindows()[0];w.setBounds({width:620,height:600});w.webContents.setZoomFactor(z);},zoom);
    for(const open of [false]) {
      await expect(page.getByRole('slider')).toHaveCount(0);
      await page.screenshot({path:path.join(artifacts,`zoom-${zoom}-${open?'controls':'course'}.png`),fullPage:true});
      const nativeImage=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
      await writeFile(path.join(artifacts,`native-${zoom}-${open?'controls':'course'}.png`),Buffer.from(nativeImage,'base64'));
      const fit=await page.evaluate(()=>({width:innerWidth,content:document.documentElement.scrollWidth}));
      layouts.push({zoom,open,...fit});
      assert(fit.content<=fit.width+1,`Horizontal clipping: ${JSON.stringify(layouts.at(-1))}`);
      const course=await page.getByRole('application').boundingBox();
      assert(course&&course.x>=0&&course.x+course.width<=fit.width+1,`Course clipped at ${zoom}`);
    }
  }
  checks.push('slider-free course reflows at 100%, 125%, 150%, 200% zoom');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  const canvas=page.getByRole('application');
  await expect(canvas).toHaveAttribute('aria-disabled','false');
  await canvas.scrollIntoViewIfNeeded();
  const bounds=await canvas.boundingBox();
  const ball={x:bounds.x+(72+760*.84)/900*bounds.width,y:bounds.y+(48+300*.84)/600*bounds.height};
  const untouched=await page.evaluate(()=>window.countryClub.loadRound());
  await page.mouse.click(ball.x,ball.y);
  assert.deepEqual(await page.evaluate(()=>window.countryClub.loadRound()),untouched,'Simple tap shot the ball');
  await page.mouse.move(ball.x,ball.y);await page.mouse.down();await page.mouse.move(ball.x-50,ball.y+20,{steps:4});
  await page.keyboard.press('Escape');await page.mouse.up();
  assert.deepEqual(await page.evaluate(()=>window.countryClub.loadRound()),untouched,'Canceled drag shot the ball');
  assert(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),'Canceling a drag hid the window');
  checks.push('tap does not shoot; Escape cancels drag without shooting or hiding');
  await expect(canvas).toHaveAttribute('aria-description',/^Aim 180 degrees, power 45 percent\./);
  await canvas.focus();await page.keyboard.press('ArrowRight');
  await expect(canvas).toHaveAttribute('aria-description',/^Aim 185 degrees, power 45 percent\./);
  await page.keyboard.press('ArrowUp');
  await expect(canvas).toHaveAttribute('aria-description',/^Aim 185 degrees, power 50 percent\./);
  await page.keyboard.press('ArrowLeft');await page.keyboard.press('ArrowDown');
  await expect(canvas).toHaveAttribute('aria-description',/^Aim 180 degrees, power 45 percent\./);
  const before=await page.evaluate(()=>window.countryClub.loadRound());
  await page.keyboard.down('Space');await page.keyboard.down('Space');await page.keyboard.up('Space');
  await expect.poll(async()=> (await page.evaluate(()=>window.countryClub.loadRound()))?.state?.strokes).toBe((before?.state?.strokes??0)+1);
  await page.keyboard.press('Escape');
  await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
  const frozen=await page.evaluate(()=>window.countryClub.loadRound());
  await app.close();
  app=await electron.launch({executablePath:process.env.CCC_EXECUTABLE,env,timeout:30000});
  const restored=await app.firstWindow();
  await expect(restored.getByRole('button',{name:'Settings',exact:true})).toBeVisible();
  const recovered=await restored.evaluate(()=>window.countryClub.loadRound());
  assert.deepEqual(recovered.state,frozen.state);
  assert(recovered.revision>=frozen.revision);
  checks.push('keyboard aim/power, held Space single stroke, Escape hide, exact restart recovery');
  await restored.getByRole('button',{name:'Settings',exact:true}).click();
  const delay=restored.getByRole('combobox',{name:'Automatic opening delay',exact:true});
  await expect(delay).toBeVisible();
  assert.deepEqual(await delay.locator('option').evaluateAll(es=>es.map(e=>Number(e.value))),[1000,2000,5000,10000,30000]);
  for(const value of ['1000','2000','5000','10000','30000']) {
    await delay.selectOption(value);
    await expect.poll(async()=> (await restored.evaluate(()=>window.countryClub.getState())).settings.delayMs).toBe(Number(value));
  }
  checks.push('every offered delay accepted and persisted');
  const saved=await restored.evaluate(()=>window.countryClub.loadRound());
  await restored.getByRole('button',{name:'Start a new round',exact:true}).click();
  const dialog=restored.getByRole('dialog');await expect(dialog).toBeVisible();
  for(let i=0;i<12;i++){await restored.keyboard.press('Tab');assert(await dialog.evaluate(e=>e.contains(document.activeElement)),'Focus escaped modal');}
  await restored.keyboard.press('Escape');await expect(dialog).not.toBeVisible();
  assert.deepEqual(await restored.evaluate(()=>window.countryClub.loadRound()),saved);
  checks.push('reset dialog traps keyboard focus and Escape preserves round');
  assert.deepEqual(errors,[]);
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,packaged:true,checks,layouts},null,2));
  console.log('Packaged UI acceptance passed.');
} catch(error) {
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:false,error:String(error),checks,layouts},null,2));throw error;
} finally {await app?.close().catch(()=>{});}
