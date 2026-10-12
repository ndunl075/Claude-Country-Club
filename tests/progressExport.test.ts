import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeProgressExport } from '../apps/desktop/src/main/progressExport';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccc-export-')); roots.push(root);
  const destination = path.join(root, 'round.json'); await fs.writeFile(destination, 'previous backup');
  return { root, destination };
}
test('replaces an existing export only with the complete new file', async () => {
  const { root, destination } = await fixture();
  await writeProgressExport(destination, '{"round":"new"}');
  expect(await fs.readFile(destination, 'utf8')).toBe('{"round":"new"}');
  expect(await fs.readdir(root)).toEqual(['round.json']);
});
for (const failure of ['write', 'sync', 'rename'] as const) {
  test(`${failure} failure retains the previous backup and removes staging`, async () => {
    const { root, destination } = await fixture();
    const injected = new Error(`injected ${failure} failure`);
    const io = { ...fs,
      open: async (...args: Parameters<typeof fs.open>) => {
        const file = await fs.open(...args);
        if (failure === 'write') file.writeFile = async () => { await file.write('partial'); throw injected; };
        if (failure === 'sync') file.sync = async () => { throw injected; };
        return file;
      },
      rename: failure === 'rename' ? async () => { throw injected; } : fs.rename,
    };
    await expect(writeProgressExport(destination, 'replacement', io)).rejects.toBe(injected);
    expect(await fs.readFile(destination, 'utf8')).toBe('previous backup');
    expect(await fs.readdir(root)).toEqual(['round.json']);
  });
}
