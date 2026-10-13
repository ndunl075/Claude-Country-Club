import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store, SHOT_HISTORY_LIMIT, SHOT_HISTORY_BYTES } from '../apps/desktop/src/main/store';
import { createRound, shoot, stepRound } from '../packages/game';
const cleanups: (()=>void)[]=[];
afterEach(()=>{for(const clean of cleanups.splice(0))clean();});
function setup(){const directory=mkdtempSync(path.join(tmpdir(),'ccc-store-'));let store=new Store(directory);cleanups.push(()=>{try{store.close();}catch{}rmSync(directory,{recursive:true,force:true});});return {get store(){return store;},restart(){store.close();store=new Store(directory);},directory};}
describe('durable round store',()=>{
  it('bounds old shot entries while preserving the current round and latest initial impulse',()=>{
    const ctx=setup();let latest;
    for(let i=1;i<=SHOT_HISTORY_LIMIT+3;i++){
      latest=shoot(createRound(i),{x:100,y:0});ctx.store.save(latest,i);
    }
    expect(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM shots').get()).toMatchObject({n:SHOT_HISTORY_LIMIT});
    expect(ctx.store.db.prepare('SELECT round_id FROM shots ORDER BY rowid LIMIT 1').get()).toMatchObject({round_id:'round-4'});
    const initial=ctx.store.db.prepare('SELECT state FROM shots ORDER BY rowid DESC LIMIT 1').get() as {state:string};
    const checkpoint=stepRound(latest!,1/120);ctx.store.save(checkpoint,SHOT_HISTORY_LIMIT+4);
    expect(ctx.store.db.prepare('SELECT state FROM shots ORDER BY rowid DESC LIMIT 1').get()).toEqual(initial);
    ctx.restart();expect(ctx.store.load()).toEqual({revision:SHOT_HISTORY_LIMIT+4,state:checkpoint});
  });
  it('bounds legacy history by UTF-8 payload bytes as well as row count',()=>{
    const {store}=setup();
    const insert=store.db.prepare('INSERT INTO shots VALUES(?,?,?)');
    for(let i=0;i<30;i++)insert.run(`legacy-${i}`,1,'é'.repeat(100_000));
    const round=shoot(createRound(37),{x:120,y:0});store.save(round,1);
    const stats=store.db.prepare('SELECT COUNT(*) AS n, SUM(length(CAST(state AS BLOB))) AS bytes FROM shots').get() as {n:number;bytes:number};
    expect(stats.n).toBeLessThanOrEqual(SHOT_HISTORY_LIMIT);expect(stats.bytes).toBeLessThanOrEqual(SHOT_HISTORY_BYTES);
    expect(stats.n).toBeGreaterThan(1);expect(store.load()).toEqual({revision:1,state:round});
    expect(store.db.prepare('SELECT round_id FROM shots ORDER BY rowid DESC LIMIT 1').get()).toMatchObject({round_id:round.id});
  });
  it('rolls back history pruning and new progress together when retention fails',()=>{
    const {store}=setup();const original=createRound(38);store.save(original,1);
    const insert=store.db.prepare('INSERT INTO shots VALUES(?,?,?)');
    for(let i=0;i<SHOT_HISTORY_LIMIT;i++)insert.run(`legacy-${i}`,1,'preserved history');
    store.db.exec("CREATE TRIGGER reject_pruning BEFORE DELETE ON shots BEGIN SELECT RAISE(ABORT,'retention fixture'); END;");
    expect(()=>store.save(shoot(original,{x:100,y:0}),2)).toThrow('retention fixture');
    expect(store.load()).toEqual({revision:1,state:original});
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM shots').get()).toMatchObject({n:SHOT_HISTORY_LIMIT});
    expect(store.db.prepare('SELECT state FROM shots WHERE round_id=?').get(original.id)).toBeUndefined();
    store.db.exec('DROP TRIGGER reject_pruning');store.save(shoot(original,{x:100,y:0}),2);
    expect(store.load()?.revision).toBe(2);
  });
  it('preserves the disk-full error and acknowledged round when SQLite exhausts its page budget',()=>{
    const {store}=setup();const round=createRound(34);store.save(round,1);
    store.db.exec('CREATE TABLE full_disk_fixture(payload BLOB);');
    const pages=(store.db.prepare('PRAGMA page_count').get() as {page_count:number}).page_count;
    store.db.exec(`PRAGMA max_page_count=${pages+1}; CREATE TRIGGER exhaust_disk BEFORE INSERT ON shots BEGIN INSERT INTO full_disk_fixture VALUES(zeroblob(1048576)); END;`);
    expect(()=>store.save(shoot(round,{x:100,y:0}),2)).toThrow(/database or disk is full/);
    expect(store.load()).toEqual({revision:1,state:round});
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM shots').get()).toMatchObject({n:0});
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM full_disk_fixture').get()).toMatchObject({n:0});
    store.db.exec('DROP TRIGGER exhaust_disk; PRAGMA max_page_count=1073741823;');
    store.save(shoot(round,{x:100,y:0}),2);expect(store.load()?.revision).toBe(2);
  });
  it('retains the write failure when SQLite has already rolled back the transaction',()=>{
    const {store}=setup();const round=createRound(35);store.save(round,1);
    store.db.exec("CREATE TRIGGER rollback_fixture BEFORE INSERT ON shots BEGIN SELECT RAISE(ROLLBACK,'storage transaction canceled'); END;");
    expect(()=>store.save(shoot(round,{x:100,y:0}),2)).toThrow('storage transaction canceled');
    expect(store.load()).toEqual({revision:1,state:round});
    store.db.exec('DROP TRIGGER rollback_fixture;');store.save(shoot(round,{x:100,y:0}),2);
    expect(store.load()?.revision).toBe(2);
  });
  it('recovers the exact acknowledged in-flight position and one stroke',()=>{const ctx=setup();const shot=stepRound(shoot(createRound(42),{x:250,y:75}),1/120);ctx.store.save(shot,1);ctx.restart();expect(ctx.store.load()).toEqual({revision:1,state:shot});});
  it('rejects stale saves without overwriting newer progress',()=>{const {store}=setup();const original=createRound(43);store.save(original,3);expect(()=>store.save(shoot(original,{x:120,y:0}),2)).toThrow('Stale');expect(store.load()?.state).toEqual(original);});
  it('does not count repeated checkpoints as more shots',()=>{const {store}=setup();const shot=shoot(createRound(45),{x:100,y:0});store.save(shot,1);store.save(stepRound(shot,1/120),2);expect(store.db.prepare('SELECT COUNT(*) AS n FROM shots').get()).toMatchObject({n:1});});
  it('rejects malformed saves and unknown export formats',()=>{const {store}=setup();store.save(createRound(1),1);expect(()=>store.save({...createRound(1),velocity:{x:NaN,y:0}},2)).toThrow();expect(()=>store.import({version:99})).toThrow();expect(store.load()?.revision).toBe(1);});
  it('preserves quiet defaults and validates setting ranges',()=>{const {store}=setup();expect(store.settings()).toMatchObject({automatic:false,startAtLogin:false,sound:false});expect(()=>store.setSettings({delayMs:0})).toThrow();expect(()=>store.setSettings({sound:'yes'})).toThrow();store.setSettings({reducedMotion:true});expect(store.settings().reducedMotion).toBe(true);});
  it('imports validated progress at a fresh local revision',()=>{const {store}=setup();store.save(createRound(2),2);store.import({format:'claude-country-club',version:1,round:{revision:999,state:createRound(3)}});expect(store.load()?.revision).toBe(3);expect((store.load()?.state as {seed:number}).seed).toBe(3);});
  it('recovers a corrupt round through validated import while retaining a database backup',()=>{const {store,directory}=setup();store.save(createRound(2),7);store.db.prepare("UPDATE round_save SET state='broken-json'").run();expect(()=>store.load()).toThrow();store.import({format:'claude-country-club',version:1,round:{revision:1,state:createRound(9)}});expect(store.load()?.revision).toBe(8);const backup=new DatabaseSync(path.join(directory,'country-club.sqlite.before-import'));try{expect(backup.prepare('SELECT state FROM round_save').get()).toMatchObject({state:'broken-json'});}finally{backup.close();}});
  it('rolls back round and stroke history together on a failed transaction',()=>{const {store}=setup();const round=createRound(31);store.save(round,1);store.db.exec("CREATE TRIGGER reject_shot BEFORE INSERT ON shots BEGIN SELECT RAISE(ABORT,'storage fixture'); END;");expect(()=>store.save(shoot(round,{x:100,y:0}),2)).toThrow();expect(store.load()).toEqual({revision:1,state:round});expect(store.db.prepare('SELECT COUNT(*) AS n FROM shots').get()).toMatchObject({n:0});});
  it('fails boundedly on locked storage and preserves acknowledged progress',()=>{const {store,directory}=setup();const round=createRound(32);store.save(round,1);const other=new DatabaseSync(path.join(directory,'country-club.sqlite'));try{other.exec('BEGIN IMMEDIATE');const start=performance.now();expect(()=>store.save(shoot(round,{x:100,y:0}),2)).toThrow();expect(performance.now()-start).toBeLessThan(1000);expect(store.load()).toEqual({revision:1,state:round});}finally{other.exec('ROLLBACK');other.close();}});
  it('refuses a future database schema without rewriting it',()=>{const ctx=setup();ctx.store.save(createRound(33),1);ctx.store.db.exec('PRAGMA user_version=999');ctx.store.close();const filename=path.join(ctx.directory,'country-club.sqlite');const before=readFileSync(filename);expect(()=>new Store(ctx.directory)).toThrow('newer');expect(readFileSync(filename)).toEqual(before);});
});
