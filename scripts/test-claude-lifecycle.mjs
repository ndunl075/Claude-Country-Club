import { _electron as electron, expect } from 'playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { dragShot, observePointerInput } from './play-input.mjs';
assert(process.env.CCC_EXECUTABLE, 'Set CCC_EXECUTABLE to the packaged application');
const artifacts = path.resolve('work/claude-lifecycle'); await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(artifacts, 'profile-')), data = path.join(profile, 'data'), home = path.join(profile, 'home');
const env = { ...process.env, CCC_TEST_MODE: '1', CCC_DATA_DIR: data, CCC_TEST_HOME: home }; delete env.ELECTRON_RUN_AS_NODE;
const helper = path.resolve(path.dirname(process.env.CCC_EXECUTABLE), process.platform === 'darwin' ? '../Resources/ccc-hook' : 'resources/ccc-hook.exe');
const checks = []; let app, page, phase = 'launch';
const state = () => page.evaluate(() => window.countryClub.getState());
const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(w => w.isVisible()));
let hooks;
async function hook(event, extra = {}) {
  const group = hooks[event]?.[0], command = group?.hooks?.[0];
  assert(command?.type === 'command', `Missing reviewed ${event} command hook`);
  assert.equal(command.timeout, 1);
  const kind = command.args ? command.args[command.args.indexOf('--event') + 1] : / --event ([a-z-]+) --config /.exec(command.command)?.[1]; assert(kind);
  if (process.platform === 'win32') { assert.equal(command.command, helper); assert.deepEqual(command.args, ['--provider', 'claude', '--event', kind, '--config', path.join(data, 'connection.json')]); }
  const child = spawn(command.args ? command.command : helper, command.args ?? ['--provider', 'claude', '--event', kind, '--config', path.join(data, 'connection.json')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  child.stdin.end(JSON.stringify({ session_id: 'claude-lifecycle-root', cwd: home, hook_event_name: event, ...extra }));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Owned helper exceeded bounded execution')); }, 2000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Hook exit ${code}`)); });
  });
  assert.equal(output, '', 'Passive hook produced provider-visible output');
}
try {
  app = await electron.launch({ executablePath: process.env.CCC_EXECUTABLE, env, timeout: 30000 }); page = await app.firstWindow(); await observePointerInput(page);
  await expect.poll(() => state().then(s => s.brokerReady)).toBe(true);
  phase = 'reviewed mapping'; const preview = await page.evaluate(() => window.countryClub.previewIntegration('claude')); hooks = JSON.parse(preview.after).hooks;
  assert(hooks.StopFailure?.length === 1, 'Packaged preview does not enroll StopFailure');
  assert(hooks.Elicitation?.length === 1, 'Packaged preview does not enroll Elicitation');
  assert(/ --event failed /.test(' '+[hooks.StopFailure[0].hooks[0].command,...(hooks.StopFailure[0].hooks[0].args??[])].join(' ')+' '));
  assert(/ --event attention /.test(' '+[hooks.Elicitation[0].hooks[0].command,...(hooks.Elicitation[0].hooks[0].args??[])].join(' ')+' '));
  await page.evaluate(p => window.countryClub.applyIntegration(p), preview);
  const config = JSON.parse(await readFile(path.join(home, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(config.hooks.StopFailure, hooks.StopFailure); assert.deepEqual(config.hooks.Elicitation, hooks.Elicitation);
  checks.push('reviewed fixture install includes passive StopFailure/failed and Elicitation/attention hooks');
  await page.evaluate(async () => { await window.countryClub.setSettings({ automatic: true, delayMs: 1000 }); await window.countryClub.hide(); });
  phase = 'working wait'; await hook('UserPromptSubmit');
  await expect.poll(() => state().then(s => s.sessions.length)).toBe(1);
  const key = (await state()).sessions[0].key; await page.evaluate(k => window.countryClub.selectSession(k), key);
  await expect.poll(visible, { timeout: 5000 }).toBe(true);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), false);
  await dragShot(page, { angle: 180, power: 15 });
  await expect.poll(async () => { const r = (await page.evaluate(() => window.countryClub.loadRound()))?.state; return r?.shotId === 1 && r.velocity.x === 0 && r.velocity.y === 0; }, { timeout: 15000 }).toBe(true);
  const saved = (await page.evaluate(() => window.countryClub.loadRound())).state;
  phase = 'MCP input attention'; await hook('Elicitation', { mcp_server_name: 'PRIVATE-SERVER', message: 'PRIVATE-FORM', mode: 'url', url: 'https://PRIVATE-LOGIN.invalid', requested_schema: { private: 'PRIVATE-SCHEMA' } });
  await expect.poll(visible).toBe(false); assert.equal((await state()).sessions.find(s => s.key === key).state, 'attention');
  assert.deepEqual((await page.evaluate(() => window.countryClub.loadRound())).state, saved);
  // No native turn ID: ordinary activity cannot establish a safe resume.
  await hook('PreToolUse', { tool_name: 'Bash' }); await page.waitForTimeout(1200); assert.equal(await visible(), false);
  checks.push('MCP input hides and preserves the acknowledged round; ambiguous no-turn activity cannot reopen it');
  await hook('Stop'); await hook('UserPromptSubmit'); await expect.poll(visible, { timeout: 5000 }).toBe(true);
  phase = 'API-error termination'; await hook('StopFailure', { error: 'rate_limit', error_details: 'PRIVATE-ERROR', last_assistant_message: 'PRIVATE-RESPONSE' });
  await expect.poll(visible).toBe(false); assert.equal((await state()).sessions.find(s => s.key === key).state, 'failed');
  await hook('PreToolUse', { tool_name: 'Bash' }); await page.waitForTimeout(1200); assert.equal(await visible(), false);
  assert.deepEqual((await page.evaluate(() => window.countryClub.loadRound())).state, saved);
  const hostBytes = JSON.stringify(await state()); assert(!hostBytes.includes('PRIVATE'));
  checks.push('StopFailure terminates the selected wait; late activity cannot revive it; error/form data never reaches the host');
  phase = 'next explicit turn'; await hook('UserPromptSubmit'); await expect.poll(visible, { timeout: 5000 }).toBe(true); await hook('Stop'); await expect.poll(visible).toBe(false);
  await page.evaluate(() => window.countryClub.removeIntegration('claude'));
  const removed = JSON.parse(await readFile(path.join(home, '.claude/settings.json'), 'utf8')); assert.equal(removed.hooks.StopFailure, undefined); assert.equal(removed.hooks.Elicitation, undefined);
  checks.push('fresh root turn recovers and fixture removal removes both owned mappings');
  await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ passed: true, packaged: true, checks, limitations: ['Documented Claude payload fixtures travel through the actual helper and IPC; no live configuration or signed-in client was enrolled.', 'No provider request, API error or MCP authentication was initiated.', 'Unidentified Claude turns remain conservative after attention; real client delivery and version support remain unverified.'] }, null, 2));
  console.log('Packaged Claude failure and elicitation lifecycle acceptance passed.');
} catch (error) {
  const evidence = await page?.evaluate(async () => ({ events: window.__dragEvidence, host: await window.countryClub.getState(), round: await window.countryClub.loadRound() })).catch(e => ({ unavailable: String(e) }));
  await page?.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
  await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ passed: false, phase, error: String(error), checks, profile, evidence }, null, 2)); throw error;
} finally { await app?.close().catch(() => {}); }
