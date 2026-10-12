// Packaged Windows console-free helper acceptance, with an isolated console baseline.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
assert.equal(process.platform, 'win32');
const artifacts = path.resolve('work/consoleless-helper'); await mkdir(artifacts, { recursive: true });
const fixture = await mkdtemp(path.join(artifacts, 'fixture-'));
const executable = process.env.CCC_EXECUTABLE ?? path.resolve('release/win-unpacked/Claude Country Club.exe');
const packagedHelper = path.join(path.dirname(executable), 'resources/ccc-hook.exe');
const gitBash = [process.env.CCC_GIT_BASH, path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git/bin/bash.exe')].find(file => file && existsSync(file));
const invocations = ['direct', 'cmd', 'powershell', ...(gitBash ? ['git-bash'] : [])];
// Build only the old console baseline; test the actual package as delivered.
const baseline = path.join(fixture, 'console-baseline.exe');
execFileSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', baseline, '.'], {
  cwd: path.resolve('native/ccc-hook'), windowsHide: true, timeout: 60000,
  env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0', GOCACHE: path.resolve('work/go-cache'), GOMODCACHE: path.resolve('work/go-modcache') }
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
async function waitFor(fn, timeout = 5000) { const end = Date.now() + timeout; while (!fn()) { if (Date.now() > end) throw Error('Owned helper timed out'); await pause(20); } }
function launch(file, args, options = {}) {
  const child = spawn(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  child.output = ''; child.errors = ''; child.failure = null;
  child.stdout.on('data', b => child.output += b); child.stderr.on('data', b => child.errors += b);
  child.on('error', e => child.failure = e);
  return child;
}
async function exited(child) { await waitFor(() => child.exitCode !== null || child.failure, 3000); if (child.failure) throw child.failure; assert.equal(child.exitCode, 0); }
async function run(file, expectedSubsystem) {
  const bytes = await readFile(file), pe = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.toString('ascii', pe, pe + 4), 'PE\0\0');
  assert.equal(bytes.readUInt16LE(pe + 24 + 68), expectedSubsystem);
  const probe = launch(file, ['--build-info']);
  try { probe.stdin.end(); await exited(probe); assert.equal(probe.errors, ''); assert.equal(JSON.parse(probe.output).kind, 'ccc-hook'); }
  finally { if (probe.exitCode === null) probe.kill(); }
  const commandDirectory = path.join(fixture, `Command path café Ω ${expectedSubsystem}`); await mkdir(commandDirectory);
  const hookFile = path.join(commandDirectory, 'ccc-hook.exe'); await copyFile(file, hookFile);
  const config = path.join(commandDirectory, 'connection file.json');
  await writeFile(config, JSON.stringify({ pipe: `\\\\.\\pipe\\country-club-consoleless-${randomUUID()}`, token: randomBytes(32).toString('hex'), identityKey: randomBytes(32).toString('hex') }), { mode: 0o600 });
  const server = launch(file, ['--serve', '--config', config]);
  try {
    await waitFor(() => server.failure || server.exitCode !== null || server.output.includes('"ready":true'));
    if (server.failure) throw server.failure;
    assert.equal(server.exitCode, null, 'Owned broker exited before readiness');
    const expectedEvents = [];
    for (const invocation of invocations) for (const [provider, kind] of [['claude', 'start'], ['codex', 'attention']]) {
      const args = ['--provider', provider, '--event', kind, '--config', config];
      const hook = invocation === 'direct' ? launch(hookFile, args)
        : invocation === 'cmd' ? launch('cmd.exe', ['/d', '/s', '/c', `""${hookFile}" --provider ${provider} --event ${kind} --config "${config}""`], { windowsVerbatimArguments: true })
        : invocation === 'git-bash' ? launch(gitBash, ['--noprofile', '--norc', '-c', `"${hookFile}" --provider ${provider} --event ${kind} --config "${config}"`])
        : launch('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& '${hookFile.replaceAll("'", "''")}' --provider ${provider} --event ${kind} --config '${config.replaceAll("'", "''")}'; exit $LASTEXITCODE`]);
      try {
        hook.stdin.end(JSON.stringify({ session_id: 'consoleless-fixture', cwd: fixture, turn_id: 'test-turn', prompt: 'PRIVATE-PROMPT', transcript_path: 'PRIVATE-TRANSCRIPT' }));
        await exited(hook); assert.equal(hook.output + hook.errors, '');
        expectedEvents.push([provider, kind]);
        await waitFor(() => server.output.trim().split(/\r?\n/).filter(line => line.includes('"event":')).length === expectedEvents.length);
      } finally { if (hook.exitCode === null) hook.kill(); }
    }
    const events = server.output.trim().split(/\r?\n/).map(line => JSON.parse(line)).filter(r => r.event).map(r => r.event);
    assert.deepEqual(events.map(e => [e.provider, e.kind]), expectedEvents);
    assert(!server.output.includes('PRIVATE')); assert.equal(server.errors, '');
    const script = `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${server.pid}" | Select-Object @{n='pid';e={[int]$_.ProcessId}},Name) | ConvertTo-Json -Compress`;
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    const children = output.trim() ? JSON.parse(output) : []; const list = Array.isArray(children) ? children : [children];
    if (expectedSubsystem === 2) assert.equal(list.length, 0, 'Console-free broker unexpectedly has descendants');
    else assert(list.some(p => p.Name === 'conhost.exe'), 'Console baseline did not establish an owned console host');
    checks.push({ subsystem: expectedSubsystem, sha256: createHash('sha256').update(bytes).digest('hex'), invocations, unicodeCommandPaths: true, metadataPiped: true, passiveOutputEmpty: true, privatePayloadExcluded: true, lifecycleEvents: events.map(e => [e.provider, e.kind]), children: list });
    server.stdin.end(); await exited(server);
  } finally { if (server.exitCode === null) { server.stdin.end(); await pause(300); if (server.exitCode === null) server.kill(); } }
}
try {
  await run(baseline, 3);
  await run(packagedHelper, 2);
  await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ passed: true, packaged: true, checks, limitations: ['Owned fixture named pipes and command shells; no live provider enrolled.', 'No subscription, real provider hook delivery, physical console-flash observation or native macOS behavior certified.'] }, null, 2));
  console.log('Console-free helper preserves piped metadata, passive lifecycle delivery, and stdin shutdown; no console-host child.');
} catch (error) { await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ passed: false, error: String(error), checks }, null, 2)); throw error; }
