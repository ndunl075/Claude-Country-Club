import { describe, expect, it } from 'vitest';
import { createRound, isMoving, nextHole, shoot, stepRound, totalScore, validateRound } from '../packages/game';
import { generateCourses } from '../packages/courses';
import type { Round } from '../packages/game/types';

function plain(): Round {
  const r = createRound(11);
  r.holes[0] = { id: 'test', name: 'Test', theme: 'garden', par: 2, tee: { x: 100, y: 300 }, cup: { x: 800, y: 300 }, walls: [], zones: [] };
  r.ball = { ...r.holes[0]!.tee }; r.safe = { ...r.ball }; return r;
}
function settle(r: Round): Round { for (let i = 0; i < 4000 && isMoving(r); i++) r = stepRound(r, 1 / 120); return r; }

describe('deterministic local golf', () => {
  it('has nine distinct, repeatable holes and bounded fresh variants', () => {
    expect(createRound(44)).toEqual(createRound(44));
    const r = createRound(44);
    expect(new Set(r.holes.map(h => h.id)).size).toBe(9);
    expect(r.holes.filter(h => h.theme === 'garden')).toHaveLength(3);
    expect(new Set(Array.from({ length: 40 }, (_, seed) => JSON.stringify(generateCourses(seed)))).size).toBeGreaterThan(10);
  });
  it('replays identically after saving in motion without changing the input round', () => {
    const original = plain(), json = JSON.stringify(original);
    let r = shoot(original, { x: 490, y: -123 });
    for (let i = 0; i < 30; i++) r = stepRound(r, 1 / 120);
    const saved = validateRound(JSON.parse(JSON.stringify(r)));
    expect(settle(r)).toEqual(settle(saved));
    expect(JSON.stringify(original)).toBe(json);
  });
  it('charges exactly one stroke and ignores another shot in flight', () => {
    const r = shoot(plain(), { x: 200, y: 0 });
    expect(r.strokes).toBe(1); expect(r.shotId).toBe(1);
    expect(shoot(r, { x: 200, y: 0 })).toEqual(r);
    expect(settle(r).strokes).toBe(1);
    expect(shoot(plain(), { x: NaN, y: 1 }).strokes).toBe(0);
    expect(shoot(plain(), { x: 0, y: 0 }).strokes).toBe(0);
  });
  it('limits power and catch-up time', () => {
    const r = shoot(plain(), { x: 9000, y: 0 });
    expect(r.velocity.x).toBe(720);
    expect(stepRound(r, 100)).toEqual(stepRound(r, 0.1));
    expect(stepRound(r, Infinity)).toEqual(r);
  });
  it('reflects a fast ball at thin walls without crossing them', () => {
    const r = plain(); r.ball.x = 180; r.holes[0]!.walls = [{ a: { x: 200, y: 0 }, b: { x: 200, y: 600 } }];
    const after = stepRound(shoot(r, { x: 720, y: 0 }), 0.1);
    expect(after.ball.x).toBeLessThan(192); expect(after.velocity.x).toBeLessThan(0);
  });
  it('resolves segment endpoints and world corners to finite in-bounds positions', () => {
    let r = plain(); r.ball = { x: 190, y: 190 }; r.holes[0]!.walls = [{ a: { x: 200, y: 200 }, b: { x: 300, y: 200 } }];
    r = stepRound(shoot(r, { x: 500, y: 500 }), 0.03);
    expect(Math.hypot(r.ball.x - 200, r.ball.y - 200)).toBeGreaterThanOrEqual(8);
    r = plain(); r.ball = { x: 10, y: 10 }; r = settle(shoot(r, { x: -500, y: -500 }));
    expect(r.ball.x).toBeGreaterThanOrEqual(8); expect(r.ball.y).toBeGreaterThanOrEqual(8);
    expect(Number.isFinite(r.ball.x + r.ball.y)).toBe(true);
  });
  it('captures slow putts, records score once and advances only when holed', () => {
    let r = plain(); r.holes[0]!.cup = { x: 140, y: 300 };
    r = settle(shoot(r, { x: 100, y: 0 }));
    expect(r.status).toBe('holed'); expect(r.scores).toEqual([1]); expect(totalScore(r)).toBe(1);
    expect(stepRound(r, 0.1)).toEqual(r);
    const next = nextHole(r); expect(next.holeIndex).toBe(1); expect(next.strokes).toBe(0);
    expect(nextHole(next)).toEqual(next);
  });
  it('a fast pass over the cup does not sink', () => {
    const r = plain(); r.holes[0]!.cup = { x: 140, y: 300 };
    expect(stepRound(shoot(r, { x: 600, y: 0 }), 0.1).status).toBe('playing');
  });
  it('sand increases drag and water restores the pre-shot lie with one penalty', () => {
    const dry = plain(), sand = plain(); sand.holes[0]!.zones = [{ x: 80, y: 200, width: 600, height: 200, kind: 'sand' }];
    expect(settle(shoot(sand, { x: 200, y: 0 })).ball.x).toBeLessThan(settle(shoot(dry, { x: 200, y: 0 })).ball.x);
    const water = plain(); water.holes[0]!.zones = [{ x: 130, y: 200, width: 200, height: 200, kind: 'water' }];
    const wet = settle(shoot(water, { x: 200, y: 0 }));
    expect(wet.ball).toEqual(water.ball); expect(wet.strokes).toBe(2); expect(wet.velocity).toEqual({ x: 0, y: 0 });
    expect(stepRound(wet, 0.1).strokes).toBe(2);
    expect(settle(shoot(wet, { x: 200, y: 0 })).strokes).toBe(4);
  });
  it('ends the nine-hole round with exactly nine score entries', () => {
    let r = plain(); r.holeIndex = 8; r.scores = Array(8).fill(2); r.strokes = 1; r.shotId = 17; r.status = 'holed'; r.ball = { ...r.holes[8]!.cup }; r.scores.push(1);
    r = nextHole(r); expect(r.status).toBe('complete'); expect(totalScore(r)).toBe(17); expect(validateRound(r)).toEqual(r);
  });
});

describe('strict save validation', () => {
  it('round-trips all generated courses and returns an independent copy', () => {
    for (let seed = 0; seed < 100; seed++) {
      const r = createRound(seed), loaded = validateRound(r); expect(loaded).toEqual(r); expect(loaded.holes).not.toBe(r.holes);
    }
  });
  it.each([
    (r: any) => r.schemaVersion = 2,
    (r: any) => r.physicsVersion = 2,
    (r: any) => r.ball.x = NaN,
    (r: any) => r.velocity.x = 721,
    (r: any) => r.holeIndex = 9,
    (r: any) => r.status = 'flying',
    (r: any) => r.extra = 'untrusted',
    (r: any) => r.ball.extra = 42,
    (r: any) => r.holes[0].theme = 'unknown',
    (r: any) => r.holes[0].par = 1.5,
    (r: any) => r.holes[0].tee.x = 0,
    (r: any) => r.holes[0].zones.push({ x: 899, y: 0, width: 100, height: 50, kind: 'water' }),
    (r: any) => r.holes[0].walls.push({ a: { x: 50, y: 50 }, b: { x: 50, y: 50 } }),
    (r: any) => r.scores.push(1),
    (r: any) => r.strokes = 100,
    (r: any) => r.holes[1].id = r.holes[0].id,
  ])('rejects corrupt and unsupported save fields %#', mutate => { const r = createRound(10); mutate(r); expect(() => validateRound(r)).toThrow(); });
});

it('every generated hole retains a dry, ball-width route to the cup', () => {
  // Independent grid flood fill checks routes rather than the generator implementation.
  for (let seed = 0; seed < 36; seed++) for (const h of generateCourses(seed)) {
    const step = 10, nx = 89, ny = 59;
    const free = (x: number, y: number) => !h.zones.some(z => z.kind === 'water' && x >= z.x - 9 && x <= z.x + z.width + 9 && y >= z.y - 9 && y <= z.y + z.height + 9) && !h.walls.some(w => { const dx = w.b.x - w.a.x, dy = w.b.y - w.a.y; const t = Math.max(0, Math.min(1, ((x - w.a.x) * dx + (y - w.a.y) * dy) / (dx * dx + dy * dy))); return Math.hypot(x - w.a.x - dx * t, y - w.a.y - dy * t) < 12; });
    const start = [Math.round(h.tee.x / step) - 1, Math.round(h.tee.y / step) - 1], target = [Math.round(h.cup.x / step) - 1, Math.round(h.cup.y / step) - 1];
    const queue = [start], seen = new Set([start.join(',')]); let reached = false;
    for (let i = 0; i < queue.length; i++) { const [x, y] = queue[i]!; if (x === target[0] && y === target[1]) { reached = true; break; } for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x! + dx!, yy = y! + dy!, key = `${xx},${yy}`; if (xx >= 0 && xx < nx && yy >= 0 && yy < ny && !seen.has(key) && free((xx + 1) * step, (yy + 1) * step)) { seen.add(key); queue.push([xx, yy]); } } }
    expect(reached, `${seed}:${h.id}`).toBe(true);
  }
});
it('does not charge a stroke for finite components with an overflowing magnitude',()=>{
  const round=createRound(55);
  expect(shoot(round,{x:Number.MAX_VALUE,y:Number.MAX_VALUE})).toEqual(round);
});
