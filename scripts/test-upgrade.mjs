// Local real-version upgrade and recovery acceptance. Never enroll live clients.
import { _electron as electron, expect } from 'playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, access, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
assert.equal(process.platform, 'win32');
const root = process.cwd(), work = path.join(root, 'work/upgrade-test');
await mkdir(work, { recursive: true });
const target = path.join(work, 'app'), executable = path.join(target, 'Claude Country Club.exe');
const coordinator = path.join(root, 'dist/native/ccc-installer.exe');
const base = path.join(root, 'release/Claude-Country-Club-Setup-0.1.0-x64.exe');
const upgrade = path.join(root, 'work/upgrade-release/Claude-Country-Club-Setup-0.1.1-x64.exe');
const exists = p => access(p).then(() => true, () => false);
const registration = () => {
  const json = execFileSync('powershell.exe', ['-NoProfile', '-Command', "if (Test-Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\e0e2b6b5-dc94-506c-b07b-3fd5ab2393ac') { Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\e0e2b6b5-dc94-506c-b07b-3fd5ab2393ac' | Select-Object UninstallString,DisplayVersion | ConvertTo-Json -Compress }; exit 0"], { encoding: 'utf8', windowsHide: true }).trim();
  if (!json) return null;
  const value = JSON.parse(json), file = /^"([^"]+)"/.exec(value.UninstallString ?? '')?.[1];
  assert(file && path.dirname(file).toLowerCase() === target.toLowerCase(), 'An installation outside this test is registered; refusing to continue.');
  return value;
};
registration();
assert(!(await exists(path.join(process.env.APPDATA, 'Claude Country Club/config-patches.json'))), 'Live integration ledger exists; use a disposable account.');
for (const file of [base, upgrade, coordinator]) assert(await exists(file), `Required fixture missing: ${file}`);
async function run(file, args, expected = 0, verbatim = false) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, windowsVerbatimArguments: verbatim, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(Error('Upgrade test timed out')); }, 180_000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); code === expected ? resolve() : reject(Error(`${path.basename(file)} exited ${code}; expected ${expected}`)); });
  });
}
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const checks = []; let app;
try {
  if (registration()?.DisplayVersion === '0.1.1') {
    await run(path.join(target, 'Uninstall Claude Country Club.exe'), ['/S']);
    await expect.poll(() => exists(executable), { timeout: 30_000 }).toBe(false);
  }
  await run(base, ['/S', `/D=${target}`], 0, true);
  assert.equal(registration().DisplayVersion, '0.1.0');
  const originalHash = await hash(executable), transaction = `${target}.ccc-transaction`;
  await run(coordinator, ['prepare', target]);
  await cp(target, path.join(transaction, 'new'), { recursive: true });
  await writeFile(path.join(transaction, 'new/resources/app.asar'), 'corrupt-staged-archive');
  await run(coordinator, ['commit', target], 5);
  assert.equal(await hash(executable), originalHash);
  await run(coordinator, ['recover', target]);
  assert(!(await exists(transaction)));
  checks.push('corrupt staged application refused; installed executable unchanged');
  await run(coordinator, ['prepare', target]);
  await cp(target, path.join(transaction, 'new'), { recursive: true });
  await run(coordinator, ['commit', target]);
  execFileSync('reg.exe', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\e0e2b6b5-dc94-506c-b07b-3fd5ab2393ac', '/v', 'DisplayVersion', '/t', 'REG_SZ', '/d', '0.1.1', '/f'], { windowsHide: true, stdio: 'pipe' });
  // A second installer invocation recovers this unfinalized swap before work.
  await run(base, ['/S', `/D=${target}`], 0, true);
  assert.equal(registration().DisplayVersion, '0.1.0');
  assert.equal(await hash(executable), originalHash);
  assert(!(await exists(transaction)));
  checks.push('installer retry recovers unfinalized file switch and old registration');
  const profile = await mkdtemp(path.join(work, 'profile-')), data = path.join(profile, 'data'), home = path.join(profile, 'home');
  await mkdir(path.join(home, '.codex'), { recursive: true });
  const auth = path.join(home, '.codex/auth.json'), hooks = path.join(home, '.codex/hooks.json');
  await writeFile(auth, '{"fixture":"preserve-authentication"}');
  const env = { ...process.env, CCC_TEST_MODE: '1', CCC_DATA_DIR: data, CCC_TEST_HOME: home, CCC_WINDOW_WORKER: '0' }; delete env.ELECTRON_RUN_AS_NODE;
  async function launch() { app = await electron.launch({ executablePath: executable, args: [], env }); const page = await app.firstWindow(); await expect(page.getByRole('region', { name: 'Mini golf game', exact: true })).toBeVisible(); return page; }
  let page = await launch();
  await page.evaluate(() => window.countryClub.practice());
  await (await import('./play-input.mjs')).dragShot(page);
  await expect.poll(async () => (await page.evaluate(() => window.countryClub.loadRound())).state?.strokes).toBe(1);
  const preview = await page.evaluate(() => window.countryClub.previewIntegration('codex'));
  assert(preview.configPath.startsWith(home + path.sep));
  await page.evaluate(p => window.countryClub.applyIntegration(p), preview);
  await page.evaluate(() => window.countryClub.hide());
  const acknowledged = await page.evaluate(() => window.countryClub.loadRound());
  await run(upgrade, ['/S', `/D=${target}`], 2, true);
  assert.equal(registration().DisplayVersion, '0.1.0');
  assert.deepEqual((await page.evaluate(() => window.countryClub.loadRound())).state, acknowledged.state);
  assert(!(await exists(transaction)));
  checks.push('silent upgrade refuses a running hidden app without killing it or changing its saved shot');
  await app.close(); app = undefined;
  const database = new DatabaseSync(path.join(data, 'country-club.sqlite'), { readOnly: true });
  const row = database.prepare('SELECT revision,state FROM round_save WHERE id=1').get(); database.close();
  const saved = { revision: row.revision, state: JSON.parse(row.state) };
  assert.deepEqual(saved.state, acknowledged.state, 'Shutdown changed the frozen acknowledged state');
  const priorHooks = await readFile(hooks), priorAuth = await readFile(auth), priorSave = await hash(path.join(data, 'country-club.sqlite'));
  await run(upgrade, ['/S', `/D=${target}`], 0, true);
  assert.equal(registration().DisplayVersion, '0.1.1');
  assert.deepEqual(await readFile(hooks), priorHooks); assert.deepEqual(await readFile(auth), priorAuth);
  assert.equal(await hash(path.join(data, 'country-club.sqlite')), priorSave);
  assert(!(await exists(transaction)));
  page = await launch();
  assert.deepEqual(await page.evaluate(() => window.countryClub.loadRound()), saved);
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), '0.1.1');
  await page.evaluate(() => window.countryClub.removeIntegration('codex'));
  await app.close(); app = undefined;
  checks.push('real 0.1.0 to 0.1.1 installer upgrade preserves exact acknowledged shot, SQLite, fixture hook configuration and authentication');
  await run(base, ['/S', `/D=${target}`], 4, true);
  assert.equal(registration().DisplayVersion, '0.1.1');
  checks.push('actual older-version installer refused');
  await run(path.join(target, 'Uninstall Claude Country Club.exe'), ['/S']);
  await expect.poll(() => exists(executable), { timeout: 30_000 }).toBe(false);
  assert(await exists(path.join(data, 'country-club.sqlite'))); assert.deepEqual(await readFile(auth), priorAuth);
  checks.push('upgraded application uninstalls while fixture progress and authentication remain');
  await writeFile(path.join(work, 'result.json'), JSON.stringify({ passed: true, base, upgrade, checks }, null, 2));
  console.log('Real version upgrade and recovery acceptance passed.');
} catch (error) {
  await writeFile(path.join(work, 'result.json'), JSON.stringify({ passed: false, checks, error: String(error) }, null, 2)); throw error;
} finally { if (app) { await app.evaluate(async ({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; if (window) await window.webContents.executeJavaScript("window.countryClub.removeIntegration('codex')"); }).catch(() => {}); await app.close().catch(() => {}); } }
