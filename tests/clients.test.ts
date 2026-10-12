import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectClient } from '../apps/desktop/src/main/clients';
const directories: string[] = [];
afterEach(async()=>{for(const directory of directories.splice(0))await rm(directory,{recursive:true,force:true});});
async function fixture(){const home=await mkdtemp(path.join(os.tmpdir(),'ccc-client-'));directories.push(home);const bin=path.join(home,'.local','bin');await mkdir(bin,{recursive:true});return {home,bin,directory:path.join(home,'data'),platform:'win32' as const};}
describe('explicit bounded client version inspection',()=>{
  it('reports missing clients without running a process or reading provider config',async()=>{const f=await fixture();let ran=false;const result=await inspectClient('codex',{...f,env:{PATH:''},run:async()=>{ran=true;return '';}});expect(result.status).toBe('missing');expect(ran).toBe(false);});
  it('retains only version metadata and isolates configuration and secrets',async()=>{const f=await fixture();const exe=path.join(f.bin,'codex.exe');await writeFile(exe,'fixture');const result=await inspectClient('codex',{...f,env:{PATH:'',OPENAI_API_KEY:'must-not-reach-process',ANTHROPIC_API_KEY:'must-not-reach-process'},run:async(file,cwd,env)=>{expect(file).toBe(exe);expect(cwd.startsWith(f.directory)).toBe(true);expect(env.OPENAI_API_KEY).toBeUndefined();expect(env.ANTHROPIC_API_KEY).toBeUndefined();expect(env.USERPROFILE).not.toBe(f.home);return 'codex-cli 0.142.5\nSECRET ARBITRARY OUTPUT';}});expect(result).toMatchObject({status:'found',version:'0.142.5'});expect(JSON.stringify(result)).not.toContain('SECRET');});
  it('never executes Windows shell wrappers or an unrelated chosen program',async()=>{const f=await fixture();for(const name of ['codex.cmd','powershell.exe']){const executable=path.join(f.bin,name);await writeFile(executable,'fixture');const result=await inspectClient('codex',{...f,executable,run:async()=>{throw new Error('Must not run');}});expect(result.status).toBe('limited');expect(result.executable).toBeUndefined();}});
  it('discovers native Codex in bounded npm layouts without executing wrappers',async()=>{
    for(const layout of ['nested','hoisted','legacy']){
      const f=await fixture();const prefix=path.join(f.home,'npm');await mkdir(prefix,{recursive:true});
      await writeFile(path.join(prefix,'codex.ps1'),'throw "wrapper must not run"');
      const packageRoot=path.join(prefix,'node_modules','@openai','codex');
      const vendor=layout==='nested'?path.join(packageRoot,'node_modules','@openai','codex-win32-x64','vendor'):layout==='hoisted'?path.join(prefix,'node_modules','@openai','codex-win32-x64','vendor'):path.join(packageRoot,'vendor');
      const exe=path.join(vendor,'x86_64-pc-windows-msvc','bin','codex.exe');await mkdir(path.dirname(exe),{recursive:true});await writeFile(exe,'fixture native');
      let calls=0;const result=await inspectClient('codex',{...f,arch:'x64',env:{PATH:prefix,OPENAI_API_KEY:'secret'},run:async(file,cwd,env)=>{calls++;expect(file).toBe(exe);expect(env.OPENAI_API_KEY).toBeUndefined();expect(cwd.startsWith(f.directory)).toBe(true);return 'codex-cli 0.162.0-alpha.17.2';}});
      expect(result).toMatchObject({status:'found',version:'0.162.0-alpha.17.2',executable:exe});expect(calls).toBe(1);
    }
  });
  it('prefers a direct native executable and never substitutes an explicit wrapper choice',async()=>{
    const f=await fixture();const direct=path.join(f.bin,'codex.exe');await writeFile(direct,'fixture');
    const run=async(file:string)=>{expect(file).toBe(direct);return 'codex-cli 1.0.0';};
    expect((await inspectClient('codex',{...f,env:{PATH:f.bin},run})).executable).toBe(direct);
    expect((await inspectClient('codex',{...f,executable:path.join(f.bin,'codex.ps1'),run})).status).toBe('limited');
  });
  it('uses only the matching Windows npm architecture',async()=>{
    const f=await fixture();const prefix=path.join(f.home,'npm');
    const exe=path.join(prefix,'node_modules','@openai','codex-win32-arm64','vendor','aarch64-pc-windows-msvc','bin','codex.exe');await mkdir(path.dirname(exe),{recursive:true});await writeFile(exe,'fixture');
    let calls=0;const run=async(file:string)=>{calls++;expect(file).toBe(exe);return 'codex-cli 1.0.0';};
    expect((await inspectClient('codex',{...f,arch:'x64',env:{PATH:prefix},run})).status).toBe('missing');
    expect((await inspectClient('codex',{...f,arch:'arm64',env:{PATH:prefix},run})).status).toBe('found');expect(calls).toBe(1);
  });
  it('reports failed or unrecognized version checks without raw output',async()=>{const f=await fixture();await writeFile(path.join(f.bin,'claude.exe'),'fixture');for(const run of [async()=>{throw new Error('SECRET process error');},async()=> 'SECRET unknown output']){const result=await inspectClient('claude',{...f,run});expect(result.status).toBe('limited');expect(JSON.stringify(result)).not.toContain('SECRET');}});
});
