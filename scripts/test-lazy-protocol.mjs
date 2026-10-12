// Cold-start regression without Playwright or a browser debugging connection.
// Do not inspect session/protocol APIs before first use: that would itself
// create the default session whose premature initialization this test detects.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
assert(process.env.CCC_EXECUTABLE);
const artifacts = path.resolve('work/lazy-protocol'); await mkdir(artifacts, { recursive: true });
const fixture = await mkdtemp(path.join(artifacts, 'profile-'));
const env = { ...process.env, CCC_TEST_MODE: '1', CCC_DATA_DIR: path.join(fixture, 'data'), CCC_TEST_HOME: path.join(fixture, 'home') };
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.CCC_TEST_SOFTWARE;
const child = spawn(process.env.CCC_EXECUTABLE, ['--inspect=0', '--ccc-background'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let endpoint, ws, sequence = 0, phase = 'launch'; const pending = new Map(), checks = [];
child.stderr.on('data', b => { endpoint ??= /Debugger listening on (ws:\/\/\S+)/.exec(String(b))?.[1]; });
child.on('error', error => { throw error; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { const end = Date.now() + 15000; while (!await fn()) { assert.equal(child.exitCode, null); if (Date.now() > end) throw Error(`Timeout during ${phase}`); await pause(30); } }
function command(method, params) { return new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(Error(`Inspector timeout ${method}`)); }, 10000); pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } }); ws.send(JSON.stringify({ id, method, params })); }); }
async function main(expression) { const r = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; }
let cold, firstUse;
try {
  await until(() => endpoint); ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', event => { const r = JSON.parse(event.data); if (r.id) { const job = pending.get(r.id); pending.delete(r.id); r.error ? job?.reject(Error(r.error.message)) : job?.resolve(r.result); } });
  phase = 'background initialization';
  await until(() => main(`require('electron').app.isReady() && process._getActiveHandles().some(h=>h.constructor?.name==='ChildProcess'&&/ccc-hook(?:\\.exe)?$/.test(h.spawnfile??'')&&!!h.stdout)`));
  await pause(1000);
  cold = await main(`(()=>{const {app,BrowserWindow,webContents}=require('electron');return {windows:BrowserWindow.getAllWindows().length,webContents:webContents.getAllWebContents().length,processes:app.getAppMetrics().map(p=>({type:p.type,workingSetKiB:p.memory.workingSetSize}))};})()`);
  assert.equal(cold.windows, 0); assert.equal(cold.webContents, 0);
  assert(!cold.processes.some(p => p.type === 'Tab'), 'Unused background launch started a renderer');
  checks.push('background starts no window, webContents or spare renderer without browser-test instrumentation');
  // Fault injection starts after the cold sample: touching protocol earlier
  // would invalidate the startup observation by creating its session.
  phase = 'protocol registration retry';
  await main(`(()=>{const {protocol}=require('electron');const original=protocol.handle;globalThis.__cccProtocolAttempts=0;protocol.handle=function(...args){globalThis.__cccProtocolAttempts++;if(globalThis.__cccProtocolAttempts===1)throw Error('Isolated registration fault');return original.apply(this,args);};})()`);
  await main(`require('electron').app.emit('activate')`);
  await until(() => main(`globalThis.__cccProtocolAttempts===1`));
  await pause(100);
  assert.equal(await main(`require('electron').BrowserWindow.getAllWindows().length`), 0);
  checks.push('synchronous registration failure creates no partial window and leaves explicit retry available');
  phase = 'first explicit course'; await main(`require('electron').app.emit('activate')`);
  await until(() => main(`(()=>{const w=require('electron').BrowserWindow.getAllWindows()[0];return !!w&&!w.webContents.isLoading();})()`));
  await until(() => main(`require('electron').BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('!!window.countryClub && !!document.querySelector("canvas")')`));
  firstUse = await main(`(async()=>{const {BrowserWindow,protocol}=require('electron');const w=BrowserWindow.getAllWindows()[0];return {handled:await protocol.isProtocolHandled('ccc'),url:w.webContents.getURL(),state:await w.webContents.executeJavaScript('window.countryClub.getState()')};})()`);
  assert.equal(firstUse.handled, true); assert.equal(firstUse.url, 'ccc://app/index.html');
  assert.equal(firstUse.state.settings.automatic, false); assert.equal(firstUse.state.settings.sound, false); assert.equal(firstUse.state.settings.startAtLogin, false);
  assert.equal(firstUse.state.brokerReady, true);
  assert.equal(await main(`globalThis.__cccProtocolAttempts`), 2);
  await main(`require('electron').BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('window.countryClub.practice()')`);
  await until(() => main(`require('electron').BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('document.querySelector("canvas").getAttribute("aria-disabled")==="false"')`));
  checks.push('first explicit opening registers protocol, loads the course, preserves quiet defaults and allows practice');
  await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ passed: true, executableSha256: createHash('sha256').update(await readFile(process.env.CCC_EXECUTABLE)).digest('hex'), cold, checks, limitations: ['Main-process inspector enabled; no browser debugger/preload or protocol/session inspection before the cold sample.', 'Single isolated startup sample; does not prove the post-game memory budget, automatic focus behavior or native Mac execution.'] }, null, 2));
  console.log('Lazy protocol cold-start and first-use acceptance passed.');
} catch (error) { await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ passed: false, phase, error: String(error), cold, checks }, null, 2)); throw error; }
finally {
  if (ws?.readyState === WebSocket.OPEN) { await main(`require('electron').app.quit()`).catch(() => {}); ws.close(); }
  if (child.exitCode === null) { await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(3000)]); if (child.exitCode === null) child.kill(); }
  for (const job of pending.values()) job.reject(Error('Owned inspector closed')); pending.clear();
}
