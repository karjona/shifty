// Tracks in the snow: every board on the snow leaves a thin groove behind it
// (wider when it skids), which fades over a few seconds. One strip of quads
// per rider in a ring buffer; a quad's age comes from the time its points
// were laid, so nothing is rewritten as the tracks fade.
import * as THREE from "three/webgpu";
import { attribute, clamp, float, uniform, vec3 } from "three/tsl";
import type { RiderView } from "./world.ts";

/** Quads per rider, the distance between their ends (m), and how long a track lasts (s). */
const SEGMENTS = 240;
const STEP = 0.35;
const LIFE = 14;
/** Half width of a carved groove, and how much wider a full skid smears it (m). */
const GROOVE = 0.08;
const SMEAR = 0.32;
/** Height above the snow (m): enough to clear the snow mesh between its vertices. */
const LIFT = 0.035;
/** Further than this in one step is a teleport (a reset), not riding. */
const JUMP = 3;

interface Trail {
  mesh: THREE.Mesh;
  pos: Float32Array;
  birth: Float32Array;
  posAttr: THREE.BufferAttribute;
  birthAttr: THREE.BufferAttribute;
  head: number;
  /** The last point laid (its left and right edges), if the board was on the snow. */
  last: {
    x: number;
    z: number;
    lx: number;
    ly: number;
    lz: number;
    rx: number;
    ry: number;
    rz: number;
    t: number;
  } | null;
}

export class CarveTrails {
  readonly group = new THREE.Group();
  private trails = new Map<number, Trail>();
  private time = uniform(0);
  private material: THREE.MeshStandardNodeMaterial;
  private index: number[];

  constructor() {
    const mat = new THREE.MeshStandardNodeMaterial({
      roughness: 1,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    mat.colorNode = vec3(0.56, 0.63, 0.8);
    const age = this.time.sub(attribute("birth", "float"));
    mat.opacityNode = clamp(float(1).sub(age.div(LIFE)), 0, 1).mul(0.45);
    this.material = mat;
    this.index = [];
    for (let k = 0; k < SEGMENTS; k++) {
      const v = k * 4;
      this.index.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
    }
  }

  private trail(slot: number): Trail {
    let t = this.trails.get(slot);
    if (t) return t;
    const pos = new Float32Array(SEGMENTS * 4 * 3);
    const birth = new Float32Array(SEGMENTS * 4).fill(-1e6);
    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    const birthAttr = new THREE.BufferAttribute(birth, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", posAttr);
    const up = new Float32Array(SEGMENTS * 4 * 3);
    for (let i = 1; i < up.length; i += 3) up[i] = 1;
    geo.setAttribute("normal", new THREE.BufferAttribute(up, 3));
    geo.setAttribute("birth", birthAttr);
    geo.setIndex(this.index);
    const mesh = new THREE.Mesh(geo, this.material);
    // The ring wraps anywhere: bounds would be wrong, so never cull it.
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    this.group.add(mesh);
    t = { mesh, pos, birth, posAttr, birthAttr, head: 0, last: null };
    this.trails.set(slot, t);
    return t;
  }

  /** Lays new track behind every rider on the snow. `t` is the sim time (s). */
  update(riders: RiderView[], t: number): void {
    this.time.value = t;
    for (const r of riders) {
      const trail = this.trail(r.slot);
      if (!r.grounded || r.bailing) {
        trail.last = null;
        continue;
      }
      const last = trail.last;
      const moved = last ? Math.hypot(r.x - last.x, r.z - last.z) : Infinity;
      if (last && moved < STEP) continue;
      // Across the direction of travel; a skid (sitting back) smears it wide.
      const speed = Math.hypot(r.vx, r.vz);
      const fx = speed > 0.5 ? r.vx / speed : Math.sin(r.yaw);
      const fz = speed > 0.5 ? r.vz / speed : Math.cos(r.yaw);
      const skid = Math.max(0, -r.lean) * Math.min(1, speed / 6) + Math.abs(r.steer) * 0.1;
      const w = GROOVE + SMEAR * Math.min(1, skid);
      const y = r.y + LIFT;
      const next = {
        x: r.x,
        z: r.z,
        lx: r.x - fz * w,
        ly: y,
        lz: r.z + fx * w,
        rx: r.x + fz * w,
        ry: y,
        rz: r.z - fx * w,
        t,
      };
      trail.last = next;
      if (!last || moved > JUMP) continue;
      const v = trail.head * 4;
      trail.pos.set(
        [last.lx, last.ly, last.lz, last.rx, last.ry, last.rz, next.lx, next.ly, next.lz, next.rx, next.ry, next.rz],
        v * 3,
      );
      trail.birth.set([last.t, last.t, next.t, next.t], v);
      trail.head = (trail.head + 1) % SEGMENTS;
      trail.posAttr.needsUpdate = true;
      trail.birthAttr.needsUpdate = true;
    }
  }
}
