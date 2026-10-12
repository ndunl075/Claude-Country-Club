import { randomUUID } from 'node:crypto';
import type { HostState, DiagnosticsPreview } from '../../../../packages/contracts';
const codes=new Set(['RENDERER_REPAIR','EVENT_REJECTED','BROKER_UNAVAILABLE','BROKER_FRAME','BROKER_MESSAGE','BROKER_STOPPED','SAVE_RECOVERY','SAVE_FAILED','RENDERER_STOPPED','LOCK_STATE_UNKNOWN','STORAGE_RECOVERED','DIAGNOSTIC_LOG_UNAVAILABLE','OTHER']);
export function diagnosticEntry(time:unknown,code:unknown):{time:string|null;code:string} {
  const parsed=typeof time==='string'&&time.length<=40?Date.parse(time):NaN;
  return {time:Number.isFinite(parsed)?new Date(parsed).toISOString():null,code:typeof code==='string'&&codes.has(code)?code:'OTHER'};
}
const version=(value:unknown)=>typeof value==='string'?/^(\d{1,6}\.\d{1,6}\.\d{1,6})(?:[-+].*)?$/.exec(value.slice(0,100))?.[1]??'unknown':'unknown';
const choice=(value:unknown,values:readonly string[])=>typeof value==='string'&&values.includes(value)?value:'unknown';
export function diagnosticReport(state:HostState,arch:string,now=new Date()):string {
  const states=['working','attention','stopped','interrupted','failed','closed','unknown'] as const;
  const sessions=Object.fromEntries(states.map(kind=>[kind,state.sessions.slice(0,100).filter(s=>s.state===kind).length]));
  return JSON.stringify({format:'claude-country-club-diagnostics',version:1,createdAt:now.toISOString(),
    application:{version:version(state.version),platform:choice(state.platform,['win32','darwin','linux']),arch:choice(arch,['x64','arm64'])},
    status:{brokerReady:state.brokerReady===true,automaticEnabled:state.settings.automatic===true,practice:state.practice===true,suspended:state.suspended===true},
    integrations:(['claude','codex'] as const).map(provider=>{const item=state.integrations.find(i=>i.provider===provider);return {provider,status:choice(item?.status,['not-connected','installed','trust-required','limited']),clientStatus:choice(item?.client?.status,['not-checked','found','missing','limited']),clientVersion:version(item?.client?.version)};}),
    sessions,
    diagnostics:state.diagnostics.slice(0,80).map(entry=>diagnosticEntry(entry.time,entry.code)),
  },null,2)+'\n';
}
export class DiagnosticReviews {
  private current:{id:string;content:string;expires:number}|undefined;
  create(content:string,now=Date.now()):DiagnosticsPreview {
    if(Buffer.byteLength(content,'utf8')>65536)throw new Error('Diagnostic report is too large.');
    const id=randomUUID();this.current={id,content,expires:now+300000};return {id,content};
  }
  read(id:unknown,now=Date.now()):string {
    if(!this.current||typeof id!=='string'||id!==this.current.id||now>=this.current.expires)throw new Error('Review a fresh diagnostic report before saving.');
    return this.current.content;
  }
  complete(id:string){if(this.current?.id===id)this.current=undefined;}
}
