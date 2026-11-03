// Costa Nevada backdrops. Summer: the coastal plain behind the town quay,
// green hills and snow-capped peaks behind them, so the bay sits between
// the sea and the ski slopes. Winter: the sierra's peaks all around the
// run. Far and cheap: low-poly, flat-shaded; hills and peaks are tinted
// toward the sky by hand (the scene fog would hide them).
import * as THREE from "three/webgpu";

/** Deterministic noise in [0, 1) for placing scenery. */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** A jagged peak with vertex colours: rock low, snow above `snowline` (0-1). */
function peak(
  radius: number,
  height: number,
  seed: number,
  snowline: number,
  haze: number,
  sky: THREE.Color,
  rockColor = 0x4f5b4a,
  /** Extra haze at the foot of the peak (fading up), so it melts into the distance. */
  footHaze = 0,
) {
  const geo = new THREE.ConeGeometry(radius, height, 9, 4);
  const pos = geo.attributes.position!;
  const colors: number[] = [];
  const rock = new THREE.Color(rockColor);
  const snow = new THREE.Color(0xf4f7fb);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = (y + height / 2) / height;
    if (t < 0.99) {
      const j = (hash(seed * 31 + i) - 0.5) * radius * 0.35 * (1 - t);
      pos.setX(i, pos.getX(i) + j);
      pos.setZ(i, pos.getZ(i) + (hash(seed * 17 + i) - 0.5) * radius * 0.35 * (1 - t));
      pos.setY(i, y + (hash(seed * 7 + i) - 0.5) * height * 0.08);
    }
    c.copy(t > snowline + (hash(seed + i) - 0.5) * 0.08 ? snow : rock).lerp(
      sky,
      Math.min(1, haze + footHaze * (1 - t) ** 2),
    );
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const m = new THREE.Mesh(
    geo,
    new THREE.MeshStandardNodeMaterial({ vertexColors: true, flatShading: true, roughness: 1, fog: false }),
  );
  m.position.y = height / 2 - 20;
  return m;
}

export function buildScenery(sky: THREE.Color): THREE.Group {
  const g = new THREE.Group();

  // North shore: the coastal plain the town stands on (its beach runs off
  // past the turns), then low hills. The hills are hazed by hand, not by
  // the scene fog (fogged, they would turn sky-coloured and hide the peaks).
  const hazed = (hex: number, haze: number) => new THREE.Color(hex).lerp(sky, haze);
  const sand = new THREE.MeshStandardNodeMaterial({ color: 0xe8d6a8, roughness: 1, flatShading: true });
  const plain = new THREE.Mesh(new THREE.BoxGeometry(2400, 4, 240), sand);
  plain.position.set(0, -1.2, 240);
  plain.receiveShadow = true;
  g.add(plain);
  const green = new THREE.MeshStandardNodeMaterial({
    color: hazed(0x5f8a46, 0.4),
    roughness: 1,
    flatShading: true,
    fog: false,
  });
  for (let i = 0; i < 18; i++) {
    const r = 70 + hash(i) * 90;
    const hill = new THREE.Mesh(new THREE.SphereGeometry(r, 9, 5, 0, Math.PI * 2, 0, Math.PI / 2), green);
    hill.scale.y = 0.12 + hash(i + 50) * 0.12;
    hill.position.set(-1150 + i * 135 + hash(i + 9) * 60, 0, 380 + hash(i + 3) * 90);
    g.add(hill);
  }

  // The sierra behind: two ranges, the far one taller and hazier.
  for (let i = 0; i < 18; i++) {
    const far = i % 2 === 1;
    const h = (far ? 300 : 170) + hash(i + 100) * (far ? 160 : 90);
    const p = peak(h * (1.1 + hash(i + 7) * 0.5), h, i + 1, far ? 0.5 : 0.62, far ? 0.45 : 0.25, sky);
    p.position.x = -2200 + i * 260 + hash(i + 21) * 140;
    p.position.z = (far ? 2400 : 1500) + hash(i + 33) * 250;
    g.add(p);
  }
  return g;
}

const WINTER_ROCK = 0x464b5c;

/**
 * Winter: high peaks all around the run, beyond the fog. `top` and
 * `bottom` are the run's heights at its ends; `path` is its centre line.
 */
export function peakRange(
  sky: THREE.Color,
  top: number,
  bottom: number,
  path: { x: number; z: number }[],
): THREE.Group {
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
    const p = peak(h * (1.0 + hash(i + 70) * 0.5), h, i + 40, 0.55, 0.55 + t * 0.15, sky, WINTER_ROCK, 0.9);
    p.position.set(cx + side * (1300 + hash(i + 90) * 700), base + h / 2 - 60, z);
    g.add(p);
  }
  // Across the valley below the finish: the range you see riding down.
  for (let i = 0; i < 12; i++) {
    const h = 380 + hash(i + 400) * 300;
    const p = peak(
      h * (1.1 + hash(i + 410) * 0.5),
      h,
      i + 120,
      0.55,
      0.6 + hash(i + 420) * 0.15,
      sky,
      WINTER_ROCK,
      0.9,
    );
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
    const p = peak(h * 1.3, h, i + 80, 0.4, 0.5, sky, WINTER_ROCK, 0.9);
    p.position.set(cx + (i - 2.5) * 520, top + h / 2 - 80, minZ - 1300 - hash(i + 5) * 500);
    g.add(p);
  }
  return g;
}
