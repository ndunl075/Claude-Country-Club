export interface Vec { x: number; y: number; }
export interface Wall { a: Vec; b: Vec; }
export interface Zone { x: number; y: number; width: number; height: number; kind: 'sand' | 'water'; }
export interface Hole { id: string; name: string; par: number; theme: 'garden' | 'coast' | 'night'; tee: Vec; cup: Vec; walls: Wall[]; zones: Zone[]; }
export interface Round {
  schemaVersion: 1; physicsVersion: 1; id: string; seed: number; holes: Hole[]; holeIndex: number;
  ball: Vec; velocity: Vec; safe: Vec; strokes: number; scores: number[];
  tick: number; status: 'playing' | 'holed' | 'complete'; shotId: number;
}
export const WIDTH = 900; export const HEIGHT = 600; export const BALL_RADIUS = 8;
