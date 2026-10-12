import type { Hole, Vec, Wall, Zone } from '../game/types';

const wall = (x: number, y: number, xx: number, yy: number): Wall => ({ a: { x, y }, b: { x: xx, y: yy } });
const zone = (x: number, y: number, width: number, height: number, kind: Zone['kind']): Zone => ({ x, y, width, height, kind });
const hole = (id: string, name: string, theme: Hole['theme'], par: number, tee: Vec, cup: Vec, walls: Wall[], zones: Zone[] = []): Hole => ({ id, name, theme, par, tee, cup, walls, zones });

// Each route has wide alternative approaches. Reflections preserve route clearance;
// decoration is never generated into a playable corridor.
export const CURATED_HOLES: Hole[] = [
  hole('garden-welcome', 'First Light', 'garden', 2, { x: 140, y: 300 }, { x: 760, y: 300 }, []),
  hole('garden-gate', 'Garden Gate', 'garden', 3, { x: 140, y: 420 }, { x: 760, y: 180 }, [wall(450, 80, 450, 260), wall(450, 360, 450, 520)]),
  hole('garden-zigzag', 'Hedge Hop', 'garden', 4, { x: 120, y: 160 }, { x: 780, y: 440 }, [wall(330, 0, 330, 340), wall(580, 260, 580, 600)]),
  hole('coast-shore', 'Shore Thing', 'coast', 3, { x: 130, y: 300 }, { x: 770, y: 300 }, [], [zone(350, 220, 200, 160, 'sand')]),
  hole('coast-island', 'Island Time', 'coast', 4, { x: 120, y: 300 }, { x: 780, y: 300 }, [], [zone(340, 190, 220, 220, 'water')]),
  hole('coast-breakwater', 'Breakwater', 'coast', 4, { x: 130, y: 460 }, { x: 770, y: 140 }, [wall(300, 200, 600, 200), wall(600, 200, 600, 430)], [zone(350, 350, 140, 130, 'sand')]),
  hole('night-orbit', 'Moon Orbit', 'night', 3, { x: 140, y: 300 }, { x: 760, y: 300 }, [wall(400, 210, 500, 210), wall(500, 210, 540, 300), wall(540, 300, 500, 390), wall(500, 390, 400, 390), wall(400, 390, 360, 300), wall(360, 300, 400, 210)]),
  hole('night-bank', 'Bank Shot', 'night', 3, { x: 150, y: 450 }, { x: 750, y: 150 }, [wall(350, 450, 550, 250), wall(550, 250, 670, 250)]),
  hole('night-finale', 'Last Lantern', 'night', 4, { x: 120, y: 480 }, { x: 780, y: 120 }, [wall(300, 200, 300, 430), wall(600, 170, 600, 400)], [zone(380, 230, 140, 140, 'sand'), zone(390, 470, 120, 90, 'water')]),
];

export function generateCourses(seed: number): Hole[] {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const reflectX = random() < 0.5, reflectY = random() < 0.5;
  const map = (v: Vec): Vec => ({ x: reflectX ? 900 - v.x : v.x, y: reflectY ? 600 - v.y : v.y });
  const rotation = Math.floor(random() * 9);
  return Array.from({ length: 9 }, (_, i) => {
    const base = CURATED_HOLES[(i + rotation) % 9]!;
    return { ...base, tee: map(base.tee), cup: map(base.cup), walls: base.walls.map(w => ({ a: map(w.a), b: map(w.b) })), zones: base.zones.map(z => ({ ...z, x: reflectX ? 900 - z.x - z.width : z.x, y: reflectY ? 600 - z.y - z.height : z.y })) };
  });
}
