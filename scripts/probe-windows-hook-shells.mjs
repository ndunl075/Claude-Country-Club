// Read-only adapter-command probe. Does not enroll hooks or invoke a provider.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
assert.equal(process.platform, 'win32');
const artifacts = path.resolve('work/windows-hook-shells'); await mkdir(artifacts, { recursive: true });
const fixture = await mkdtemp(path.join(artifacts, 'fixture-'));
const bundle = path.join(fixture, 'adapters.mjs');
await build({ entryPoints: ['packages/adapters/index.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm' });
const { IntegrationManager } = await import(pathToFileURL(bundle));
const helperPath = path.resolve('release/win-unpacked/resources/ccc-hook.exe');
const dataDir = path.join(fixture, 'data');
const manager = new IntegrationManager({ homeDir: path.join(fixture, 'home'), dataDir, helperPath, platform: 'win32' });
const preview = await manager.preview('claude');
const hook = JSON.parse(preview.after).hooks.UserPromptSubmit[0].hooks[0];
const command = hook.command;
const run = (file, args) => {
  const r = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 5000, input: JSON.stringify({ session_id: 'fixture' }), maxBuffer: 16384 });
  return { exitCode: r.status, timedOut: r.error?.code === 'ETIMEDOUT', stdoutBytes: Buffer.byteLength(r.stdout ?? ''), stderrBytes: Buffer.byteLength(r.stderr ?? '') };
};
// Deliberately missing private fixture config makes a successfully launched
// passive helper exit silently with zero; no broker or client is needed here.
const directControl = run(helperPath, ['--provider', 'claude', '--event', 'start', '--config', path.join(dataDir, 'connection.json')]);
assert.deepEqual(directControl, { exitCode: 0, timedOut: false, stdoutBytes: 0, stderrBytes: 0 });
const generatedInvocation = hook.args ? run(command, hook.args) : run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
if (hook.args) assert.deepEqual(hook.args, ['--provider','claude','--event','start','--config',path.join(dataDir,'connection.json')]);
const invocationControl = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& '${helperPath.replaceAll("'", "''")}' --provider claude --event start --config '${path.join(dataDir, 'connection.json').replaceAll("'", "''")}'; exit $LASTEXITCODE`]);
assert.deepEqual(invocationControl, directControl);
const result = { passed: generatedInvocation.exitCode === 0 && generatedInvocation.stderrBytes === 0, dispatch: hook.args ? 'exec-without-shell' : 'powershell-fallback', commandSha256: createHash('sha256').update(JSON.stringify(hook)).digest('hex'), directControl, invocationControl, generatedInvocation, scope: 'Exact source-adapter Claude invocation with missing fixture config. Exec form bypasses shell selection. This tests executable launch, not provider schema acceptance; packaged lifecycle acceptance tests actual reviewed arguments and event delivery.' };
await writeFile(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (!result.passed) process.exitCode = 1;
