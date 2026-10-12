import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../apps/desktop/src/main/store';
import { preserveDamagedStorage, RECOVERY_MARKER, RecoverableStorageError } from '../apps/desktop/src/main/storageRecovery';
const directories:string[]=[];
function fixture(){const directory=mkdtempSync(path.join(tmpdir(),'ccc-recovery-'));directories.push(directory);return directory;}
afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
describe('whole database recovery',()=>{
  it('classifies an unreadable database without changing its bytes or starting recovery',()=>{
    const directory=fixture(),file=path.join(directory,'country-club.sqlite'),bytes=Buffer.from('damaged database fixture');writeFileSync(file,bytes);
    expect(()=>new Store(directory)).toThrow(RecoverableStorageError);
    expect(readFileSync(file)).toEqual(bytes);expect(readdirSync(directory)).toEqual(['country-club.sqlite']);
  });
  it('preserves the entire SQLite family and unrelated configuration before a fresh store',()=>{
    const directory=fixture(),family=['country-club.sqlite','country-club.sqlite-wal','country-club.sqlite-shm'];
    for(const name of family)writeFileSync(path.join(directory,name),`original:${name}`);
    writeFileSync(path.join(directory,'connection.json'),'private connection fixture');
    const archive=preserveDamagedStorage(directory);
    for(const name of family){expect(readFileSync(path.join(archive,name),'utf8')).toBe(`original:${name}`);expect(existsSync(path.join(directory,name))).toBe(false);}
    expect(readFileSync(path.join(directory,'connection.json'),'utf8')).toBe('private connection fixture');
    const store=new Store(directory);try{expect(store.load()).toBeNull();expect(store.settings().automatic).toBe(false);}finally{store.close();}
    expect(existsSync(path.join(directory,RECOVERY_MARKER))).toBe(false);
  });
  it('does not let read-only SQLite inspection rewrite original shared-memory sidecars',()=>{
    const directory=fixture(),family=['country-club.sqlite','country-club.sqlite-wal','country-club.sqlite-shm'];
    for(const name of family)writeFileSync(path.join(directory,name),`damaged:${name}`);
    expect(()=>new Store(directory)).toThrow(RecoverableStorageError);
    for(const name of family)expect(readFileSync(path.join(directory,name),'utf8')).toBe(`damaged:${name}`);
    expect(readdirSync(directory).sort()).toEqual(family.sort());
  });
  it('refuses startup after an interrupted move and resumes without overwriting originals',()=>{
    const directory=fixture();writeFileSync(path.join(directory,'country-club.sqlite'),'database');writeFileSync(path.join(directory,'country-club.sqlite-wal'),'wal');
    let moves=0;
    expect(()=>preserveDamagedStorage(directory,(source,destination)=>{if(++moves===2)throw new Error('injected move failure');renameSync(source,destination);})).toThrow('injected move failure');
    expect(()=>new Store(directory)).toThrow(RecoverableStorageError);
    const archive=preserveDamagedStorage(directory);
    expect(readFileSync(path.join(archive,'country-club.sqlite'),'utf8')).toBe('database');
    expect(readFileSync(path.join(archive,'country-club.sqlite-wal'),'utf8')).toBe('wal');
    expect(existsSync(path.join(directory,RECOVERY_MARKER))).toBe(false);
  });
  it('preserves conflicting original and archive files for manual review',()=>{
    const directory=fixture();writeFileSync(path.join(directory,'country-club.sqlite'),'original');
    expect(()=>preserveDamagedStorage(directory,()=>{throw new Error('injected');})).toThrow();
    const record=JSON.parse(readFileSync(path.join(directory,RECOVERY_MARKER),'utf8'));
    writeFileSync(path.join(directory,record.archive,'country-club.sqlite'),'conflicting archive');
    expect(()=>preserveDamagedStorage(directory)).toThrow('Both original and archived');
    expect(readFileSync(path.join(directory,'country-club.sqlite'),'utf8')).toBe('original');
    expect(readFileSync(path.join(directory,record.archive,'country-club.sqlite'),'utf8')).toBe('conflicting archive');
  });
  it('refuses an invalid or traversing recovery marker without moving files',()=>{
    const directory=fixture();writeFileSync(path.join(directory,'country-club.sqlite'),'original');
    writeFileSync(path.join(directory,RECOVERY_MARKER),JSON.stringify({version:1,archive:'../outside',files:['country-club.sqlite']}));
    expect(()=>preserveDamagedStorage(directory)).toThrow('marker is invalid');
    expect(readFileSync(path.join(directory,'country-club.sqlite'),'utf8')).toBe('original');
  });
});
