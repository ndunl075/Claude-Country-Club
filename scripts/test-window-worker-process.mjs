import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const electron = path.resolve('node_modules/electron/dist/electron.exe');
const data = await mkdtemp(path.join(os.tmpdir(), 'ccc-window-worker-'));
const nonce = 'a'.repeat(48), generation = 41;
const child = spawn(electron, ['.', '--ccc-window-worker'], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, CCC_TEST_MODE: '1', CCC_DATA_DIR: data } });
const received = [], pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let launchError;
child.on('message', value => received.push(value)); child.on('error', error => { launchError = error; });
async function until(predicate, label) {
  const end = Date.now() + 15_000;
  while (!predicate()) { if (launchError) throw launchError; if (child.exitCode !== null) throw Error(`Worker exited during ${label}: ${child.exitCode}`); if (Date.now() > end) throw Error(`Timed out during ${label}`); await pause(25); }
}
function send(message) { return new Promise((resolve, reject) => child.send(message, error => error ? reject(error) : resolve())); }
try {
  await send({ protocolVersion: 2, type: 'init', generation, nonce }); await pause(100);
  assert.equal(received.length, 0);
  await send({ protocolVersion: 1, type: 'init', generation, nonce });
  await until(() => received.some(message => message.type === 'ready'), 'authenticated ready');
  assert.deepEqual(received.find(message => message.type === 'ready'), { protocolVersion: 1, type: 'ready', generation, nonce });
  await send({ protocolVersion: 1, type: 'command', generation, id: 'open', command: 'open', payload: {} });
  await until(() => received.some(message => message.id === 'open'), 'window open');
  assert.deepEqual(received.find(message => message.id === 'open'), { protocolVersion: 1, type: 'response', generation, id: 'open', ok: true, payload: { visible: true } });
  await send({ protocolVersion: 1, type: 'command', generation, id: 'bad', command: 'invalid', payload: {} });
  await until(() => received.some(message => message.id === 'bad'), 'unknown command');
  assert.deepEqual(received.find(message => message.id === 'bad'), { protocolVersion: 1, type: 'response', generation, id: 'bad', ok: false, errorCode: 'UNKNOWN_COMMAND' });
  await send({ protocolVersion: 1, type: 'command', generation, id: 'hide', command: 'hide', payload: {} });
  await until(() => received.some(message => message.id === 'hide'), 'window hide');
  await send({ protocolVersion: 1, type: 'command', generation, id: 'quit', command: 'quit', payload: {} });
  await until(() => received.some(message => message.id === 'quit'), 'worker quit acknowledgement');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(5000)]);
  assert.equal(child.exitCode, 0);
  console.log('Opt-in Electron window-worker process passed authenticated lifecycle checks.');
} finally {
  if (child.exitCode === null) child.kill();
}
