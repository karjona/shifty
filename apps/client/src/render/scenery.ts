// Costa Nevada backdrop: a beach and green hills along the north shore and
// snow-capped peaks behind them, so the bay sits between the sea and the
// ski slopes. Far and cheap: low-poly, flat-shaded, tinted toward the sky
// by hand (the scene fog would hide them).
import * as THREE from "three/webgpu";

/** Deterministic noise in [0, 1) for placing scenery. */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** A jagged peak with vertex colours: rock low, snow above `snowline` (0-1). */
function peak(radius: number, height: number, seed: number, snowline: number, haze: number, sky: THREE.Color) {
  const geo = new THREE.ConeGeometry(radius, height, 9, 4);
  const pos = geo.attributes.position!;
  const colors: number[] = [];
  const rock = new THREE.Color(0x4f5b4a);
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
    c.copy(t > snowline + (hash(seed + i) - 0.5) * 0.08 ? snow : rock).lerp(sky, haze);
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

  // North shore: a long beach, then low hills. Hazed by hand, not by the
  // scene fog (fogged, they would turn sky-coloured and hide the peaks).
  const hazed = (hex: number, haze: number) => new THREE.Color(hex).lerp(sky, haze);
  const sand = new THREE.MeshStandardNodeMaterial({
    color: hazed(0xe8d6a8, 0.35),
    roughness: 1,
    flatShading: true,
    fog: false,
  });
  const beach = new THREE.Mesh(new THREE.BoxGeometry(2400, 4, 90), sand);
  beach.position.set(0, -1.2, 300);
  beach.receiveShadow = true;
  g.add(beach);
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
