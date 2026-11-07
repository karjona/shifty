// What stands around each run down the mountain, beyond what the sim knows:
// how thick the pines grow along it, where the netting runs, the lodge, the
// lake, the lift's top station, rock outcrops on its walls and the creek.
// Positions are along the run: arc length `s` and offset (m, right of the
// direction of travel), as in the sim.

/** Rock outcrops scattered on the walls from `from` to `to`, `near` to `far` m beyond the riding limit. */
export interface Outcrops {
  from: number;
  to: number;
  count: number;
  near: number;
  far: number;
  /** Size of the biggest (m across). */
  size: number;
}

export interface RunScenery {
  /** How thick the pines stand along the edges at `s` (1: the usual). */
  forest(s: number): number;
  /** Pines grow only below this height (m); the mountain above is bare. */
  treeLine: number;
  /** Red netting along the edges at `s` (a run `half` wide there). */
  fenced(s: number, half: number, finishS: number): boolean;
  /** A lodge, `out` m beyond the riding limit on `side` (1: right), turned to face the run. */
  lodge: { s: number; out: number; side: 1 | -1; size: number };
  /** A frozen lake beside the run: its centre and half extents (m, along and across). */
  lake: { s: number; offset: number; along: number; across: number } | null;
  /** The chairlift's top station (its line runs from here down past the lift's towers). */
  liftTop: { s: number; offset: number } | null;
  outcrops: Outcrops[];
  /** A creek along the foot of the run's wall on `side`. */
  creek: { from: number; to: number; side: 1 | -1 } | null;
}

/** The mountain run: pines thickest through the S-turns and the gully, a lodge above the cliff drop. */
const MOUNTAIN: RunScenery = {
  forest: (s) => (s > 700 && s < 1000 ? 2.2 : s > 1100 && s < 1380 ? 1.4 : 1),
  treeLine: Infinity,
  fenced: (s, half, finishS) => half > 10 && s > 50 && s < finishS + 30,
  lodge: { s: 1040, out: 9, side: 1, size: 1 },
  lake: null,
  liftTop: null,
  outcrops: [],
  creek: null,
};

/**
 * The glades: bare rock and snow round the ridge, the couloir and the bowl
 * (above the trees), the pines closing in through the glades and down the
 * creek, netting only where the run is open, and the lodge by the lake.
 */
const GLADES: RunScenery = {
  forest: (s) => (s < 560 ? 0.1 : s < 640 ? 0.8 : s < 1210 ? 3.2 : s < 1480 ? 1.7 : s < 1880 ? 1.2 : 0.6),
  treeLine: 300,
  fenced: (s, half, finishS) => half > 12 && ((s > 190 && s < 560) || (s > 1600 && s < finishS + 30)),
  lodge: { s: 2010, out: 18, side: 1, size: 1.5 },
  lake: { s: 2010, offset: -78, along: 46, across: 30 },
  liftTop: { s: 26, offset: 30 },
  outcrops: [
    // The ridge and the rock round the couloir.
    { from: -40, to: 60, count: 18, near: 4, far: 40, size: 5 },
    { from: 55, to: 175, count: 46, near: 0.5, far: 22, size: 6 },
    // The bowl's rim.
    { from: 180, to: 600, count: 34, near: 10, far: 55, size: 7 },
    // The creek gully's walls.
    { from: 1215, to: 1480, count: 26, near: 0.5, far: 14, size: 3 },
  ],
  creek: { from: 1222, to: 1478, side: -1 },
};

/** The scenery of a run (`sim::CourseId`). */
export function runScenery(course: number): RunScenery {
  return course === 3 ? GLADES : MOUNTAIN;
}
