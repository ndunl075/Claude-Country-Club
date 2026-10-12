import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, copyFileSync, existsSync, mkdtempSync, rmSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, SavedRound, Settings } from '../../../../packages/contracts';
import { validateRound } from '../../../../packages/game';
import { assertNoPendingRecovery, RecoverableStorageError } from './storageRecovery';

export const SHOT_HISTORY_LIMIT = 128;
export const SHOT_HISTORY_BYTES = 4 * 1024 * 1024;

export function validateSettings(patch: unknown): Partial<Settings> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings');
  const result: Partial<Settings> = {};
  const allowed = ['automatic','sound','reducedMotion','highContrast','startAtLogin'] as const;
  for (const key of allowed) if (key in patch) {
    const value = (patch as Record<string, unknown>)[key]; if (typeof value !== 'boolean') throw new Error(`Invalid ${key}`);
    result[key] = value;
  }
  if ('delayMs' in patch) { const n = (patch as Settings).delayMs; if (!Number.isInteger(n) || n < 1000 || n > 30_000) throw new Error('Delay must be between 1 and 30 seconds'); result.delayMs = n; }
  if ('selectedSession' in patch) { const key = (patch as Settings).selectedSession; if (key !== null && (typeof key !== 'string' || !/^(claude|codex):[a-zA-Z0-9_.:-]{1,128}$/.test(key))) throw new Error('Invalid session'); result.selectedSession = key; }
  return result;
}
export class Store {
  readonly db: DatabaseSync;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertNoPendingRecovery(directory);
    const filename = path.join(directory, 'country-club.sqlite');
    // Even a read-only SQLite connection can rewrite shared-memory sidecars.
    // Inspect a private copy before opening originals or running schema writes.
    // Only SQLite's explicit corruption codes permit the recovery flow.
    if(existsSync(filename)) {
      const inspection=mkdtempSync(path.join(directory,'.storage-check-'));
      let probe:DatabaseSync|undefined;
      try {
        for(const name of ['country-club.sqlite','country-club.sqlite-wal','country-club.sqlite-shm']) {
          const source=path.join(directory,name);
          if(!existsSync(source))continue;
          const entry=lstatSync(source);
          if(!entry.isFile() || entry.isSymbolicLink())throw new Error('Database files are not regular files. Keep them unchanged for manual review.');
          copyFileSync(source,path.join(inspection,name));
          const after=lstatSync(source);
          if(after.size!==entry.size || after.mtimeMs!==entry.mtimeMs)throw new Error('Database files changed during inspection. Close other copies and try again.');
        }
        probe=new DatabaseSync(path.join(inspection,'country-club.sqlite'),{readOnly:true});
        probe.exec('PRAGMA busy_timeout=50;');
        const version=probe.prepare('PRAGMA user_version').get() as {user_version:number};
        if(version.user_version>1)throw new Error('This save needs a newer Country Club version. Your data has been preserved.');
        const results=probe.prepare('PRAGMA quick_check(1)').all();
        if(results.length!==1 || Object.values(results[0])[0]!=='ok')throw new RecoverableStorageError('The saved database is damaged. Your original files have been preserved.');
      } catch(error) {
        const code=(error as {errcode?:number})?.errcode;
        if(code===11 || code===26)throw new RecoverableStorageError('The saved database is damaged. Your original files have been preserved.');
        throw error;
      } finally {try{probe?.close();}finally{rmSync(inspection,{recursive:true,force:true});}}
    }
    this.db = new DatabaseSync(filename);
    try {
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=50;');
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version > 1) { this.db.close(); throw new Error('This save needs a newer Country Club version. Your data has been preserved.'); }
    this.db.exec(`BEGIN; CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS round_save(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shots(round_id TEXT NOT NULL, shot_id INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(round_id,shot_id));
      PRAGMA user_version=1; COMMIT;`);
    } catch (error) { try { this.db.close(); } catch {} throw error; }
  }
  settings(): Settings {
    const record = this.db.prepare("SELECT value FROM settings WHERE key='preferences'").get() as {value:string} | undefined;
    if (!record) return { ...DEFAULT_SETTINGS };
    try { return { ...DEFAULT_SETTINGS, ...validateSettings(JSON.parse(record.value)) }; } catch { return { ...DEFAULT_SETTINGS }; }
  }
  setSettings(patch: unknown): Settings {
    const next = { ...this.settings(), ...validateSettings(patch) };
    this.db.prepare("INSERT INTO settings VALUES('preferences',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(next)); return next;
  }
  load(): SavedRound | null {
    const row = this.db.prepare('SELECT revision,state FROM round_save WHERE id=1').get() as {revision:number,state:string} | undefined;
    if (!row) return null;
    return { revision: row.revision, state: validateRound(JSON.parse(row.state)) };
  }
  revision(): number {
    return (this.db.prepare('SELECT revision FROM round_save WHERE id=1').get() as {revision:number}|undefined)?.revision ?? 0;
  }
  save(value: unknown, revision: number): {revision: number} {
    const round = validateRound(value);
    if (!Number.isSafeInteger(revision) || revision <= 0) throw new Error('Invalid save revision');
    const json = JSON.stringify(round); if (Buffer.byteLength(json) > 256_000) throw new Error('Save too large');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.db.prepare('SELECT revision FROM round_save WHERE id=1').get() as {revision:number} | undefined;
      if (old && revision <= old.revision) throw new Error('Stale save revision');
      this.db.prepare('INSERT INTO round_save VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state=excluded.state').run(revision,json);
      if (round.shotId > 0) this.db.prepare('INSERT OR IGNORE INTO shots VALUES(?,?,?)').run(round.id,round.shotId,json);
      // History is a bounded journal, not the authoritative current round.
      // Keep the newest inserted entries within both limits. Include pruning
      // in this transaction so failure cannot acknowledge a partial save.
      this.db.prepare(`DELETE FROM shots WHERE rowid IN (
        SELECT entry FROM (
          SELECT rowid AS entry,
            ROW_NUMBER() OVER (ORDER BY rowid DESC) AS position,
            SUM(length(CAST(state AS BLOB))) OVER (ORDER BY rowid DESC ROWS UNBOUNDED PRECEDING) AS bytes
          FROM shots
        ) WHERE position > ? OR bytes > ?
      )`).run(SHOT_HISTORY_LIMIT, SHOT_HISTORY_BYTES);
      this.db.exec('COMMIT'); return { revision };
    } catch (error) {
      // SQLite can end a transaction itself after a write failure. Retain the
      // original failure even when there is no remaining transaction to undo.
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
  export() { return { format: 'claude-country-club', version: 1, round: this.load() }; }
  import(value: unknown) {
    const data = value as {format?:string;version?:number;round?:SavedRound};
    if (data?.format !== 'claude-country-club' || data.version !== 1 || !data.round) throw new Error('Invalid progress file');
    const round = validateRound(data.round.state);
    const checkpoint = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {busy:number};
    if (checkpoint.busy !== 0) throw new Error('Storage is busy. Import was canceled; existing progress was preserved.');
    const file = path.join(this.directory, 'country-club.sqlite');
    if (existsSync(file)) copyFileSync(file, `${file}.before-import`);
    return this.save(round, this.revision() + 1);
  }
  close() { this.db.close(); }
}
