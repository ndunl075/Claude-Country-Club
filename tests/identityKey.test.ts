import { afterEach,expect,test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadIdentityKey } from '../apps/desktop/src/main/identityKey';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'ccc-identity-'));roots.push(root);return root;}
test('creates a private random key and reuses it across restarts',async()=>{
  const root=await fixture();const initial=await loadIdentityKey(root);
  expect(initial.created).toBe(true);expect(initial.key).toMatch(/^[a-f0-9]{64}$/);
  expect(await loadIdentityKey(root)).toEqual({key:initial.key,created:false});
  const other=await loadIdentityKey(await fixture());expect(other.key).not.toBe(initial.key);
  if(process.platform!=='win32')expect((await fs.stat(path.join(root,'identity-key'))).mode&0o077).toBe(0);
});
test.each(['bad','x'.repeat(64),'a'.repeat(65)])('refuses an invalid existing key without replacing it',async value=>{
  const root=await fixture(),filename=path.join(root,'identity-key');await fs.writeFile(filename,value,{mode:0o600});
  await expect(loadIdentityKey(root)).rejects.toThrow('Invalid private identity key');
  expect(await fs.readFile(filename,'utf8')).toBe(value);
});
test('refuses a directory instead of a key file',async()=>{
  const root=await fixture();await fs.mkdir(path.join(root,'identity-key'));
  await expect(loadIdentityKey(root)).rejects.toThrow('Invalid private identity key');
  expect((await fs.stat(path.join(root,'identity-key'))).isDirectory()).toBe(true);
});
