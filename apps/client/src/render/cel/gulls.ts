// Gulls wheeling over the harbour: two wings and a body each, flapping now
// and then and gliding between, drawn in ink like everything else.
import * as THREE from "three/webgpu";
import { CelMaterial, UNREFLECTED, inkId } from "./material.ts";

interface Gull {
  group: THREE.Group;
  left: THREE.Mesh;
  right: THREE.Mesh;
  centre: THREE.Vector3;
  radius: number;
  speed: number;
  phase: number;
  bob: number;
}

function wing(side: number): THREE.BufferGeometry {
  // A bent wing: inner panel up, outer panel swept back and down.
  const s = side;
  const pts = [
    0,
    0,
    0.12,
    s * 0.42,
    0.06,
    0.02,
    0,
    0,
    -0.18,
    s * 0.42,
    0.06,
    0.02,
    s * 0.95,
    -0.05,
    -0.22,
    s * 0.4,
    0.06,
    -0.16,
  ];
  const idx = side > 0 ? [0, 1, 2, 2, 1, 3, 1, 4, 3, 3, 4, 5] : [0, 2, 1, 2, 3, 1, 1, 3, 4, 3, 5, 4];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts.slice(0, 15), 3));
  g.setIndex(idx.filter((i) => i < 5));
  g.computeVertexNormals();
  return g;
}

export class Gulls {
  readonly group = new THREE.Group();
  private gulls: Gull[] = [];

  constructor(centre: THREE.Vector3, count = 9) {
    const white = new CelMaterial({
      color: 0xffffff,
      shade: new THREE.Color(0.62, 0.66, 0.86),
      side: THREE.DoubleSide,
      id: inkId("gull"),
    });
    const tips = new CelMaterial({ color: 0x3a3f4a, side: THREE.DoubleSide, id: inkId("gull") });
    for (let i = 0; i < count; i++) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.42, 3, 6), white);
      body.rotation.x = Math.PI / 2;
      const left = new THREE.Mesh(wing(-1), i % 3 === 0 ? tips : white);
      const right = new THREE.Mesh(wing(1), i % 3 === 0 ? tips : white);
      g.add(body, left, right);
      for (const m of g.children) m.layers.set(UNREFLECTED);
      g.scale.setScalar(2.2);
      this.group.add(g);
      const r = (n: number) => {
        const x = Math.sin(i * 12.9898 + n * 78.233) * 43758.5453;
        return x - Math.floor(x);
      };
      this.gulls.push({
        group: g,
        left,
        right,
        centre: centre.clone().add(new THREE.Vector3((r(1) - 0.5) * 160, 18 + r(2) * 26, (r(3) - 0.5) * 120)),
        radius: 18 + r(4) * 30,
        speed: (0.12 + r(5) * 0.1) * (r(6) < 0.5 ? 1 : -1),
        phase: r(7) * Math.PI * 2,
        bob: r(8) * 10,
      });
    }
  }

  update(t: number): void {
    for (const g of this.gulls) {
      const a = g.phase + t * g.speed;
      const x = g.centre.x + Math.cos(a) * g.radius;
      const z = g.centre.z + Math.sin(a) * g.radius;
      const y = g.centre.y + Math.sin(t * 0.4 + g.bob) * 2;
      g.group.position.set(x, y, z);
      // Facing along the circle, banked into it.
      const dir = Math.sign(g.speed);
      g.group.rotation.set(0, -a - (dir * Math.PI) / 2 + Math.PI, dir * 0.35, "YXZ");
      // Bursts of flapping, then a glide (held on twos).
      const tt = Math.floor(t * 12) / 12;
      const flapping = Math.sin(tt * 0.7 + g.bob) > 0.3;
      const beat = flapping ? Math.sin(tt * 11 + g.bob) * 0.55 : 0.08;
      g.left.rotation.z = -beat;
      g.right.rotation.z = beat;
    }
  }
}
