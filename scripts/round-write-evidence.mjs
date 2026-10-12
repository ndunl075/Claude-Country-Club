// Inspector-only observation of owned fixture processes. No production flags,
// bridge changes, input injection, retries or save acknowledgement substitutions.
export async function observeRoundWrites(application) {
  await application.evaluate(({ ipcMain }) => {
    if (process.env.CCC_TEST_MODE !== '1') throw new Error('Round observation requires an owned fixture process');
    if (globalThis.__roundWriteEvidence) return;
    const original = ipcMain._invokeHandlers?.get('ccc:save');
    if (typeof original !== 'function') throw new Error('Packaged save handler is not ready for observation');
    const trace = globalThis.__roundWriteEvidence = { received: 0, dropped: 0, writes: [] };
    ipcMain.removeHandler('ccc:save');
    ipcMain.handle('ccc:save', async (event, state, revision) => {
      const candidate = state && typeof state === 'object' ? state : {};
      const record = { sequence: ++trace.received, time: Date.now(), revision,
        shotId: candidate.shotId, tick: candidate.tick, strokes: candidate.strokes, status: candidate.status,
        ball: { ...candidate.ball }, safe: { ...candidate.safe }, velocity: { ...candidate.velocity } };
      if (trace.writes.length === 256) { trace.writes.shift(); trace.dropped++; }
      trace.writes.push(record);
      try {
        const acknowledgement = await original(event, state, revision);
        record.acknowledgedRevision = acknowledgement?.revision;
        return acknowledgement;
      } catch (error) {
        record.errorCode = typeof error?.code === 'string' ? error.code : 'SAVE_REJECTED';
        throw error;
      }
    });
  });
}

export async function readRoundWrites(application) {
  return application.evaluate(() => globalThis.__roundWriteEvidence ?? null);
}
