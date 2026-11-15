// The country club: a paved terrace over the sea at the east end of the
// town quay, a grand stair down to the landing stage with its signal mast
// and moored boats, and the clubhouse behind. Riders gather here before a
// race. Its art is modelled in art/env/club.py (public/env/club.glb) and
// drawn in a handful of batches; the paving's pattern is a shader, and what
// moves (boats at their moorings, sails out at sea, a gull, a fan, a waiter
// and members lifting a glass) is moved here; its lettering is set at
// runtime (env/signs.ts). The sea in front of it glints.
import * as THREE from "three/webgpu";
import { Fn, attribute, cameraWorldMatrix, float, max, positionLocal, sin, vec3, vec4 } from "three/tsl";
import { LOOK } from "./cel/look.ts";
import { UNREFLECTED, inklessBasic } from "./cel/material.ts";
import { EnvLook, classOf } from "./env/materials.ts";
import { type EnvAnim, type EnvModel, loadEnv } from "./env/model.ts";
import { signs } from "./env/signs.ts";
import { warmUp } from "./warm.ts";

/** Where the club stands. */
export const CLUB = {
  /** Centre of the terrace floor (world). */
  x: 170,
  z: 96,
  /** Height of the terrace floor. */
  floor: 5.2,
  /** The terrace faces the bay (−z). */
};

/** The medallion in the paving at the head of the stair (on the terrace, from its middle; m). */
const MEDALLION = { x: 3.9, z: -8.1, radius: 1.1 };

/** The terrace is drawn in squares of ground this size (m), so what the camera has its back to is culled. */
const CELL = 12;

const ready = new WeakMap<THREE.Object3D, Promise<void>>();

/** Resolves once a club's art is in (and its shaders compiled). */
export function clubReady(club: THREE.Object3D): Promise<void> {
  return ready.get(club) ?? Promise.resolve();
}

/** The club, in the world's coordinates. Its art arrives a moment later (see `clubReady`). */
export function buildClub(): THREE.Group {
  const g = new THREE.Group();
  ready.set(
    g,
    loadEnv("club", CELL)
      .then(async (model) => {
        const art = assemble(model);
        const lettering = await signs(model.anchors.get("sign"));
        if (lettering) {
          lettering.layers.set(UNREFLECTED);
          art.add(lettering);
        }
        art.position.set(CLUB.x, CLUB.floor, CLUB.z);
        await warmUp(art);
        g.add(art);
      })
      .catch((e: unknown) => console.error(e)),
  );
  return g;
}

/** A number in 0-1 from a whole number, for things that happen now and then. */
const chance = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** A group of the art that moves, with where it rests. */
interface Mover {
  group: THREE.Group;
  rest: THREE.Matrix4;
  index: number;
}

const up = new THREE.Vector3(0, 1, 0);
const offset = new THREE.Matrix4();
const turn = new THREE.Quaternion();
const lean = new THREE.Euler();

/** A boat at its mooring: it rocks and lifts on the swell. */
function rock(m: Mover, t: number): void {
  const k = m.index * 1.9;
  lean.set(Math.sin(t * 0.83 + k) * 0.055, 0, Math.sin(t * 0.61 + k * 2) * 0.025);
  offset.makeRotationFromEuler(lean).setPosition(0, Math.sin(t * 0.7 + k) * 0.07, 0);
  m.group.matrix.multiplyMatrices(m.rest, offset);
}

/** How far a sail out at sea goes before it comes round again (m). */
const SAIL_REACH = 520;

/** A boat under sail, far out: it crosses slowly, heeled a little, and comes round again. */
function sail(m: Mover, t: number): void {
  const speed = (m.index % 2 === 0 ? 1 : -1) * (2.2 + m.index * 0.5);
  const x = ((((t * speed + m.index * 170) % SAIL_REACH) + SAIL_REACH) % SAIL_REACH) - SAIL_REACH / 2;
  turn.setFromAxisAngle(up, speed > 0 ? 0 : Math.PI);
  offset.makeRotationFromQuaternion(turn).setPosition(x, Math.sin(t * 0.5 + m.index) * 0.2, 0);
  m.group.matrix.multiplyMatrices(m.rest, offset);
}

/** A ceiling fan's blades: they turn. */
function spin(m: Mover, t: number): void {
  offset.makeRotationY(t * 2.4);
  m.group.matrix.multiplyMatrices(m.rest, offset);
}

/** How long a gull holds a look before it turns its head somewhere else (s). */
const GULL_HOLD = 2.9;

/** A gull standing about: every few seconds it turns to look another way, and now and then dips to preen, on twos. */
function perch(m: Mover, t: number): void {
  const held = Math.floor(t * 12) / 12 + m.index * 1.7;
  const beat = Math.floor(held / GULL_HOLD);
  const into = held / GULL_HOLD - beat;
  const heading = (n: number) => (chance(n) - 0.5) * 1.5;
  const k = Math.min(1, into / 0.1);
  const yaw = heading(beat - 1) + (heading(beat) - heading(beat - 1)) * k * k * (3 - 2 * k);
  const dip = chance(beat + 0.5) > 0.6 && into > 0.45 && into < 0.75 ? Math.sin(((into - 0.45) / 0.3) * Math.PI) : 0;
  lean.set(0, yaw, -dip * 0.5);
  offset.makeRotationFromEuler(lean);
  m.group.matrix.multiplyMatrices(m.rest, offset);
}

/** How long someone sitting takes over a sip (s): now and then they lift their glass. */
const SIP_EVERY = 5.6;

/** Whether someone sitting has their glass up at `t` (on twos). */
function sipping(m: Mover, t: number): boolean {
  const held = Math.floor(t * 12) / 12 + m.index * 2.3;
  const into = held / SIP_EVERY - Math.floor(held / SIP_EVERY);
  return into > 0.62 && into < 0.86;
}

/** The waiter's walk: how fast (m/s), how long he stops at each end (s), and steps a second. */
const WAITER = { speed: 0.85, stop: 2.6, steps: 3 };

/**
 * The waiter, going from where he stands to `to` and back, stopping at
 * each end: where he is at `t` along the way (0-1), which way he faces, and
 * whether he is mid-stride (the second of his two poses).
 */
function waiting(to: THREE.Vector3, t: number): { along: number; back: boolean; stride: boolean } {
  const walk = Math.max(0.1, to.length() / WAITER.speed);
  const lap = 2 * (walk + WAITER.stop);
  const into = t - Math.floor(t / lap) * lap;
  const half = walk + WAITER.stop;
  const back = into >= half;
  const leg = back ? into - half : into;
  const moving = leg < walk;
  const k = Math.min(1, leg / walk);
  const stride = moving && Math.floor(t * WAITER.steps) % 2 === 1;
  return { along: back ? 1 - k : k, back: back === moving, stride };
}

/** Two poses of one figure, swapped: which of them (`first`) a group is, and when it is the one on show. */
function posed(first: boolean, second: (m: Mover, t: number) => boolean): (m: Mover, t: number) => void {
  return (m, t) => {
    m.group.visible = second(m, t) !== first;
  };
}

/** The waiter's two poses, walking (see `waiting`). */
function serving(first: boolean, to: THREE.Vector3): (m: Mover, t: number) => void {
  return (m, t) => {
    const w = waiting(to, t);
    m.group.visible = w.stride !== first;
    turn.setFromAxisAngle(up, Math.atan2(to.x, to.z) + (w.back ? Math.PI : 0));
    offset.makeRotationFromQuaternion(turn).setPosition(to.x * w.along, 0, to.z * w.along);
    m.group.matrix.multiplyMatrices(m.rest, offset);
  };
}

const MOVES: Record<string, (m: Mover, t: number) => void> = { boat: rock, sail, fan: spin, gull: perch };

/** Glints on the sea, in the terrace's coordinates: how many, and the sea's level. */
const GLINTS = 150;
const SEA = -CLUB.floor;

/**
 * Sunlight glinting off the sea in front of the terrace: short dashes
 * facing the camera, each flashing for a moment now and then, bigger the
 * further out they are (so they hold a pixel or two). One batch, moved on
 * the GPU.
 */
function glints(): THREE.Mesh {
  const centre = new Float32Array(GLINTS * 18);
  const corner = new Float32Array(GLINTS * 12);
  const phase = new Float32Array(GLINTS * 6);
  const quad = [-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1];
  let placed = 0;
  for (let n = 0; placed < GLINTS && n < GLINTS * 20; n++) {
    // Out to sea in front of the stair, thinning with distance; not on the breakwater.
    const d = 30 + chance(n * 3 + 1) ** 1.5 * 260;
    const x = 4 + (chance(n * 3 + 2) * 0.82 - 0.6) * d;
    const z = -8 - d;
    if (Math.abs(z + CLUB.z) < 12 && x + CLUB.x < 175) continue;
    if (Math.hypot(x + CLUB.x - 80, z + CLUB.z + 63) < 16) continue;
    const size = 0.5 + d / 110;
    for (let k = 0; k < 6; k++) {
      const o = placed * 6 + k;
      centre.set([x, SEA + 0.25, z], o * 3);
      corner.set([quad[k * 2]! * 0.42 * size, quad[k * 2 + 1]! * 0.05 * size], o * 2);
      phase[o] = chance(n * 3 + 3);
    }
    placed++;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(centre, 3));
  geo.setAttribute("corner", new THREE.BufferAttribute(corner, 2));
  geo.setAttribute("phase", new THREE.BufferAttribute(phase, 1));
  geo.setDrawRange(0, placed * 6);
  const mat = inklessBasic({ color: 0xffffff });
  mat.positionNode = Fn(() => {
    const c = attribute<"vec2">("corner", "vec2");
    const p = attribute<"float">("phase", "float");
    // A glint is there for a moment in each of its turns, and gone the rest of it.
    const wink = sin(LOOK.time.mul(p.mul(1.3).add(0.9)).add(p.mul(47)));
    const flash = max(wink, float(0)).pow(10);
    const across = cameraWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz;
    return positionLocal.add(across.mul(c.x.mul(flash))).add(vec3(0, 1, 0).mul(c.y.mul(flash)));
  })();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "club.glints";
  mesh.frustumCulled = false;
  mesh.layers.set(UNREFLECTED);
  return mesh;
}

/** The art as meshes: a batch per material, the paving, and what moves. */
function assemble(model: EnvModel): THREE.Group {
  const g = new THREE.Group();
  const look = new EnvLook();
  look.setBreeze(model.anchors.get("wind")?.[0]?.data.dir);
  look.medallion.value.set(CLUB.x + MEDALLION.x, CLUB.z + MEDALLION.z, MEDALLION.radius);
  g.add(...look.meshes(model.parts, ["paving"]));
  const movers: { move: (m: Mover, t: number) => void; mover: Mover }[] = [];
  const count = new Map<string, number>();
  const animated = (a: EnvAnim) => {
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.matrix.copy(a.matrix);
    group.add(...look.meshes(a.parts));
    g.add(group);
    const index = count.get(a.name) ?? 0;
    count.set(a.name, index + 1);
    // Figures come as two poses to swap between: `sit0.a` and `sit0.b`.
    const pose = /^([a-z]+)(\d*)\.([ab])$/u.exec(a.name);
    let move = MOVES[a.name];
    if (pose?.[1] === "sit") move = posed(pose[3] === "a", sipping);
    if (pose?.[1] === "waiter") {
      const to = new THREE.Vector3().setFromMatrixPosition(model.anchors.get("waiter")?.[0]?.matrix ?? a.matrix);
      move = serving(pose[3] === "a", to.sub(new THREE.Vector3().setFromMatrixPosition(a.matrix)));
    }
    if (move)
      movers.push({ move, mover: { group, rest: a.matrix.clone(), index: pose ? Number(pose[2] || 0) : index } });
  };
  for (const a of model.anims) animated(a);
  g.add(glints());
  const tick = () => {
    const t = LOOK.time.value;
    for (const m of movers) m.move(m.mover, t);
  };
  for (const [key, floor] of model.parts) {
    if (classOf(key) !== "paving") continue;
    const mesh = new THREE.Mesh(floor, look.material("paving"));
    mesh.name = "env.paving";
    mesh.receiveShadow = true;
    mesh.layers.set(UNREFLECTED);
    // The floor is in every picture of the terrace: drawing it moves what moves.
    mesh.frustumCulled = false;
    mesh.onBeforeRender = tick;
    g.add(mesh);
  }
  return g;
}
