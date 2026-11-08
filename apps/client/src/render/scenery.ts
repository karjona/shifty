// Costa Nevada backdrops. Summer: the coastal plain behind the town quay,
// green hills and snow-capped peaks behind them, so the bay sits between
// the sea and the ski slopes. Winter: the sierra's peaks all around the
// run. Far and cheap: low-poly, flat-shaded; hills and peaks are tinted
// toward the sky by hand (the scene fog would hide them).
import * as THREE from "three/webgpu";
import { SKY } from "./cel/sky.ts";
import { celPeak } from "./cel/terrain.ts";
import {
  Fn,
  color,
  float,
  fract,
  fwidth,
  min,
  mix,
  mx_cell_noise_float,
  mx_noise_float,
  positionWorld,
  smoothstep,
  step,
  vec2,
  vec3,
} from "three/tsl";

/** Deterministic noise in [0, 1) for placing scenery. */
export function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** A ridged peak, snow-capped above `snowline` (0-1) and hazed toward the sky. */
export function peak(
  radius: number,
  height: number,
  seed: number,
  snowline: number,
  haze: number,
  rock = 0x5f6f8a,
  /** Extra haze at the foot of the peak (fading up), so it melts into the distance. */
  footHaze = 0,
) {
  const m = celPeak(radius, height, seed, {
    rock,
    snow: 0xf7f9fd,
    snowline,
    haze: haze * 0.75,
    footHaze: Math.max(footHaze, 0.35),
    sky: SKY.fog,
  });
  m.position.y = -20;
  return m;
}

/** Round crowns of trees dotted over a hill: added to `out` (matrices and colours). */
function hillTrees(
  at: THREE.Vector3,
  radius: number,
  squash: number,
  seed: number,
  sky: THREE.Color,
  out: { matrices: THREE.Matrix4[]; colours: THREE.Color[] },
): void {
  const count = 46;
  const q = new THREE.Quaternion();
  for (let i = 0; i < count; i++) {
    const a = hash(seed * 97 + i) * Math.PI * 2;
    const d = Math.sqrt(hash(seed * 53 + i * 7)) * 0.85;
    const x = Math.cos(a) * d * radius;
    const z = Math.sin(a) * d * radius;
    const y = Math.sqrt(Math.max(0, 1 - d * d)) * radius * squash;
    const s = 7 + hash(seed + i * 13) * 7;
    out.matrices.push(
      new THREE.Matrix4().compose(
        new THREE.Vector3(at.x + x, y + s * 0.4, at.z + z),
        q,
        new THREE.Vector3(s, s * 1.1, s),
      ),
    );
    out.colours.push(new THREE.Color(hash(i + seed) < 0.3 ? 0x3f6e32 : 0x335f2c).lerp(sky, 0.35));
  }
}

/** A colour as a shader constant. */
function tone(hex: number): THREE.Node<"vec3"> {
  const k = new THREE.Color(hex);
  return vec3(k.r, k.g, k.b);
}

/** The coastal plain: a beach along the water, then a patchwork of fields and hedges. */
function fields(): THREE.Node<"vec3"> {
  return Fn(() => {
    const p = positionWorld.xz;
    // Plots: a grid, warped so no two are square, each one flat colour.
    const q0 = vec2(p.x.mul(0.022), p.y.mul(0.034));
    const warp = vec2(mx_noise_float(vec3(q0.mul(0.45), 2.1)), mx_noise_float(vec3(q0.mul(0.45), 8.7))).mul(0.45);
    const q = q0.add(warp);
    const cell = q.floor();
    const f = q.fract();
    const id = mx_cell_noise_float(vec3(cell, 1.0));
    const palette = [0x8fb35a, 0xb7c46a, 0xd9c27a, 0x7fa04e, 0x9fb0d8, 0xc9d27e, 0xa8c070];
    let c: THREE.Node<"vec3"> = tone(palette[0]!);
    for (let i = 1; i < palette.length; i++) c = mix(c, tone(palette[i]!), step(i / palette.length, id));
    // Rows in some plots (vines, wheat), and hedges between them.
    const rows = fract(q.x.mul(9).add(q.y.mul(2)));
    const rw = fwidth(q.x.mul(9).add(q.y.mul(2))).max(1e-4);
    const ploughed = step(0.55, mx_cell_noise_float(vec3(cell, 5.0)));
    c = mix(c, c.mul(0.86), smoothstep(rw.mul(1.2), float(0), rows).mul(ploughed));
    const edge = min(min(f.x, f.y), min(f.x.oneMinus(), f.y.oneMinus()));
    const w = fwidth(edge).max(1e-4);
    c = mix(color(0x5d7a3c), c, smoothstep(w.mul(0.8), w.mul(2), edge));
    // Sand along the water, then a track behind the beach.
    const beach = smoothstep(152, 150, p.y.add(mx_noise_float(vec3(p.x.mul(0.02), 0, 0)).mul(6)));
    c = mix(c, color(0xe8d6a8), beach);
    const track = smoothstep(1.6, 1.0, p.y.sub(158).abs());
    return mix(c, color(0xd8c9a6), track);
  })();
}

/** Umbrella pines and cypresses in clumps on the coastal plain behind the town. */
function plainTrees(sky: THREE.Color): THREE.Group {
  const g = new THREE.Group();
  const pineGeo = new THREE.IcosahedronGeometry(1, 1);
  pineGeo.scale(1, 0.45, 1);
  const cypressGeo = new THREE.ConeGeometry(0.5, 1, 8, 2);
  cypressGeo.translate(0, 0.5, 0);
  const pines = new THREE.InstancedMesh(
    pineGeo,
    new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1 }),
    220,
  );
  const cypresses = new THREE.InstancedMesh(
    cypressGeo,
    new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1 }),
    160,
  );
  const trunks = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardNodeMaterial({ color: 0x6b4a30, roughness: 1 }),
    220,
  );
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const c = new THREE.Color();
  let np = 0;
  let nc = 0;
  for (let k = 0; k < 40; k++) {
    // Clumps along the plain, thinning toward the hills.
    const cx = -1100 + hash(k * 3.1) * 2200;
    const cz = 175 + hash(k * 7.7) * 150;
    const n = 4 + Math.floor(hash(k + 0.5) * 9);
    for (let i = 0; i < n; i++) {
      const x = cx + (hash(k * 31 + i) - 0.5) * 40;
      const z = cz + (hash(k * 17 + i * 3) - 0.5) * 30;
      const haze = Math.min(0.45, Math.max(0, (z - 170) / 400));
      if (hash(k * 5 + i) < 0.55 && np < 220) {
        const s = 5 + hash(k + i * 11) * 4;
        const h = 6 + hash(k * 2 + i) * 4;
        m.compose(new THREE.Vector3(x, 0.8 + h, z), q, new THREE.Vector3(s, s, s));
        pines.setMatrixAt(np, m);
        pines.setColorAt(np, c.setHex(0x3f7034).lerp(sky, haze));
        m.compose(new THREE.Vector3(x, 0.8 + h / 2, z), q, new THREE.Vector3(0.5, h, 0.5));
        trunks.setMatrixAt(np, m);
        trunks.setColorAt(np, c.setHex(0xffffff));
        np++;
      } else if (nc < 160) {
        const h = 9 + hash(k * 9 + i) * 6;
        m.compose(new THREE.Vector3(x, 0.8, z), q, new THREE.Vector3(2.2, h, 2.2));
        cypresses.setMatrixAt(nc, m);
        cypresses.setColorAt(nc, c.setHex(0x2c5530).lerp(sky, haze));
        nc++;
      }
    }
  }
  pines.count = np;
  trunks.count = np;
  cypresses.count = nc;
  for (const mesh of [pines, cypresses, trunks]) {
    mesh.castShadow = true;
    g.add(mesh);
  }
  return g;
}

export function buildScenery(sky: THREE.Color): THREE.Group {
  const g = new THREE.Group();

  // North shore: the coastal plain the town stands on (its beach runs off
  // past the turns), then low hills. The hills are hazed by hand, not by
  // the scene fog (fogged, they would turn sky-coloured and hide the peaks).
  const hazed = (hex: number, haze: number) => new THREE.Color(hex).lerp(sky, haze);
  const sand = new THREE.MeshStandardNodeMaterial({ color: 0xe8d6a8, roughness: 1, flatShading: true });
  sand.userData.colorNode = fields();
  const plain = new THREE.Mesh(new THREE.BoxGeometry(2400, 4, 240), sand);
  plain.position.set(0, -1.2, 240);
  plain.receiveShadow = true;
  g.add(plain);
  g.add(plainTrees(sky));
  const green = new THREE.MeshStandardNodeMaterial({
    color: hazed(0x5f8a46, 0.4),
    roughness: 1,
    flatShading: true,
    fog: false,
  });
  const trees = { matrices: [] as THREE.Matrix4[], colours: [] as THREE.Color[] };
  for (let i = 0; i < 18; i++) {
    const r = 70 + hash(i) * 90;
    const hill = new THREE.Mesh(new THREE.SphereGeometry(r, 9, 5, 0, Math.PI * 2, 0, Math.PI / 2), green);
    hill.scale.y = 0.12 + hash(i + 50) * 0.12;
    hill.position.set(-1150 + i * 135 + hash(i + 9) * 60, 0, 380 + hash(i + 3) * 90);
    g.add(hill);
    hillTrees(hill.position, r, hill.scale.y, i, sky, trees);
  }
  const crowns = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 1),
    new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1, fog: false }),
    trees.matrices.length,
  );
  trees.matrices.forEach((m, i) => {
    crowns.setMatrixAt(i, m);
    crowns.setColorAt(i, trees.colours[i]!);
  });
  crowns.computeBoundingSphere();
  g.add(crowns);

  // The sierra behind: two ranges, the far one taller and hazier.
  for (let i = 0; i < 18; i++) {
    const far = i % 2 === 1;
    const h = (far ? 300 : 170) + hash(i + 100) * (far ? 160 : 90);
    const p = peak(h * (1.1 + hash(i + 7) * 0.5), h, i + 1, far ? 0.5 : 0.62, far ? 0.45 : 0.25);
    p.position.x = -2200 + i * 260 + hash(i + 21) * 140;
    p.position.z = (far ? 2400 : 1500) + hash(i + 33) * 250;
    g.add(p);
  }
  return g;
}

const WINTER_ROCK = 0x56607e;

/**
 * Winter: high peaks all around the run, beyond the fog. `top` and
 * `bottom` are the run's heights at its ends; `path` is its centre line.
 */
export function peakRange(top: number, bottom: number, path: { x: number; z: number }[]): THREE.Group {
  const g = new THREE.Group();
  let minZ = Infinity;
  let maxZ = -Infinity;
  let cx = 0;
  for (const p of path) {
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
    cx += p.x / path.length;
  }
  const along = maxZ - minZ;
  for (let i = 0; i < 26; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const t = Math.floor(i / 2) / 12;
    const z = minZ - 300 + t * (along + 600);
    // The mountain rises behind the start: peaks there stand higher.
    const base = top + (bottom - top) * Math.min(1, Math.max(0, (z - minZ) / along));
    const h = 220 + hash(i + 200) * 180 + (1 - t) * 140;
    const p = peak(h * (1.0 + hash(i + 70) * 0.5), h, i + 40, 0.55, 0.55 + t * 0.15, WINTER_ROCK, 0.9);
    p.position.set(cx + side * (1300 + hash(i + 90) * 700), base + h / 2 - 60, z);
    g.add(p);
  }
  // Across the valley below the finish: the range you see riding down.
  for (let i = 0; i < 12; i++) {
    const h = 380 + hash(i + 400) * 300;
    const p = peak(h * (1.1 + hash(i + 410) * 0.5), h, i + 120, 0.55, 0.6 + hash(i + 420) * 0.15, WINTER_ROCK, 0.9);
    p.position.set(
      cx + (i - 5.5) * 420 + hash(i + 430) * 200,
      bottom - 160 + h / 2,
      maxZ + 2200 + hash(i + 440) * 1200,
    );
    g.add(p);
  }
  // The summit ridge behind the start.
  for (let i = 0; i < 6; i++) {
    const h = 420 + hash(i + 300) * 200;
    const p = peak(h * 1.3, h, i + 80, 0.4, 0.5, WINTER_ROCK, 0.9);
    p.position.set(cx + (i - 2.5) * 520, top + h / 2 - 80, minZ - 1300 - hash(i + 5) * 500);
    g.add(p);
  }
  return g;
}
