import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const electron = path.resolve('node_modules/electron/dist/electron.exe');
const data = await mkdtemp(path.join(os.tmpdir(), 'ccc-window-controller-'));
const child = spawn(electron, ['.', '--ccc-background'], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CCC_TEST_MODE: '1', CCC_DATA_DIR: data, CCC_WINDOW_WORKER_CONTROLLER_PROBE: '1' } });
let output = '', launchError; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; }); child.on('error', error => { launchError = error; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const end = Date.now() + 20_000;
while (child.exitCode === null && Date.now() < end) { if (launchError) throw launchError; await pause(25); }
if (child.exitCode === null) { child.kill(); throw Error(`Timed out: ${output}`); }
assert.equal(child.exitCode, 0, output);
assert.match(output, /CCC_WINDOW_WORKER_CONTROLLER_PROBE_OK/);
// The controller root no longer exists, so no descendant with its recorded
// identity can remain. Query is intentionally read-only and PID/start-time
// aware to avoid confusing a reused Windows PID with the tested process.
const records = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', `$p=Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue;if($p){@{pid=$p.Id;created=$p.StartTime.ToUniversalTime().ToString('o')}|ConvertTo-Json}else{'null'}`], { encoding: 'utf8', windowsHide: true }));
assert.equal(records, null, 'controller process remains after probe');
console.log('Controller-owned opt-in window-worker bridge passed clean lifecycle checks.');
