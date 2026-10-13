// Correlate passive helper exit, native delivery, reducer state and window state.
// All payloads, connection files and application data belong to private fixtures.
import { _electron as electron, expect } from 'playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { dragShot } from './play-input.mjs';

assert(process.env.CCC_EXECUTABLE, 'Set CCC_EXECUTABLE to the packaged app');
const artifacts = path.resolve('work/attention-delivery');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(artifacts, 'profile-'));
const data = path.join(profile, 'data'), home = path.join(profile, 'home');
const executable = process.env.CCC_EXECUTABLE;
const helper = path.resolve(path.dirname(executable), process.platform === 'darwin' ? '../Resources/ccc-hook' : 'resources/ccc-hook.exe');
const connection = path.join(data, 'connection.json');
const env = { ...process.env, CCC_TEST_MODE: '1', CCC_DATA_DIR: data, CCC_TEST_HOME: home };
delete env.ELECTRON_RUN_AS_NODE;
const steps = []; let app, page, phase = 'launch', saved, finalObservation;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function observe() {
  return app.evaluate(async ({ BrowserWindow, ipcMain }) => {
    const course = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('ccc://'));
    let host = null, unavailable;
    // Read the existing trusted state handler; never replace reducers or IPC.
    if (course) try {
      const state = await ipcMain._invokeHandlers.get('ccc:state')({ sender: course.webContents, senderFrame: course.webContents.mainFrame });
      host = { sessions: state.sessions, selected: state.selectedSession, suspended: state.suspended, brokerReady: state.brokerReady };
    } catch (error) { unavailable = String(error); }
    return { trace: globalThis.__attentionDeliveryTrace, host, unavailable,
      windows: BrowserWindow.getAllWindows().map(w => ({ id: w.id, course: w.webContents.getURL().startsWith('ccc://'), visible: w.isVisible(), focused: w.isFocused() })) };
  });
}
const courseVisible = observation => observation.windows.some(w => w.course && w.visible);
async function hook(kind, toolName, config = connection, expectedKind = kind, expectedDelivery = true) {
  const before = await observe(), start = performance.now();
  const child = spawn(helper, ['--provider', 'claude', '--event', kind, '--config', config], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let outputBytes = 0;
  child.stdout.on('data', bytes => outputBytes += bytes.length);
  child.stderr.on('data', bytes => outputBytes += bytes.length);
  child.stdin.end(JSON.stringify({ session_id: 'attention-delivery-root', turn_id: 'delivery-turn', cwd: home, tool_name: toolName }));
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('Owned helper exceeded 2s')); }, 2000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const step = { phase, kind, toolName, expectedDelivery, helperElapsedMs: performance.now() - start, exitCode, outputBytes, before };
  steps.push(step);
  assert.equal(exitCode, 0); assert.equal(outputBytes, 0);
  if (expectedDelivery) {
    await expect.poll(async () => {
      step.after = await observe();
      return step.after.trace.events.slice(before.trace.events.length).some(event => event.source === 'broker' && event.kind === expectedKind && event.turnId === 'delivery-turn');
    }, { timeout: 5000, message: `No broker delivery during ${phase}; helper exit alone is insufficient` }).toBe(true);
    step.delivered = true;
  } else {
    await pause(350); step.after = await observe();
    assert.equal(step.after.trace.events.filter(event => event.source === 'broker').length, before.trace.events.filter(event => event.source === 'broker').length);
    step.delivered = false;
  }
  await writeFile(path.join(artifacts, 'steps.json'), JSON.stringify({ profile, phase, steps }, null, 2));
  return step;
}
async function stateAndVisibility(state, visible) {
  await expect.poll(async () => {
    finalObservation = await observe();
    const session = finalObservation.host?.sessions.find(s => s.turnId === 'delivery-turn');
    return session?.state === state && courseVisible(finalObservation) === visible;
  }, { timeout: 5000, message: `State/window mismatch during ${phase}` }).toBe(true);
}
try {
  app = await electron.launch({ executablePath: executable, env, timeout: 30000 });
  page = await app.firstWindow();
  await expect.poll(async () => (await page.evaluate(() => window.countryClub.getState())).brokerReady).toBe(true);
  await app.evaluate(({ app, BrowserWindow }) => {
    const trace = globalThis.__attentionDeliveryTrace = { events: [], dropped: 0, attached: false };
    const record = event => { if (trace.events.length === 256) { trace.events.shift(); trace.dropped++; } trace.events.push({ time: Date.now(), ...event }); };
    const observeWindow = w => {
      const id = w.id;
      for (const event of ['show', 'hide', 'closed']) w.on(event, () => record({ source: 'window', id, event }));
      w.webContents.on('render-process-gone', (_event, details) => record({ source: 'renderer', reason: details.reason, exitCode: details.exitCode }));
    };
    for (const w of BrowserWindow.getAllWindows()) observeWindow(w);
    app.on('browser-window-created', (_event, w) => observeWindow(w));
    app.on('child-process-gone', (_event, details) => record({ source: 'child', type: details.type, reason: details.reason, exitCode: details.exitCode }));
    const broker = process._getActiveHandles().find(h => h.constructor?.name === 'ChildProcess' && /ccc-hook(?:\.exe)?$/.test(h.spawnfile ?? ''));
    if (!broker?.stdout) throw Error('Ready broker has no observable stdout');
    let buffer = '';
    broker.stdout.prependListener('data', chunk => {
      buffer += chunk.toString(); let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { const message = JSON.parse(line); if (message.event) record({ source: 'broker', eventId: message.event.eventId, kind: message.event.kind, turnId: message.event.turnId }); } catch {}
      }
    });
    trace.attached = true;
  });
  await page.getByRole('button', { name: 'Play local practice', exact: true }).click();
  await dragShot(page, { angle: 180, power: 15 });
  await expect.poll(async () => {
    const round = (await page.evaluate(() => window.countryClub.loadRound()))?.state;
    return round?.shotId === 1 && round.velocity.x === 0 && round.velocity.y === 0;
  }, { timeout: 15000 }).toBe(true);
  saved = await page.evaluate(() => window.countryClub.loadRound());
  await page.evaluate(async () => { await window.countryClub.setSettings({ automatic: true, delayMs: 1000 }); await window.countryClub.hide(); });
  const destinationId = await app.evaluate(async ({ BrowserWindow }) => {
    const w = new BrowserWindow({ show: false, width: 200, height: 100, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await w.loadURL('about:blank'); w.show(); w.focus(); return w.id;
  });
  await expect.poll(() => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isFocused(), destinationId)).toBe(true);
  phase = 'identified start'; await hook('start'); await stateAndVisibility('working', true);
  for (let cycle = 0; cycle < 8; cycle++) {
    phase = `attention ${cycle}`;
    await hook('activity', cycle % 2 === 0 ? 'AskUserQuestion' : 'ExitPlanMode', connection, 'attention');
    await stateAndVisibility('attention', false);
    if (cycle === 0) {
      phase = 'wrong-token negative control';
      const rejectedBaseline = await page.evaluate(() => window.countryClub.loadRound());
      const config = JSON.parse(await readFile(connection, 'utf8'));
      const originalToken = config.token;
      config.token = config.token === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
      const rejectedConnection = path.join(data, 'rejected-connection.json');
      await writeFile(rejectedConnection, JSON.stringify(config), { mode: 0o600 });
      await hook('activity', 'Bash', rejectedConnection, 'activity', false);
      await stateAndVisibility('attention', false);
      assert.deepEqual(await page.evaluate(() => window.countryClub.loadRound()), rejectedBaseline);
      // Prove the alternate file/path works by changing only its token back.
      phase = 'restored-token positive control'; config.token = originalToken;
      await writeFile(rejectedConnection, JSON.stringify(config), { mode: 0o600 });
      await hook('activity', 'Bash', rejectedConnection);
      await stateAndVisibility('working', true);
    }
    phase = `correlated resume ${cycle}`; await hook('activity', 'Bash'); await stateAndVisibility('working', true);
    assert.equal(finalObservation.windows.find(w => w.id === destinationId)?.focused, true, 'Automatic resume displaced the owned foreground window');
    assert.equal(finalObservation.windows.find(w => w.course)?.focused, false);
    // Valid freezes can advance the save revision while preserving round state.
    assert.deepEqual((await page.evaluate(() => window.countryClub.loadRound())).state, saved.state);
  }
  phase = 'terminal stop'; await hook('stop'); await stateAndVisibility('stopped', false);
  assert.equal(finalObservation.trace.dropped, 0);
  assert(!finalObservation.trace.events.some(event => event.source === 'renderer' || event.source === 'child'));
  await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ passed: true, executableSha256: createHash('sha256').update(await readFile(executable)).digest('hex'), cycles: 8, steps, finalObservation,
    limitations: ['Private identified-turn payloads through actual packaged helper and IPC; no signed-in client or live config enrolled.', 'Main-process inspector and event observers affect timing; past intermittent failures remain unexplained.', 'Wrong-token control proves silent successful helper exit can mean rejected delivery; it does not establish why the earlier attention timeout occurred.', 'Focus uses a separate owned foreground window; physical desktop routing and native Mac execution remain unverified.'] }, null, 2));
  console.log('Packaged attention delivery correlation and rejected-token control passed.');
} catch (error) {
  finalObservation = await observe().catch(error => ({ unavailable: String(error) }));
  await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ passed: false, phase, error: String(error), profile, steps, finalObservation }, null, 2));
  throw error;
} finally { await app?.close().catch(() => {}); }
