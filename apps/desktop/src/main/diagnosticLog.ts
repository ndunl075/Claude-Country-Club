import { promises as fs,constants } from 'node:fs';
import path from 'node:path';
import type { Diagnostic } from '../../../../packages/contracts';
import { diagnosticEntry } from './diagnosticExport';

type Entry={time:string|null;code:string};
type Chunk={format:'ccc-local-diagnostics';version:1;generation:number;entries:Entry[]};
export const DIAGNOSTIC_CHUNK_BYTES=1024*1024;
const pendingName='events.pending';
const slot=(generation:number)=>`events.${(generation-1)%4}.json`;
const names=new Set([pendingName,...Array.from({length:4},(_,i)=>`events.${i}.json`)]);

// Four bounded chunks plus one bounded atomic-write stage use at most 5 MiB.
// This store accepts projections only; raw messages/configuration never enter it.
export class DiagnosticLog {
  private current:Chunk={format:'ccc-local-diagnostics',version:1,generation:1,entries:[]};
  private queue:Entry[]=[];
  private writing:Promise<void>|undefined;
  available=false;
  readonly directory:string;
  constructor(dataDir:string,private io=fs,private chunkBytes=DIAGNOSTIC_CHUNK_BYTES,private onFailure=()=>{}) {
    if(!Number.isInteger(chunkBytes)||chunkBytes<256||chunkBytes>DIAGNOSTIC_CHUNK_BYTES)throw new Error('Invalid diagnostic chunk bound');
    this.directory=path.join(dataDir,'diagnostics-v1');
  }
  private async directoryCheck(){
    const stat=await this.io.lstat(this.directory);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Diagnostic directory is not an ordinary directory');
    if((await this.io.readdir(this.directory)).some(name=>!names.has(name)))throw new Error('Unexpected diagnostic file preserved');
  }
  private async read(name:string):Promise<Chunk|undefined>{
    const filename=path.join(this.directory,name);
    let stat;
    try{stat=await this.io.lstat(filename);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>this.chunkBytes)throw new Error('Unsafe diagnostic file preserved');
    const file=await this.io.open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    let text;
    try{
      const opened=await file.stat();
      if(!opened.isFile()||opened.nlink!==1||opened.size>this.chunkBytes||opened.ino!==stat.ino||opened.dev!==stat.dev)throw new Error('Diagnostic file changed');
      const buffer=Buffer.alloc(this.chunkBytes+1);let length=0;
      while(length<buffer.length){const result=await file.read(buffer,length,buffer.length-length,length);if(!result.bytesRead)break;length+=result.bytesRead;}
      if(length>this.chunkBytes)throw new Error('Diagnostic chunk grew beyond its bound');
      text=buffer.subarray(0,length).toString('utf8');
    }finally{await file.close();}
    if(Buffer.byteLength(text,'utf8')>this.chunkBytes)throw new Error('Diagnostic chunk too large');
    const value=JSON.parse(text) as Chunk;
    if(!value||Object.keys(value).sort().join(',')!=='entries,format,generation,version'||value.format!=='ccc-local-diagnostics'||value.version!==1||!Number.isSafeInteger(value.generation)||value.generation<1||!Array.isArray(value.entries)||value.entries.length>20000)throw new Error('Unknown diagnostic data preserved');
    for(const entry of value.entries){
      if(!entry||Object.keys(entry).sort().join(',')!=='code,time')throw new Error('Unknown diagnostic entry preserved');
      const normalized=diagnosticEntry(entry.time,entry.code);
      if(entry.code!==normalized.code||entry.time!==normalized.time)throw new Error('Invalid diagnostic entry preserved');
    }
    return value;
  }
  private disable(){this.available=false;this.queue=[];try{this.onFailure();}catch{/* Logging must never interrupt gameplay. */}}
  async initialize():Promise<Diagnostic[]>{
    try{
      await this.io.mkdir(this.directory,{mode:0o700}).catch(error=>{if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;});
      await this.directoryCheck();
      const chunks:Chunk[]=[];
      for(let i=0;i<4;i++){
        const chunk=await this.read(`events.${i}.json`);
        if(chunk){if(slot(chunk.generation)!==`events.${i}.json`)throw new Error('Diagnostic slot mismatch');chunks.push(chunk);}
      }
      chunks.sort((a,b)=>a.generation-b.generation);
      const latest=chunks.at(-1),pending=await this.read(pendingName);
      if(pending){
        const same=latest&&pending.generation===latest.generation;
        const next=pending.generation===(latest?.generation??0)+1;
        if(!next&&!(same&&pending.entries.length>=latest.entries.length&&JSON.stringify(pending.entries.slice(0,latest.entries.length))===JSON.stringify(latest.entries)))throw new Error('Ambiguous diagnostic stage preserved');
        await this.io.rename(path.join(this.directory,pendingName),path.join(this.directory,slot(pending.generation)));
        const old=chunks.findIndex(chunk=>slot(chunk.generation)===slot(pending.generation));if(old>=0)chunks.splice(old,1);
        chunks.push(pending);chunks.sort((a,b)=>a.generation-b.generation);
      }
      this.current=chunks.at(-1)??this.current;this.available=true;
      return chunks.flatMap(chunk=>chunk.entries).slice(-80).reverse().map(entry=>({time:entry.time??'',code:entry.code,message:'Previous local diagnostic; no message was retained.'}));
    }catch{this.disable();return [];}
  }
  append(entry:{time:unknown;code:unknown}){
    if(!this.available)return;
    this.queue.push(diagnosticEntry(entry.time,entry.code));
    if(this.queue.length>256)this.queue.splice(0,this.queue.length-256);
    this.start();
  }
  private start(){if(!this.writing)this.writing=Promise.resolve().then(()=>this.drain()).finally(()=>{this.writing=undefined;if(this.available&&this.queue.length)this.start();});}
  private async drain(){
    try{
      while(this.available&&this.queue.length){
        const entries=this.queue.splice(0,256);
        let next:Chunk={...this.current,entries:[...this.current.entries,...entries]};
        let content=JSON.stringify(next)+'\n';
        if(next.entries.length>20000||Buffer.byteLength(content)>this.chunkBytes){
          next={...this.current,generation:this.current.generation+(this.current.entries.length?1:0),entries:[]};
          // Unit tests use smaller chunks. Keep only the newest fitting records.
          for(const entry of entries){next.entries.push(entry);while(Buffer.byteLength(JSON.stringify(next)+'\n')>this.chunkBytes)next.entries.shift();}
          content=JSON.stringify(next)+'\n';
        }
        if(!Number.isSafeInteger(next.generation))throw new Error('Diagnostic generations exhausted');
        await this.directoryCheck();
        // Refuse links/changed/unrecognized existing targets before replacement.
        await this.read(slot(next.generation));
        const staged=path.join(this.directory,pendingName);
        const file=await this.io.open(staged,'wx',0o600);
        try{await file.writeFile(content,'utf8');await file.sync();}finally{await file.close();}
        await this.io.rename(staged,path.join(this.directory,slot(next.generation)));
        this.current=next;
      }
    }catch{this.disable();}
  }
  async flush(){while(this.writing)await this.writing;}
}
