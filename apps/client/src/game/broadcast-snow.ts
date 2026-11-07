// Television at the bottom of the mountain: the finish area. A camera low
// past the finish arch watches riders come through and skid to a stop, a
// long lens under the arch picks up riders coming down the final pitch, a
// camera circles a rider standing in the finish area, and a crane circling
// the finish area and a high wide shot take in the whole of it. A rider still up the run (watching a race you
// joined midway) is followed by cameras set beside the run ahead of it, and
// a drone. At the bottom of the glades, a camera on the lodge's deck and one
// across the frozen lake look on at the finish area too.
import * as THREE from "three/webgpu";
import type { RunData } from "../render/mountain.ts";
import { runScenery } from "../render/runs.ts";
import type { Environment, RiderView } from "../render/world.ts";
import { type Rig, type Watch, clear, drone, onRider } from "./broadcast-rig.ts";

/** Past the finish, the finish area reaches this far (m). */
const AREA = 70;
/** The final pitch, as the camera under the arch sees it (m before the finish). */
const PITCH_FROM = 130;
const PITCH_TO = 22;
/** Riders this far above the finish (m) are on the run, not the finish. */
const UP_THE_RUN = 150;

/** Where riders are along the run (m), from its centre line (kept per seat, so each frame looks near the last). */
class Along {
  private last = new Map<number, number>();
  private run: RunData;

  constructor(run: RunData) {
    this.run = run;
  }

  of(r: RiderView): number {
    const path = this.run.path;
    const best = (from: number, to: number) => {
      let bi = from;
      let bd = Infinity;
      for (let i = Math.max(0, from); i <= Math.min(path.length - 1, to); i++) {
        const p = path[i]!;
        const d = (p.x - r.x) ** 2 + (p.z - r.z) ** 2;
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      return { i: bi, d: bd };
    };
    let found = best((this.last.get(r.slot) ?? 0) - 12, (this.last.get(r.slot) ?? 0) + 12);
    if (found.d > 30 * 30) found = best(0, path.length - 1);
    this.last.set(r.slot, found.i);
    const p = path[found.i]!;
    // Along the centre line from the nearest point.
    return p.s + (r.x - p.x) * Math.sin(p.yaw) + (r.z - p.z) * Math.cos(p.yaw);
  }
}

/** The cameras for a run (`course`: `sim::CourseId`, for the cameras only some runs have). */
export function snowRigs(
  run: RunData,
  env: Environment,
  heights?: (points: Float32Array) => Float32Array,
  course = 1,
): Rig[] {
  const along = new Along(run);
  const finish = run.finishS;
  const ground = (x: number, z: number) => env.ground(x, z, 0);
  /** A point `offset` m right of the centre line at `s`, `up` m over the snow. */
  const on = (s: number, offset: number, up: number) => {
    const path = run.path;
    const i = Math.max(0, Math.min(path.length - 1, Math.round((s - path[0]!.s) / 4)));
    const p = path[i]!;
    const x = p.x - Math.cos(p.yaw) * offset;
    const z = p.z + Math.sin(p.yaw) * offset;
    return new THREE.Vector3(x, ground(x, z) + up, z);
  };
  // The snow in the way, sampled in one go.
  const probe = new Float32Array(32);
  const sightAt = new THREE.Vector3();
  const sees = (eye: THREE.Vector3, r: RiderView) => {
    sightAt.set(r.x, r.y + 0.5, r.z);
    if (!heights) return clear(eye, sightAt, ground, 8);
    for (let i = 0; i < 16; i++) {
      const k = (i + 1) / 17;
      probe[i * 2] = eye.x + (sightAt.x - eye.x) * k;
      probe[i * 2 + 1] = eye.z + (sightAt.z - eye.z) * k;
    }
    const h = heights(probe);
    let i = 0;
    return clear(eye, sightAt, () => h[i++] ?? 0, 17, 0, Infinity);
  };
  const near = (s: number) => s > finish - PITCH_TO - 50 && s < finish + AREA;
  /** Riders coming down to the finish, the nearest to it first. */
  const coming = (w: Watch, from: number, to: number) =>
    w.riders
      .map((r) => ({ r, s: along.of(r) }))
      .filter(({ r, s }) => r.speed > 2 && s > from && s < to)
      .toSorted((a, b) => b.s - a.s);

  // Low past the arch, to one side: riders come through and pull up in front of it.
  const lowEye = on(finish + 56, 13, 1.3);
  const low: Rig = {
    name: "finish",
    minShot: 2.5,
    maxShot: 12,
    rate(w) {
      const me = w.me;
      if (me && me.speed > 1.5 && near(along.of(me))) return { slot: me.slot, score: 1 };
      // Every finisher coming in gets its moment.
      const next = coming(w, finish - PITCH_TO - 50, finish + AREA)[0];
      return next ? { slot: next.r.slot, score: 1 } : null;
    },
    aim(w, r, out) {
      out.eye.copy(lowEye);
      out.frame = 3.8;
      out.follow = 6;
      onRider(out, r);
    },
    // Until the rider has stood a moment.
    holds: (w, r) => w.still(r.slot) < 1.6 && near(along.of(r)),
  };

  // Under the arch, a long lens up the final pitch.
  const pitchEye = on(finish - 6, -(run.finish.limit + 2), 5);
  const pitch: Rig = {
    name: "pitch",
    minShot: 3,
    maxShot: 10,
    rate(w) {
      const next = coming(w, finish - PITCH_FROM, finish - PITCH_TO - 10).find(({ r }) => sees(pitchEye, r));
      if (!next) return null;
      return { slot: next.r.slot, score: next.r.isMe ? 0.8 : 0.72 };
    },
    aim(_w, r, out) {
      out.eye.copy(pitchEye);
      out.frame = 4.5;
      out.follow = 5;
      onRider(out, r);
    },
    holds: (_w, r) => along.of(r) < finish - PITCH_TO && sees(pitchEye, r),
  };

  // Round a rider standing in the finish area.
  let angle = 0;
  let turn = 1;
  let from = 0;
  const orbit: Rig = {
    name: "orbit",
    minShot: 4,
    maxShot: 8,
    rate(w) {
      // (Too close for the results, which cover the middle of the picture.)
      if (w.results) return null;
      const standing = (r: RiderView) => w.still(r.slot) > 0.7 && along.of(r) > finish;
      if (w.me && standing(w.me)) return { slot: w.me.slot, score: 0.7 };
      const other = w.riders.find(standing);
      return other ? { slot: other.slot, score: 0.45 } : null;
    },
    begin(w, r) {
      // From in front of the rider, a little to one side, coming round.
      turn = Math.sin(w.t * 5.1) > 0 ? 1 : -1;
      angle = r.yaw - turn * 0.7;
      from = w.t;
    },
    aim(w, r, out) {
      const a = angle + (w.t - from) * 0.16 * turn;
      const x = r.x + Math.sin(a) * 6.5;
      const z = r.z + Math.cos(a) * 6.5;
      out.eye.set(x, Math.max(r.y + 1.5, ground(x, z) + 1.2), z);
      out.look.set(r.x, r.y + 0.95, r.z);
      out.fov = 36;
      out.follow = 10;
    },
    holds: (w, r) => !w.results && along.of(r) > finish - 5,
  };

  // High over the bottom of the finish area, looking back up at the arch.
  const wideEye = on(finish + AREA + 20, 0, 16);
  const wideLook = on(finish + 18, 0, 0);
  const wide: Rig = {
    name: "wide",
    minShot: 4,
    maxShot: 6,
    rest: 20,
    rate: (w) => (w.me && along.of(w.me) > finish ? { slot: w.me.slot, score: 0.35 } : null),
    aim(w, _r, out) {
      out.eye.copy(wideEye);
      out.eye.x += Math.sin(w.t * 0.2) * 2;
      out.look.copy(wideLook);
      out.fov = 42;
      out.follow = 20;
    },
    holds: () => true,
  };

  // A crane over the bottom of the finish area, swinging slowly, looking back up at it.
  const craneAt = on(finish + 30, 0, 0);
  let craneFrom = 0;
  let craneAngle = 0;
  let craneSwing = 1;
  const crane: Rig = {
    name: "crane",
    minShot: 5,
    maxShot: 9,
    rest: 12,
    rate: (w) => (w.me && along.of(w.me) > finish ? { slot: w.me.slot, score: 0.4 } : null),
    begin(w) {
      craneFrom = w.t;
      const p = run.path[Math.min(run.path.length - 1, Math.round((finish + 30 - run.path[0]!.s) / 4))]!;
      craneSwing = Math.sin(w.t * 3.7) > 0 ? 1 : -1;
      craneAngle = p.yaw - craneSwing * 0.5;
    },
    aim(w, _r, out) {
      const a = craneAngle + (w.t - craneFrom) * 0.06 * craneSwing;
      const x = craneAt.x + Math.sin(a) * 30;
      const z = craneAt.z + Math.cos(a) * 30;
      out.eye.set(x, Math.max(craneAt.y + 10, ground(x, z) + 4), z);
      out.look.set(craneAt.x, craneAt.y + 1, craneAt.z);
      out.fov = 44;
      out.follow = 20;
    },
    holds: () => true,
  };

  // Beside the run ahead of a rider still on it: set up, watch them come past, move on.
  const sideEye = new THREE.Vector3();
  let sideS = 0;
  let sideOf = 1;
  const trackside: Rig = {
    name: "trackside",
    minShot: 2.5,
    maxShot: 9,
    repeats: true,
    rate: (w) =>
      w.me && w.me.speed > 2 && along.of(w.me) < finish - UP_THE_RUN ? { slot: w.me.slot, score: 0.9 } : null,
    begin(_w, r) {
      sideS = along.of(r) + 40 + r.speed * 1.6;
      sideOf = -sideOf;
      // On the edge of the run, inside its fence and clear of the trees (and of its own pines).
      for (let tries = 0; tries < 4; tries++) {
        const i = Math.max(0, Math.min(run.path.length - 1, Math.round((sideS - run.path[0]!.s) / 4)));
        sideEye.copy(on(sideS, sideOf * (run.path[i]!.limit - 0.5), 2.2));
        if (!run.obstacles.some((o) => Math.hypot(o.x - sideEye.x, o.z - sideEye.z) < o.radius + 4)) break;
        sideS += 10;
      }
    },
    aim(_w, r, out) {
      out.eye.copy(sideEye);
      out.frame = 3.6;
      out.follow = 6;
      onRider(out, r);
    },
    holds: (_w, r) =>
      along.of(r) < sideS + 12 && Math.hypot(sideEye.x - r.x, sideEye.z - r.z) < 120 && sees(sideEye, r),
  };

  const rigs = [low, pitch, orbit, crane, wide, trackside, drone("drone", (x, z) => ground(x, z))];
  const scenery = runScenery(course);
  const standing = (w: Watch, r: RiderView) => w.still(r.slot) > 0.4 && along.of(r) > finish;
  /** A long lens from `eye` on a rider standing in the finish area (yours first). */
  const onlooker = (name: string, eye: THREE.Vector3, frame: number, score: number): Rig => ({
    name,
    minShot: 4,
    maxShot: 8,
    rest: 14,
    rate(w) {
      const r = w.me && standing(w, w.me) ? w.me : w.riders.find((x) => standing(w, x));
      return r && sees(eye, r) ? { slot: r.slot, score: r.isMe ? score : score * 0.7 } : null;
    },
    aim(_w, r, out) {
      out.eye.copy(eye);
      out.frame = frame;
      out.follow = 4;
      onRider(out, r);
    },
    holds: (_w, r) => along.of(r) > finish - 5 && sees(eye, r),
  });
  const lodge = scenery.lodge;
  if (lodge.size !== 1) {
    // On the lodge's deck, over the finish area.
    const p = run.path.find((q) => q.s >= lodge.s) ?? run.path.at(-1)!;
    rigs.push(onlooker("deck", on(lodge.s - 6, (p.limit + lodge.out - 9 * lodge.size) * lodge.side, 4.5), 5, 0.5));
  }
  if (scenery.lake) {
    // Across the frozen lake, low: the ice, the finish area, the mountain behind.
    const l = scenery.lake;
    rigs.push(
      onlooker("lake", on(l.s + l.along * 0.4, l.offset * 1.05 - Math.sign(l.offset) * l.across, 1.6), 7, 0.45),
    );
  }
  return rigs;
}
