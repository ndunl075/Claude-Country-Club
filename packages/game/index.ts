import { BALL_RADIUS as R, WIDTH, HEIGHT } from './types';
import type { Hole, Round, Vec, Wall, Zone } from './types';
import { generateCourses } from '../courses';
export * from './types';

const speed = (v: Vec) => Math.hypot(v.x, v.y);
const clone = (r: Round): Round => ({ ...r, ball: { ...r.ball }, velocity: { ...r.velocity }, safe: { ...r.safe }, scores: [...r.scores] });
const contains = (p: Vec, z: Zone) => p.x >= z.x && p.x <= z.x + z.width && p.y >= z.y && p.y <= z.y + z.height;
const distance = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
export const isMoving = (r: Round): boolean => r.status === 'playing' && speed(r.velocity) > 0;
export const totalScore = (r: Round): number => r.scores.reduce((a, b) => a + b, 0) + (r.status === 'playing' ? r.strokes : 0);

export function createRound(seed = Date.now() >>> 0): Round {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Invalid course seed');
  const holes = generateCourses(seed), ball = { ...holes[0]!.tee };
  return { schemaVersion: 1, physicsVersion: 1, id: `round-${seed}`, seed, holes, holeIndex: 0, ball, safe: { ...ball }, velocity: { x: 0, y: 0 }, strokes: 0, scores: [], tick: 0, status: 'playing', shotId: 0 };
}

export function shoot(round: Round, impulse: Vec): Round {
  const r = clone(round);
  if (isMoving(r) || r.status !== 'playing' || !Number.isFinite(impulse.x) || !Number.isFinite(impulse.y)) return r;
  const s = speed(impulse);
  if (!Number.isFinite(s) || s < 1) return r;
  const scale = Math.min(720, s) / s;
  r.safe = { ...r.ball }; r.velocity = { x: impulse.x * scale, y: impulse.y * scale }; r.strokes++; r.shotId++;
  return r;
}

function collide(r: Round, wall: Wall): void {
  const dx = wall.b.x - wall.a.x, dy = wall.b.y - wall.a.y;
  const t = Math.max(0, Math.min(1, ((r.ball.x - wall.a.x) * dx + (r.ball.y - wall.a.y) * dy) / (dx * dx + dy * dy)));
  const x = wall.a.x + dx * t, y = wall.a.y + dy * t;
  const dist = Math.hypot(r.ball.x - x, r.ball.y - y);
  if (dist >= R) return;
  let nx = (r.ball.x - x) / dist, ny = (r.ball.y - y) / dist;
  if (dist < 1e-9) { const length = Math.hypot(dx, dy); nx = -dy / length; ny = dx / length; if (r.velocity.x * nx + r.velocity.y * ny > 0) { nx = -nx; ny = -ny; } }
  r.ball.x = x + nx * (R + 1e-5); r.ball.y = y + ny * (R + 1e-5);
  const incoming = r.velocity.x * nx + r.velocity.y * ny;
  if (incoming < 0) { r.velocity.x -= 1.78 * incoming * nx; r.velocity.y -= 1.78 * incoming * ny; }
}

const borders: Wall[] = [{ a: { x: 0, y: 0 }, b: { x: WIDTH, y: 0 } }, { a: { x: WIDTH, y: 0 }, b: { x: WIDTH, y: HEIGHT } }, { a: { x: WIDTH, y: HEIGHT }, b: { x: 0, y: HEIGHT } }, { a: { x: 0, y: HEIGHT }, b: { x: 0, y: 0 } }];
export function stepRound(round: Round, dt: number): Round {
  const r = clone(round);
  if (!Number.isFinite(dt) || dt <= 0 || r.status !== 'playing') return r;
  // Bounded catch-up: a suspended renderer never simulates minutes of lost time.
  const duration = Math.min(dt, 0.1), n = Math.ceil(duration / (1 / 240)), h = duration / n;
  const hole = r.holes[r.holeIndex]!;
  r.tick++;
  for (let i = 0; i < n; i++) {
    r.ball.x += r.velocity.x * h; r.ball.y += r.velocity.y * h;
    // Two relaxation passes resolve corners without tunneling (max travel 3px).
    for (let pass = 0; pass < 2; pass++) for (const w of [...borders, ...hole.walls]) collide(r, w);
    r.ball.x = Math.max(R, Math.min(WIDTH - R, r.ball.x)); r.ball.y = Math.max(R, Math.min(HEIGHT - R, r.ball.y));
    if (hole.zones.some(z => z.kind === 'water' && contains(r.ball, z))) {
      // The shot already cost a stroke. Water adds exactly one penalty, restores
      // the last resting lie and ends motion, so subsequent ticks cannot charge again.
      r.strokes++; r.ball = { ...r.safe }; r.velocity = { x: 0, y: 0 }; break;
    }
    if (r.strokes > 0 && distance(r.ball, hole.cup) <= 12 && speed(r.velocity) <= 135) {
      r.ball = { ...hole.cup }; r.velocity = { x: 0, y: 0 }; r.status = 'holed'; r.scores.push(r.strokes); break;
    }
    const friction = hole.zones.some(z => z.kind === 'sand' && contains(r.ball, z)) ? 330 : 85;
    const s = speed(r.velocity), remaining = Math.max(0, s - friction * h);
    const scale = s > 0 && remaining >= 4 ? remaining / s : 0;
    r.velocity.x *= scale; r.velocity.y *= scale;
    if (scale === 0) { r.safe = { ...r.ball }; break; }
  }
  return r;
}

export function nextHole(round: Round): Round {
  const r = clone(round);
  if (r.status !== 'holed') return r;
  if (r.holeIndex === r.holes.length - 1) { r.status = 'complete'; return r; }
  r.holeIndex++; r.ball = { ...r.holes[r.holeIndex]!.tee }; r.safe = { ...r.ball }; r.velocity = { x: 0, y: 0 }; r.strokes = 0; r.status = 'playing';
  return r;
}

// Reconstruct allowlisted values rather than trusting persisted object shapes.
function object(v: unknown, keys: string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) throw new Error('Invalid save object');
  return v as Record<string, unknown>;
}
function number(v: unknown, min: number, max: number, integer = false): number { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) throw new Error('Invalid save number'); return v; }
function string(v: unknown, max: number): string { if (typeof v !== 'string' || !v.length || v.length > max || /[\x00-\x1f]/.test(v)) throw new Error('Invalid save string'); return v; }
function list(v: unknown, max: number): unknown[] { if (!Array.isArray(v) || v.length > max) throw new Error('Invalid save array'); return v; }
function vec(v: unknown, velocity = false): Vec { const o = object(v, ['x', 'y']); return { x: number(o.x, velocity ? -720 : 0, velocity ? 720 : WIDTH), y: number(o.y, velocity ? -720 : 0, velocity ? 720 : HEIGHT) }; }
function parseHole(v: unknown): Hole {
  const o = object(v, ['id', 'name', 'par', 'theme', 'tee', 'cup', 'walls', 'zones']);
  if (!['garden', 'coast', 'night'].includes(o.theme as string)) throw new Error('Invalid theme');
  const walls = list(o.walls, 48).map(v => { const w = object(v, ['a', 'b']); const a = vec(w.a), b = vec(w.b); if (distance(a, b) < 1) throw new Error('Degenerate wall'); return { a, b }; });
  const zones = list(o.zones, 16).map(v => { const z = object(v, ['x', 'y', 'width', 'height', 'kind']); if (z.kind !== 'sand' && z.kind !== 'water') throw new Error('Invalid zone'); const result: Zone = { x: number(z.x, 0, WIDTH), y: number(z.y, 0, HEIGHT), width: number(z.width, 1, WIDTH), height: number(z.height, 1, HEIGHT), kind: z.kind }; if (result.x + result.width > WIDTH || result.y + result.height > HEIGHT) throw new Error('Zone exceeds course'); return result; });
  const tee = vec(o.tee), cup = vec(o.cup);
  for (const point of [tee, cup]) {
    if (point.x < 20 || point.x > WIDTH - 20 || point.y < 20 || point.y > HEIGHT - 20 || zones.some(z => contains(point, z))) throw new Error('Unsafe endpoint');
    for (const w of walls) { const dx = w.b.x - w.a.x, dy = w.b.y - w.a.y, t = Math.max(0, Math.min(1, ((point.x - w.a.x) * dx + (point.y - w.a.y) * dy) / (dx * dx + dy * dy))); if (distance(point, { x: w.a.x + dx * t, y: w.a.y + dy * t }) < 20) throw new Error('Blocked endpoint'); }
  }
  return { id: string(o.id, 64), name: string(o.name, 64), par: number(o.par, 1, 9, true), theme: o.theme as Hole['theme'], tee, cup, walls, zones };
}

export function validateRound(value: unknown): Round {
  const o = object(value, ['schemaVersion', 'physicsVersion', 'id', 'seed', 'holes', 'holeIndex', 'ball', 'velocity', 'safe', 'strokes', 'scores', 'tick', 'status', 'shotId']);
  if (o.schemaVersion !== 1 || o.physicsVersion !== 1) throw new Error('Unsupported save or physics version');
  const holes = list(o.holes, 9).map(parseHole);
  if (holes.length !== 9 || new Set(holes.map(h => h.id)).size !== holes.length) throw new Error('Invalid hole set');
  if (o.status !== 'playing' && o.status !== 'holed' && o.status !== 'complete') throw new Error('Invalid round status');
  const r: Round = { schemaVersion: 1, physicsVersion: 1, id: string(o.id, 80), seed: number(o.seed, 0, 0xffffffff, true), holes, holeIndex: number(o.holeIndex, 0, 8, true), ball: vec(o.ball), safe: vec(o.safe), velocity: vec(o.velocity, true), strokes: number(o.strokes, 0, 1000000, true), scores: list(o.scores, 9).map(v => number(v, 1, 1000000, true)), tick: number(o.tick, 0, Number.MAX_SAFE_INTEGER, true), status: o.status, shotId: number(o.shotId, 0, 1000000, true) };
  if (speed(r.velocity) > 720.001 || r.scores.length !== r.holeIndex + (r.status === 'playing' ? 0 : 1) || (r.status === 'complete' && r.holeIndex !== 8) || (r.status !== 'playing' && (speed(r.velocity) !== 0 || r.scores.at(-1) !== r.strokes || distance(r.ball, holes[r.holeIndex]!.cup) > 0.01))) throw new Error('Inconsistent round state');
  const current = holes[r.holeIndex]!;
  for (const p of [r.ball, r.safe]) {
    if (p.x < R || p.x > WIDTH - R || p.y < R || p.y > HEIGHT - R || current.zones.some(z => z.kind === 'water' && contains(p, z))) throw new Error('Invalid ball lie');
    for (const w of current.walls) {
      const dx = w.b.x - w.a.x, dy = w.b.y - w.a.y;
      const t = Math.max(0, Math.min(1, ((p.x - w.a.x) * dx + (p.y - w.a.y) * dy) / (dx * dx + dy * dy)));
      if (distance(p, { x: w.a.x + dx * t, y: w.a.y + dy * t }) < R - 0.001) throw new Error('Ball intersects wall');
    }
  }
  const counted = totalScore(r);
  if (counted < r.shotId || counted > r.shotId * 2) throw new Error('Inconsistent strokes');
  return r;
}
