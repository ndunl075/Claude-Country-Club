import { expect, test } from 'vitest';
import { WindowWorkerBridge, WindowWorkerPort, WindowWorkerUnavailableError } from '../apps/desktop/src/main/windowWorkerBridge';

const nonce = 'a'.repeat(48);
class FakePort implements WindowWorkerPort {
  connected = true; sent: unknown[] = []; private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  send(message: any, callback: (error?: Error | null) => void) { this.sent.push(message); callback(); return true; }
  on(event: 'message' | 'disconnect' | 'exit' | 'error', listener: (...args: unknown[]) => void) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); }
  emit(event: 'message' | 'disconnect' | 'exit' | 'error', value?: unknown) { for (const listener of this.listeners.get(event) ?? []) listener(value); }
}
const ready = (generation = 7, token = nonce) => ({ protocolVersion: 1, type: 'ready', generation, nonce: token });

test('sends authenticated startup then resolves the matching current response', async () => {
  const port = new FakePort(), bridge = new WindowWorkerBridge(port, { generation: 7, nonce, id: () => 'open' });
  const starting = bridge.start();
  expect(port.sent).toEqual([{ protocolVersion: 1, type: 'init', generation: 7, nonce }]);
  port.emit('message', ready()); await starting;
  const opening = bridge.request('open', { view: 'practice' });
  expect(port.sent[1]).toMatchObject({ type: 'command', id: 'open', command: 'open' });
  port.emit('message', { protocolVersion: 1, type: 'response', generation: 7, id: 'open', ok: true, payload: { visible: true } });
  await expect(opening).resolves.toEqual({ visible: true });
});

test('rejects use before ready, ignores stale traffic, and fails inflight work on exit', async () => {
  const port = new FakePort(), bridge = new WindowWorkerBridge(port, { generation: 7, nonce, id: () => 'save' });
  await expect(bridge.request('save', {})).rejects.toBeInstanceOf(WindowWorkerUnavailableError);
  const starting = bridge.start();
  port.emit('message', ready(6));
  // A stale ready cannot settle the startup handshake.
  const failedStart = expect(starting).rejects.toBeInstanceOf(WindowWorkerUnavailableError);
  port.emit('exit'); await failedStart;
  const activePort = new FakePort(), active = new WindowWorkerBridge(activePort, { generation: 7, nonce, id: () => 'save' });
  const startActive = active.start(); activePort.emit('message', ready()); await startActive;
  const saving = active.request('save', { revision: 2 });
  activePort.emit('message', { protocolVersion: 1, type: 'response', generation: 6, id: 'save', ok: true });
  const failedSave = expect(saving).rejects.toBeInstanceOf(WindowWorkerUnavailableError);
  activePort.emit('exit'); await failedSave;
});

test('relays only post-ready worker requests through the controller handler', async () => {
  const port = new FakePort(), bridge = new WindowWorkerBridge(port, { generation: 7, nonce, onRequest: (command, payload) => command === 'state' ? { payload } : Promise.reject(new Error('denied')) });
  port.emit('message', { protocolVersion: 1, type: 'request', generation: 7, id: 'early', command: 'state', payload: {} });
  await new Promise(resolve => setTimeout(resolve));
  expect(port.sent.at(-1)).toMatchObject({ type: 'response', id: 'early', ok: false, errorCode: 'WORKER_NOT_READY' });
  const starting = bridge.start(); port.emit('message', ready()); await starting;
  port.emit('message', { protocolVersion: 1, type: 'request', generation: 7, id: 'state', command: 'state', payload: { local: true } });
  await new Promise(resolve => setTimeout(resolve));
  expect(port.sent.at(-1)).toMatchObject({ type: 'response', id: 'state', ok: true, payload: { payload: { local: true } } });
});
