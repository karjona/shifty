// Dev: `/?lookdev=1` shows riders on the club's terrace for look testing.
// URL options: shot (select, hero, lineup, face, back), sport (summer, winter), seed (random
// looks; 0 = the default rider), body (male, female: everyone's, in its starter kit), skin, hair,
// hairColor, eyes, eyeColor, brows, nose, mouth, facialHair, height, wear (item ids to put on),
// bare (slots to empty), pose (idle, crossed), t (freeze the idle at a time), cx/cy/dist (camera),
// orbit, ride (on the sport's ride: steer -1 to 1, bail, lean -1 to 1, grab 1-5, air; on a jetski, stunt 1-5
// and how far into it, reach 0-1). Keys: F next shot, R new looks, arrows orbit.
import * as THREE from "three/webgpu";
import {
  type Appearance,
  type Sport,
  botAppearance,
  defaultAppearance,
  defaultOutfits,
  item,
  model,
} from "@shifty/rider";
import { Scenery } from "../wasm/sim.js";
import { Bay } from "../render/bay.ts";
import { CLUB, buildClub } from "../render/club.ts";
import { BoarderModel } from "../render/boarder.ts";
import { celify } from "../render/cel/material.ts";
import { JetskiModel } from "../render/rider.ts";
import { RiderFigure } from "../render/rider/model.ts";
import { crossedPose, idlePose } from "../render/rider/poses.ts";
import { parseCourse } from "../wasm-json.ts";
import type { RiderModel, RiderView } from "../render/world.ts";
import { Engine } from "./engine.ts";

type Shot = "select" | "hero" | "lineup" | "face" | "back";
const SHOTS: readonly Shot[] = ["select", "hero", "lineup", "face", "back"];
const isShot = (s: string | null): s is Shot => SHOTS.some((x) => x === s);

function appearanceFor(seed: number, i: number, params: URLSearchParams): Appearance {
  const a = seed === 0 && i === 0 ? defaultAppearance() : botAppearance(seed, i);
  const body = params.get("body");
  if (body === "male" || body === "female") {
    a.look.body = body;
    a.outfits = defaultOutfits(body);
    if (body === "female") a.look.facialHair = 0;
  }
  // `wear=summer.vest.foam.red,...`: put items on, each in its own slot.
  for (const id of (params.get("wear") ?? "").split(",").filter(Boolean)) {
    const it = item(id);
    const m = it && model(it.model);
    if (m) a.outfits[m.sport][m.slot] = id;
  }
  // `bare=head,eyes`: leave slots empty.
  const bare = (params.get("bare") ?? "").split(",");
  for (const kit of Object.values(a.outfits)) {
    for (const slot of Object.keys(kit)) if (bare.includes(slot)) Reflect.deleteProperty(kit, slot);
  }
  for (const part of [
    "skin",
    "hair",
    "hairColor",
    "eyes",
    "eyeColor",
    "brows",
    "nose",
    "mouth",
    "facialHair",
    "height",
  ] as const) {
    const v = params.get(part);
    if (v !== null) a.look[part] = Number(v);
  }
  return a;
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
  if ((params.get("shot") ?? "select") === "select") world.setSunOffset(18, 45, 40);
  else world.setSunOffset(-25, 55, -30);
  world.scene.add(buildClub());

  const shotParam = params.get("shot");
  let shot: Shot = isShot(shotParam) ? shotParam : "select";
  const sport: Sport = params.get("sport") === "winter" ? "winter" : "summer";
  let seed = Number(params.get("seed") ?? 0);
  const frozen = params.has("t") ? Number(params.get("t")) : null;
  let orbit = Number(params.get("orbit") ?? 0);
  let riders: RiderFigure[] = [];
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

  const riding = params.has("ride");
  let skis: RiderModel[] = [];
  const build = () => {
    for (const r of riders) {
      r.group.removeFromParent();
      r.dispose();
    }
    for (const j of skis) {
      j.mesh.removeFromParent();
      j.dispose?.();
    }
    const count = shot === "lineup" ? 4 : 1;
    if (riding) {
      riders = [];
      skis = Array.from({ length: count }, (_, i) => {
        const a = appearanceFor(seed, i, params);
        const m = sport === "winter" ? new BoarderModel(i, a) : new JetskiModel(i, a);
        celify(m.mesh);
        return m;
      });
      for (const j of skis) world.scene.add(j.mesh);
    } else {
      riders = Array.from({ length: count }, (_, i) => new RiderFigure(appearanceFor(seed, i, params), sport));
      for (const r of riders) world.scene.add(r.group);
    }
    label.textContent = `${shot} · ${sport} · seed ${seed} · keys: F shot, R new looks, ←→ orbit`;
  };
  build();

  addEventListener("keydown", (e) => {
    if (e.key === "f") {
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
  const framing: Record<Shot, { cy: number; dist: number; fov: number }> = {
    select: { cy: 0.98, dist: 4.6, fov: 26 },
    hero: { cy: 0.92, dist: 5.2, fov: 24 },
    lineup: { cy: 0.95, dist: 5.6, fov: 34 },
    face: { cy: 1.64, dist: 1.1, fov: 24 },
    back: { cy: 0.92, dist: 5.2, fov: 24 },
  };
  void world.renderer.setAnimationLoop((now: number) => {
    t += 1 / 60;
    const time = frozen ?? t;
    riders.forEach((r, i) => {
      const x = (i - (riders.length - 1) / 2) * 0.95;
      r.group.position.set(base.x - x, base.y, base.z);
      // The select shot looks out from the terrace's sea side, toward the sky, like a character select.
      r.group.rotation.y = shot === "select" ? 0.25 : facing + (shot === "back" ? Math.PI : 0);
      const pose = params.get("pose") ?? (shot === "select" ? "crossed" : "idle");
      if (r.body) r.pose((pose === "crossed" ? crossedPose : idlePose)(r.body, time + i * 3.1));
    });
    skis.forEach((j, i) => {
      const x = (i - (skis.length - 1) / 2) * 1.6;
      const view: RiderView = {
        slot: i,
        x: base.x - x,
        // Boards sit on the floor; jumps leave it.
        y: base.y + (sport === "winter" ? 0.01 : 0) + (params.has("air") ? 0.6 : 0),
        z: base.z,
        yaw: facing + (shot === "back" ? Math.PI : 0),
        pitch: 0,
        roll: 0,
        speed: 0,
        grounded: !params.has("air"),
        isMe: i === 0,
        isBot: false,
        bailing: params.has("bail"),
        vx: 0,
        vy: 0,
        vz: 0,
        charge: params.has("stunt") ? Number(params.get("reach") ?? 1) : 0,
        grab: Number(params.get("stunt") ?? params.get("grab") ?? 0),
        lean: Number(params.get("lean") ?? 0),
        steer: Number(params.get("steer") ?? 0),
        wobble: 0,
      };
      j.update(view, 1 / 60);
    });
    const f = framing[shot];
    const look = base
      .clone()
      .add(new THREE.Vector3(Number(params.get("cx") ?? 0), Number(params.get("cy") ?? f.cy), 0));
    const dist = Number(params.get("dist") ?? f.dist);
    const lift = shot === "face" ? 0.02 : shot === "select" ? -0.25 : -0.1;
    const turn = orbit + (shot === "select" ? Math.PI : 0);
    const eye = look.clone().add(new THREE.Vector3(Math.sin(turn) * dist, lift, -Math.cos(turn) * dist));
    world.renderFrom(eye, look, now / 1000, 1 / 60, Number(params.get("fov") ?? f.fov));
  });
}
