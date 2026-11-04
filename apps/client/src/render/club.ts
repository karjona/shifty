// The country club: a terrace on a stone pier at the east end of the town
// quay, over the bay, with the clubhouse behind it and the sierra beyond.
// Riders gather here before a race. Low-poly and flat-shaded, like the
// town.
import * as THREE from "three/webgpu";

const STONE = 0xc8b89a;
const PAVING = 0xe9dcc2;
const WHITE = 0xf6f2ea;
const ROOF = 0xc0623a;
const WOOD = 0x8a5a36;
const GLASS = 0x2c3a46;
const PLANT = 0x4f8a3a;
const POT = 0xb5653a;
const AWNING = [0x2a8fb0, 0xf6f2ea];

const mat = (color: number, rough = 0.9) =>
  new THREE.MeshStandardNodeMaterial({ color, roughness: rough, flatShading: true });

function block(w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Where the club stands, and where riders stand on its terrace. */
export const CLUB = {
  /** Centre of the terrace floor (world). */
  x: 157,
  z: 96,
  /** Height of the terrace floor. */
  floor: 5.2,
  /** The terrace faces the bay (−z). */
};

/** Where the club's camera stands (off the pier, over the water) and looks (north-west, at the riders). */
export const CLUB_VIEW = {
  eye: { x: CLUB.x + 7, y: CLUB.floor + 3.2, z: CLUB.z - 15 },
  look: { x: CLUB.x - 6, y: CLUB.floor + 2.4, z: CLUB.z + 4 },
};

/**
 * Spots for up to four riders on the terrace, turned toward the camera:
 * you in front, friends gathering beside you.
 */
function facingCamera(x: number, z: number): { x: number; z: number; yaw: number } {
  return { x, z, yaw: Math.atan2(CLUB_VIEW.eye.x - x, CLUB_VIEW.eye.z - z) + 0.25 };
}

export function riderSpots(): { x: number; z: number; yaw: number }[] {
  const face = facingCamera;
  return [
    face(CLUB.x + 4.0, CLUB.z - 5.0),
    face(CLUB.x + 2.4, CLUB.z - 3.6),
    face(CLUB.x + 5.6, CLUB.z - 3.4),
    face(CLUB.x + 0.8, CLUB.z - 4.8),
  ];
}

export function buildClub(): THREE.Group {
  const g = new THREE.Group();
  const { x, z, floor } = CLUB;
  const stone = mat(STONE);
  const paving = mat(PAVING, 0.8);
  const white = mat(WHITE);
  const roof = mat(ROOF);
  const wood = mat(WOOD, 0.7);
  const glass = mat(GLASS, 0.3);

  // The pier: a stone block out of the water, paved on top.
  g.add(block(30, floor + 6, 22, stone, x, -6, z + 2));
  g.add(block(29.4, 0.12, 21.4, paving, x, floor - 0.06, z + 2));
  // Steps down to the water on the east side.
  for (let i = 0; i < 6; i++) g.add(block(3, floor + 6 - i * 0.9, 1.1, stone, x + 16, -6, z - 4 + i * 1.1));

  // The balustrade along the front and the sides.
  const rail = mat(WHITE, 0.6);
  const front = z - 9;
  g.add(block(29, 0.12, 0.3, rail, x, floor + 0.95, front));
  for (let px = -14; px <= 14; px += 0.7) g.add(block(0.14, 0.95, 0.14, rail, x + px, floor, front));
  for (const side of [-1, 1]) {
    g.add(block(0.3, 0.12, 10, rail, x + side * 14.6, floor + 0.95, z - 4));
    for (let pz = -9; pz <= 1; pz += 0.7) g.add(block(0.14, 0.95, 0.14, rail, x + side * 14.6, floor, z + pz));
  }

  // The clubhouse: two white storeys with an arcade, a terracotta roof.
  const back = z + 6;
  g.add(block(26, 7.2, 8, white, x, floor, back + 4));
  g.add(block(27, 0.5, 9, white, x, floor + 7.2, back + 4));
  const roofGeo = new THREE.ConeGeometry(1, 1, 4, 1);
  roofGeo.rotateY(Math.PI / 4);
  const roofMesh = new THREE.Mesh(roofGeo, roof);
  roofMesh.scale.set(19.5, 3, 6.6);
  roofMesh.position.set(x, floor + 7.7 + 1.5, back + 4);
  roofMesh.castShadow = true;
  g.add(roofMesh);
  // Arches below, windows above.
  for (let i = -5; i <= 5; i++) {
    const ax = x + i * 2.2;
    g.add(block(1.5, 2.6, 0.15, glass, ax, floor + 0.2, back - 0.02));
    g.add(block(1.1, 1.3, 0.15, glass, ax, floor + 4.3, back - 0.02));
    g.add(block(1.5, 0.12, 0.6, rail, ax, floor + 4.15, back - 0.3));
  }
  // A striped awning over the arcade.
  for (let i = 0; i < 12; i++) {
    const a = block(2.2, 0.08, 2.6, mat(AWNING[i % 2]!, 0.7), x - 12.1 + i * 2.2, floor + 3.05, back - 1.2);
    a.rotation.x = -0.25;
    g.add(a);
  }
  // A flag on the roof.
  g.add(block(0.08, 4, 0.08, rail, x + 9, floor + 7.7, back + 4));
  g.add(block(1.4, 0.8, 0.04, mat(0xd94a3a, 0.7), x + 9.72, floor + 10.8, back + 4));

  // Tables with parasols, chairs, loungers, potted palms.
  const parasolColors = [0xf6f2ea, 0x2a8fb0, 0xf2c14e];
  [
    [-9, -1],
    [9.5, -0.5],
    [-10.5, 3.5],
    [10, 3.8],
  ].forEach(([px, pz], i) => {
    const tx = x + px!;
    const tz = z + pz!;
    g.add(block(1.2, 0.06, 1.2, white, tx, floor + 0.74, tz));
    g.add(block(0.12, 0.74, 0.12, wood, tx, floor, tz));
    g.add(block(0.06, 2.6, 0.06, wood, tx, floor + 0.8, tz));
    const shade = new THREE.Mesh(new THREE.ConeGeometry(1.9, 0.7, 8, 1), mat(parasolColors[i % 3]!, 0.7));
    shade.position.set(tx, floor + 3.2, tz);
    shade.castShadow = true;
    g.add(shade);
    for (const [cx, cz] of [
      [0.9, 0],
      [-0.9, 0],
      [0, 0.9],
    ]) {
      g.add(block(0.45, 0.45, 0.45, wood, tx + cx!, floor, tz + cz!));
      g.add(block(0.45, 0.5, 0.08, wood, tx + cx! * 1.2, floor + 0.45, tz + cz! * 1.2 + (cz === 0 ? 0 : 0.2)));
    }
  });
  // Potted plants along the clubhouse.
  for (const px of [-12.5, -5.5, 5.5, 12.5]) {
    g.add(block(0.8, 0.7, 0.8, mat(POT), x + px, floor, back - 2.6));
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(0.75, 0), mat(PLANT));
    crown.position.set(x + px, floor + 1.4, back - 2.6);
    crown.castShadow = true;
    g.add(crown);
  }
  // A couple of tall palms beside the clubhouse.
  for (const side of [-1, 1]) {
    const px = x + side * 15.5;
    const pz = back + 1;
    g.add(block(0.45, 9, 0.45, mat(0x7a5a3c), px, floor, pz));
    for (let i = 0; i < 6; i++) {
      const leaf = block(0.5, 0.08, 3.4, mat(PLANT, 0.8), px, floor + 8.8, pz);
      leaf.geometry.translate(0, 0, 1.6);
      leaf.rotation.set(0.35, (i / 6) * Math.PI * 2, 0);
      g.add(leaf);
    }
  }
  return g;
}
