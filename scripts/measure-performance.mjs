import { dragShot } from './play-input.mjs';
import { _electron as electron, expect } from 'playwright/test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const root=process.cwd(),artifacts=path.join(root,'work/performance');await mkdir(artifacts,{recursive:true});
const fixture=await mkdtemp(path.join(artifacts,'profile-')),data=path.join(fixture,'data'),home=path.join(fixture,'home');await mkdir(home);
const executablePath=process.env.CCC_EXECUTABLE||path.join(root,'release/win-unpacked/Claude Country Club.exe');
const helper=process.platform==='darwin'?path.resolve(path.dirname(executablePath),'../Resources/ccc-hook'):path.join(path.dirname(executablePath),'resources/ccc-hook.exe');
const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:data,CCC_TEST_HOME:home};delete env.ELECTRON_RUN_AS_NODE;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function stats(values){const sorted=[...values].sort((a,b)=>a-b);return {samples:values.length,minMs:sorted[0],medianMs:sorted[Math.ceil(sorted.length*.5)-1],p95Ms:sorted[Math.ceil(sorted.length*.95)-1],maxMs:sorted.at(-1)};}
let application;
async function hook(kind,turnId){
  const start=performance.now();
  const child=spawn(helper,['--provider','codex','--event',kind,'--config',path.join(data,'connection.json')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  child.stdin.end(JSON.stringify({session_id:'performance-fixture',turn_id:turnId,cwd:home}));
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`Hook exited ${code}`)));});
  assert.equal(output,'');return performance.now()-start;
}
async function until(fn,label){const deadline=performance.now()+10_000;while(!await fn()){if(performance.now()>deadline)throw Error(label);await pause(10);}}
try {
  const netLogPath=path.join(fixture,'chromium-netlog.json');
  application=await electron.launch({executablePath,args:[`--log-net-log=${netLogPath}`],env,timeout:30_000});const page=await application.firstWindow();
  await expect(page.getByRole('region',{name:'Mini golf game',exact:true})).toBeVisible();
  await until(async()=>(await page.evaluate(()=>window.countryClub.getState())).brokerReady,'Broker did not start');
  await hook('start','benchmark');for(let i=0;i<5;i++)await hook('activity','benchmark');
  const helperTimes=[];for(let i=0;i<60;i++)helperTimes.push(await hook('activity','benchmark'));
  await hook('stop','benchmark');

  await page.evaluate(()=>window.countryClub.practice());
  await expect(page.getByRole('application')).toHaveAttribute('aria-disabled','false');
  // Sample renderer scheduling during a real durable shot. RAF cadence is not a
  // compositor presentation trace; retain that limit with the measured result.
  await page.evaluate(()=>{
    window.__frameSample={times:[],draws:[],longTasks:[],done:false};
    const context=document.querySelector('canvas').getContext('2d'),clear=context.clearRect;
    context.clearRect=function(...args){window.__frameSample.draws.push(performance.now());return clear.apply(this,args);};
    const start=performance.now();let last;
    const observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())window.__frameSample.longTasks.push(entry.duration);});observer.observe({type:'longtask',buffered:false});
    const frame=time=>{if(last!==undefined)window.__frameSample.times.push(time-last);last=time;if(time-start<6000)requestAnimationFrame(frame);else {context.clearRect=clear;observer.disconnect();window.__frameSample.done=true;}};
    requestAnimationFrame(frame);
  });
  const shotStart=performance.now();await dragShot(page);
  await until(async()=>((await page.evaluate(()=>window.countryClub.loadRound()))?.state?.strokes??0)===1,'Shot was not acknowledged');
  const clickToObservedSaveMs=performance.now()-shotStart;
  await until(()=>page.evaluate(()=>window.__frameSample.done),'Frame sample did not finish');
  const frames=await page.evaluate(()=>window.__frameSample);
  await page.evaluate(async()=>{await window.countryClub.setSettings({automatic:true,delayMs:1000});await window.countryClub.hide();});

  // Timestamp the first state publication after acceptance and the native
  // BrowserWindow show/hide events in one main-process monotonic clock. This
  // avoids counting external polling or helper spawn time as hide latency.
  await application.evaluate(({BrowserWindow})=>{
    globalThis.__lifecycle={};const window=BrowserWindow.getAllWindows()[0],send=window.webContents.send.bind(window.webContents);
    window.webContents.send=(channel,...args)=>{
      const record=globalThis.__lifecycle;
      if(channel==='ccc:state'){
        const selected=args[0].sessions.find(s=>s.key===args[0].selectedSession);
        if(selected?.state==='working' && record.working===undefined)record.working=performance.now();
        if(selected && ['stopped','attention'].includes(selected.state) && record.terminal===undefined)record.terminal=performance.now();
      }
      if(channel==='ccc:freeze' && record.freeze===undefined)record.freeze=performance.now();
      return send(channel,...args);
    };
    window.on('show',()=>{globalThis.__lifecycle.shown=performance.now();globalThis.__lifecycle.focused=window.isFocused();});
    window.on('hide',()=>{globalThis.__lifecycle.hidden=performance.now();});
  });
  const cycles=[];
  for(let i=0;i<12;i++){
    await application.evaluate(()=>{globalThis.__lifecycle={};});
    const turn=`cycle-${i}`;await hook('start',turn);
    await until(()=>application.evaluate(()=>globalThis.__lifecycle.shown!==undefined),'Automatic window never showed');
    const blocked=i>=8;
    if(blocked){await page.evaluate(()=>{setTimeout(()=>{const end=performance.now()+450;while(performance.now()<end){}},0);});await pause(25);}
    await hook(i%2?'attention':'stop',turn);
    await until(()=>application.evaluate(()=>globalThis.__lifecycle.hidden!==undefined),'Terminal event never hid the game');
    const record=await application.evaluate(()=>globalThis.__lifecycle);
    assert(record.working!==undefined && record.terminal!==undefined);
    cycles.push({kind:i%2?'attention':'stop',blockedRenderer:blocked,showAfterDelayMs:record.shown-record.working-1000,terminalPublicationToHideMs:record.hidden-record.terminal,freezeRequestToHideMs:record.hidden-record.freeze,focusedOnAutomaticShow:record.focused});
    if(blocked)await pause(500);
  }
  const normal=cycles.filter(c=>!c.blockedRenderer),blocked=cycles.filter(c=>c.blockedRenderer);
  const versions=await application.evaluate(()=>process.versions);
  // CLI net logging is owned by Chromium, not netLog.startLogging(). Normal
  // process exit flushes it; netLog.stopLogging() only stops API-owned logging.
  await application.close();application=undefined;
  const netLog=JSON.parse(await readFile(netLogPath,'utf8'));
  const networkURLs=[...new Set(netLog.events.flatMap(event=>typeof event.params?.url==='string' && /^(https?|wss?):/i.test(event.params.url)?[event.params.url]:[]))];
  const network={scope:'Chromium net log from process launch through gameplay and native lifecycle benchmark',httpOrWebSocketURLs:networkURLs.length,externalURLs:networkURLs.filter(value=>{const url=new URL(value);return !['localhost','127.0.0.1','[::1]'].includes(url.hostname);}).length,limitations:'This is Chromium network instrumentation, not OS-wide packet capture or an audit of user-invoked external documentation links.'};
  const result={measured:true,time:new Date().toISOString(),packaged:true,executablePath,reference:{cpu:os.cpus()[0].model,logicalCPUs:os.cpus().length,ramGiB:os.totalmem()/1024**3,platform:process.platform,release:os.release(),versions},helper:stats(helperTimes),clickToObservedSaveMs,frameCadence:{...stats(frames.times),averageFPS:1000*frames.times.length/frames.times.reduce((sum,n)=>sum+n,0),over33ms:frames.times.filter(n=>n>33.4).length,longTasksMs:frames.longTasks},warmShowAfterDelay:stats(cycles.map(c=>c.showAfterDelayMs)),terminalToHide:stats(normal.map(c=>c.terminalPublicationToHideMs)),blockedRendererTerminalToHide:stats(blocked.map(c=>c.terminalPublicationToHideMs)),cycles,targets:{helperWarmP95Ms:50,warmShowAfterDelayMs:250,terminalToHideMaxMs:200},limitations:['Local single-machine sample, not cross-hardware certification.','Acceptance clock begins at first state publication after registry acceptance; a small amount of synchronous acceptance work precedes that publication.','RAF cadence measures scheduling during one real shot, not compositor presentation or every course.','Blocked renderer models a 450 ms JS stall; physical disk exhaustion and OS hangs are not simulated.','Click-to-observed-save includes Playwright input and polling overhead.']};
  result.network=network;
  const drawIntervals=frames.draws.slice(1).map((time,index)=>time-frames.draws[index]);
  result.canvasDrawCadence={...stats(drawIntervals),draws:frames.draws.length,over33ms:drawIntervals.filter(n=>n>33.4).length,scope:'Canvas clear/draw starts during the six-second shot sample; this is not a compositor presentation trace.'};
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({helper:result.helper,frameCadence:result.frameCadence,canvasDrawCadence:result.canvasDrawCadence,warmShowAfterDelay:result.warmShowAfterDelay,terminalToHide:result.terminalToHide,blockedRendererTerminalToHide:result.blockedRendererTerminalToHide,network},null,2));
}catch(error){await writeFile(path.join(artifacts,'result.json'),JSON.stringify({measured:false,time:new Date().toISOString(),error:String(error)},null,2));throw error;}
finally{if(application)await application.close().catch(()=>{});}

