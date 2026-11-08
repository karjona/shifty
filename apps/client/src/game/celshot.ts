// Dev: look testing the cel look without the menus.
//  `/?celshot=flyover` (`&fly=0.3&freeze`) or `/?celshot=club`: the menu backdrops.
//  `/?celshot=bay&eye=x,y,z&look=x,y,z&fov=50`: the bay and its course from there.
//  `/?celshot=course&event=snow&season=fall&weather=storm&time=dusk`: a circuit in its conditions (courseshot.ts).
//  `/?celshot=hero`: your rider on the club's terrace, framed like a
//  character select. Options: yaw (rider), sun=x,y,z (offset), cx, cy, dist,
//  fov, orbit, lift, t (freeze the idle), pose (idle, crossed), seed, bare (slots to empty).
import * as THREE from "three/webgpu";
import { botAppearance, defaultAppearance } from "@shifty/rider";
import { CLUB, buildClub } from "../render/club.ts";
import { celify } from "../render/cel/material.ts";
import { RiderFigure } from "../render/rider/model.ts";
import { crossedPose, idlePose } from "../render/rider/poses.ts";
import { backdrop, setClubRider, sharedBay } from "./backdrops.ts";
import { Engine } from "./engine.ts";
import { booted } from "../loading.ts";

/** Anime motion: poses held on twos (12 a second), not tweened. */
export const ON_TWOS = 12;

export async function celshot(params: URLSearchParams): Promise<void> {
  const engine = await Engine.get();
  const kind = params.get("celshot");
  if (kind === "course") {
    const { courseShot } = await import("./courseshot.ts");
    await courseShot(engine, params);
    return;
  }
  if (kind === "bay") {
    const world = engine.world;
    world.setEnvironment(sharedBay(engine));
    world.setSunOffset(30, 60, 15);
    const point = (k: string, d: string) => {
      const [x = 0, y = 0, z = 0] = (params.get(k) ?? d).split(",").map(Number);
      return new THREE.Vector3(x, y, z);
    };
    const eye = point("eye", "0,160,-260");
    const look = point("look", "0,0,0");
    const fov = Number(params.get("fov") ?? 50);
    void world.renderer.setAnimationLoop((now: number) => world.renderFrom(eye, look, now / 1000, 1 / 60, fov));
    booted();
    return;
  }
  if (kind !== "hero") {
    if (kind === "club") setClubRider(defaultAppearance(), "summer");
    engine.show(backdrop(kind === "club" ? "club" : "flyover"));
    return;
  }
  const world = engine.world;
  world.setEnvironment(sharedBay(engine));
  const club = buildClub();
  celify(club);
  world.scene.add(club);
  const num = (k: string, d: number) => Number(params.get(k) ?? d);
  const sun = (params.get("sun") ?? "-30,38,-26").split(",").map(Number);
  world.setSunOffset(sun[0] ?? -30, sun[1] ?? 38, sun[2] ?? -26);
  const seed = num("seed", 0);
  const appearance = seed === 0 ? defaultAppearance() : botAppearance(seed, 0);
  // `bare=head,eyes`: leave those slots empty (to see the face).
  for (const slot of (params.get("bare") ?? "").split(",").filter(Boolean))
    Reflect.deleteProperty(appearance.outfits.summer, slot);
  const figure = new RiderFigure(appearance, "summer");
  world.scene.add(figure.group);
  const base = new THREE.Vector3(CLUB.x + 3, CLUB.floor, CLUB.z - 4);
  figure.group.position.copy(base);
  figure.group.rotation.y = num("yaw", 0.35);
  const frozen = params.has("t") ? num("t", 0) : null;
  const pose = params.get("pose") ?? "crossed";
  let t = 0;
  // A tighter shadow frustum round the rider: crisp shade edges from the cap and arms.
  world.setShadowBox(6);
  void world.renderer.setAnimationLoop((now: number) => {
    t += 1 / 60;
    const time = frozen ?? Math.floor(t * ON_TWOS) / ON_TWOS;
    if (figure.body) figure.pose((pose === "crossed" ? crossedPose : idlePose)(figure.body, time));
    const look = base.clone().add(new THREE.Vector3(num("cx", 0), num("cy", 0.98), 0));
    const dist = num("dist", 4.6);
    const turn = num("orbit", 0) + Math.PI;
    const eye = look.clone().add(new THREE.Vector3(Math.sin(turn) * dist, num("lift", -0.25), -Math.cos(turn) * dist));
    world.renderFrom(eye, look, now / 1000, 1 / 60, num("fov", 26));
  });
}
