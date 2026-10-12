import { expect,test } from 'vitest';
import { diagnosticReport,DiagnosticReviews } from '../apps/desktop/src/main/diagnosticExport';
import { DEFAULT_SETTINGS,HostState } from '../packages/contracts';
function state():HostState{return {settings:DEFAULT_SETTINGS,sessions:[],integrations:[],selectedSession:null,practice:false,suspended:true,brokerReady:true,diagnostics:[],version:'0.1.0',platform:'win32'};}
test('allowlisted report excludes private messages, paths, identities, tokens, notes and unknown fields',()=>{
  const s=state(),secret='PRIVATE-DO-NOT-EXPORT';
  s.selectedSession=secret;s.settings={...DEFAULT_SETTINGS,selectedSession:secret};
  s.sessions=[{key:secret,provider:'codex',state:'working',turnId:secret,generation:1,updatedAt:0,reliable:true}];
  s.integrations=[{provider:'codex',configPath:secret,exists:true,status:'trust-required',note:secret,client:{status:'found',version:'1.2.3+'+secret,executable:secret,note:secret}}];
  s.diagnostics=[{time:'2026-10-11T00:00:00Z',code:'STORAGE_RECOVERED',message:secret},{time:secret,code:secret,message:secret}];
  const text=diagnosticReport({...s,token:secret} as HostState,'x64',new Date('2026-10-11T00:00:00Z'));
  expect(text).not.toContain(secret);const report=JSON.parse(text);
  expect(report.sessions.working).toBe(1);expect(report.integrations[1].clientVersion).toBe('1.2.3');
  expect(report.diagnostics).toEqual([{time:'2026-10-11T00:00:00.000Z',code:'STORAGE_RECOVERED'},{time:null,code:'OTHER'}]);
});
test('bounds retained diagnostics and normalizes untrusted version/platform fields',()=>{
  const s=state();s.version='private/path';s.platform='private/path';s.diagnostics=Array.from({length:1000},()=>({time:'bad',code:'OTHER',message:'private'}));
  const report=JSON.parse(diagnosticReport(s,'private'));
  expect(report.application).toEqual({version:'unknown',platform:'unknown',arch:'unknown'});expect(report.diagnostics).toHaveLength(80);
});
test('review binds exact snapshot, expires and rejects stale/forged/reused references',()=>{
  const r=new DiagnosticReviews(),a=r.create('original',100);
  expect(r.read(a.id,101)).toBe('original');expect(()=>r.read(a.id,300100)).toThrow('fresh');
  const b=r.create('new snapshot',300101);expect(()=>r.read(a.id,300102)).toThrow('fresh');
  for(const id of [null,{},'forged'])expect(()=>r.read(id,300102)).toThrow('fresh');
  expect(r.read(b.id,300102)).toBe('new snapshot');r.complete(b.id);expect(()=>r.read(b.id,300103)).toThrow('fresh');
});
test('review limit counts UTF-8 bytes and preserves existing review after oversized request',()=>{
  const r=new DiagnosticReviews(),a=r.create('original',0);expect(()=>r.create('é'.repeat(32769),1)).toThrow('too large');expect(r.read(a.id,2)).toBe('original');
});
