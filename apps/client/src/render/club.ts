// The country club: a paved terrace over the sea at the east end of the
// town quay, a grand stair down to the landing stage with its signal mast
// and moored boats, and the clubhouse behind. Riders gather here before a
// race. Its art is modelled in art/env/club.py (public/env/club.glb) and
// drawn in a handful of batches; the paving's pattern is a shader, and what
// moves (boats at their moorings, sails out at sea) is moved here.
import * as THREE from "three/webgpu";
import { Fn, float, fwidth, max, mix, positionWorld, smoothstep, step, vec3 } from "three/tsl";
import { CelMaterial } from "./cel/material.ts";
import { FOLIAGE, LOOK } from "./cel/look.ts";
import { noise4 } from "./cel/noise.ts";
import { EnvLook } from "./env/materials.ts";
import { type EnvAnim, type EnvModel, loadEnv } from "./env/model.ts";
import { warmUp } from "./warm.ts";

/** Where the club stands. */
export const CLUB = {
  /** Centre of the terrace floor (world). */
  x: 157,
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

/** Terracotta and limestone, as shader constants. */
const tone = (hex: number) => {
  const c = new THREE.Color(hex);
  return vec3(c.r, c.g, c.b);
};

/** The terrace's paving: limestone slabs with grout, a small terracotta tile set in at every corner. */
function paving(): THREE.Node<"vec3"> {
  return Fn(() => {
    const q = positionWorld.xz.div(0.66);
    const cell = q.floor();
    const f = q.fract().sub(0.5).abs();
    // How many slabs a pixel spans: far off, the pattern melts into its average.
    const span = fwidth(q.x).add(fwidth(q.y));
    const edge = max(f.x, f.y);
    const aa = max(fwidth(edge), float(1e-4));
    const grout = smoothstep(float(0.48).sub(aa), float(0.48).add(aa), edge);
    const corner = f.x.add(f.y);
    const ca = max(fwidth(corner), float(1e-4));
    const inset = smoothstep(float(0.8).sub(ca), float(0.8).add(ca), corner);
    const n = noise4(cell.mul(5.37).add(0.5));
    const slab = mix(tone(0xead9b6), tone(0xdcc7a0), smoothstep(-0.5, 0.5, n.x));
    const k = noise4(q.add(0.5).floor().mul(3.71).add(0.5));
    const tile = mix(mix(tone(0xc8683f), tone(0xb4552f), smoothstep(-0.4, 0.4, k.y)), tone(0x2f7f9a), step(0.42, k.z));
    const groutLine = grout.mul(float(1).sub(smoothstep(float(0.86).sub(ca), float(0.86).add(ca), corner)));
    const pattern = mix(mix(slab, tile, inset), tone(0xb7a27e), groutLine);
    return mix(pattern, tone(0xdfcba6), smoothstep(0.5, 1.4, span));
  })();
}

/** The shade that falls on the paving: deep enough that a rider's shadow grounds them on the pale stone. */
const PAVING_SHADE = new THREE.Color(0.5, 0.5, 0.78);

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

const MOVES: Record<string, (m: Mover, t: number) => void> = { boat: rock, sail };

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
    const mesh = new THREE.Mesh(
      floor,
      new CelMaterial({ colorNode: paving(), crease: 0, outdoor: FOLIAGE.none, shade: PAVING_SHADE }),
    );
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
