import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// Stage beside the destination so promotion stays on the same filesystem.
// Injection supports failures after real partial writes, without runtime test flags.
export async function writeProgressExport(destination: string, content: string, io = fs): Promise<void> {
  const staged = path.join(path.dirname(destination), `.ccc-export-${randomUUID()}.tmp`);
  let owned = false;
  try {
    const file = await io.open(staged, 'wx', 0o600);
    owned = true;
    try {
      await file.writeFile(content, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await io.rename(staged, destination);
    owned = false;
  } finally {
    if (owned) await io.unlink(staged).catch(() => {});
  }
}
