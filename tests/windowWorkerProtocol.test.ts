import { expect, test } from 'vitest';
import { MAX_WINDOW_WORKER_MESSAGE_BYTES, isCurrentWorkerMessage, parseControllerMessage, parseWorkerMessage } from '../apps/desktop/src/main/windowWorkerProtocol';

const nonce = 'a'.repeat(48);
test('accepts bounded versioned startup and response messages', () => {
  expect(parseControllerMessage({ protocolVersion: 1, type: 'init', generation: 4, nonce })).toEqual({ protocolVersion: 1, type: 'init', generation: 4, nonce });
  expect(parseControllerMessage({ protocolVersion: 1, type: 'command', generation: 4, id: 'open', command: 'open', payload: { view: 'practice' } })?.type).toBe('command');
  expect(parseWorkerMessage({ protocolVersion: 1, type: 'request', generation: 4, id: 'state', command: 'state', payload: {} })?.type).toBe('request');
  expect(parseWorkerMessage({ protocolVersion: 1, type: 'response', generation: 4, id: 'open', ok: true, payload: { visible: true } })).toMatchObject({ type: 'response', ok: true });
});
test('rejects malformed, stale and oversized worker messages', () => {
  expect(parseControllerMessage({ protocolVersion: 2, type: 'init', generation: 1, nonce })).toBeUndefined();
  expect(parseWorkerMessage({ protocolVersion: 1, type: 'ready', generation: 0, nonce })).toBeUndefined();
  expect(parseWorkerMessage({ protocolVersion: 1, type: 'response', generation: 1, id: '../bad', ok: true })).toBeUndefined();
  expect(parseControllerMessage({ protocolVersion: 1, type: 'command', generation: 1, id: 'x', command: 'open', payload: 'x'.repeat(MAX_WINDOW_WORKER_MESSAGE_BYTES) })).toBeUndefined();
  expect(isCurrentWorkerMessage({ protocolVersion: 1, type: 'ready', generation: 2, nonce }, 3, nonce)).toBe(false);
  expect(isCurrentWorkerMessage({ protocolVersion: 1, type: 'ready', generation: 3, nonce: 'b'.repeat(48) }, 3, nonce)).toBe(false);
  expect(isCurrentWorkerMessage({ protocolVersion: 1, type: 'ready', generation: 3, nonce }, 3, nonce)).toBe(true);
});
