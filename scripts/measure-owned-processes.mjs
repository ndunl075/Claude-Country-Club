// Windows resource investigation without Playwright, its Electron preload, or
// a browser remote-debugging port. The owned main-process inspector remains on.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
assert.equal(process.platform, 'win32'); assert(process.env.CCC_EXECUTABLE);
const mode = process.argv[2] ?? 'default'; assert(['default', 'software-no-rasterizer', 'no-spare', 'software-no-spare', 'cache-release'].includes(mode));
const artifacts = path.resolve('work/owned-resources'); await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(artifacts, 'profile-'));
const env = { ...process.env, CCC_TEST_MODE: '1', CCC_DATA_DIR: path.join(profile, 'data'), CCC_TEST_HOME: path.join(profile, 'home') };
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.CCC_TEST_SOFTWARE;
if (mode.startsWith('software')) env.CCC_TEST_SOFTWARE = '1';
const experimentFlags = [...(mode.startsWith('software') ? ['--disable-software-rasterizer'] : []), ...(mode.includes('no-spare') ? ['--disable-features=SpareRendererForSitePerProcess'] : [])];
const child = spawn(process.env.CCC_EXECUTABLE, ['--inspect=0', '--ccc-background', ...experimentFlags], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let endpoint, ws, sequence = 0, phase = 'launch'; const pending = new Map(), measurements = [], transientSamples = [], cacheRelease = [];
child.stderr.on('data', chunk => { endpoint ??= /Debugger listening on (ws:\/\/\S+)/.exec(String(chunk))?.[1]; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 15000) { const end = Date.now() + timeout; while (!await fn()) { assert.equal(child.exitCode, null, 'Owned app exited unexpectedly'); if (Date.now() > end) throw new Error(`Timeout during ${phase}`); await pause(50); } }
function command(method, params = {}) { return new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Inspector timeout ${method}`)); }, 10000); pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } }); ws.send(JSON.stringify({ id, method, params })); }); }
async function main(expression) { const r = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; }
const currentWindow = `require('electron').BrowserWindow.getAllWindows()[0]`;
async function renderer(expression) {
  const r = await main(`${currentWindow}.webContents.debugger.sendCommand('Runtime.evaluate',${JSON.stringify({ expression, awaitPromise: true, returnByValue: true })})`);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value;
}
async function input(params) { await main(`${currentWindow}.webContents.debugger.sendCommand('Input.dispatchMouseEvent',${JSON.stringify(params)})`); }
async function snapshot(label) {
  assert(Number.isSafeInteger(child.pid) && child.pid > 0); assert.equal(child.exitCode, null);
  const script = `$ErrorActionPreference='Stop'; $ownedRoot=${child.pid}; $rootRecord=Get-CimInstance Win32_Process -Filter "ProcessId = $ownedRoot"; if(!$rootRecord){throw 'Owned root missing'}; $records=@($rootRecord); $frontier=@([int]$ownedRoot); $seen=@{}; $seen[$ownedRoot]=$true; while($frontier.Count){ $filter=($frontier | ForEach-Object { "ParentProcessId = $_" }) -join ' OR '; $next=@(); foreach($item in @(Get-CimInstance Win32_Process -Filter $filter)){ if(!$seen.ContainsKey([int]$item.ProcessId)){ $seen[[int]$item.ProcessId]=$true; $records+=$item; $next+=[int]$item.ProcessId } }; $frontier=$next }; @($records | ForEach-Object { $item=$_; $process=Get-Process -Id $item.ProcessId -ErrorAction Stop; $role=if($item.ProcessId -eq $ownedRoot){'browser'}elseif($item.Name -eq 'ccc-hook.exe'){'native-helper'}elseif($item.CommandLine -match '--type=([a-zA-Z0-9_-]+)'){$Matches[1]}else{$item.Name}; $subtype=if($item.CommandLine -match '--utility-sub-type=([a-zA-Z0-9_.-]+)'){$Matches[1]}else{$null}; [pscustomobject]@{pid=[int]$item.ProcessId;parentPid=[int]$item.ParentProcessId;role=$role;subtype=$subtype;workingSetKiB=$process.WorkingSet64/1024;privateKiB=$process.PrivateMemorySize64/1024;cpuSeconds=$process.CPU} }) | ConvertTo-Json -Compress`;
  let parsed;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { parsed = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] })); break; }
    catch (error) {
      if (!String(error.stderr).includes('NoProcessFoundForGivenId') || attempt === 2) throw error;
      // Discard the entire changing tree; never silently omit a disappearing process.
      transientSamples.push({ label, attempt: attempt + 1, reason: 'Owned descendant exited between enumeration and process-counter read' });
      await pause(250);
    }
  }
  const processes = Array.isArray(parsed) ? parsed : [parsed]; assert(processes.some(p => p.role === 'native-helper'), 'Incomplete process tree: native helper missing');
  assert.equal(child.exitCode, null);
  const windows = await main(`require('electron').BrowserWindow.getAllWindows().length`);
  const result = { label, time: Date.now(), windows, processes, totalWorkingSetMiB: processes.reduce((s, p) => s + p.workingSetKiB, 0) / 1024 };
  measurements.push(result); console.log(`${label}: ${result.totalWorkingSetMiB.toFixed(2)} MiB, ${processes.map(p => p.role).join(', ')}`); return result;
}
try {
  await until(() => endpoint); ws = new WebSocket(endpoint); await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', event => { const r = JSON.parse(event.data); if (r.id) { const job = pending.get(r.id); pending.delete(r.id); r.error ? job?.reject(new Error(r.error.message)) : job?.resolve(r.result); } });
  await command('Runtime.enable'); phase = 'background ready';
  await until(() => main(`require('electron').app.isReady() && process._getActiveHandles().some(h=>h.constructor?.name==='ChildProcess'&&/ccc-hook(?:\\.exe)?$/.test(h.spawnfile??'')&&!!h.stdout)`));
  await pause(1000); assert.equal(await main(`require('electron').BrowserWindow.getAllWindows().length`), 0);
  for (let i = 0; i < 3; i++) { await snapshot(`cold background ${i + 1}`); await pause(1000); }
  phase = 'first explicit open'; await main(`require('electron').app.emit('activate')`);
  await until(() => main(`!!${currentWindow} && !${currentWindow}.webContents.isLoading()`));
  await main(`${currentWindow}.webContents.debugger.attach('1.3')`);
  await until(() => renderer(`!!window.countryClub && !!document.querySelector('canvas')`));
  const security = await main(`(()=>{const p=${currentWindow}.webContents.getLastWebPreferences();return {sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration,webSecurity:p.webSecurity};})()`);
  assert.deepEqual(security, { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
  await renderer('window.countryClub.practice()'); await until(() => renderer(`document.querySelector('canvas').getAttribute('aria-disabled')==='false'`));
  const geometry = await renderer(`(async()=>{const r=await window.countryClub.loadRound();return {rect:document.querySelector('canvas').getBoundingClientRect().toJSON(),ball:r?.state.ball??{x:760,y:300}};})()`);
  const x = geometry.rect.x + (72 + geometry.ball.x * .84) / 900 * geometry.rect.width, y = geometry.rect.y + (48 + geometry.ball.y * .84) / 600 * geometry.rect.height;
  phase = 'actual drag shot'; await input({ type: 'mouseMoved', x, y }); await input({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  for (let step = 1; step <= 6; step++) { await input({ type: 'mouseMoved', x: x + 27 * .84 / 900 * geometry.rect.width * step / 6, y, button: 'left', buttons: 1 }); await pause(8); }
  await input({ type: 'mouseReleased', x: x + 27 * .84 / 900 * geometry.rect.width, y, button: 'left', buttons: 0, clickCount: 1 });
  await until(() => renderer(`window.countryClub.loadRound().then(r=>r?.state.shotId===1&&r.state.velocity.x===0&&r.state.velocity.y===0)`));
  const saved = await renderer('window.countryClub.loadRound()');
  await snapshot('visible after first settled shot');
  await renderer('window.countryClub.hide()'); phase = 'normal renderer parking';
  await until(() => main(`require('electron').BrowserWindow.getAllWindows().length===0`), 35000);
  if(mode==='cache-release'){
    await snapshot('parked before cache release');
    phase='private fixture cache release';
    cacheRelease.push(await main(`(async()=>{const s=require('electron').session.defaultSession;const before={httpCacheBytes:await s.getCacheSize(),mainMemory:process.memoryUsage()};await s.clearCache();await s.clearStorageData({storages:['shadercache']});return {before,after:{httpCacheBytes:await s.getCacheSize(),mainMemory:process.memoryUsage()},actions:['clearCache','clearStorageData(shadercache)']};})()`));
    await pause(1000);
  }
  for (let i = 0; i < 3; i++) { await snapshot(`post-game parked ${i + 1}`); await pause(1000); }
  phase = 'explicit reopen'; const reopenStart = performance.now(); await main(`require('electron').app.emit('activate')`);
  await until(() => main(`!!${currentWindow}&&!${currentWindow}.webContents.isLoading()`)); await main(`${currentWindow}.webContents.debugger.attach('1.3')`);
  await until(() => renderer('!!window.countryClub')); const restored = await renderer('window.countryClub.loadRound()');
  assert.deepEqual(restored.state, saved.state); assert(restored.revision >= saved.revision);
  const reopenMs = performance.now() - reopenStart;
  let pixels; await until(async () => {
    pixels = await renderer(`(()=>{const c=document.querySelector('canvas');if(!c)return {turf:0,cyan:0};const p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let turf=0,cyan=0;for(let i=0;i<p.length;i+=4){if(p[i+3]>200&&p[i+1]>120&&p[i+1]>p[i]*1.5&&p[i+1]>p[i+2]*1.2)turf++;if(p[i+3]>200&&p[i+2]>150&&p[i+1]>120&&p[i]<130)cyan++;}return {turf,cyan};})()`);
    return pixels.turf > 1000 && pixels.cyan > 1000;
  });
  assert(pixels.turf > 1000 && pixels.cyan > 1000);
  await writeFile(path.join(artifacts, `${mode}.json`), JSON.stringify({
    passed: true, mode, experimentFlags,
    executableSha256: createHash('sha256').update(await readFile(process.env.CCC_EXECUTABLE)).digest('hex'),
    measurements, transientSamples, cacheRelease, security, exactRestore: true, reopenMs, pixels, targetMiB: 200,
    scope: 'Sum of Windows working sets for the owned application and recursively discovered descendants, including native helper and any console host. Shared pages may be counted more than once.',
    limitations: ['Main-process inspector is enabled; no Playwright preload or browser remote-debugging port.',
      'Renderer debugger attaches only after cold samples, and its window is destroyed by normal parking.',
      'Resource investigation, not physical-input, compositor or signed-in-client certification. Graphics and spare-renderer changes are test-only.']
  }, null, 2));
} catch (error) { await writeFile(path.join(artifacts, `${mode}.json`), JSON.stringify({ passed: false, phase, error: String(error), measurements, transientSamples, profile }, null, 2)); throw error; }
finally {
  if (ws?.readyState === WebSocket.OPEN) { await main(`require('electron').app.quit()`).catch(() => {}); ws.close(); }
  if (child.exitCode === null) { await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(3000)]); if (child.exitCode === null) child.kill(); }
  for (const job of pending.values()) job.reject(new Error('Owned inspector closed')); pending.clear();
}
