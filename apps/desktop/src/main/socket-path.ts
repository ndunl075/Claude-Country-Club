import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
/** A new private directory avoids stale sockets after a hard crash. Keep the
 * Darwin sun_path under its byte limit even for long user/config paths. */
export async function createSocketPath(temporaryRoot = os.tmpdir()): Promise<{directory:string;socket:string}> {
  const prefix=path.join(temporaryRoot,'ccc-');
  const base=Buffer.byteLength(prefix)+6+9<=103 ? temporaryRoot : '/tmp';
  const directory=await fs.mkdtemp(path.join(base,'ccc-'));
  await fs.chmod(directory,0o700);
  return {directory,socket:path.join(directory,'ipc.sock')};
}
