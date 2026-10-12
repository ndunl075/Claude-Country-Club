import { _electron as electron, expect } from 'playwright/test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { dragShot, observePointerInput } from './play-input.mjs';
import { observeRoundWrites, readRoundWrites } from './round-write-evidence.mjs';

assert(process.env.CCC_EXECUTABLE, 'Set CCC_EXECUTABLE to the packaged application');
const artifacts = path.resolve('work/input-provenance'); await mkdir(artifacts, { recursive: true });
const attempts = Number(process.env.CCC_INPUT_ATTEMPTS ?? 8);
assert(Number.isInteger(attempts) && attempts >= 4 && attempts <= 40);
const executableSha256 = createHash('sha256').update(await readFile(process.env.CCC_EXECUTABLE)).digest('hex');
const results = []; let app, page, current;
const load = () => page.evaluate(() => window.countryClub.loadRound());
async function settled(shotId) {
  await expect.poll(async () => { const r = (await load())?.state; return r?.shotId === shotId && r.velocity.x === 0 && r.velocity.y === 0; }, { timeout: 15000 }).toBe(true);
}
async function capture() {
  return { renderer: await page.evaluate(async () => ({ events: window.__dragEvidence, round: await window.countryClub.loadRound(), host: await window.countryClub.getState() })), writer: await readRoundWrites(app) };
}
async function report(passed, error) {
  await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ passed, packaged: true, executableSha256, requested: attempts, completed: results.length, error, results,
    limitations: ['Owned main-process inspector wraps the existing save handler without replacing its result. Observation can affect timing.', 'Input and save observation is test-only; no production logging, live client enrollment or physical-input certification.', 'A passing sample does not explain earlier missed-shot or duplicate-stroke observations.'] }, null, 2));
}
try {
  for (let index = 0; index < attempts; index++) {
    const mode = ['immediate-practice', 'screenshot-before-drag', 'settings-to-play', 'broker-ready-first'][index % 4];
    const profile = await mkdtemp(path.join(artifacts, 'profile-'));
    const env = { ...process.env, CCC_TEST_MODE: '1', CCC_DATA_DIR: path.join(profile, 'data'), CCC_TEST_HOME: path.join(profile, 'home') };
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    current = { index, mode, profile, passed: false, phase: 'launch' };
    app = await electron.launch({ executablePath: process.env.CCC_EXECUTABLE, env, timeout: 30000 });
    page = await app.firstWindow(); await observePointerInput(page); await observeRoundWrites(app);
    if (mode === 'broker-ready-first') await expect.poll(() => page.evaluate(() => window.countryClub.getState()).then(s => s.brokerReady)).toBe(true);
    current.phase = 'enter practice'; await page.getByRole('button', { name: 'Play local practice', exact: true }).click();
    if (mode === 'settings-to-play') {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('button', { name: 'Play', exact: true }).click();
    }
    if (mode === 'screenshot-before-drag') await page.screenshot({ path: path.join(profile, 'before.png') });
    assert.equal((await load())?.state.shotId ?? 0, 0, 'Fresh fixture already has a shot');
    current.phase = 'one real drag'; await dragShot(page, { angle: 180, power: 15 }); await settled(1);
    // A later firing is a failure too; do not stop observation at first ack.
    await page.waitForTimeout(2500); await settled(1);
    current.afterDrag = await capture();
    const events = current.afterDrag.renderer.events;
    assert.equal(events.filter(e => e.type === 'pointerup' && e.target === 'CANVAS').length, 1);
    assert.equal(events.filter(e => e.type === 'keydown' && [' ', 'Enter'].includes(e.key)).length, 0, 'Unexpected shooting key during pointer-only case');
    const proposals = current.afterDrag.writer.writes.filter((w, i, all) => w.shotId > 0 && all.findIndex(other => other.shotId === w.shotId) === i);
    assert.deepEqual(proposals.map(w => w.shotId), [1]);
    assert(proposals.every(w => w.acknowledgedRevision === w.revision));
    assert.equal(current.afterDrag.writer.dropped, 0);
    if (index === attempts - 1) {
      // Positive control: prove that keyboard firing is visible and distinguishable
      // from a second pointer gesture, using the ordinary accessible control.
      current.phase = 'keyboard positive control'; await page.getByRole('application').press('Space'); await settled(2);
      current.afterKeyboard = await capture();
      assert(current.afterKeyboard.renderer.events.some(e => e.type === 'keydown' && e.key === ' ' && e.target === 'CANVAS'));
      const second = current.afterKeyboard.writer.writes.find(w => w.shotId === 2);
      assert(second && second.acknowledgedRevision === second.revision);
      assert.equal(current.afterKeyboard.renderer.events.filter(e => e.type === 'pointerup' && e.target === 'CANVAS').length, 1);
    }
    await app.close(); app = undefined; page = undefined;
    const db = new DatabaseSync(path.join(profile, 'data/country-club.sqlite'), { readOnly: true });
    try { current.journal = db.prepare('SELECT shot_id,state FROM shots ORDER BY shot_id').all().map(row => { const s = JSON.parse(row.state); return { shotId: row.shot_id, tick: s.tick, ball: s.ball, velocity: s.velocity }; }); }
    finally { db.close(); }
    assert.deepEqual(current.journal.map(s => s.shotId), index === attempts - 1 ? [1, 2] : [1]);
    current.passed = true; current.phase = 'complete'; results.push(current); current = undefined;
    await report(results.length === attempts); console.log(`Input provenance ${index + 1}/${attempts}: ${mode} passed`);
  }
} catch (error) {
  if (current) {
    current.error = String(error); current.evidence = await capture().catch(e => ({ unavailable: String(e) }));
    await page?.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
    results.push(current);
  }
  await report(false, String(error)); throw error;
} finally { await app?.close().catch(() => {}); }
