// Gulls wheeling over the harbour: two wings and a body each, flapping now
// and then and gliding between, drawn in ink like everything else.
import * as THREE from "three/webgpu";
import { CelMaterial, UNREFLECTED, inkId } from "./material.ts";

interface Gull {
  centre: THREE.Vector3;
  radius: number;
  speed: number;
  phase: number;
  bob: number;
}

/** How big a gull is drawn (its shapes are about half a metre across). */
const SIZE = 2.2;

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
  /** Every gull's body, left wing and right wing: a batch each. */
  private bodies: THREE.InstancedMesh;
  private left: THREE.InstancedMesh;
  private right: THREE.InstancedMesh;
  private m = new THREE.Matrix4();
  private part = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private at = new THREE.Vector3();
  private size = new THREE.Vector3(SIZE, SIZE, SIZE);

  constructor(centre: THREE.Vector3, count = 12) {
    const white = new CelMaterial({
      color: 0xffffff,
      shade: new THREE.Color(0.62, 0.66, 0.86),
      side: THREE.DoubleSide,
      id: inkId("gull"),
    });
    const body = new THREE.CapsuleGeometry(0.09, 0.42, 3, 6).rotateX(Math.PI / 2);
    this.bodies = new THREE.InstancedMesh(body, white, count);
    this.left = new THREE.InstancedMesh(wing(-1), white, count);
    this.right = new THREE.InstancedMesh(wing(1), white, count);
    const pale = new THREE.Color(0xffffff);
    const dark = new THREE.Color(0x3a3f4a);
    for (const mesh of [this.bodies, this.left, this.right]) {
      mesh.layers.set(UNREFLECTED);
      mesh.frustumCulled = false;
      mesh.userData.noMerge = true;
      this.group.add(mesh);
    }
    for (let i = 0; i < count; i++) {
      // Every third gull has dark wings.
      this.bodies.setColorAt(i, pale);
      this.left.setColorAt(i, i % 3 === 0 ? dark : pale);
      this.right.setColorAt(i, i % 3 === 0 ? dark : pale);
      const r = (n: number) => {
        const x = Math.sin(i * 12.9898 + n * 78.233) * 43758.5453;
        return x - Math.floor(x);
      };
      this.gulls.push({
        centre: centre.clone().add(new THREE.Vector3((r(1) - 0.5) * 160, 18 + r(2) * 26, (r(3) - 0.5) * 120)),
        radius: 18 + r(4) * 30,
        speed: (0.12 + r(5) * 0.1) * (r(6) < 0.5 ? 1 : -1),
        phase: r(7) * Math.PI * 2,
        bob: r(8) * 10,
      });
    }
    this.update(0);
  }

  update(t: number): void {
    this.gulls.forEach((g, i) => {
      const a = g.phase + t * g.speed;
      // A circle that breathes in and out and drifts: no two rounds alike.
      const reach = g.radius * (1 + 0.35 * Math.sin(a * 0.37 + g.bob));
      const x = g.centre.x + Math.cos(a) * reach + Math.sin(t * 0.05 + g.bob) * 14;
      const z = g.centre.z + Math.sin(a) * reach * 0.8 + Math.cos(t * 0.04 + g.bob) * 12;
      // Soaring up on the turn into the wind, sliding down the other side.
      const y = g.centre.y + Math.sin(a + g.bob) * 5 + Math.sin(t * 0.4 + g.bob) * 1.5;
      // Facing along the circle, banked into it.
      const dir = Math.sign(g.speed);
      this.e.set(Math.cos(a + g.bob) * 0.12, -a - (dir * Math.PI) / 2 + Math.PI, dir * 0.4, "YXZ");
      this.m.compose(this.at.set(x, y, z), this.q.setFromEuler(this.e), this.size);
      this.bodies.setMatrixAt(i, this.m);
      // Bursts of flapping, then a glide (held on twos).
      const tt = Math.floor(t * 12) / 12;
      const flapping = Math.sin(tt * 0.7 + g.bob) > 0.3;
      const beat = flapping ? Math.sin(tt * 11 + g.bob) * 0.55 : 0.08;
      this.left.setMatrixAt(i, this.part.makeRotationZ(-beat).premultiply(this.m));
      this.right.setMatrixAt(i, this.part.makeRotationZ(beat).premultiply(this.m));
    });
    for (const mesh of [this.bodies, this.left, this.right]) mesh.instanceMatrix.needsUpdate = true;
  }
}
