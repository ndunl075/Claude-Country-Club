// Architectural experiment only: two independent private copies of the current
// packaged app. No relay, production host split, shared store or live hooks.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
assert.equal(process.platform, 'win32'); assert(process.env.CCC_EXECUTABLE);
const mode = process.argv[2] ?? 'split'; assert(['split', 'monolithic'].includes(mode));
const resultName = mode === 'split' ? 'result.json' : 'monolithic.json';
const executable = path.resolve(process.env.CCC_EXECUTABLE);
const artifacts = path.resolve('work/split-process-resources'); await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(artifacts, 'profile-'));
const instances = [], measurements = [], transientSamples = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let phase = 'launch', security, saved, restoreMs, pixels;
async function until(fn, timeout = 15000) { const end = Date.now() + timeout; while (!await fn()) { if (Date.now() > end) throw Error(`Timeout during ${phase}`); await pause(50); } }
async function launch(role, profileName = role) {
  const data = path.join(profile, profileName, 'data'), home = path.join(profile, profileName, 'home');
  const env = { ...process.env, CCC_TEST_MODE: '1', CCC_DATA_DIR: data, CCC_TEST_HOME: home };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.CCC_TEST_SOFTWARE;
  const child = spawn(executable, ['--inspect=0', '--ccc-background'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const entry = { role, child, data, home, env, pending: new Map(), sequence: 0, stopped: false };
  instances.push(entry);
  child.on('error', error => { entry.error = error; });
  child.stderr.on('data', bytes => { entry.endpoint ??= /Debugger listening on (ws:\/\/\S+)/.exec(String(bytes))?.[1]; });
  await until(() => { if (entry.error) throw entry.error; assert.equal(child.exitCode, null); return entry.endpoint; });
  entry.ws = new WebSocket(entry.endpoint);
  await new Promise((resolve, reject) => { entry.ws.addEventListener('open', resolve, { once: true }); entry.ws.addEventListener('error', reject, { once: true }); });
  entry.ws.addEventListener('message', message => {
    const response = JSON.parse(message.data), job = entry.pending.get(response.id);
    if (job) { entry.pending.delete(response.id); clearTimeout(job.timer); response.error ? job.reject(Error(response.error.message)) : job.resolve(response.result); }
  });
  entry.main = async expression => {
    const result = await new Promise((resolve, reject) => {
      const id = ++entry.sequence;
      const timer = setTimeout(() => { entry.pending.delete(id); reject(Error(`Owned ${role} inspector timeout`)); }, 10000);
      entry.pending.set(id, { timer, resolve, reject });
      entry.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true } }));
    });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  assert.equal(await entry.main('process.pid'), child.pid, 'Inspector identity differs from owned direct launch');
  await until(() => entry.main(`require('electron').app?.isReady() && process._getActiveHandles().some(h=>h.constructor?.name==='ChildProcess'&&/ccc-hook(?:\\.exe)?$/.test(h.spawnfile??'')&&!!h.stdout)`));
  assert.equal(await entry.main(`require('electron').BrowserWindow.getAllWindows().length`), 0);
  return entry;
}
async function tree(entry, label) {
  assert.equal(entry.child.exitCode, null);
  let parsed;
  for (let attempt = 0; attempt < 3; attempt++) try {
    parsed = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/owned-process-snapshot.ps1'), '-RootProcessId', String(entry.child.pid)], { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] })); break;
  } catch (error) {
    if (!String(error.stderr).includes('NoProcessFoundForGivenId') || attempt === 2) throw error;
    transientSamples.push({ label, role: entry.role, attempt: attempt + 1 }); await pause(250);
  }
  const metrics = await entry.main(`require('electron').app.getAppMetrics().map(p=>({pid:p.pid,type:p.type}))`);
  const processes = (Array.isArray(parsed) ? parsed : [parsed]).map(p => ({ ...p, host: entry.role, role: p.pid === entry.child.pid ? 'browser' : p.name === 'ccc-hook.exe' ? 'native-helper' : metrics.find(m=>m.pid===p.pid)?.type ?? p.name }));
  assert.equal(path.resolve(processes.find(p => p.pid === entry.child.pid).executable).toLowerCase(), executable.toLowerCase());
  assert(processes.some(p => p.role === 'native-helper'));
  entry.lastTree = processes;
  return processes;
}
async function sample(label) {
  const processes = [];
  for (const entry of instances.filter(entry => !entry.stopped)) processes.push(...await tree(entry, label));
  const record = { label, time: Date.now(), processes, totalWorkingSetMiB: processes.reduce((sum, p) => sum + p.workingSetKiB, 0) / 1024 };
  measurements.push(record); console.log(`${label}: ${record.totalWorkingSetMiB.toFixed(2)} MiB`);
  return record;
}
async function stop(entry) {
  if (!entry || entry.cleanupVerified) return;
  if (!entry.stopped && entry.ws?.readyState === WebSocket.OPEN) { await entry.main(`require('electron').app.quit()`).catch(() => {}); entry.ws.close(); }
  if (entry.child.exitCode === null) await Promise.race([new Promise(resolve => entry.child.once('exit', resolve)), pause(5000)]);
  if (entry.child.exitCode === null) { entry.child.kill(); await Promise.race([new Promise(resolve => entry.child.once('exit', resolve)), pause(3000)]); }
  entry.stopped = entry.child.exitCode !== null;
  for (const job of entry.pending.values()) { clearTimeout(job.timer); job.reject(Error('Owned inspector closed')); } entry.pending.clear();
  assert(entry.stopped, `Owned ${entry.role} did not exit`);
  assert.equal(entry.child.exitCode, 0, `Owned ${entry.role} did not quit normally`);
  if (entry.lastTree) {
    const checks = entry.lastTree.map(p => `$p=Get-Process -Id ${p.pid} -ErrorAction SilentlyContinue;if($p -and $p.StartTime.ToUniversalTime().ToString('o') -eq '${p.created}'){throw 'Owned descendant remains: ${p.pid}'}`).join('\n');
    execFileSync('powershell.exe', ['-NoProfile', '-Command', checks + '\nexit 0'], { windowsHide: true, stdio: 'pipe', timeout: 20000 });
  }
  entry.cleanupVerified = true;
}
const windowExpression = `require('electron').BrowserWindow.getAllWindows()[0]`;
async function openGame(entry) {
  await entry.main(`require('electron').app.emit('activate')`);
  await until(() => entry.main(`!!${windowExpression} && !${windowExpression}.webContents.isLoading()`));
  await entry.main(`${windowExpression}.webContents.debugger.attach('1.3')`);
  entry.renderer = async expression => {
    const result = await entry.main(`${windowExpression}.webContents.debugger.sendCommand('Runtime.evaluate',${JSON.stringify({ expression, awaitPromise: true, returnByValue: true })})`);
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await until(() => entry.renderer('!!window.countryClub && !!document.querySelector("canvas")'));
}
try {
  const controller = await launch('controller');
  await controller.main(`(()=>{globalThis.__splitEvents=[];const b=process._getActiveHandles().find(h=>h.constructor?.name==='ChildProcess'&&/ccc-hook(?:\\.exe)?$/.test(h.spawnfile??''));let buffer='';b.stdout.prependListener('data',chunk=>{buffer+=chunk.toString();let end;while((end=buffer.indexOf(String.fromCharCode(10)))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const value=JSON.parse(line);if(value.event)globalThis.__splitEvents.push(value.event.kind);}catch{}}});})()`);
  for (const kind of ['start', 'stop']) {
    const helper = spawn(path.join(path.dirname(executable), 'resources/ccc-hook.exe'), ['--provider', 'codex', '--event', kind, '--config', path.join(controller.data, 'connection.json')], { env: controller.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = 0; helper.stdout.on('data', b => output += b.length); helper.stderr.on('data', b => output += b.length);
    helper.stdin.end(JSON.stringify({ session_id: 'split-controller', turn_id: 'controller-turn', cwd: controller.home }));
    await new Promise((resolve, reject) => { const timer = setTimeout(() => { helper.kill(); reject(Error('Fixture helper timeout')); }, 2000); helper.once('error', reject); helper.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(`Fixture helper exit ${code}`)); }); });
    assert.equal(output, 0);
  }
  await until(() => controller.main(`globalThis.__splitEvents.length===2`));
  assert.equal(await controller.main(`require('electron').BrowserWindow.getAllWindows().length`), 0);
  phase = 'controller samples'; for (let i = 0; i < 3; i++) { await sample(`controller-only ${i + 1}`); await pause(1000); }
  const game = mode === 'split' ? await launch('game') : controller; phase = 'real game'; await openGame(game);
  security = await game.main(`(()=>{const p=${windowExpression}.webContents.getLastWebPreferences();return {sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration,webSecurity:p.webSecurity};})()`);
  assert.deepEqual(security, { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
  await game.renderer('window.countryClub.practice()'); await until(() => game.renderer(`document.querySelector('canvas').getAttribute('aria-disabled')==='false'`));
  const geometry = await game.renderer(`(async()=>({rect:document.querySelector('canvas').getBoundingClientRect().toJSON(),ball:(await window.countryClub.loadRound())?.state.ball??{x:760,y:300}}))()`);
  const x = geometry.rect.x + (72 + geometry.ball.x * .84) / 900 * geometry.rect.width, y = geometry.rect.y + (48 + geometry.ball.y * .84) / 600 * geometry.rect.height;
  const input = params => game.main(`${windowExpression}.webContents.debugger.sendCommand('Input.dispatchMouseEvent',${JSON.stringify(params)})`);
  await input({ type: 'mouseMoved', x, y }); await input({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 6; i++) { await input({ type: 'mouseMoved', x: x + 27 * .84 / 900 * geometry.rect.width * i / 6, y, button: 'left', buttons: 1 }); await pause(8); }
  await input({ type: 'mouseReleased', x: x + 27 * .84 / 900 * geometry.rect.width, y, button: 'left', buttons: 0, clickCount: 1 });
  await until(() => game.renderer(`window.countryClub.loadRound().then(r=>r?.state.shotId===1&&r.state.velocity.x===0&&r.state.velocity.y===0)`));
  saved = await game.renderer('window.countryClub.loadRound()'); await sample(mode === 'split' ? 'both hosts after real shot' : 'single host after real shot');
  await game.renderer('window.countryClub.hide()'); saved = await game.renderer('window.countryClub.loadRound()');
  if (mode === 'split') {
    phase = 'game exit'; await stop(game);
    // Normal quit can acknowledge a newer freeze revision. Read the final durable
    // checkpoint independently rather than treating a pre-quit revision as final.
    const previousState = saved.state;
    const database = new DatabaseSync(path.join(game.data, 'country-club.sqlite'), { readOnly: true });
    try { const row = database.prepare('SELECT revision,state FROM round_save WHERE id=1').get(); saved = { revision: row.revision, state: JSON.parse(row.state) }; }
    finally { database.close(); }
    assert.deepEqual(saved.state, previousState);
    for (let i = 0; i < 3; i++) { await sample(`after game exit ${i + 1}`); await pause(1000); }
  } else {
    phase = 'normal monolithic parking';
    await until(() => game.main(`require('electron').BrowserWindow.getAllWindows().length===0`), 35000);
    for (let i = 0; i < 3; i++) { await sample(`monolithic parked ${i + 1}`); await pause(1000); }
  }
  phase = 'game restore'; const start = performance.now(); const reopened = mode === 'split' ? await launch('reopened-game', 'game') : game; await openGame(reopened);
  const restored = await reopened.renderer('window.countryClub.loadRound()'); restoreMs = performance.now() - start;
  assert.deepEqual(restored, saved); assert.equal(await reopened.renderer(`document.querySelector('canvas').getAttribute('aria-disabled')`), 'true');
  await until(async () => { pixels = await reopened.renderer(`(()=>{const c=document.querySelector('canvas'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let turf=0,cyan=0;for(let i=0;i<p.length;i+=4){if(p[i+3]>200&&p[i+1]>120&&p[i+1]>p[i]*1.5&&p[i+1]>p[i+2]*1.2)turf++;if(p[i+3]>200&&p[i+2]>150&&p[i+1]>120&&p[i]<130)cyan++;}return {turf,cyan};})()`); return pixels.turf > 1000 && pixels.cyan > 1000; });
  await sample(mode === 'split' ? 'both hosts after exact restore' : 'single host after exact restore'); await stop(reopened);
  if (mode === 'split') {
    for (let i = 0; i < 3; i++) { await sample(`after restored game exit ${i + 1}`); await pause(1000); }
    assert.equal(await controller.main(`require('electron').BrowserWindow.getAllWindows().length`), 0);
  }
  await stop(controller);
  const hidden = measurements.filter(sample => !sample.label.startsWith('both hosts') && !sample.label.startsWith('single host'));
  await writeFile(path.join(artifacts, resultName), JSON.stringify({ experimentCompleted: true, mode, productionArchitectureImplemented: false, executableSha256: createHash('sha256').update(await readFile(executable)).digest('hex'), measurements, transientSamples, security, exactRestore: true, restoreMs, pixels, targetMiB: 200, memoryBudgetMetInExperiment: hidden.every(sample => sample.totalWorkingSetMiB <= 200), allOwnedHostsExited: true,
    limitations: [mode === 'split' ? 'Two independent full apps with separate stores/profiles; there is no production event relay, controller/game bridge, shared progress or native lifecycle ownership split.' : 'Reference control uses one current packaged app and its normal 30s renderer parking.', 'Main-process inspectors enabled; renderer debugger attaches only after opening. No Playwright preload, software graphics, isolation weakening or working-set trimming.', 'Total sums every owned application descendant including helpers; shared pages may count more than once.', 'Does not certify automatic open latency, live clients, native Mac or cross-machine behavior; split-mode memory is not shipped product memory.'] }, null, 2));
} catch (error) { await writeFile(path.join(artifacts, resultName), JSON.stringify({ experimentCompleted: false, mode, phase, error: String(error), measurements, transientSamples, profile }, null, 2)); throw error; }
finally { for (const entry of [...instances].reverse()) await stop(entry).catch(error => console.error(`Owned cleanup: ${error}`)); }
