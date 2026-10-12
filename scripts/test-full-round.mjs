import { _electron as electron, expect } from 'playwright/test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dragShot } from './play-input.mjs';
assert(process.env.CCC_EXECUTABLE,'Set CCC_EXECUTABLE to a packaged application');
const evidence=JSON.parse(await readFile('work/courses/result.json','utf8'));
assert(evidence.passed,'Run test:courses first');
const fixture=evidence.rounds.find(r=>r.seed===72917);assert(fixture);
const artifacts=path.resolve('work/full-round');await mkdir(artifacts,{recursive:true});
const profile=await mkdtemp(path.join(artifacts,'profile-'));
const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:path.join(profile,'data'),CCC_TEST_HOME:path.join(profile,'home')};delete env.ELECTRON_RUN_AS_NODE;
let app;const played=[],errors=[];
try{
  app=await electron.launch({executablePath:process.env.CCC_EXECUTABLE,env,timeout:30000});
  let page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('button',{name:'Play local practice',exact:true}).click();
  for(const shot of fixture.shots){
    await expect(page.getByRole('application')).toHaveAttribute('aria-label',new RegExp(`hole ${shot.holeIndex+1}:`));
    const start=Date.now();await dragShot(page,shot);
    await expect.poll(async()=>{
      const r=(await page.evaluate(()=>window.countryClub.loadRound()))?.state;
      return r&&r.shotId===played.length+1&&r.velocity.x===0&&r.velocity.y===0?r:null;
    },{timeout:15000,intervals:[100,200]}).not.toBeNull();
    const round=(await page.evaluate(()=>window.countryClub.loadRound())).state;
    played.push({...shot,durationMs:Date.now()-start,status:round.status,strokes:round.strokes});
    assert.equal(round.shotId,played.length);
    if(round.status==='holed'){
      assert.equal(round.scores[shot.holeIndex],fixture.scores[shot.holeIndex]);
      await page.screenshot({path:path.join(artifacts,`hole-${shot.holeIndex+1}.png`),fullPage:true});
      await page.getByRole('button',{name:shot.holeIndex===8?'Finish round':'Next hole',exact:true}).click();
    }
  }
  await expect(page.getByRole('button',{name:'Another round',exact:true})).toBeVisible();
  const final=(await page.evaluate(()=>window.countryClub.loadRound())).state;
  assert.equal(final.status,'complete');assert.deepEqual(final.scores,fixture.scores);
  await page.screenshot({path:path.join(artifacts,'complete.png'),fullPage:true});
  await app.close();app=await electron.launch({executablePath:process.env.CCC_EXECUTABLE,env,timeout:30000});page=await app.firstWindow();
  await expect(page.getByRole('button',{name:'Another round',exact:true})).toBeVisible();
  assert.deepEqual((await page.evaluate(()=>window.countryClub.loadRound())).state,final);
  await page.getByRole('button',{name:'Another round',exact:true}).click();
  await page.getByRole('button',{name:'Keep my round',exact:true}).click();
  assert.deepEqual((await page.evaluate(()=>window.countryClub.loadRound())).state,final);
  assert.deepEqual(errors,[]);
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,packaged:true,seed:fixture.seed,scores:final.scores,played,checks:['all nine curated holes through drag-to-shoot gestures','hole transitions and scoring','complete round restart recovery','another-round cancel preserves completed score']},null,2));
  console.log('Packaged nine-hole round passed.');
}catch(error){await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:false,error:String(error),played},null,2));throw error;}
finally{await app?.close().catch(()=>{});}
