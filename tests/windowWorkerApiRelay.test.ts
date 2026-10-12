import { expect, test } from 'vitest';
import { relayWindowWorkerApi } from '../apps/desktop/src/main/windowWorkerApiRelay';

test('relays a named controller operation with its bounded arguments', async () => {
  const handlers = new Map([['save', (state: unknown, revision: number) => ({ state, revision })]]);
  await expect(relayWindowWorkerApi({ name: 'save', args: [{ hole: 2 }, 4] }, handlers)).resolves.toEqual({ state: { hole: 2 }, revision: 4 });
});
test('denies unknown, malformed, unavailable and oversized operations', async () => {
  const handlers = new Map([['state', () => ({})]]);
  await expect(relayWindowWorkerApi({ name: 'shell', args: [] }, handlers)).rejects.toThrow('Denied');
  await expect(relayWindowWorkerApi({ name: 'state', args: 'bad' }, handlers)).rejects.toThrow('Denied');
  await expect(relayWindowWorkerApi({ name: 'save', args: [] }, handlers)).rejects.toThrow('Unavailable');
  await expect(relayWindowWorkerApi({ name: 'state', args: ['x'.repeat(256 * 1024)] }, handlers)).rejects.toThrow('too large');
});
