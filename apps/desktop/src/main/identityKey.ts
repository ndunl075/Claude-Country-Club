import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export async function loadIdentityKey(directory: string): Promise<{key:string;created:boolean}> {
  const filename=path.join(directory,'identity-key');
  try {
    const file=await fs.open(filename,'wx',0o600);
    try {
      const key=randomBytes(32).toString('hex');
      await file.writeFile(key,'utf8');await file.sync();
      return {key,created:true};
    } finally {await file.close();}
  } catch(error) {
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
  }
  const info=await fs.lstat(filename);
  if(!info.isFile()||info.isSymbolicLink()||info.size!==64||(process.platform!=='win32'&&(info.mode&0o077)!==0))throw new Error('Invalid private identity key; preserve it for manual review.');
  const file=await fs.open(filename,'r');
  try {
    const bytes=Buffer.alloc(65);const {bytesRead}=await file.read(bytes,0,65,0);
    const key=bytes.subarray(0,bytesRead).toString('utf8');
    if(!/^[a-f0-9]{64}$/.test(key))throw new Error('Invalid private identity key; preserve it for manual review.');
    return {key,created:false};
  } finally {await file.close();}
}
