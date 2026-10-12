import { build } from 'esbuild';
import { mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const artifacts=path.resolve('work/courses');await mkdir(artifacts,{recursive:true});
await build({entryPoints:['scripts/shot-planner.ts','packages/game/index.ts'],bundle:true,platform:'node',format:'esm',outdir:artifacts,outExtension:{'.js':'.mjs'}});
const {planShot}=await import('../work/courses/scripts/shot-planner.mjs');
const {createRound,nextHole,validateRound}=await import('../work/courses/packages/game/index.mjs');
const rounds=[];
try {
  for(const seed of [72917,0,44,1337]) {
    let round=createRound(seed);const shots=[];
    while(round.status!=='complete'){
      assert(round.strokes<18,`Planner did not finish ${seed}:${round.holes[round.holeIndex].id}`);
      if(round.status==='holed'){round=nextHole(round);continue;}
      const result=planShot(round);
      shots.push({holeIndex:round.holeIndex,hole:round.holes[round.holeIndex].id,angle:result.angle,power:result.power});
      round=validateRound(result.state);
    }
    assert.equal(round.scores.length,9);rounds.push({seed,scores:round.scores,shots});
    console.log(`Completed seed ${seed}: ${round.scores.join(', ')}`);
  }
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,rounds},null,2));
}catch(error){await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:false,error:String(error),rounds},null,2));throw error;}
