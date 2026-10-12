import { _electron as electron, expect } from 'playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { dragShot, observePointerInput } from './play-input.mjs';
import { observeRoundWrites, readRoundWrites } from './round-write-evidence.mjs';

assert(process.env.CCC_EXECUTABLE, 'Set CCC_EXECUTABLE to the packaged application');
const artifacts=path.resolve('work/startup-drag');await mkdir(artifacts,{recursive:true});
const attempts=Number(process.env.CCC_DRAG_ATTEMPTS??20);
assert(Number.isInteger(attempts)&&attempts>=1&&attempts<=100);
const results=[];let app;
try{
  for(let index=0;index<attempts;index++){
    const profile=await mkdtemp(path.join(artifacts,'profile-'));
    const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:path.join(profile,'data'),CCC_TEST_HOME:path.join(profile,'home')};delete env.ELECTRON_RUN_AS_NODE;
    app=await electron.launch({executablePath:process.env.CCC_EXECUTABLE,env,timeout:30000});
    const page=await app.firstWindow();
    await observePointerInput(page);await observeRoundWrites(app);
    let passed=true,error;
    try{
      await page.getByRole('button',{name:'Play local practice',exact:true}).click();
      await expect(page.getByRole('application')).toHaveAttribute('aria-disabled','false');
      // Match the original E2E sequence, including the capture before the shot.
      await page.screenshot({path:path.join(profile,'before.png'),fullPage:true});
      await dragShot(page);
      await expect.poll(async()=> (await page.evaluate(()=>window.countryClub.loadRound()))?.state?.shotId,{timeout:10000}).toBe(1);
    }catch(e){passed=false;error=String(e);await page.screenshot({path:path.join(profile,'failure.png')}).catch(()=>{});}
    const evidence=await page.evaluate(async()=>({events:window.__dragEvidence,round:await window.countryClub.loadRound(),host:await window.countryClub.getState()}));
    const writer=await readRoundWrites(app);
    results.push({index,passed,error,profile,evidence,writer});
    await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:results.length===attempts&&results.every(r=>r.passed),completed:results.length,requested:attempts,results},null,2));
    await app.close();app=undefined;
    console.log(`Startup drag ${index+1}/${attempts}: ${passed?'passed':'FAILED'}`);
    if(!passed)break;
  }
  assert.equal(results.length,attempts);assert(results.every(r=>r.passed),'Startup drag failure; inspect retained pointer evidence');
}catch(error){
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:false,error:String(error),completed:results.length,requested:attempts,results},null,2));
  throw error;
}finally{await app?.close().catch(()=>{});}
