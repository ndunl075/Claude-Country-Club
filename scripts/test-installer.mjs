// Explicit local acceptance harness. Installs only into work/installer-test/app.
import { spawn, execFileSync } from 'node:child_process';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
if (process.platform !== 'win32') throw new Error('Windows installer acceptance requires Windows.');
const root = process.cwd();
const artifacts = path.join(root, 'work', 'installer-test');
const destination = path.join(artifacts, 'app');
const release = path.join(root, 'release');
const { version } = JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const installerName = `Claude-Country-Club-Setup-${version}-x64.exe`;
assert((await readdir(release)).includes(installerName), 'Build the current Windows installer first.');
const installer = path.join(release, installerName);
const installerSha256 = createHash('sha256').update(await readFile(installer)).digest('hex');
const executable = path.join(destination, 'Claude Country Club.exe');
const exists = async p => access(p).then(() => true, () => false);
// Never overwrite another installed copy or touch its registered integrations.
function readRegistration() {
  const json = execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^Claude Country Club(?: [0-9].*)?$' } | Select-Object PSChildName,UninstallString,DisplayVersion | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true }).trim();
  if (!json) return null;
  const record = JSON.parse(json);
  assert(!Array.isArray(record), 'Ambiguous installation registration; use a disposable account.');
  const uninstallPath = /^"([^"]+)"/.exec(record.UninstallString ?? '')?.[1];
  assert(uninstallPath && path.isAbsolute(uninstallPath), 'Cannot safely identify installed application path.');
  return { ...record, InstallLocation: path.dirname(uninstallPath) };
}
const installed = readRegistration();
if (installed && path.resolve(installed.InstallLocation).toLowerCase() !== destination.toLowerCase()) throw new Error(`Existing installation preserved: ${installed.InstallLocation}`);
const liveLedger = path.join(process.env.APPDATA, 'Claude Country Club', 'config-patches.json');
assert(!(await exists(liveLedger)), 'Live integration ledger exists. Use a disposable Windows account for installer acceptance.');
await mkdir(artifacts, { recursive: true });
async function run(command, args, env = process.env, verbatim = false, expectedCode = 0) {
  return new Promise((resolve, reject) => {
    // These established Playwright fixtures attach to the controller's
    // BrowserWindow. The shipped worker path has dedicated packaged coverage;
    // retain this compatibility matrix until each fixture drives the worker.
    const childEnv=command===process.execPath?{...env,CCC_WINDOW_WORKER:'0'}:env;
    const child = spawn(command, args, { cwd: root, env:childEnv, windowsHide: true, windowsVerbatimArguments: verbatim, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Installer test exceeded 180 seconds.')); }, 180_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === expectedCode ? resolve() : reject(new Error(`${path.basename(command)} exited ${code}; expected ${expectedCode}`)); });
  });
}
const checks = [];
try {
  await run(installer, ['/S', '/allusers', `/D=${destination}`], process.env, true, 6);
  checks.push('all-users installation refused');
  // NSIS /D must be last and deliberately unquoted even when the path has spaces.
  await run(installer, ['/S', `/D=${destination}`], process.env, true);
  assert(await exists(executable), 'Install did not produce the application.');
  checks.push('silent per-user install into scoped workspace');
  await run(process.execPath, ['scripts/test-helper-build-info.mjs'], { ...process.env, CCC_EXECUTABLE: executable });
  checks.push('installed native helper metadata and mismatch refusal acceptance');
    await run(process.execPath, ['scripts/test-client-discovery.mjs'], { ...process.env, CCC_EXECUTABLE: executable });
    checks.push('installed explicit native client discovery through isolated Windows npm fixtures');
  await run(process.execPath, ['scripts/test-consoleless-helper.mjs'], { ...process.env, CCC_EXECUTABLE: executable });
  checks.push('installed console-free helper direct/cmd/PowerShell delivery, Unicode paths and shutdown acceptance');
    await run(process.execPath, ['scripts/test-lazy-protocol.mjs'], { ...process.env, CCC_EXECUTABLE: executable });
    checks.push('installed unused background has no spare renderer and protocol initialization recovers on explicit retry');
  await run(process.execPath, ['scripts/e2e.mjs'], { ...process.env, CCC_EXECUTABLE: executable });
  checks.push('installed application end-to-end acceptance');
  await run(process.execPath, ['scripts/test-input-conflicts.mjs'], { ...process.env, CCC_EXECUTABLE: executable });
  checks.push('installed pointer/keyboard ownership and repeated-Escape cancellation acceptance');
  await run(process.execPath, ['scripts/probe-focus-interruption.mjs'], { ...process.env, CCC_EXECUTABLE: executable });
  checks.push('installed focus-loss/minimize cancellation and fresh-shot recovery acceptance');
  await run(process.execPath, ['scripts/test-background-startup.mjs'], { ...process.env, CCC_EXECUTABLE: executable });
  checks.push('installed application windowless background startup and first-use recovery acceptance');
    await run(process.execPath, ['scripts/test-startup-ordering-suite.mjs'], { ...process.env, CCC_EXECUTABLE: executable });
    checks.push('installed application early open ordering, latest intent, held startup and failed-load recovery acceptance');
  await run(process.execPath, ['scripts/test-system-lifecycle.mjs'], { ...process.env, CCC_EXECUTABLE: executable });
  checks.push('installed application suspend, screen-lock and stale-turn refusal acceptance');
  await run(process.execPath, ['scripts/test-claude-lifecycle.mjs'], { ...process.env, CCC_EXECUTABLE: executable });
  checks.push('installed application passive Claude failure and MCP input hide, privacy and fixture removal acceptance');
  await run(process.execPath, ['scripts/test-display-bounds.mjs'], { ...process.env, CCC_EXECUTABLE: executable });
  checks.push('installed application display placement, shrink and no-focus acceptance');
  await run(process.execPath, ['scripts/test-ui.mjs'], { ...process.env, CCC_EXECUTABLE: executable });
  checks.push('installed application zoom, keyboard, settings and modal acceptance');
  await run(process.execPath, ['scripts/test-save-faults.mjs'], { ...process.env, CCC_EXECUTABLE: executable });
  checks.push('installed application lock and automatic-rollback recovery');
  await run(process.execPath, ['scripts/test-midflight-crash.mjs'], { ...process.env, CCC_EXECUTABLE: executable });
  checks.push('installed acknowledged mid-flight shot survives renderer crash and owned process-tree termination exactly');
    await run(process.execPath, ['scripts/test-progress-files.mjs'], { ...process.env, CCC_EXECUTABLE: executable });
    await run(process.execPath, ['scripts/test-diagnostics-export.mjs'], { ...process.env, CCC_EXECUTABLE: executable });
    checks.push('installed application previewed private diagnostic export acceptance');
    await run(process.execPath, ['scripts/test-diagnostic-log.mjs'], { ...process.env, CCC_EXECUTABLE: executable });
    checks.push('installed application bounded private diagnostic history and logging-failure practice acceptance');
    checks.push('installed application progress file export, refusal and restore acceptance');
    await run(process.execPath, ['scripts/test-history-retention.mjs'], { ...process.env, CCC_EXECUTABLE: executable });
    checks.push('installed application bounded history and exact restart acceptance');
    await run(process.execPath, ['scripts/test-private-identity.mjs'], { ...process.env, CCC_EXECUTABLE: executable });
    checks.push('installed application private native identity and invalid-key practice acceptance');
    await run(process.execPath, ['scripts/test-private-preview.mjs'], { ...process.env, CCC_EXECUTABLE: executable });
    checks.push('installed application hook-only private configuration review and large-file merge acceptance');
  const registration = readRegistration();
  assert(registration, 'Installed application registration missing.');
  assert.equal(path.resolve(registration.InstallLocation).toLowerCase(), destination.toLowerCase(), 'Only test-owned registration may be changed.');
  assert(/^[a-zA-Z0-9{}._-]+$/.test(registration.PSChildName));
  const registryKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${registration.PSChildName}`;
  const hashExecutable = async () => createHash('sha256').update(await readFile(executable)).digest('hex');
  const originalHash = await hashExecutable();
  const setTestVersion = version => execFileSync('reg.exe', ['add', registryKey, '/v', 'DisplayVersion', '/t', 'REG_SZ', '/d', version, '/f'], { windowsHide: true, stdio: 'pipe' });
  try {
    setTestVersion('999.0.0');
    await run(installer, ['/S', `/D=${destination}`], process.env, true, 4);
    assert.equal(await hashExecutable(), originalHash, 'Downgrade changed the installed application.');
    checks.push('downgrade rejected with installed executable unchanged (scoped registration fixture)');
  } finally {
    setTestVersion(registration.DisplayVersion);
  }
  await run(installer, ['/S', '/REPAIR', `/D=${destination}`], process.env, true);
  assert(await exists(executable), 'Repair lost the application.');
  checks.push('repair reinstall');
  await run(process.execPath, ['scripts/e2e.mjs'], { ...process.env, CCC_EXECUTABLE: executable });
  checks.push('repaired application end-to-end acceptance');
  const uninstallerName = (await readdir(destination)).find(name => /^Uninstall.*\.exe$/i.test(name));
  assert(uninstallerName, 'Installed uninstaller missing.');
  await run(path.join(destination, uninstallerName), ['/S']);
  const deadline = Date.now() + 30_000;
  while (await exists(executable)) {
    if (Date.now() > deadline) throw new Error('Uninstaller did not remove application files.');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  checks.push('uninstall removes application files');
  await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ passed: true, installer, installerSha256, destination, checks }, null, 2));
  console.log('Windows installer acceptance passed: install, installed E2E, repair, repaired E2E, uninstall.');
} catch (error) {
  await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ passed: false, installer, installerSha256, destination, checks, error: String(error) }, null, 2));
  throw error;
}
