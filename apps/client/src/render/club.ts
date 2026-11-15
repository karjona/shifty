// The country club: a paved terrace over the sea at the east end of the
// town quay, a grand stair down to the landing stage with its signal mast
// and moored boats, and the clubhouse behind. Riders gather here before a
// race. Its art is modelled in art/env/club.py (public/env/club.glb) and
// drawn in a handful of batches; the paving's pattern is a shader, and what
// moves (boats at their moorings, sails out at sea) is moved here.
import * as THREE from "three/webgpu";
import { LOOK } from "./cel/look.ts";
import { EnvLook } from "./env/materials.ts";
import { type EnvAnim, type EnvModel, loadEnv } from "./env/model.ts";
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
    loadEnv("club")
      .then(async (model) => {
        const art = assemble(model);
        art.position.set(CLUB.x, CLUB.floor, CLUB.z);
        await warmUp(art);
        g.add(art);
      })
      .catch((e: unknown) => console.error(e)),
  );
  return g;
}

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

/** A number in 0-1 from a whole number, for things that happen now and then. */
const chance = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

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

const MOVES: Record<string, (m: Mover, t: number) => void> = { boat: rock, sail, fan: spin, gull: perch };

/** The art as meshes: a batch per material, the paving, and what moves. */
function assemble(model: EnvModel): THREE.Group {
  const g = new THREE.Group();
  const look = new EnvLook();
  look.setBreeze(model.anchors.get("wind")?.[0]?.data.dir);
  g.add(...look.meshes(model.parts, ["paving"]));
  const floor = model.parts.get("paving");
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
    const move = MOVES[a.name];
    if (move) movers.push({ move, mover: { group, rest: a.matrix.clone(), index } });
  };
  for (const a of model.anims) animated(a);
  if (floor) {
    const mesh = new THREE.Mesh(floor, look.material("paving"));
    mesh.name = "env.paving";
    mesh.receiveShadow = true;
    // The floor is in every picture of the terrace: drawing it moves what moves.
    mesh.frustumCulled = false;
    mesh.onBeforeRender = () => {
      const t = LOOK.time.value;
      for (const m of movers) m.move(m.mover, t);
    };
    g.add(mesh);
  }
  return g;
}
