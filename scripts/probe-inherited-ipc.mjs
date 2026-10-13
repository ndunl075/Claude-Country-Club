// Capability probe only. Both endpoints are actual packaged Electron mains.
// Inspectors install fixture listeners; no production worker/bridge is present.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
assert.equal(process.platform, 'win32'); assert(process.env.CCC_EXECUTABLE);
const executable = path.resolve(process.env.CCC_EXECUTABLE);
const artifacts = path.resolve('work/inherited-ipc'); await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(artifacts, 'profile-'));
const nonce = randomBytes(24).toString('hex');
const env = { ...process.env, CCC_TEST_MODE: '1', CCC_DATA_DIR: path.join(profile, 'controller/data'), CCC_TEST_HOME: path.join(profile, 'controller/home') };
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.CCC_TEST_SOFTWARE;
const controller = spawn(executable, ['--inspect=0', '--ccc-background'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let endpoint, launchError, parent, worker, workerPid, identity, phase = 'controller launch', owned = [], supported, responses;
controller.on('error', error => { launchError = error; });
controller.stderr.on('data', bytes => { endpoint ??= /Debugger listening on (ws:\/\/\S+)/.exec(String(bytes))?.[1]; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 15000) { const end = Date.now() + timeout; while (!await fn()) { if (launchError) throw launchError; assert.equal(controller.exitCode, null); if (Date.now() > end) throw Error(`Timeout during ${phase}`); await pause(40); } }
async function connect(url) {
  const ws = new WebSocket(url), pending = new Map(); let serial = 0;
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', event => {
    const response = JSON.parse(event.data), job = pending.get(response.id);
    if (job) { pending.delete(response.id); clearTimeout(job.timer); response.error ? job.reject(Error(response.error.message)) : job.resolve(response.result); }
  });
  return { ws, async main(expression) {
    const result = await new Promise((resolve, reject) => {
      const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error('Owned inspector timeout')); }, 10000);
      pending.set(id, { timer, resolve, reject });
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true } }));
    });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  } };
}
async function quit(inspector) {
  if (inspector?.ws.readyState === WebSocket.OPEN) { await inspector.main(`require('electron').app.quit()`).catch(() => {}); inspector.ws.close(); }
}
// Serialize a complete fixture function rather than nesting regex/string escapes
// inside another JavaScript source string.
function spawnFixture({ executable, env }) {
  const child = require('node:child_process').spawn(executable, ['--inspect=0', '--ccc-background'], { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  globalThis.__ipcProbe = { child, responses: [], sendErrors: [], disconnected: false };
  child.stderr.on('data', bytes => { globalThis.__ipcProbe.endpoint ??= /Debugger listening on (ws:\/\/\S+)/.exec(String(bytes))?.[1]; });
  child.on('message', message => { if (globalThis.__ipcProbe.responses.length < 4) globalThis.__ipcProbe.responses.push(message); });
  child.on('error', error => { globalThis.__ipcProbe.error = String(error); });
  child.on('disconnect', () => { globalThis.__ipcProbe.disconnected = true; });
  child.on('exit', (code, signal) => { globalThis.__ipcProbe.exit = { code, signal }; });
  return child.pid;
}
try {
  await until(() => endpoint); parent = await connect(endpoint);
  assert.equal(await parent.main('process.pid'), controller.pid);
  await until(() => parent.main(`require('electron').app?.isReady() && process._getActiveHandles().some(h=>h.constructor?.name==='ChildProcess'&&/ccc-hook(?:\\.exe)?$/.test(h.spawnfile??''))`));
  phase = 'worker launch';
  const workerEnv = { CCC_TEST_MODE: '1', CCC_DATA_DIR: path.join(profile, 'worker/data'), CCC_TEST_HOME: path.join(profile, 'worker/home') };
  workerPid = await parent.main(`(${spawnFixture.toString()})(${JSON.stringify({ executable, env: workerEnv })})`);
  assert(Number.isSafeInteger(workerPid) && workerPid > 0);
  let workerEndpoint;
  await until(async () => { const state = await parent.main(`({endpoint:globalThis.__ipcProbe.endpoint,error:globalThis.__ipcProbe.error})`); if (state.error) throw Error(state.error); workerEndpoint = state.endpoint; return !!workerEndpoint; });
  worker = await connect(workerEndpoint);
  identity = await worker.main('({pid:process.pid,parentPid:process.ppid,connected:process.connected,sendType:typeof process.send})');
  assert.equal(identity.pid, workerPid); assert.equal(identity.parentPid, controller.pid);
  await until(() => worker.main(`require('electron').app?.isReady() && process._getActiveHandles().some(h=>h.constructor?.name==='ChildProcess'&&/ccc-hook(?:\\.exe)?$/.test(h.spawnfile??''))`));
  assert.equal(await parent.main(`require('electron').app.getPath('userData')`), env.CCC_DATA_DIR);
  assert.equal(await worker.main(`require('electron').app.getPath('userData')`), workerEnv.CCC_DATA_DIR);
  // Fixture failures must be retained instead of opening Electron's modal
  // uncaught-error dialog and blocking further inspector diagnostics.
  await worker.main(`(()=>{globalThis.__ipcProbeExceptions=[];process.on('uncaughtException',error=>{if(globalThis.__ipcProbeExceptions.length<4)globalThis.__ipcProbeExceptions.push({name:error.name,message:error.message});});})()`);
  owned = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/owned-process-snapshot.ps1'), '-RootProcessId', String(controller.pid)], { encoding: 'utf8', windowsHide: true, timeout: 20000 }));
  supported = identity.connected === true && identity.sendType === 'function';
  if (supported) {
    phase = 'native inherited channel roundtrip';
    await worker.main(`(()=>{const crypto=require('node:crypto');globalThis.__ipcProbeReceive={received:0,matched:0,callbacks:0,errors:[]};process.on('message',message=>{globalThis.__ipcProbeReceive.received++;if(message?.probe!==${JSON.stringify(nonce)})return;globalThis.__ipcProbeReceive.matched++;const bytes=JSON.stringify(message.payload);process.send({probe:message.probe,id:message.id,bytes:Buffer.byteLength(bytes),sha256:crypto.createHash('sha256').update(bytes).digest('hex')},error=>{globalThis.__ipcProbeReceive.callbacks++;if(error)globalThis.__ipcProbeReceive.errors.push(String(error));});});return process.connected;})()`);
    for (const [id, payload] of [['small', { fixture: 'local-only café Ω', values: [1, 2, 3] }], ['ui-sized', { fixture: 'x'.repeat(128 * 1024) }]]) {
      await parent.main(`globalThis.__ipcProbe.child.send(${JSON.stringify({ probe: nonce, id, payload })},error=>{if(error)globalThis.__ipcProbe.sendErrors.push(String(error));})`);
      await until(async () => {
        const exceptions = await worker.main('globalThis.__ipcProbeExceptions');
        if (exceptions.length) throw Error(`Fixture listener failed: ${JSON.stringify(exceptions)}`);
        responses = await parent.main('globalThis.__ipcProbe.responses'); return responses.some(response => response.id === id);
      });
      const actual = responses.find(response => response.id === id), bytes = JSON.stringify(payload);
      assert.equal(actual.bytes, Buffer.byteLength(bytes)); assert.equal(actual.sha256, createHash('sha256').update(bytes).digest('hex'));
    }
    assert.deepEqual(await parent.main('globalThis.__ipcProbe.sendErrors'), []);
    await until(() => worker.main('globalThis.__ipcProbeReceive.callbacks===2'));
    assert.deepEqual(await worker.main('globalThis.__ipcProbeReceive.errors'), []);
    assert.deepEqual(await worker.main('globalThis.__ipcProbeExceptions'), []);
    phase = 'channel disconnect';
    await worker.main(`process.on('disconnect',()=>{globalThis.__ipcProbeDisconnected=true;})`);
    await parent.main('globalThis.__ipcProbe.child.disconnect()');
    await until(() => parent.main('globalThis.__ipcProbe.disconnected && !globalThis.__ipcProbe.child.connected'));
    await until(() => worker.main('globalThis.__ipcProbeDisconnected===true && process.connected===false'));
  }
  assert.equal(await parent.main(`require('electron').BrowserWindow.getAllWindows().length`), 0);
  assert.equal(await worker.main(`require('electron').BrowserWindow.getAllWindows().length`), 0);
  owned = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/owned-process-snapshot.ps1'), '-RootProcessId', String(controller.pid)], { encoding: 'utf8', windowsHide: true, timeout: 20000 }));
  assert(owned.some(record => record.pid === workerPid && record.parentPid === controller.pid));
  phase = 'normal worker/controller cleanup'; await quit(worker);
  await until(() => parent.main('!!globalThis.__ipcProbe.exit'));
  assert.deepEqual(await parent.main('globalThis.__ipcProbe.exit'), { code: 0, signal: null });
  await quit(parent);
  if (controller.exitCode === null) await Promise.race([new Promise(resolve => controller.once('exit', resolve)), pause(5000)]);
  assert.equal(controller.exitCode, 0);
  const checks = owned.map(p => `$p=Get-Process -Id ${p.pid} -ErrorAction SilentlyContinue;if($p -and $p.StartTime.ToUniversalTime().ToString('o') -eq '${p.created}'){throw 'Owned process remains: ${p.pid}'}`).join('\n');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', checks + '\nexit 0'], { windowsHide: true, timeout: 20000, stdio: 'pipe' });
  await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ probeCompleted: true, inheritedChannelSupported: supported, executableSha256: createHash('sha256').update(await readFile(executable)).digest('hex'), identity, responses: responses?.map(({ probe, ...response }) => response), normalExitAndDescendantCleanup: true,
    limitations: ['Fixture listeners are installed through owned inspectors; there is no production worker, authenticated handshake, RPC validator or shared storage implementation.', 'Roundtrip uses inherited Node IPC between actual Electron parent/child processes; inspector ports only configure/observe the fixture.', 'Both private full apps retain their existing backend/tray/helper; a real window worker must not duplicate those owners.', 'Windows only; native Mac channel support and lifecycle remain untested.'] }, null, 2));
  console.log(`Packaged inherited IPC probe completed; supported=${supported}.`);
} catch (error) {
  const parentState = await parent?.main(`({connected:globalThis.__ipcProbe?.child.connected,sendErrors:globalThis.__ipcProbe?.sendErrors,responseCount:globalThis.__ipcProbe?.responses.length,exit:globalThis.__ipcProbe?.exit})`).catch(error=>({unavailable:String(error)}));
  const workerState = await worker?.main(`({connected:process.connected,receive:globalThis.__ipcProbeReceive,exceptions:globalThis.__ipcProbeExceptions,messageListeners:process.listenerCount('message')})`).catch(error=>({unavailable:String(error)}));
  await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ probeCompleted: false, phase, error: String(error), workerPid, identity, parentState, workerState, owned }, null, 2)); throw error;
}
finally {
  await quit(worker); await quit(parent);
  if (controller.exitCode === null) { await Promise.race([new Promise(resolve => controller.once('exit', resolve)), pause(3000)]); if (controller.exitCode === null) controller.kill(); }
}
