import { _electron as electron, expect } from 'playwright/test';
import electronPath from 'electron';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const root=process.cwd(), artifacts=path.join(root,'work/resources');await mkdir(artifacts,{recursive:true});
const sandbox=await mkdtemp(path.join(artifacts,'profile-'));const home=path.join(sandbox,'home');await mkdir(home);
const software=process.argv.includes('--software'),noSoftwareRasterizer=process.argv.includes('--no-software-rasterizer');
const compactV8=process.argv.includes('--compact-v8');
const inProcessNetwork=process.argv.includes('--in-process-network');
if(noSoftwareRasterizer&&!software)throw Error('--no-software-rasterizer requires --software');
const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:path.join(sandbox,'data'),CCC_TEST_HOME:home,...(software?{CCC_TEST_SOFTWARE:'1'}:{})};delete env.ELECTRON_RUN_AS_NODE;
const executable=process.env.CCC_EXECUTABLE;
const mode=[software?'software':'default',...(noSoftwareRasterizer?['no-rasterizer']:[]),...(compactV8?['compact-v8']:[]),...(inProcessNetwork?['in-process-network']:[])].join('-');
const resultFile=path.join(artifacts,`${mode}.json`);
await writeFile(resultFile,JSON.stringify({measured:false,status:'running',time:new Date().toISOString()},null,2));
const application=await electron.launch({executablePath:executable||electronPath,args:[...(executable?[]:[root]),...(noSoftwareRasterizer?['--disable-software-rasterizer']:[]),...(compactV8?['--js-flags=--optimize-for-size --max-old-space-size=64']:[]),...(inProcessNetwork?['--enable-features=NetworkServiceInProcess']:[])],env});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function sample(){return application.evaluate(({app,BrowserWindow})=>({windows:BrowserWindow.getAllWindows().length,processes:app.getAppMetrics().map(p=>({type:p.type,cpu:p.cpu.percentCPUUsage,workingSetKiB:p.memory.workingSetSize,privateKiB:p.memory.privateBytes}))}));}
async function helperSample(){
  // Electron's app metrics omit the native Go broker. Inspect only its owned
  // ChildProcess handle, then read OS counters for those exact numeric PIDs.
  const pids=await application.evaluate(()=>process._getActiveHandles().filter(handle=>handle.constructor?.name==='ChildProcess'&&/ccc-hook(?:\.exe)?$/.test(handle.spawnfile??'')).map(handle=>handle.pid));
  assert(pids.length>0&&pids.every(pid=>Number.isSafeInteger(pid)&&pid>0),'No owned helper PID was found; resource totals would be incomplete');
  if(process.platform==='win32'){
    const output=execFileSync('powershell.exe',['-NoProfile','-Command',`Get-Process -Id ${pids.join(',')} -ErrorAction Stop | ForEach-Object { [pscustomobject]@{pid=$_.Id;workingSetKiB=$_.WorkingSet64/1024;privateKiB=$_.PrivateMemorySize64/1024;cpuSeconds=$_.CPU} } | ConvertTo-Json -Compress`],{windowsHide:true,encoding:'utf8'});
    const parsed=JSON.parse(output);return Array.isArray(parsed)?parsed:[parsed];
  }
  return pids.map(pid=>({pid,workingSetKiB:Number(execFileSync('ps',['-o','rss=','-p',String(pid)],{encoding:'utf8'}).trim())}));
}
try{
  let page=await application.firstWindow();await expect(page.getByRole('region',{name:'Mini golf game',exact:true})).toBeVisible();
  await page.evaluate(async()=>{await window.countryClub.practice();await window.countryClub.hide();});
  const saved=await page.evaluate(()=>window.countryClub.loadRound());
  await delay(1000);const warm=await sample(),warmHelpers=await helperSample(),warmTime=performance.now();
  const deadline=Date.now()+35_000;
  while((await sample()).windows!==0){if(Date.now()>deadline)throw Error('Hidden renderer did not park');await delay(500);}
  await sample();await delay(1000);const parked=await sample(),parkedHelpers=await helperSample(),parkedTime=performance.now();
  const reopened=application.waitForEvent('window');await application.evaluate(({app})=>app.emit('activate'));page=await reopened;
  await expect(page.getByRole('region',{name:'Mini golf game',exact:true})).toBeVisible();
  assert.deepEqual(await page.evaluate(()=>window.countryClub.loadRound()),saved,'Parking lost acknowledged state');
  const canvas=await page.evaluate(()=>{const canvas=document.querySelector('canvas'),context=canvas.getContext('2d'),pixels=context.getImageData(0,0,canvas.width,canvas.height).data;let turf=0,cyan=0;for(let i=0;i<pixels.length;i+=4){const [r,g,b,a]=pixels.slice(i,i+4);if(a>200&&g>120&&g>r*1.5&&g>b*1.2)turf++;if(a>200&&b>150&&g>120&&r<130)cyan++;}return {width:canvas.width,height:canvas.height,turf,cyan};});
  assert(canvas.turf>1000&&canvas.cyan>1000,'Recovered course did not render its turf and background');
  await page.screenshot({path:path.join(artifacts,`${mode}.png`)});
  const electronMiB=parked.processes.reduce((s,p)=>s+p.workingSetKiB,0)/1024,helperMiB=parkedHelpers.reduce((s,p)=>s+p.workingSetKiB,0)/1024;
  const helperCPU=process.platform==='win32'?parkedHelpers.reduce((sum,p)=>sum+Math.max(0,p.cpuSeconds-(warmHelpers.find(w=>w.pid===p.pid)?.cpuSeconds??p.cpuSeconds)),0)/((parkedTime-warmTime)/1000)*100:null;
  const result={measured:true,time:new Date().toISOString(),softwareRendering:software,noSoftwareRasterizer,packaged:!!executable,warm,parked,warmHelpers,parkedHelpers,parkedElectronWorkingSetMiB:electronMiB,parkedHelperWorkingSetMiB:helperMiB,parkedWorkingSetMiB:electronMiB+helperMiB,parkedPrivateMiB:process.platform==='win32'?(parked.processes.reduce((s,p)=>s+p.privateKiB,0)+parkedHelpers.reduce((s,p)=>s+p.privateKiB,0))/1024:null,parkedElectronCPUPercent:parked.processes.reduce((s,p)=>s+p.cpu,0),helperIdleCPUPercentOneCore:helperCPU,memoryScope:'Sum of Electron process working sets plus the owned native hook helper. Shared pages can be counted more than once; use this sum consistently for the initial budget.',recovered:true,recoveredCanvas:canvas,targetMiB:200};
  result.compactV8=compactV8;
  result.requestedInProcessNetwork=inProcessNetwork;
  await writeFile(resultFile,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}catch(error){await writeFile(resultFile,JSON.stringify({measured:false,status:'failed',time:new Date().toISOString(),error:String(error)},null,2));throw error;}
finally{await application.close();}
