import { _electron as electron, expect } from 'playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
assert(process.env.CCC_EXECUTABLE,'Set CCC_EXECUTABLE to the packaged application');
const artifacts=path.resolve('work/gestures');await mkdir(artifacts,{recursive:true});
const results=[];
async function scenario(name,action,expected){
  const profile=await mkdtemp(path.join(artifacts,'profile-'));
  const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:path.join(profile,'data'),CCC_TEST_HOME:path.join(profile,'home')};delete env.ELECTRON_RUN_AS_NODE;
  let app,db;
  try{
    app=await electron.launch({executablePath:process.env.CCC_EXECUTABLE,env,timeout:30000});
    const page=await app.firstWindow();
    await page.getByRole('button',{name:'Play local practice',exact:true}).click();
    const canvas=page.getByRole('application');await expect(canvas).toHaveAttribute('aria-disabled','false');
    const bounds=await canvas.boundingBox();
    const point=(x,y)=>({x:bounds.x+(72+x*.84)/900*bounds.width,y:bounds.y+(48+y*.84)/600*bounds.height});
    const ball=point(760,300),cdp=await page.context().newCDPSession(page);
    db=new DatabaseSync(path.join(profile,'data/country-club.sqlite'),{readOnly:true});
    const shots=()=>db.prepare('SELECT state FROM shots ORDER BY shot_id').all().map(row=>JSON.parse(row.state));
    await action({page,canvas,cdp,ball,point,shots});
    if(expected){
      await expect.poll(()=>shots().length).toBe(1);
      const shot=shots()[0];
      assert.equal(shot.strokes,1);assert.equal(shot.shotId,1);
      const error=Math.hypot(shot.velocity.x-expected.x,shot.velocity.y-expected.y);
      assert(error<.02,`${name} impulse mismatch: ${JSON.stringify(shot.velocity)}`);
      results.push({name,passed:true,impulse:shot.velocity});
    }else{
      // Flush input and IPC; no shot should even enter the durable shot history.
      await page.evaluate(()=>window.countryClub.hide());assert.equal(shots().length,0);
      results.push({name,passed:true,shots:0});
    }
  }finally{db?.close();await app?.close().catch(()=>{});}
}
const mousePull=(x,y)=>async({page,ball,point})=>{const end=point(x,y);await page.mouse.move(ball.x,ball.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:5});await page.mouse.up();};
try{
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:false,status:'running',results},null,2));
  await scenario('short horizontal pull',mousePull(724,300),{x:208,y:0});
  await scenario('long horizontal pull',mousePull(652,300),{x:464,y:0});
  await scenario('vertical pull sets opposite direction',mousePull(760,390),{x:0,y:-400});
  await scenario('power is capped',mousePull(400,300),{x:720,y:0});
  await scenario('sub-threshold movement does not shoot',mousePull(757,300),null);
  await scenario('release position overrides last movement',async({page,cdp,ball,point})=>{
    await page.mouse.move(ball.x,ball.y);await page.mouse.down();const mid=point(724,300);await page.mouse.move(mid.x,mid.y);
    const end=point(760,390);await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:end.x,y:end.y,button:'left',buttons:0,clickCount:1});
  },{x:0,y:-400});
  await scenario('touch cancel preserves round',async({cdp,ball,point})=>{
    await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...ball,id:1}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...point(724,300),id:1}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
  },null);
  await scenario('secondary touch release cannot fire active pull',async({cdp,ball,point,shots})=>{
    await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...ball,id:1}]});
    const other={...point(800,380),id:2};
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...ball,id:1},other]});
    const end={...point(724,300),id:1};
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[end,other]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[end]});
    assert.equal(shots().length,0,'Second finger release fired a shot');
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  },{x:208,y:0});
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,packaged:true,results,limitations:['CDP-generated native browser input; physical touch hardware and OS interruption remain unverified.']},null,2));
  console.log('Packaged drag gesture acceptance passed.');
}catch(error){await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:false,error:String(error),results},null,2));throw error;}
