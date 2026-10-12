import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const RECOVERY_MARKER='storage-recovery.json';
const family=['country-club.sqlite','country-club.sqlite-wal','country-club.sqlite-shm'];
export class RecoverableStorageError extends Error {}
export function assertNoPendingRecovery(directory:string) {
  if(existsSync(path.join(directory,RECOVERY_MARKER)))throw new RecoverableStorageError('An interrupted storage recovery needs your confirmation. The original files are preserved.');
}
function regular(filename:string) {
  const entry=lstatSync(filename);
  if(!entry.isFile() || entry.isSymbolicLink())throw new Error('Storage recovery refused a non-regular database file. Keep the files unchanged for manual review.');
}

// This is called only after explicit confirmation. A synced marker prevents a
// later startup from opening a partially moved SQLite family after interruption.
// Retry moves only the remaining files, never overwrites archived originals.
export function preserveDamagedStorage(directory:string, move:typeof renameSync=renameSync):string {
  const marker=path.join(directory,RECOVERY_MARKER);
  let record:{version:number;archive:string;files:string[]};
  if(existsSync(marker)) {
    regular(marker);
    if(lstatSync(marker).size>4096)throw new Error('Storage recovery marker is invalid. Keep files unchanged for manual review.');
    record=JSON.parse(readFileSync(marker,'utf8'));
    if(record?.version!==1 || typeof record.archive!=='string' || !/^database-recovery-[a-f0-9-]{36}$/.test(record.archive) || !Array.isArray(record.files) || !record.files.includes(family[0]) || record.files.some(name=>!family.includes(name)) || new Set(record.files).size!==record.files.length)throw new Error('Storage recovery marker is invalid. Keep files unchanged for manual review.');
  } else {
    const files=family.filter(name=>existsSync(path.join(directory,name)));
    if(!files.includes(family[0]))throw new Error('No damaged database was found.');
    for(const name of files)regular(path.join(directory,name));
    record={version:1,archive:`database-recovery-${randomUUID()}`,files};
    mkdirSync(path.join(directory,record.archive),{mode:0o700});
    const fd=openSync(marker,'wx',0o600);
    try {writeFileSync(fd,JSON.stringify(record));fsyncSync(fd);}finally{closeSync(fd);}
  }
  const archive=path.join(directory,record.archive), entry=lstatSync(archive);
  if(!entry.isDirectory() || entry.isSymbolicLink())throw new Error('Storage recovery folder is invalid. Keep files unchanged for manual review.');
  // A new sidecar during recovery indicates another writer or a changed family.
  if(family.some(name=>!record.files.includes(name)&&existsSync(path.join(directory,name))))throw new Error('Database files changed during recovery. Close other copies and keep files unchanged.');
  for(const name of record.files) {
    const source=path.join(directory,name),target=path.join(archive,name);
    if(existsSync(target)) {
      regular(target);
      if(existsSync(source))throw new Error('Both original and archived database files exist. Keep them unchanged for manual review.');
    } else {
      regular(source);move(source,target);
    }
  }
  unlinkSync(marker);
  return archive;
}
