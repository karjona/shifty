// Dev: `/?lookdev=1` shows riders on the club's terrace for look testing.
// URL options: style (psx, n64, ps2), shot (lineup, face, back, row),
// seed (random looks), t (freeze the idle at a time). Keys: 1-3 style,
// F face / lineup / back / row, R new looks, arrows orbit.
import * as THREE from "three/webgpu";
import { type Look, randomLook, rng } from "@shifty/rider";
import { Scenery } from "../wasm/sim.js";
import { Bay } from "../render/bay.ts";
import { CLUB, buildClub } from "../render/club.ts";
import * as clothes from "../render/rider/clothes.ts";
import { RiderMesh, type RiderStyle, STYLES } from "../render/rider/model.ts";
import { idlePose } from "../render/rider/poses.ts";
import { parseCourse } from "../wasm-json.ts";
import { Engine } from "./engine.ts";

type Shot = "lineup" | "face" | "back" | "row";
const SHOTS: Shot[] = ["lineup", "face", "back", "row"];

function summer(look: Look, i: number) {
  const vest = [0xf2c14e, 0xe8553d, 0x2a8fb0, 0xf6f2ea][i % 4]!;
  const base =
    look.body === "male"
      ? clothes.boardshorts([0x2a5d8f, 0xd94a3a, 0x2f7a52, 0x1d1f24][i % 4]!, 0xf6f2ea)
      : clothes.swimsuit([0x1d1f24, 0x2a8fb0, 0xd94a3a, 0x7a3f8f][i % 4]!);
  return [base, clothes.lifeVest(vest, 0x1d1f24), clothes.waterShoes(0x2d3138)];
}

function winter(i: number) {
  const jacket = [0xd94a3a, 0x2a8fb0, 0xf2c14e, 0x3f6f4a][i % 4]!;
  return [
    clothes.jacket(jacket, 0x22252b),
    clothes.snowPants([0x2d3a4f, 0x3b3f46, 0x1d1f24, 0x6a5a48][i % 4]!),
    clothes.boots(0x3a3d44, 0x15171a),
    clothes.gloves(0x1d1f24),
    clothes.beanie([0xf6f2ea, 0x1d1f24, 0xd94a3a, 0x2a8fb0][i % 4]!, 0x2a2d33),
    clothes.goggles(0x1d1f24, [0xe8a33d, 0x4fa3d9, 0xd94a7a, 0x9ad94a][i % 4]!),
  ];
}

export async function lookdev(params: URLSearchParams): Promise<void> {
  const engine = await Engine.get();
  const world = engine.world;
  const scenery = new Scenery(0, 1, 7);
  const course = parseCourse(scenery.courseJson());
  if (course.sport !== "jetski") throw new Error("the club is in the bay");
  world.setEnvironment(
    new Bay({
      water: engine.view.water,
      topSpeed: scenery.topSpeed(),
      waves: scenery.waveParams(),
      course: course.bay,
    }),
  );
  scenery.free();
  world.setSunOffset(-25, 55, -30);
  const club = buildClub();
  world.scene.add(club);

  let style: RiderStyle = STYLES[(params.get("style") as keyof typeof STYLES) ?? "ps2"] ?? STYLES.ps2;
  let shot: Shot = SHOTS.includes(params.get("shot") as Shot) ? (params.get("shot") as Shot) : "lineup";
  let seed = Number(params.get("seed") ?? 1);
  const frozen = params.has("t") ? Number(params.get("t")) : null;
  let orbit = 0;
  let riders: RiderMesh[] = [];
  const label = document.createElement("div");
  Object.assign(label.style, {
    position: "fixed",
    left: "16px",
    top: "12px",
    font: "600 15px system-ui",
    color: "#fff",
    textShadow: "0 1px 3px #000",
    zIndex: "10",
  });
  document.body.append(label);

  const build = () => {
    for (const r of riders) {
      r.group.removeFromParent();
      r.dispose();
    }
    const next = rng(seed);
    const looks: Look[] = [];
    // Two of each body, so both sets get looked at.
    while (looks.length < 4) {
      const l = randomLook(next);
      const males = looks.filter((x) => x.body === "male").length;
      if ((l.body === "male" && males < 2) || (l.body === "female" && looks.length - males < 2)) looks.push(l);
    }
    looks.sort((a, b) => (a.body === b.body ? 0 : a.body === "male" ? -1 : 1));
    riders = looks.map((look, i) => new RiderMesh(look, i % 2 === 0 ? summer(look, i) : winter(i), style));
    riders.forEach((r) => world.scene.add(r.group));
    if (params.has("tex")) {
      document.querySelectorAll(".lookdev-tex").forEach((e) => e.remove());
      riders.forEach((r, i) => {
        const img = r.faceTexture?.image as HTMLCanvasElement | undefined;
        if (!img) return;
        img.className = "lookdev-tex";
        Object.assign(img.style, {
          position: "fixed",
          right: "8px",
          top: `${8 + i * 132}px`,
          width: "256px",
          height: "128px",
          zIndex: "10",
          imageRendering: "pixelated",
        });
        document.body.append(img);
      });
    }
    label.textContent = `${style.name} · ${shot} · seed ${seed} · keys: 1-3 style, F shot, R new looks, ←→ orbit`;
  };
  build();

  addEventListener("keydown", (e) => {
    if (e.key === "1" || e.key === "2" || e.key === "3") {
      style = [STYLES.psx, STYLES.n64, STYLES.ps2][Number(e.key) - 1]!;
      build();
    } else if (e.key === "f") {
      shot = SHOTS[(SHOTS.indexOf(shot) + 1) % SHOTS.length]!;
      build();
    } else if (e.key === "r") {
      seed++;
      build();
    } else if (e.key === "ArrowLeft") orbit -= 0.15;
    else if (e.key === "ArrowRight") orbit += 0.15;
  });

  let t = 0;
  const base = new THREE.Vector3(CLUB.x + 3, CLUB.floor, CLUB.z - 4);
  // Facing the bay (−z), toward the camera.
  const facing = Math.PI;
  void engine.world.renderer.setAnimationLoop((now: number) => {
    t += 1 / 60;
    const time = frozen ?? t;
    riders.forEach((r, i) => {
      const x = shot === "face" ? (i - 1.5) * 0.36 : (i - 1.5) * 0.95;
      r.group.position.set(base.x - x, base.y, base.z);
      r.group.rotation.y = facing + (shot === "back" ? Math.PI : 0) + (shot === "row" ? 0.6 : 0);
      r.rig.apply(idlePose(r.anatomy, time + i * 3.1));
    });
    const look = base
      .clone()
      .add(
        new THREE.Vector3(
          Number(params.get("cx") ?? 0),
          Number(params.get("cy") ?? (shot === "face" ? 1.62 : 0.95)),
          0,
        ),
      );
    const dist = Number(params.get("dist") ?? (shot === "face" ? 1.25 : 4.6));
    const eye = look
      .clone()
      .add(new THREE.Vector3(Math.sin(orbit) * dist, shot === "face" ? 0.02 : 0.25, -Math.cos(orbit) * dist));
    world.renderFrom(eye, look, now / 1000, 1 / 60, shot === "face" ? 30 : 38);
  });
}
