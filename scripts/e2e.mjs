import { dragShot, pullAim, observePointerInput } from './play-input.mjs';
import { observeRoundWrites, readRoundWrites } from './round-write-evidence.mjs';
import { _electron as electron, expect } from 'playwright/test';
import electronPath from 'electron';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
const root=process.cwd();
const artifacts=path.join(root,'work/e2e');await mkdir(artifacts,{recursive:true});
const sandbox=await mkdtemp(path.join(artifacts,'profile-'));
const data=path.join(sandbox,'data'),home=path.join(sandbox,'home');await mkdir(home,{recursive:true});
const executablePath=process.env.CCC_EXECUTABLE||electronPath;
const env={...process.env,CCC_TEST_MODE:'1',CCC_DATA_DIR:data,CCC_TEST_HOME:home};delete env.ELECTRON_RUN_AS_NODE;
const failures=[];
let application;
async function launch(extraArgs=[]){
  application=await electron.launch({executablePath,args:process.env.CCC_EXECUTABLE?extraArgs:[root,...extraArgs],env,timeout:30_000});
  if(extraArgs.includes('--ccc-background')){
    await expect.poll(()=>application.evaluate(()=>process._getActiveHandles().some(h=>h.constructor?.name==='ChildProcess'&&/ccc-hook(?:\.exe)?$/.test(h.spawnfile??'')))).toBe(true);
    assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),0,'Background launch created an unused window');
    return null;
  }
  const page=await application.firstWindow();page.on('pageerror',error=>failures.push(error.message));
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByRole('region',{name:'Mini golf game',exact:true})).toBeVisible({timeout:15_000});
  await observePointerInput(page);await observeRoundWrites(application);
  return page;
}
async function visible(){return application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(window=>window.isVisible()));}
async function until(fn,message){const deadline=Date.now()+10_000;while(Date.now()<deadline){if(await fn())return;await new Promise(r=>setTimeout(r,80));}throw new Error(message);}
try {
  let page=await launch();
  const initial=await page.evaluate(()=>window.countryClub.getState());
  assert.equal(initial.settings.sound,false);assert.equal(initial.settings.startAtLogin,false);assert.equal(initial.settings.automatic,false);
  await page.getByRole('button',{name:'Play local practice',exact:true}).click();
  
  await expect(page.getByRole('application')).toHaveAttribute('aria-disabled','false');
  await page.screenshot({path:path.join(artifacts,'practice.png'),fullPage:true});
  await dragShot(page);
  await until(async()=>((await page.evaluate(()=>window.countryClub.loadRound()))?.state?.strokes??0)===1,'Shot did not persist');
  await page.evaluate(()=>window.countryClub.hide());
  await until(async()=>!(await visible()),'Manual hide did not hide the window');
  const frozen=await page.evaluate(()=>window.countryClub.loadRound());
  assert.equal(frozen.state.strokes,1);
  await new Promise(r=>setTimeout(r,350));
  assert.deepEqual((await page.evaluate(()=>window.countryClub.loadRound())).state,frozen.state,'Hidden simulation moved');
  await application.close();
  page=await launch();
  const restored=await page.evaluate(()=>window.countryClub.loadRound());
  assert.deepEqual(restored.state,frozen.state,'Restart did not restore exact acknowledged state');
  await until(async()=>(await page.evaluate(()=>window.countryClub.getState())).brokerReady,'Native broker never became ready');
  await page.evaluate(async()=>{await window.countryClub.setSettings({automatic:true,delayMs:1000});await window.countryClub.selectSession(null);await window.countryClub.hide();});
  const helper=process.env.CCC_EXECUTABLE?(process.platform==='darwin'?path.resolve(path.dirname(executablePath),'../Resources/ccc-hook'):path.join(path.dirname(executablePath),'resources','ccc-hook.exe')):path.join(root,'dist/native',process.platform==='win32'?'ccc-hook.exe':'ccc-hook');
  async function hook(kind,turnId='turn1',sessionId='isolated-e2e',provider='codex',toolName){
    const child=spawn(helper,['--provider',provider,'--event',kind,'--config',path.join(data,'connection.json')],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    child.stdin.end(JSON.stringify({session_id:sessionId,turn_id:turnId,cwd:home,tool_name:toolName,prompt:'privacy-fixture-do-not-retain',tool_input:{command:'secret-fixture',questions:['private-question'],plan:'private-plan'}}));
    await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`Hook exit ${code}`)));});assert.equal(output,'');
  }
  await hook('start');
  await until(visible,'Automatic wait did not show the game');
  await expect(page.locator('body')).toHaveClass(/companion/);
  const companionFit = await page.evaluate(() => ({ height: innerHeight, content: document.documentElement.scrollHeight, width: innerWidth, contentWidth: document.documentElement.scrollWidth }));
  assert(companionFit.content <= companionFit.height + 1 && companionFit.contentWidth <= companionFit.width + 1, `Companion overflows its window: ${JSON.stringify(companionFit)}`);
  
  await expect(page.getByRole('application')).toHaveAttribute('aria-disabled','false',{timeout:15_000});
  
  await page.screenshot({path:path.join(artifacts,'companion.png'),fullPage:true});
  const focus=await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFocused());
  assert.equal(focus,false,'Automatic show stole focus');
  const beforeAttention=(await page.evaluate(()=>window.countryClub.loadRound())).state;
  await pullAim(page,{angle:90,power:30});
  await hook('attention');await until(async()=>!(await visible()),'Attention did not tuck the game away');
  await page.mouse.up();
  assert.equal((await page.evaluate(()=>window.countryClub.loadRound())).state.shotId,beforeAttention.shotId,'Attention during drag fired a shot');
  const sessionState=await page.evaluate(()=>window.countryClub.getState());
  assert(sessionState.sessions.some(s=>s.state==='attention'));
  assert(!JSON.stringify(sessionState).includes('privacy-fixture'));assert(!JSON.stringify(sessionState).includes('secret-fixture'));
  await hook('activity');await until(visible,'Correlated activity did not resume the game');
  await hook('stop');await until(async()=>!(await visible()),'Stop did not hide the game');
  await hook('start');await new Promise(r=>setTimeout(r,1250));
  assert.equal(await visible(),false,'Delayed start revived a completed turn');
  await hook('start','turn2');await until(visible,'A fresh turn did not show the game');
  await hook('start','other-turn','other-root');
  await hook('stop','turn2');await until(async()=>!(await visible()),'Another working root masked selected-root completion');
  await hook('start','question-turn','claude-question-root','claude');
  const claudeKey=(await page.evaluate(()=>window.countryClub.getState())).sessions.find(s=>s.provider==='claude')?.key;
  assert(claudeKey,'Claude fixture session missing');
  await page.evaluate(key=>window.countryClub.selectSession(key),claudeKey);
  await until(visible,'Selected Claude turn did not show');
  for(const tool of ['AskUserQuestion','ExitPlanMode']){
    await hook('activity','question-turn','claude-question-root','claude',tool);
    await until(async()=>!(await visible()),`${tool} did not tuck the game away`);
    const state=await page.evaluate(()=>window.countryClub.getState());
    assert.equal(state.sessions.find(s=>s.key===claudeKey).state,'attention');
    assert(!JSON.stringify(state).includes('private-question'));assert(!JSON.stringify(state).includes('private-plan'));
    await hook('activity','question-turn','claude-question-root','claude','Bash');
    await until(visible,'Normal tool activity did not resume after attention');
  }
  await hook('stop','question-turn','claude-question-root','claude');
  await until(async()=>!(await visible()),'Claude fixture stop did not hide');
  await page.evaluate(()=>window.countryClub.practice());
  await page.getByRole('button',{name:'Connections',exact:true}).click();
  await page.screenshot({path:path.join(artifacts,'connections.png'),fullPage:true});
  // Only isolated fixture configuration is changed; live provider homes are never read.
  const preview=await page.evaluate(()=>window.countryClub.previewIntegration('codex'));
  assert(preview.configPath.startsWith(home));
  await page.evaluate(p=>window.countryClub.applyIntegration(p),preview);
  assert((await readFile(path.join(home,'.codex/hooks.json'),'utf8')).includes('--provider codex'));
  await page.evaluate(()=>window.countryClub.removeIntegration('codex'));
  assert(!(await readFile(path.join(home,'.codex/hooks.json'),'utf8')).includes('--provider codex'));
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.screenshot({path:path.join(artifacts,'settings.png'),fullPage:true});
  const beforeCrash=await page.evaluate(()=>window.countryClub.loadRound());
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
  await until(async()=>!(await visible()),'Renderer crash did not hide the game');
  const reopened=application.waitForEvent('window');
  await application.evaluate(({app})=>app.emit('activate'));
  page=await reopened;
  await until(visible,'Explicit reopen did not recover the renderer window');
  await expect(page.getByRole('button',{name:'Play local practice',exact:true})).toBeVisible({timeout:15_000});
  assert.deepEqual(await page.evaluate(()=>window.countryClub.loadRound()),beforeCrash,'Renderer crash lost acknowledged progress');
  await page.evaluate(()=>window.countryClub.practice());
  await application.evaluate(({powerMonitor})=>powerMonitor.emit('suspend'));
  await until(async()=>!(await visible()),'Suspend handler did not hide the game');
  const beforeSleep=await page.evaluate(()=>window.countryClub.loadRound());
  await application.evaluate(({powerMonitor})=>powerMonitor.emit('resume'));
  assert.equal(await visible(),false,'Resume handler reopened the game without fresh evidence');
  const afterSleep=await page.evaluate(()=>window.countryClub.loadRound());
  assert.deepEqual(afterSleep.state,beforeSleep.state,'Resume changed acknowledged game state');
  assert(afterSleep.revision>=beforeSleep.revision,'Resume regressed the saved revision');
  const security=await application.evaluate(({BrowserWindow})=>{const p=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return {sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration};});
  assert.deepEqual(security,{sandbox:true,contextIsolation:true,nodeIntegration:false});
  assert.equal(failures.length,0,failures.join('\n'));
  const metrics=await application.evaluate(({app})=>app.getAppMetrics().map(p=>({type:p.type,cpu:p.cpu,memory:p.memory})));
  await application.close();
  page=await launch(['--ccc-background']);
  assert.equal(await visible(),false,'Background/login launch showed the dashboard');
  await application.close();
  const database=new DatabaseSync(path.join(data,'country-club.sqlite'));
  database.prepare("UPDATE round_save SET state='corrupt-fixture'").run();database.close();
  page=await launch();
  await expect(page.getByRole('alert')).toContainText(/saved|round|progress|JSON/i);
  assert.equal((await page.evaluate(()=>window.countryClub.loadRound())).state,null);
  await page.evaluate(()=>window.countryClub.practice());
  
  await expect(page.getByRole('application')).toHaveAttribute('aria-disabled','true');
  await page.getByRole('alert').getByRole('button',{name:'New round',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:/Start fresh|New round|Start new round/i}).click();
  await until(async()=>!!(await page.evaluate(()=>window.countryClub.loadRound())).state,'Explicit reset could not recover corrupt progress');
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,packaged:!!process.env.CCC_EXECUTABLE,checks:['quiet defaults','durable shot','hidden pause','restart restore','native private IPC','automatic show without focus','attention hide','Claude question and plan-approval tool attention','activity resume','stop hide','late start suppression','selected root independence','privacy allowlist','config preview/apply/removal in isolated home','renderer crash recovery','suspend/resume handlers (synthetic OS events)','quiet background launch','corrupt save explicit recovery','sandboxed renderer'],security,metrics},null,2));
  console.log('Desktop E2E passed: gameplay, recovery, native lifecycle, focus, privacy, isolated integration removal.');
} catch(error) {
  // Keep isolated runtime evidence for intermittent input/lifecycle failures.
  const page=application?.windows()[0];
  if(page){
    await page.screenshot({path:path.join(artifacts,'failure.png')}).catch(()=>{});
    const snapshot=await page.evaluate(async()=>({
      host:await window.countryClub.getState(),round:await window.countryClub.loadRound(),
      course:document.querySelector('canvas')?.getAttribute('aria-description'),
      disabled:document.querySelector('canvas')?.getAttribute('aria-disabled'),
      pointerEvents:window.__dragEvidence,
    })).catch(e=>({unavailable:String(e)}));
    const writer=await readRoundWrites(application).catch(e=>({unavailable:String(e)}));
    await writeFile(path.join(artifacts,'failure-state.json'),JSON.stringify({snapshot,writer},null,2));
  }
  await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:false,packaged:!!process.env.CCC_EXECUTABLE,time:new Date().toISOString(),error:String(error)},null,2));
  throw error;
} finally { if(application)await application.close().catch(()=>{}); }


