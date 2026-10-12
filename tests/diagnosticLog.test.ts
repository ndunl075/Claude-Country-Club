import { test,expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DiagnosticLog } from '../apps/desktop/src/main/diagnosticLog';

const entry=(index:number)=>({time:new Date(1700000000000+index).toISOString(),code:'SAVE_FAILED',message:'PRIVATE_TOKEN_AND_PATH'});
async function profile(){return fs.mkdtemp(path.join(os.tmpdir(),'ccc-diagnostic-log-'));}
test('rotates bounded private projections and restores the newest history across restart',async()=>{
  const dir=await profile();
  try{
    const log=new DiagnosticLog(dir,fs,1024);expect(await log.initialize()).toEqual([]);
    for(let i=0;i<120;i++){log.append(entry(i));await log.flush();}
    const files=await fs.readdir(log.directory);expect(files).toHaveLength(4);
    let bytes=0;
    for(const name of files){const text=await fs.readFile(path.join(log.directory,name),'utf8');expect(text).not.toContain('PRIVATE');expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024);bytes+=Buffer.byteLength(text);}
    expect(bytes).toBeLessThanOrEqual(4*1024);
    const reopened=new DiagnosticLog(dir,fs,1024),history=await reopened.initialize();
    expect(history[0].time).toBe(entry(119).time);expect(history.length).toBeGreaterThan(10);expect(history.length).toBeLessThanOrEqual(80);
    expect(history.map(e=>e.time)).toEqual([...history.map(e=>e.time)].sort().reverse());
    expect(JSON.stringify(history)).not.toContain('PRIVATE');
    if(process.platform!=='win32'){expect((await fs.stat(log.directory)).mode&0o777).toBe(0o700);for(const name of files)expect((await fs.stat(path.join(log.directory,name))).mode&0o777).toBe(0o600);}
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('bounded queue drops older pending events without retaining raw fields or invalid codes',async()=>{
  const dir=await profile();
  try{
    const log=new DiagnosticLog(dir);await log.initialize();
    for(let i=0;i<1000;i++)log.append({...entry(i),code:'PRIVATE_UNKNOWN_CODE'});
    await log.flush();const text=await fs.readFile(path.join(log.directory,'events.0.json'),'utf8');const chunk=JSON.parse(text);
    expect(chunk.entries).toHaveLength(256);expect(chunk.entries[0].time).toBe(entry(744).time);expect(chunk.entries.at(-1).time).toBe(entry(999).time);expect(text).not.toContain('PRIVATE');expect(chunk.entries.every((e:{code:string})=>e.code==='OTHER')).toBe(true);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('recovers an exact synced stage after promotion failure without losing prior history',async()=>{
  const dir=await profile();let failures=0;
  try{
    const first=new DiagnosticLog(dir);await first.initialize();first.append(entry(0));await first.flush();
    const log=new DiagnosticLog(dir,{...fs,rename:async()=>{throw new Error('PRIVATE_DISK_ERROR');}},1024*1024,()=>failures++);await log.initialize();log.append(entry(1));await log.flush();
    expect(log.available).toBe(false);expect(failures).toBe(1);expect(await fs.readdir(log.directory)).toContain('events.pending');
    const reopened=new DiagnosticLog(dir);const history=await reopened.initialize();expect(reopened.available).toBe(true);expect(history.map(e=>e.time)).toEqual([entry(1).time,entry(0).time]);expect(await fs.readdir(log.directory)).not.toContain('events.pending');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('preserves malformed, oversized, foreign and hard-linked files and disables logging only',async()=>{
  for(const kind of ['malformed','oversized','foreign','hardlink']){
    const dir=await profile();
    try{
      const log=new DiagnosticLog(dir);await fs.mkdir(log.directory);
      const file=path.join(log.directory,kind==='foreign'?'user-note.txt':'events.0.json'),content=kind==='oversized'?'x'.repeat(1025):'PRIVATE_ORIGINAL';await fs.writeFile(file,content);
      if(kind==='hardlink')await fs.link(file,path.join(dir,'outside-link'));
      const bounded=new DiagnosticLog(dir,fs,1024);expect(await bounded.initialize()).toEqual([]);expect(bounded.available).toBe(false);bounded.append(entry(0));await bounded.flush();expect(await fs.readFile(file,'utf8')).toBe(content);
    }finally{await fs.rm(dir,{recursive:true,force:true});}
  }
});
test('refuses a linked diagnostic directory without reading or writing its target',async()=>{
  const dir=await profile(),outside=await profile();
  try{
    const file=path.join(outside,'private.txt');await fs.writeFile(file,'PRIVATE_UNCHANGED');
    const log=new DiagnosticLog(dir);await fs.symlink(outside,log.directory,process.platform==='win32'?'junction':'dir');
    expect(await log.initialize()).toEqual([]);expect(log.available).toBe(false);log.append(entry(0));await log.flush();
    expect(await fs.readdir(outside)).toEqual(['private.txt']);expect(await fs.readFile(file,'utf8')).toBe('PRIVATE_UNCHANGED');
    await fs.unlink(log.directory);
  }finally{await fs.rm(dir,{recursive:true,force:true});await fs.rm(outside,{recursive:true,force:true});}
});
test('short normalized entries rotate at the record bound before producing an unreadable chunk',async()=>{
  const dir=await profile();
  try{
    const log=new DiagnosticLog(dir);await fs.mkdir(log.directory);
    await fs.writeFile(path.join(log.directory,'events.0.json'),JSON.stringify({format:'ccc-local-diagnostics',version:1,generation:1,entries:Array.from({length:20000},()=>({time:null,code:'OTHER'}))}));
    await log.initialize();expect(log.available).toBe(true);log.append(entry(1));await log.flush();expect(log.available).toBe(true);
    const history=await new DiagnosticLog(dir).initialize();expect(history[0].time).toBe(entry(1).time);expect(history).toHaveLength(80);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
