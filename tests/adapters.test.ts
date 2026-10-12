import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { IntegrationManager } from '../packages/adapters';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function fixture(platform: NodeJS.Platform = process.platform) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ccc-adapter-'))); dirs.push(dir);
  const homeDir = path.join(dir, 'home'); const dataDir = path.join(dir, 'data');
  const manager = new IntegrationManager({ homeDir, dataDir, helperPath: path.join(dir, 'app with space', 'ccc-hook.exe'), platform });
  return { manager, homeDir, dataDir };
}
describe('explicit user-reviewed integration patches', () => {
  it('upgrades legacy Windows Claude shell hooks only after review and preserves edited exec arguments', async () => {
    const {manager,homeDir,dataDir}=await fixture('win32');await manager.apply(await manager.preview('claude'));
    const file=path.join(homeDir,'.claude','settings.json'),ledgerFile=path.join(dataDir,'config-patches.json');
    const config=JSON.parse(await fs.readFile(file,'utf8')),ledger=JSON.parse(await fs.readFile(ledgerFile,'utf8'));
    for(const entry of ledger.claude.entries){const hook=entry.group.hooks[0];
      expect(hook.args).toEqual(['--provider','claude','--event',expect.any(String),'--config',path.join(dataDir,'connection.json')]);
      const old={hooks:[{type:'command',command:`"${hook.command}" --provider claude --event ${hook.args[3]} --config "${hook.args[5]}"`,timeout:1}]};
      config.hooks[entry.event]=[old];entry.group=old;
    }
    const foreign={hooks:[{type:'command',command:'echo foreign'}]};config.hooks.Stop.push(foreign);
    const bytes=JSON.stringify(config);await fs.writeFile(file,bytes);await fs.writeFile(ledgerFile,JSON.stringify(ledger));
    await manager.list();const preview=await manager.preview('claude');expect(await fs.readFile(file,'utf8')).toBe(bytes);
    expect(JSON.parse(preview.before).hooks.Stop[0].hooks[0].args).toBeUndefined();
    await manager.apply(preview);await manager.apply(await manager.preview('claude'));
    const upgraded=JSON.parse(await fs.readFile(file,'utf8'));expect(upgraded.hooks.Stop).toHaveLength(2);expect(upgraded.hooks.Stop[0]).toEqual(foreign);
    const owned=upgraded.hooks.Stop[1];expect(owned.hooks[0].args[3]).toBe('stop');
    owned.hooks[0].args.push('user-edit');const edited=JSON.stringify(upgraded);await fs.writeFile(file,edited);
    await expect(manager.remove('claude')).rejects.toThrow('Modified Country Club hooks');expect(await fs.readFile(file,'utf8')).toBe(edited);
    owned.hooks[0].args.pop();const originalCommand=owned.hooks[0].command;
    owned.hooks[0].command='wrapper.exe';owned.hooks[0].args.unshift(originalCommand);const wrapped=JSON.stringify(upgraded);await fs.writeFile(file,wrapped);
    await expect(manager.remove('claude')).rejects.toThrow('Modified Country Club hooks');expect(await fs.readFile(file,'utf8')).toBe(wrapped);
    owned.hooks[0].command=originalCommand;owned.hooks[0].args.shift();await fs.writeFile(file,JSON.stringify(upgraded));await manager.remove('claude');
    expect(JSON.parse(await fs.readFile(file,'utf8')).hooks).toEqual({Stop:[foreign]});
  });
  it('reviews passive Claude error/input hooks and preserves third-party handlers through removal', async () => {
    const {manager,homeDir}=await fixture();const file=path.join(homeDir,'.claude','settings.json');
    await fs.mkdir(path.dirname(file),{recursive:true});
    const foreign={hooks:[{type:'command',command:'echo PRIVATE-FOREIGN'}]};
    await fs.writeFile(file,JSON.stringify({hooks:{StopFailure:[foreign],Elicitation:[foreign]}}));
    const preview=await manager.preview('claude');expect(preview.after).not.toContain('PRIVATE-FOREIGN');
    const added=JSON.parse(preview.after).hooks;
    expect(added.StopFailure[0].hooks[0]).toMatchObject({type:'command',timeout:1});
    expect([added.StopFailure[0].hooks[0].command,...(added.StopFailure[0].hooks[0].args??[])].join(' ')).toContain('--event failed');
    expect([added.Elicitation[0].hooks[0].command,...(added.Elicitation[0].hooks[0].args??[])].join(' ')).toContain('--event attention');
    expect(added.ElicitationResult).toBeUndefined();
    await manager.apply(preview);const installed=JSON.parse(await fs.readFile(file,'utf8'));
    for(const event of ['StopFailure','Elicitation']){expect(installed.hooks[event]).toHaveLength(2);expect(installed.hooks[event][0]).toEqual(foreign);}
    await manager.remove('claude');const removed=JSON.parse(await fs.readFile(file,'utf8'));
    expect(removed.hooks).toEqual({StopFailure:[foreign],Elicitation:[foreign]});
    const codex=JSON.parse((await manager.preview('codex')).after).hooks;
    expect(codex.StopFailure).toBeUndefined();expect(codex.Elicitation).toBeUndefined();
  });
  it('leaves a legacy connection unchanged until a fresh reviewed upgrade and adds new mappings exactly once', async () => {
    const {manager,homeDir,dataDir}=await fixture();await manager.apply(await manager.preview('claude'));
    const file=path.join(homeDir,'.claude','settings.json'),ledgerFile=path.join(dataDir,'config-patches.json');
    const legacy=JSON.parse(await fs.readFile(file,'utf8')),ledger=JSON.parse(await fs.readFile(ledgerFile,'utf8'));
    delete legacy.hooks.StopFailure;delete legacy.hooks.Elicitation;
    ledger.claude.entries=ledger.claude.entries.filter((entry:{event:string})=>!['StopFailure','Elicitation'].includes(entry.event));
    const bytes=JSON.stringify(legacy);await fs.writeFile(file,bytes);await fs.writeFile(ledgerFile,JSON.stringify(ledger));
    await manager.list();expect(await fs.readFile(file,'utf8')).toBe(bytes);
    const preview=await manager.preview('claude');expect(await fs.readFile(file,'utf8')).toBe(bytes);
    expect(JSON.parse(preview.before).hooks.StopFailure).toEqual([]);
    await manager.apply(preview);await manager.apply(await manager.preview('claude'));
    const upgraded=JSON.parse(await fs.readFile(file,'utf8'));
    expect(upgraded.hooks.StopFailure).toHaveLength(1);expect(upgraded.hooks.Elicitation).toHaveLength(1);
    await manager.remove('claude');expect(JSON.parse(await fs.readFile(file,'utf8')).hooks).toEqual({});
  });
  it('keeps unrelated secrets and third-party commands out of IPC previews while merging losslessly',async()=>{
    const {manager,homeDir,dataDir}=await fixture();const file=path.join(homeDir,'.claude','settings.json');
    await fs.mkdir(path.dirname(file),{recursive:true});
    const original={env:{API_KEY:'private-env-fixture'},theme:'private-theme-fixture',hooks:{Stop:[{hooks:[{type:'command',command:'echo private-command-fixture'}]}]}};
    const bytes=JSON.stringify(original);await fs.writeFile(file,bytes);
    const preview=await manager.preview('claude');
    for(const secret of ['private-env-fixture','private-theme-fixture','private-command-fixture'])expect(JSON.stringify(preview)).not.toContain(secret);
    expect(JSON.parse(preview.before).hooks.Stop).toEqual([]);expect(JSON.parse(preview.after).hooks.Stop).toHaveLength(1);
    await manager.apply(preview);
    const installed=JSON.parse(await fs.readFile(file,'utf8'));expect(installed.env).toEqual(original.env);expect(installed.theme).toBe(original.theme);expect(installed.hooks.Stop[0]).toEqual(original.hooks.Stop[0]);
    const ledger=JSON.parse(await fs.readFile(path.join(dataDir,'config-patches.json'),'utf8'));
    expect(await fs.readFile(ledger.claude.backupPath,'utf8')).toBe(bytes);
    const repeated=await manager.preview('claude');expect(repeated.before).toBe(repeated.after);
    await manager.remove('claude');expect(JSON.parse(await fs.readFile(file,'utf8'))).toEqual(original);
  });
  it('rejects changes to hidden unrelated fields after review',async()=>{
    const {manager,homeDir}=await fixture();const file=path.join(homeDir,'.codex','hooks.json');
    await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'{"privateSetting":"old"}');
    const preview=await manager.preview('codex');await fs.writeFile(file,'{"privateSetting":"new"}');
    await expect(manager.apply(preview)).rejects.toThrow('changed');expect(await fs.readFile(file,'utf8')).toBe('{"privateSetting":"new"}');
  });
  it('preserves unrelated hooks and settings across install and structural removal', async () => {
    const { manager, homeDir } = await fixture(); const file = path.join(homeDir, '.claude', 'settings.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const userHook = { hooks: [{ type: 'command', command: 'echo own-hook' }] };
    await fs.writeFile(file, JSON.stringify({ theme: 'dark', hooks: { Stop: [userHook] } }));
    await manager.apply(await manager.preview('claude'));
    const installed = JSON.parse(await fs.readFile(file, 'utf8')); installed.hooks.Stop.push({ hooks: [{ type: 'command', command: 'echo added-later' }] });
    await fs.writeFile(file, JSON.stringify(installed)); await manager.remove('claude');
    const removed = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(removed.theme).toBe('dark'); expect(removed.hooks.Stop).toHaveLength(2); expect(removed.hooks.Stop[0]).toEqual(userHook);
    expect(removed.hooks.UserPromptSubmit).toBeUndefined();
  });
  it('rejects a stale or forged renderer preview without writing provider configuration', async () => {
    const { manager } = await fixture(); const p = await manager.preview('codex');
    await expect(manager.apply({ ...p, after: '{"evil":true}' })).rejects.toThrow('preview');
    await fs.mkdir(path.dirname(p.configPath), { recursive: true }); await fs.writeFile(p.configPath, '{}');
    await expect(manager.apply(p)).rejects.toThrow('changed'); expect(await fs.readFile(p.configPath, 'utf8')).toBe('{}');
  });
  it('is idempotent and leaves modified owned hook entries intact', async () => {
    const { manager } = await fixture(); await manager.apply(await manager.preview('codex')); await manager.apply(await manager.preview('codex'));
    const p = await manager.preview('codex'); const obj = JSON.parse(await fs.readFile(p.configPath,'utf8')); expect(obj.hooks.Stop).toHaveLength(1);
    obj.hooks.Stop[0].hooks[0].command += ' user-edit'; await fs.writeFile(p.configPath, JSON.stringify(obj));
    await expect(manager.remove('codex')).rejects.toThrow('Modified Country Club hooks'); expect(JSON.parse(await fs.readFile(p.configPath, 'utf8')).hooks.Stop[0].hooks[0].command).toContain('user-edit');
  });
  it('refuses malformed and hook-disabled configuration', async () => {
    const { manager } = await fixture(); const p = await manager.preview('claude'); await fs.mkdir(path.dirname(p.configPath), { recursive: true });
    await fs.writeFile(p.configPath, '{'); await expect(manager.preview('claude')).rejects.toThrow();
    await fs.writeFile(p.configPath, '{"disableAllHooks":true}'); await expect(manager.preview('claude')).rejects.toThrow('disabled');
  });
  it('blocks Windows expansion characters instead of executing unsafe paths', async () => {
    const { homeDir, dataDir } = await fixture(); const manager = new IntegrationManager({ homeDir, dataDir, platform: 'win32', helperPath: path.join(homeDir, '%PATH%', 'ccc-hook.exe') });
    await expect(manager.preview('claude')).rejects.toThrow('unsupported shell');
  });
  it('keeps practice startup available with malformed settings and ownership ledger', async () => {
    const { manager, homeDir, dataDir } = await fixture(); const config = path.join(homeDir, '.claude', 'settings.json');
    await fs.mkdir(path.dirname(config), { recursive: true }); await fs.writeFile(config, '{bad config');
    let infos = await manager.list(); expect(infos.find(info => info.provider === 'claude')?.status).toBe('limited');
    await fs.mkdir(dataDir, { recursive: true }); const ledger = path.join(dataDir, 'config-patches.json');
    for (const text of ['{bad ledger', 'null', '[]', '{"claude":{"entries":null}}']) {
      await fs.writeFile(ledger, text); infos = await manager.list(); expect(infos).toHaveLength(2); expect(infos.every(info => info.status === 'limited')).toBe(true); expect(await fs.readFile(ledger, 'utf8')).toBe(text);
    }
    expect(await fs.readFile(config, 'utf8')).toBe('{bad config');
  });
  it('reports a configuration directory or read-only file safely without mutating it', async () => {
    const { manager, homeDir } = await fixture(); const config = path.join(homeDir, '.claude', 'settings.json');
    await fs.mkdir(config, { recursive: true }); expect((await manager.list())[0].status).toBe('limited');
    await fs.rmdir(config); await fs.writeFile(config, '{}'); await fs.chmod(config, 0o400);
    try { expect((await manager.list())[0].status).toBe('limited'); expect(await fs.readFile(config, 'utf8')).toBe('{}'); } finally { await fs.chmod(config, 0o600); }
  });
  it('retains prior helper ownership when an upgrade fails before provider mutation', async () => {
    const { manager, homeDir, dataDir } = await fixture(); await manager.apply(await manager.preview('claude'));
    const upgraded = new IntegrationManager({ homeDir, dataDir, helperPath: path.join(dataDir, 'new-helper.exe') }); const preview = await upgraded.preview('claude');
    const rename = fs.rename.bind(fs); const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => { if (String(to) === preview.configPath) throw new Error('Simulated provider write failure'); return rename(from, to); });
    try { await expect(upgraded.apply(preview)).rejects.toThrow('Simulated'); } finally { spy.mockRestore(); }
    await upgraded.remove('claude'); expect(JSON.parse(await fs.readFile(preview.configPath, 'utf8')).hooks.Stop).toBeUndefined();
  });
  it('reports linked configuration safely while rejecting an integration patch', async () => {
    const { manager, homeDir, dataDir } = await fixture(); const target = path.join(dataDir, 'linked-provider');
    await fs.mkdir(target, { recursive: true }); await fs.mkdir(homeDir, { recursive: true }); await fs.writeFile(path.join(target, 'settings.json'), '{}');
    await fs.symlink(target, path.join(homeDir, '.claude'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await manager.list())[0].status).toBe('limited'); await expect(manager.preview('claude')).rejects.toThrow('Symbolic');
    expect(await fs.readFile(path.join(target, 'settings.json'), 'utf8')).toBe('{}');
  });
  it('does not read unenrolled provider configuration during startup', async () => {
    const { manager, homeDir } = await fixture(); const config = path.join(homeDir, '.claude', 'settings.json'); await fs.mkdir(path.dirname(config), { recursive: true }); await fs.writeFile(config, '{"privateSetting":"never-read-at-startup"}');
    const read = fs.readFile.bind(fs); const spy = vi.spyOn(fs, 'readFile').mockImplementation((...args: Parameters<typeof fs.readFile>) => { if (String(args[0]) === config) throw new Error('Provider configuration must not be read before review'); return read(...args); });
    try { const infos = await manager.list(); expect(infos[0].status).toBe('limited'); expect(infos[0].note).toContain('Review connection'); expect(spy.mock.calls.some(args => String(args[0]) === config)).toBe(false); } finally { spy.mockRestore(); }
  });
});
