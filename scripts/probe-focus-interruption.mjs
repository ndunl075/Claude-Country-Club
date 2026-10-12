import { _electron as electron,expect } from 'playwright/test';
import { mkdir,mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pullAim,dragShot,observePointerInput } from './play-input.mjs';
import { observeRoundWrites,readRoundWrites } from './round-write-evidence.mjs';
assert(process.env.CCC_EXECUTABLE);
const artifacts=path.resolve('work/focus-interruption');await mkdir(artifacts,{recursive:true});
const results=[];
for(const kind of ['canvas-focus-away','window-blur','minimize','hidden-event-fixture']){
 let app,page;const observations={};const profile=await mkdtemp(path.join(artifacts,'profile-'));
 const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:path.join(profile,'data'),CCC_TEST_HOME:path.join(profile,'home')};delete env.ELECTRON_RUN_AS_NODE;
 try{
  app=await electron.launch({executablePath:process.env.CCC_EXECUTABLE,env,timeout:30000});page=await app.firstWindow();
  // Preserve native termination details even when the page can no longer run JS.
  await app.evaluate(({app,BrowserWindow})=>{
   globalThis.__focusProcessFailures=[];
   app.on('child-process-gone',(_event,details)=>globalThis.__focusProcessFailures.push({source:'child',type:details.type,reason:details.reason,exitCode:details.exitCode}));
   for(const w of BrowserWindow.getAllWindows())w.webContents.on('render-process-gone',(_event,details)=>globalThis.__focusProcessFailures.push({source:'renderer',reason:details.reason,exitCode:details.exitCode}));
  });
  // Playwright's focused-page emulation masks native blur/visibility signals.
  const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:false});
  await observePointerInput(page);await observeRoundWrites(app);
  await page.evaluate(()=>{window.__focusEvidence=[];for(const type of ['blur','focus'])window.addEventListener(type,()=>window.__focusEvidence.push({type,time:Date.now(),focused:document.hasFocus(),visibility:document.visibilityState}));});
  const shown=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible()));
  await page.getByRole('button',{name:'Play local practice',exact:true}).click();await page.evaluate(()=>window.countryClub.hide());await expect.poll(shown).toBe(false);
  await app.evaluate(({app})=>app.emit('activate'));await page.getByRole('button',{name:'Play local practice',exact:true}).click();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].focus());
  const canvas=page.getByRole('application'),initialAim=await canvas.getAttribute('aria-description');
  const snapshot=()=>page.evaluate(async()=>({round:(await window.countryClub.loadRound()).state,aim:document.querySelector('canvas').getAttribute('aria-description'),focused:document.hasFocus(),visibility:document.visibilityState,active:document.activeElement?.tagName,events:window.__dragEvidence,focusEvents:window.__focusEvidence}));
  const nativeState=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().filter(w=>w.webContents.getURL().startsWith('ccc://')).map(w=>({id:w.id,url:w.webContents.getURL(),visible:w.isVisible(),focused:w.isFocused(),minimized:w.isMinimized(),minimizable:w.isMinimizable()})));
  const before=await snapshot();await pullAim(page,{angle:180,power:15});const nativeBefore=await nativeState();
  if(kind==='hidden-event-fixture')await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  else if(kind==='canvas-focus-away')await page.evaluate(()=>{const button=document.querySelector('button');if(!button)throw Error('No focus destination');button.focus();});
  else await app.evaluate(async({BrowserWindow},kind)=>{
   const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('ccc://'));
   // Give native focus a deterministic owned destination. With no destination,
   // Windows can immediately reactivate the sole window after blur/minimize.
   const destination=new BrowserWindow({show:false,width:200,height:100,webPreferences:{sandbox:true}});
   await destination.loadURL('about:blank');
   if(kind==='window-blur')w.blur();else w.minimize();destination.show();destination.focus();
  },kind);
  if(kind==='window-blur'||kind==='minimize'){
   await expect.poll(async()=>{const state=await nativeState();observations.native=state;return !state[0].focused&&(kind!=='minimize'||state[0].minimized);},{timeout:5000}).toBe(true);
   await expect.poll(()=>page.evaluate(()=>document.hasFocus())).toBe(false);
  }
  await page.waitForTimeout(100);const interrupted=await snapshot(),nativeInterrupted=await nativeState();observations.interrupted=interrupted;observations.native=nativeInterrupted;
  if(kind==='window-blur'||kind==='minimize')assert.equal(nativeInterrupted[0].focused,false,'Native focus loss was not observed');
  if(kind==='window-blur'||kind==='minimize')assert.equal(interrupted.focused,false,'Browser focus loss was masked');
  if(kind==='minimize')assert.equal(nativeInterrupted[0].minimized,true);
  // Deliver a release through Chromium while the owned window is interrupted.
  // This tests app state, not physical OS routing of a release outside its window.
  await page.mouse.up();await page.waitForTimeout(300);const released=await snapshot();
  await app.evaluate(({BrowserWindow})=>{const windows=BrowserWindow.getAllWindows(),w=windows.find(w=>w.webContents.getURL().startsWith('ccc://'));for(const other of windows)if(other!==w)other.destroy();if(w.isMinimized())w.restore();w.focus();});
  if(kind==='hidden-event-fixture')await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForTimeout(300);const restored=await snapshot();
  assert.equal(interrupted.aim,initialAim,'Interruption did not restore the pre-pull aim');
  assert.deepEqual(released.round,before.round,'Release after interruption changed saved progress');
  assert.deepEqual(restored.round,before.round,'Restoring the window changed saved progress');
  await dragShot(page,{angle:180,power:15});
  await expect.poll(async()=>{const r=(await snapshot()).round;return r.shotId===before.round.shotId+1&&r.velocity.x===0&&r.velocity.y===0;},{timeout:15000}).toBe(true);
  const recovered=await snapshot(),writer=await readRoundWrites(app);
  assert.equal(recovered.round.strokes,before.round.strokes+1,'Recovery counted an interrupted stroke');
  assert.equal(writer.dropped,0,'Save observer dropped records');
  results.push({kind,observed:true,passed:true,initialAim,before,interrupted,released,restored,recovered,nativeBefore,nativeInterrupted,writer});
 }catch(error){results.push({kind,observed:false,error:String(error),profile,observations,processFailures:await app?.evaluate(()=>globalThis.__focusProcessFailures).catch(()=>null),events:await page?.evaluate(()=>window.__dragEvidence).catch(()=>null)});}
 finally{await app?.close().catch(()=>{});}
}
const passed=results.every(r=>r.passed);
await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed,executableSha256:createHash('sha256').update(await readFile(process.env.CCC_EXECUTABLE)).digest('hex'),results,limitations:['Owned BrowserWindow blur/minimize and DOM focus operations; physical Alt-Tab and outside-window release routing are not certified.','The hidden-document case overrides document.hidden and dispatches visibilitychange; it proves handler behavior, not native visibility delivery.','Input/save observers affect timing. A delivered release after interruption intentionally probes whether a pending pull remains armed.']},null,2));
console.log(JSON.stringify(results.map(r=>({kind:r.kind,observed:r.observed,error:r.error,interrupted:r.interrupted&&{focused:r.interrupted.focused,visibility:r.interrupted.visibility,aim:r.interrupted.aim},shotBefore:r.before?.round.shotId,shotAfterRelease:r.released?.round.shotId,shotAfterRestore:r.restored?.round.shotId}))));
assert(passed,'Focus interruption acceptance failed; inspect retained evidence');
