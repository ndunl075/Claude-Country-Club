import { _electron as electron,expect } from 'playwright/test';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { dragShot,pullAim,observePointerInput } from './play-input.mjs';

assert(process.env.CCC_EXECUTABLE,'Set CCC_EXECUTABLE to the packaged application');
const artifacts=path.resolve('work/pointer-interruption');await mkdir(artifacts,{recursive:true});
const results=[];let app,page,profile;
const load=()=>page.evaluate(()=>window.countryClub.loadRound());
const shown=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible()));
try{
  for(const kind of ['escape','lost-capture','hide']){
    profile=await mkdtemp(path.join(artifacts,'profile-'));
    const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:path.join(profile,'data'),CCC_TEST_HOME:path.join(profile,'home')};delete env.ELECTRON_RUN_AS_NODE;
    app=await electron.launch({executablePath:process.env.CCC_EXECUTABLE,env,timeout:30000});page=await app.firstWindow();
    await observePointerInput(page);
    await page.getByRole('button',{name:'Play local practice',exact:true}).click();
    // Fresh idle rounds are written on their first shot or freeze, not on boot.
    // Establish an acknowledged checkpoint before comparing canceled gestures.
    await page.evaluate(()=>window.countryClub.hide());await expect.poll(shown).toBe(false);
    await app.evaluate(({app})=>app.emit('activate'));await expect.poll(shown).toBe(true);
    await page.getByRole('button',{name:'Play local practice',exact:true}).click();
    const canvas=page.getByRole('application');await expect(canvas).toHaveAttribute('aria-disabled','false');
    const before=(await load()).state,aim=await canvas.getAttribute('aria-description');
    await pullAim(page,{angle:90,power:25});
    await expect(canvas).not.toHaveAttribute('aria-description',aim);
    if(kind==='escape'){
      await page.keyboard.press('Escape');assert.equal(await shown(),true,'Escape while dragging hid the course');
    }else if(kind==='lost-capture'){
      await page.evaluate(()=>{
        const down=window.__dragEvidence.findLast(e=>e.type==='pointerdown'&&e.target==='CANVAS');
        const canvas=document.querySelector('canvas');
        if(!down||!canvas.hasPointerCapture(down.id))throw new Error('Active native pointer capture missing');
        canvas.releasePointerCapture(down.id);
      });
      // Chromium dispatches pending lost capture before the next pointer event.
      await page.mouse.move(10,10);
      await expect.poll(()=>page.evaluate(()=>window.__dragEvidence.some(e=>e.type==='lostpointercapture'))).toBe(true);
    }else{
      await page.evaluate(()=>window.countryClub.hide());await expect.poll(shown).toBe(false);
      await expect(canvas).toHaveAttribute('aria-disabled','true');
    }
    await page.mouse.up();
    await expect(canvas).toHaveAttribute('aria-description',aim);
    assert.deepEqual((await load()).state,before,`${kind} changed progress before recovery`);
    if(kind==='hide'){
      await app.evaluate(({app})=>app.emit('activate'));await expect.poll(shown).toBe(true);
      await page.getByRole('button',{name:'Play local practice',exact:true}).click();
    }
    await dragShot(page,{angle:180,power:15});
    await expect.poll(async()=>{const r=(await load()).state;return r.shotId===before.shotId+1&&r.velocity.x===0&&r.velocity.y===0;},{timeout:15000}).toBe(true);
    const after=(await load()).state;
    assert.equal(after.strokes,before.strokes+1,`${kind} counted a canceled stroke`);
    const events=await page.evaluate(()=>window.__dragEvidence);
    results.push({kind,passed:true,restoredAim:true,shotId:after.shotId,strokes:after.strokes,events});
    await app.close();app=undefined;page=undefined;
  }
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,packaged:true,results,limitations:['Browser input and injected main-process hide; physical OS focus/capture delivery is not certified.','These deliberate interruptions do not explain the preserved intermittent no-shot failure.']},null,2));
  console.log('Packaged pointer interruption acceptance passed.');
}catch(error){
  const evidence=await page?.evaluate(async()=>({events:window.__dragEvidence,round:await window.countryClub.loadRound(),host:await window.countryClub.getState(),visibility:document.visibilityState,focused:document.hasFocus()})).catch(e=>({unavailable:String(e)}));
  await page?.screenshot({path:path.join(artifacts,'failure.png')}).catch(()=>{});
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:false,error:String(error),profile,results,evidence},null,2));throw error;
}finally{await app?.close().catch(()=>{});}
