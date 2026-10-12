import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IntegrationInfo, IntegrationPreview, Provider } from '../contracts/index';

type Group = { matcher?: string; hooks: { type: 'command'; command: string; args?: string[]; timeout: number }[] };
type Owned = { event: string; group: Group };
type Patch = { configPath: string; entries: Owned[]; backupPath: string; installedAt: string };
type Ledger = Partial<Record<Provider, Patch>>;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const format = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const validArgs = (args: unknown) => args === undefined || (Array.isArray(args) && args.length <= 32 && args.every(arg => typeof arg === 'string' && arg.length <= 32768 && !/[\r\n\0]/.test(arg)));
function hasOwnedCommand(value: unknown, entries: Owned[]): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(item => hasOwnedCommand(item, entries));
  const obj = value as Record<string, unknown>;
  const references = [obj.command,...(Array.isArray(obj.args)?obj.args:[])];
  if (references.some(command => typeof command === 'string' && entries.some(entry => entry.group.hooks.some(hook => command.includes(hook.command.split(' --provider ')[0]!))))) return true;
  return Object.values(obj).some(item => hasOwnedCommand(item, entries));
}
function providerCheck(provider: Provider) { if (provider !== 'claude' && provider !== 'codex') throw new Error('Unsupported provider'); }
async function noSymlink(file: string) {
  let current = path.resolve(file);
  while (true) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Symbolic links are not supported for integration files'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
async function readBounded(file: string): Promise<string> {
  await noSymlink(file);
  try { const info = await fs.stat(file); if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Configuration is too large or is not a regular file'); return await fs.readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
function parse(text: string): Record<string, unknown> {
  const result: unknown = text ? JSON.parse(text) : {};
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Configuration must be a JSON object');
  const obj = result as Record<string, unknown>;
  if (obj.hooks !== undefined && (!obj.hooks || typeof obj.hooks !== 'object' || Array.isArray(obj.hooks))) throw new Error('Invalid hooks configuration');
  if (obj.disableAllHooks === true) throw new Error('Hooks are disabled in this configuration');
  return obj;
}
async function atomicWrite(file: string, text: string, expected?: string) {
  await noSymlink(file); await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    const existing = await fs.stat(file).catch(() => null);
    await fs.writeFile(temp, text, { flag: 'wx', mode: existing?.mode ?? 0o600 });
    if (expected !== undefined && digest(await readBounded(file)) !== expected) throw new Error('Configuration changed. Review a fresh preview.');
    await fs.rename(temp, file);
  } finally { await fs.unlink(temp).catch(() => undefined); }
}
export class IntegrationManager {
  private readonly dataDir: string; private readonly helperPath: string; private readonly homeDir: string; private readonly platform: NodeJS.Platform;
  constructor(options: { dataDir: string; helperPath: string; homeDir?: string; platform?: NodeJS.Platform }) {
    this.dataDir = path.resolve(options.dataDir); this.helperPath = path.resolve(options.helperPath); this.homeDir = options.homeDir ?? os.homedir(); this.platform = options.platform ?? process.platform;
  }
  private configPath(provider: Provider) { providerCheck(provider); return path.join(this.homeDir, provider === 'claude' ? '.claude' : '.codex', provider === 'claude' ? 'settings.json' : 'hooks.json'); }
  private get ledgerPath() { return path.join(this.dataDir, 'config-patches.json'); }
  private async ledger(): Promise<Ledger> {
    const text = await readBounded(this.ledgerPath); const value: unknown = text ? JSON.parse(text) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid integration ownership ledger');
    for (const [provider, item] of Object.entries(value)) {
      providerCheck(provider as Provider);
      if (!item || typeof item !== 'object') throw new Error('Invalid integration ownership ledger');
      const patch = item as Patch;
      if (patch.configPath !== this.configPath(provider as Provider) || typeof patch.backupPath !== 'string' || typeof patch.installedAt !== 'string' || !Array.isArray(patch.entries) || patch.entries.length > 128 || patch.entries.some(entry => !entry || typeof entry.event !== 'string' || !entry.group || typeof entry.group !== 'object' || !Array.isArray(entry.group.hooks) || entry.group.hooks.some(hook => !hook || hook.type !== 'command' || typeof hook.command !== 'string' || !validArgs(hook.args) || typeof hook.timeout !== 'number'))) throw new Error('Invalid integration ownership ledger');
    }
    return value as Ledger;
  }
  private quote(value: string) {
    if (/[\r\n\0]/.test(value)) throw new Error('Unsafe helper path');
    if (this.platform === 'win32') { if (/["%!&|<>^]/.test(value)) throw new Error('This Windows path contains unsupported shell characters. Choose a different installation directory.'); return '"' + value + '"'; }
    return "'" + value.replaceAll("'", "'\\''") + "'";
  }
  private entries(provider: Provider): Owned[] {
    const mappings: [string, string, string?][] = [['UserPromptSubmit', 'start'], ['PreToolUse', 'activity'], ['PermissionRequest', 'attention'], ['Stop', 'stop'], ['SessionEnd', 'session-ended']];
    if (provider === 'codex') mappings.push(['Interrupt', 'interrupted']);
    else mappings.push(['Notification', 'attention', 'permission_prompt'], ['Elicitation', 'attention'], ['StopFailure', 'failed']);
    const config = path.join(this.dataDir, 'connection.json');
    // Preserve current path validation and legacy ledger support. Claude's
    // documented exec form bypasses both Git Bash and PowerShell tokenization.
    const quotedHelper = this.quote(this.helperPath), quotedConfig = this.quote(config);
    return mappings.map(([event, kind, matcher]) => ({ event, group: { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command',
      ...(provider === 'claude' && this.platform === 'win32'
        ? { command: this.helperPath, args: ['--provider', provider, '--event', kind, '--config', config] }
        : { command: `${quotedHelper} --provider ${provider} --event ${kind} --config ${quotedConfig}` }),
      timeout: 1 }] } }));
  }
  async list(): Promise<IntegrationInfo[]> {
    let ledger: Ledger = {}; let ledgerUnsafe = false;
    try { ledger = await this.ledger(); } catch { ledgerUnsafe = true; }
    return await Promise.all((['claude', 'codex'] as Provider[]).map(async provider => {
      const configPath = this.configPath(provider); let exists = false;
      try {
        exists = await fs.lstat(configPath).then(() => true, () => false);
        await noSymlink(configPath);
        if (ledgerUnsafe) return { provider, configPath, exists, status: 'limited', note: 'Integration ownership cannot be read safely. Existing files were preserved. Practice remains available; repair ownership before changing hooks.' };
        if (exists) { const info = await fs.stat(configPath); if (!info.isFile() || !(info.mode & 0o200)) throw new Error('Configuration unavailable or read-only'); await fs.access(configPath, constants.W_OK); }
        if (!ledger[provider]) return { provider, configPath, exists, status: exists ? 'limited' : 'not-connected', note: 'Local CLI hooks only. Choose Review connection to inspect configuration. Desktop, IDE, remote and cloud surfaces are unverified.' };
        const text = await readBounded(configPath); const obj = parse(text);
        const hooks = obj.hooks as Record<string, unknown> | undefined;
        const installed = Boolean(ledger[provider]?.entries.length && ledger[provider]?.entries.every(({ event, group }) => Array.isArray(hooks?.[event]) && (hooks![event] as unknown[]).some(v => JSON.stringify(v) === JSON.stringify(group))));
        return { provider, configPath, exists, status: installed ? 'trust-required' : exists ? 'limited' : 'not-connected', note: installed ? 'Hooks are present. Complete the client trust review; a real lifecycle event is still required to verify connection.' : 'Local CLI hooks only. Review configuration to connect. Desktop, IDE, remote and cloud surfaces are unverified.' };
      } catch {
        return { provider, configPath, exists, status: 'limited', note: 'Configuration is malformed, disabled, read-only, linked, or inaccessible. Existing files were preserved. Practice remains available.' };
      }
    }));
  }
  private async prepare(provider: Provider) {
    const configPath = this.configPath(provider); const before = await readBounded(configPath); const obj = parse(before); const ledger = await this.ledger();
    const hooks = (obj.hooks ??= {}) as Record<string, unknown>;
    const entries=this.entries(provider);
    const shownBefore:Record<string,unknown[]>={},shownAfter:Record<string,unknown[]>={};
    for (const { event, group } of entries) {
      const current = hooks[event] ?? []; if (!Array.isArray(current)) throw new Error(`Invalid ${event} hook list`);
      const old = ledger[provider]?.entries.filter(e => e.event === event) ?? [];
      const reviewed=[...old.map(entry=>entry.group),group];
      shownBefore[event]=current.filter(value=>reviewed.some(owned=>JSON.stringify(value)===JSON.stringify(owned)));
      const retained = current.filter(v => !old.some(entry => JSON.stringify(v) === JSON.stringify(entry.group)));
      hooks[event] = retained.some(v => JSON.stringify(v) === JSON.stringify(group)) ? retained : [...retained, group];
      shownAfter[event]=(hooks[event] as unknown[]).filter(value=>JSON.stringify(value)===JSON.stringify(group));
    }
    const preview:IntegrationPreview={ provider, configPath, beforeHash: digest(before), before:format({hooks:shownBefore}), after:format({hooks:shownAfter}), note: 'Only local lifecycle metadata is observed. The helper exits silently within 250 ms. Client trust review and a real-turn test are required. Claude interruption and arbitrary questions may lack attention events; automatic detection is limited.' };
    return {preview,before,after:format(obj),ledger,entries};
  }
  async preview(provider: Provider): Promise<IntegrationPreview> {
    // Only app-owned hook projections leave the main process. Full configuration
    // remains here for lossless merging, hashing and the private rollback copy.
    return (await this.prepare(provider)).preview;
  }
  async apply(preview: IntegrationPreview): Promise<void> {
    providerCheck(preview.provider);
    const prepared=await this.prepare(preview.provider);const fresh=prepared.preview;
    if (preview.configPath !== fresh.configPath || preview.beforeHash !== fresh.beforeHash || preview.before !== fresh.before || preview.after !== fresh.after) throw new Error('Configuration changed or preview is invalid. Review a fresh preview.');
    const ledger = prepared.ledger; await noSymlink(this.ledgerPath);
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const backupPath = path.join(this.dataDir, `${preview.provider}-${randomUUID()}.backup.json`);
    await fs.writeFile(backupPath, prepared.before || '{}\n', { flag: 'wx', mode: 0o600 });
    const patch: Patch = { configPath: fresh.configPath, entries: prepared.entries, backupPath, installedAt: new Date().toISOString() };
    // Write recovery ownership before provider mutation. A failed write leaves a removable intent ledger.
    const prior = ledger[preview.provider]?.entries ?? [];
    const ownership = [...prior, ...patch.entries].filter((entry, index, all) => all.findIndex(other => JSON.stringify(other) === JSON.stringify(entry)) === index);
    ledger[preview.provider] = { ...patch, entries: ownership }; await atomicWrite(this.ledgerPath, format(ledger));
    await atomicWrite(fresh.configPath, prepared.after, fresh.beforeHash);
    ledger[preview.provider] = patch; await atomicWrite(this.ledgerPath, format(ledger));
  }
  async remove(provider: Provider): Promise<void> {
    providerCheck(provider); const ledger = await this.ledger(); const patch = ledger[provider]; if (!patch) return;
    const file = this.configPath(provider); if (patch.configPath !== file) throw new Error('Integration ownership path mismatch');
    const before = await readBounded(file); const obj = parse(before); const hooks = obj.hooks as Record<string, unknown> | undefined;
    if (hooks) for (const { event, group } of patch.entries) {
      if (!Array.isArray(hooks[event])) continue;
      const remaining = (hooks[event] as unknown[]).filter(v => JSON.stringify(v) !== JSON.stringify(group));
      if (remaining.length) hooks[event] = remaining; else delete hooks[event];
    }
    if (hasOwnedCommand(hooks, patch.entries)) throw new Error('Modified Country Club hooks still reference the helper. Restore or remove those references before removal. Configuration and ownership were preserved.');
    if (before) await atomicWrite(file, format(obj), digest(before));
    delete ledger[provider]; await atomicWrite(this.ledgerPath, format(ledger));
  }
}
