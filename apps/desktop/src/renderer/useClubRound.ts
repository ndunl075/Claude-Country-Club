import { useCallback, useEffect, useRef, useState } from 'react';
import type { CountryClubAPI, HostState } from '../../../../packages/contracts';
import { createRound, isMoving, nextHole, shoot, stepRound, validateRound } from '../../../../packages/game';
import type { Round, Vec } from '../../../../packages/game/types';

export const canPlay = (host: HostState | null) => !!host && !host.suspended && (host.practice || host.sessions.some(session => session.key === host.selectedSession && session.state === 'working'));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function useClubRound(api: CountryClubAPI) {
  const [host, setHost] = useState<HostState | null>(null);
  const [round, setRound] = useState<Round>(() => createRound(72917));
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [frozen, setFrozen] = useState(true);
  const [error, setError] = useState('');
  const [restoreFailed, setRestoreFailed] = useState(false);
  const roundRef = useRef(round);
  const revision = useRef(0);
  const epoch = useRef(0);
  const readyRef = useRef(false);
  const allowedRef = useRef(false);
  const frozenRef = useRef(true);
  const saveFailure = useRef(false);
  const restoreFailure = useRef(false);
  const pendingRef = useRef(false);
  const raf = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const shotPromise = useRef<Promise<void>>(Promise.resolve());
  const boot = useRef<Promise<void>>(Promise.resolve());
  const commit = useCallback((value: Round) => { roundRef.current = value; setRound(value); }, []);
  const stop = useCallback(() => { frozenRef.current = true; cancelAnimationFrame(raf.current); setFrozen(true); }, []);
  const fail = useCallback((cause: unknown) => { saveFailure.current = true; setError(message(cause)); stop(); }, [stop]);

  // One ordered writer prevents slow acknowledgements from overwriting newer shots.
  const persist = useCallback((value: Round, generation = epoch.current): Promise<boolean> => {
    const snapshot = structuredClone(value);
    const writeRevision = ++revision.current;
    const job = queue.current.then(async () => {
      if (generation !== epoch.current) return false;
      const ack = await api.saveRound(snapshot, writeRevision);
      if (ack.revision !== writeRevision) throw new Error('The round could not be saved at the expected revision.');
      return generation === epoch.current;
    });
    queue.current = job.catch(() => undefined);
    return job;
  }, [api]);

  useEffect(() => {
    let active = true;
    let hostSerial = 0;
    const receive = (value: HostState) => {
      if (!active) return;
      hostSerial++;
      allowedRef.current = canPlay(value);
      frozenRef.current = !allowedRef.current || saveFailure.current;
      if (frozenRef.current) cancelAnimationFrame(raf.current);
      setFrozen(frozenRef.current); setHost(value);
    };
    const offState = api.onState(receive);
    const loadGeneration = epoch.current;
    const initialSerial = hostSerial;
    boot.current = (async () => {
      try {
        const [, saved] = await Promise.all([api.getState().then(initialHost => { if (active && hostSerial === initialSerial) receive(initialHost); }), api.loadRound()]);
        if (!active || epoch.current !== loadGeneration) return;
        if (saved) {
          if (!Number.isSafeInteger(saved.revision) || saved.revision < 0) throw new Error('The saved round has an invalid revision.');
          revision.current = saved.revision;
          commit(validateRound(saved.state));
        }
        readyRef.current = true; setReady(true);
      } catch (cause) {
        if (!active || epoch.current !== loadGeneration) return;
        restoreFailure.current = true; saveFailure.current = true; setRestoreFailed(true); stop();
        setError(`Unable to restore your round: ${message(cause)}. Your existing save is preserved. Import a valid backup in Settings or confirm a New round.`);
        readyRef.current = true; setReady(true);
      }
    })();
    const offFreeze = api.onFreeze(async () => {
      // Stop first, before any asynchronous save or React update can run.
      stop();
      await boot.current;
      await shotPromise.current;
      if (readyRef.current && !restoreFailure.current) {
        try { await persist(roundRef.current); } catch (cause) { fail(cause); throw cause; }
      }
    });
    return () => { active = false; offState(); offFreeze(); cancelAnimationFrame(raf.current); };
  }, [api, commit, fail, persist, stop]);

  useEffect(() => {
    if (!ready || frozen || !canPlay(host)) return;
    let last = 0;
    let accumulator = 0;
    let lastCheckpoint = 0;
    const frame = (time: number) => {
      if (frozenRef.current || !allowedRef.current || document.hidden) { last = 0; accumulator = 0; return; }
      const before = roundRef.current;
      if (!pendingRef.current && isMoving(before)) {
        accumulator += last ? Math.min((time - last) / 1000, 0.1) : 1 / 120;
        let next = before;
        while (accumulator >= 1 / 120 && isMoving(next)) { next = stepRound(next, 1 / 120); accumulator -= 1 / 120; }
        if (!isMoving(next)) accumulator = 0;
        commit(next);
        if (time - lastCheckpoint >= 250 || !isMoving(next)) {
          lastCheckpoint = time;
          const generation = epoch.current;
          void persist(next, generation).catch(cause => { if (generation === epoch.current) fail(cause); });
        }
      }
      last = time;
      raf.current = requestAnimationFrame(frame);
    };
    const resume = () => {
      cancelAnimationFrame(raf.current); last = 0; accumulator = 0;
      if (document.hidden) {
        const generation = epoch.current;
        void shotPromise.current.then(() => {
          if (generation === epoch.current && !restoreFailure.current) return persist(roundRef.current, generation);
        }).catch(cause => { if (generation === epoch.current) fail(cause); });
      } else if (!frozenRef.current) raf.current = requestAnimationFrame(frame);
    };
    document.addEventListener('visibilitychange', resume);
    raf.current = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf.current); document.removeEventListener('visibilitychange', resume); };
  }, [ready, frozen, host, pending, commit, persist, fail]);

  const takeShot = useCallback((impulse: Vec) => {
    if (!readyRef.current || pendingRef.current || frozenRef.current || !allowedRef.current || isMoving(roundRef.current) || roundRef.current.status !== 'playing') return;
    pendingRef.current = true; setPending(true);
    const generation = epoch.current;
    const proposed = shoot(roundRef.current, impulse);
    shotPromise.current = (async () => {
      try {
        // A stroke and its complete impulse are durable before simulation starts.
        if (await persist(proposed, generation)) commit(proposed);
      } catch (cause) { if (generation === epoch.current) fail(cause); }
      finally { if (generation === epoch.current) { pendingRef.current = false; setPending(false); } }
    })();
  }, [commit, fail, persist]);

  const replaceRound = useCallback((next: Round) => {
    if (!readyRef.current || pendingRef.current) return Promise.resolve();
    const generation = ++epoch.current;
    pendingRef.current = true; setPending(true);
    cancelAnimationFrame(raf.current);
    const operation = (async () => {
      try {
        if (await persist(next, generation)) {
          commit(next); saveFailure.current = false; restoreFailure.current = false; setRestoreFailed(false); setError('');
          frozenRef.current = !allowedRef.current; setFrozen(frozenRef.current);
        }
      } catch (cause) { if (generation === epoch.current) fail(cause); }
      finally { if (generation === epoch.current) { pendingRef.current = false; setPending(false); } }
    })();
    shotPromise.current = operation;
    return operation;
  }, [commit, fail, persist]);

  const newRound = useCallback(() => replaceRound(createRound(Date.now() % 2147483647)), [replaceRound]);
  const advance = useCallback(() => { if (roundRef.current.status === 'holed' && !pendingRef.current) return replaceRound(nextHole(roundRef.current)); }, [replaceRound]);
  const importRound = useCallback(async () => {
    stop(); await shotPromise.current;
    const generation = ++epoch.current;
    pendingRef.current = true; setPending(true);
    let imported = false;
    try {
      await queue.current;
      imported = await api.importProgress();
      if (generation !== epoch.current) return false;
      if (imported) {
        const saved = await api.loadRound();
        if (generation !== epoch.current) return false;
        if (!saved || !Number.isSafeInteger(saved.revision) || saved.revision < 0) throw new Error('No valid imported round was found.');
        const restored = validateRound(saved.state);
        revision.current = saved.revision; commit(restored); setError(''); saveFailure.current = false; restoreFailure.current = false; setRestoreFailed(false);
      }
      frozenRef.current = !allowedRef.current || saveFailure.current; setFrozen(frozenRef.current);
      return imported;
    } catch (cause) {
      if (generation === epoch.current) {
        if (imported) fail(cause);
        else { frozenRef.current = !allowedRef.current || saveFailure.current; setFrozen(frozenRef.current); }
      }
      throw cause;
    }
    finally { if (generation === epoch.current) { pendingRef.current = false; setPending(false); } }
  }, [api, commit, fail, stop]);

  const retrySave = useCallback(async () => {
    if (restoreFailure.current || pendingRef.current || !readyRef.current) return;
    const generation = epoch.current;
    pendingRef.current = true; setPending(true);
    try {
      if (await persist(roundRef.current, generation)) {
        saveFailure.current = false; setError(''); frozenRef.current = !allowedRef.current; setFrozen(frozenRef.current);
      }
    } catch (cause) { if (generation === epoch.current) fail(cause); }
    finally { if (generation === epoch.current) { pendingRef.current = false; setPending(false); } }
  }, [fail, persist]);
  const exportRound = useCallback(async () => { if (restoreFailure.current) return false; await shotPromise.current; await persist(roundRef.current); return api.exportProgress(); }, [api, persist]);
  return { host, round, ready, pending, frozen, error, restoreFailed, takeShot, newRound, advance, importRound, exportRound, retrySave };
}
