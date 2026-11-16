// Dev: a circuit in its conditions without a race, for look tests.
//  `/?celshot=course&event=snow&season=fall&weather=storm&turns=clear&time=dusk&turn=0.5&view=1`
//  (`event`, `season`, `weather`, `turns` and `time` as the quick race takes
//  them; `turn` how far the weather has turned, 0-1; `at` (and `off`) a
//  rider that far down a run (and off its centre line; `back`: seen from
//  that far below, looking back up); `view` one of the
//  circuit's set views: a rider from behind along the course, then a wide
//  one; or `eye=x,y,z&look=x,y,z`; or `fly=0-1`, the intro's fly-over that
//  far through; or, on a run, `tv=<camera>&rider=<m down the run>`, one of
//  the television cameras on a rider there, moving at `speed` m/s).
//  `window.__shotReady` turns true once it is drawn.
import * as THREE from "three/webgpu";
import { NOON, SEASONS, WEATHERS, botAppearance } from "@shifty/rider";
import { Scenery } from "../wasm/sim.js";
import { Bay } from "../render/bay.ts";
import { Cape } from "../render/cape.ts";
import { Mountain } from "../render/mountain.ts";
import type { Environment, RiderView } from "../render/world.ts";
import { parseCourse } from "../wasm-json.ts";
import type { Aim, Watch } from "./broadcast-rig.ts";
import { snowRigs } from "./broadcast-snow.ts";
import { type Conditions, conditionsBytes } from "./conditions.ts";
import { Flyover } from "./flyover.ts";
import type { Engine } from "./engine.ts";
import { quickPlan } from "./quick.ts";
import { booted } from "../loading.ts";

interface View {
  eye: THREE.Vector3;
  look: THREE.Vector3;
  rider: { x: number; z: number; yaw: number } | null;
}

export async function courseShot(engine: Engine, params: URLSearchParams): Promise<void> {
  const plan = quickPlan(params);
  const course = Number(plan.get("course") ?? 0);
  const conditions: Conditions = {
    season: SEASONS[Number(plan.get("season") ?? 0)] ?? "summer",
    weather: WEATHERS[Number(plan.get("weather") ?? 0)] ?? "clear",
    turns: WEATHERS[Number(plan.get("turns") ?? plan.get("weather") ?? 0)] ?? "clear",
    time: Number(plan.get("time") ?? NOON),
  };
  const scenery = new Scenery(course, 1, 7);
  scenery.setConditions(conditionsBytes(conditions));
  const data = parseCourse(scenery.courseJson());
  const world = engine.world;
  const views: View[] = [];
  let env: Environment;
  if (data.sport === "snow") {
    const run = data.run;
    env = new Mountain(
      run,
      {
        ribbon: (rows, offsets) => scenery.runRibbon(rows, offsets),
        grid: (x0, z0, step, nx, nz) => scenery.terrainGrid(x0, z0, step, nx, nz),
        heights: (points) => scenery.heightsAt(points),
        snow: (points) => scenery.snowAt(points),
      },
      conditions,
      course,
    );
    for (const f of [0.12, 0.42, 0.62, 0.86]) {
      const p = run.path[Math.floor(f * (run.path.length - 1))]!;
      const fx = Math.sin(p.yaw);
      const fz = Math.cos(p.yaw);
      views.push({
        eye: new THREE.Vector3(p.x - fx * 4.5, p.y + 2.2, p.z - fz * 4.5),
        look: new THREE.Vector3(p.x + fx * 10, p.y - 1.2, p.z + fz * 10),
        rider: { x: p.x, z: p.z, yaw: p.yaw },
      });
    }
    const a = run.path[Math.floor(run.path.length * 0.3)]!;
    const b = run.path[Math.floor(run.path.length * 0.55)]!;
    views.push({
      eye: new THREE.Vector3(a.x - Math.cos(a.yaw) * 60, a.y + 45, a.z - 40),
      look: new THREE.Vector3(b.x, b.y, b.z),
      rider: null,
    });
  } else {
    const bay = data.bay;
    const water = {
      water: engine.view.water,
      topSpeed: scenery.topSpeed(),
      waves: scenery.waveParams(),
      course: bay,
      conditions,
    };
    env = bay.place === "cape" ? new Cape(water) : new Bay(water);
    const spots = [bay.start, ...bay.buoys.filter((_, i) => i % 3 === 1).slice(0, 2)];
    for (const [i, buoy] of spots.entries()) {
      // Short of a buoy, to the side it is passed on.
      const back = i === 0 ? 0 : 26;
      const side = i === 0 ? 0 : 5;
      const s = {
        x: buoy.x - Math.sin(buoy.yaw) * back + Math.cos(buoy.yaw) * side,
        z: buoy.z - Math.cos(buoy.yaw) * back - Math.sin(buoy.yaw) * side,
        yaw: buoy.yaw,
      };
      const fx = Math.sin(s.yaw);
      const fz = Math.cos(s.yaw);
      views.push({
        eye: new THREE.Vector3(s.x - fx * 5, 2.6, s.z - fz * 5),
        look: new THREE.Vector3(s.x + fx * 10, 0.8, s.z + fz * 10),
        rider: { x: s.x, z: s.z, yaw: s.yaw },
      });
    }
    views.push({ eye: new THREE.Vector3(-40, 70, -280), look: new THREE.Vector3(20, 0, 80), rider: null });
  }
  world.setEnvironment(env);
  const point = (k: string) => {
    const [x = 0, y = 0, z = 0] = (params.get(k) ?? "").split(",").map(Number);
    return new THREE.Vector3(x, y, z);
  };
  // A rider `at` metres down a run, `off` metres to their right of its centre line.
  const downRun = (): View | null => {
    if (data.sport !== "snow" || !params.has("at")) return null;
    const path = data.run.path;
    const p = path[Math.max(0, Math.min(path.length - 1, Math.round((Number(params.get("at")) - path[0]!.s) / 4)))]!;
    const off = Number(params.get("off") ?? 0);
    const x = p.x - Math.cos(p.yaw) * off;
    const z = p.z + Math.sin(p.yaw) * off;
    const y = env.ground(x, z, 0);
    const fx = Math.sin(p.yaw);
    const fz = Math.cos(p.yaw);
    // `back`: seen from that many metres further down, looking back up at them.
    const back = Number(params.get("back") ?? 0);
    if (back > 0) {
      const bx = x + fx * back;
      const bz = z + fz * back;
      return {
        eye: new THREE.Vector3(bx, env.ground(bx, bz, 0) + 2.4, bz),
        look: new THREE.Vector3(x, y + 1, z),
        rider: { x, z, yaw: p.yaw },
      };
    }
    return {
      eye: new THREE.Vector3(x - fx * 4.5, y + 2.2, z - fz * 4.5),
      look: new THREE.Vector3(x + fx * 10, y - 1.2, z + fz * 10),
      rider: { x, z, yaw: p.yaw },
    };
  };
  const view: View =
    params.has("eye") && params.has("look")
      ? { eye: point("eye"), look: point("look"), rider: null }
      : (downRun() ?? views[Math.min(views.length - 1, Number(params.get("view") ?? 0))]!);
  const turn = Number(params.get("turn") ?? 0);
  // The intro's fly-over, held at one moment of it.
  const fly = params.has("fly") ? new Flyover(data, env).intro(Number(params.get("fly")) * 7, 7) : null;
  // A television camera on a rider somewhere down the run.
  const tv = data.sport === "snow" ? params.get("tv") : null;
  const aim: Aim = { eye: new THREE.Vector3(), look: new THREE.Vector3(), frame: 4, fov: null, follow: 6, roll: 0 };
  let televised: ((t: number) => void) | null = null;
  if (tv !== null && data.sport === "snow") {
    const run = data.run;
    const along = Number(params.get("rider") ?? run.finishS + 25);
    const p = run.path[Math.max(0, Math.min(run.path.length - 1, Math.round((along - run.path[0]!.s) / 4)))]!;
    view.rider = { x: p.x, z: p.z, yaw: p.yaw };
    const rig = snowRigs(run, env, (points) => scenery.heightsAt(points), course).find((r) => r.name === tv);
    const speed = Number(params.get("speed") ?? 0);
    let begun = false;
    televised = (t) => {
      const r = riderAt(view.rider!, env.ground(p.x, p.z, t), speed);
      const watch: Watch = {
        riders: [r],
        me: r,
        t,
        simT: t,
        dt: 1 / 60,
        still: () => (speed > 0 ? 0 : 3),
        results: false,
      };
      if (!rig) return;
      if (!begun) rig.begin?.(watch, r);
      begun = true;
      aim.fov = null;
      rig.aim(watch, r, aim);
    };
  }
  world.setAppearance(0, botAppearance(3, 0));
  const [model] = world.addRiders([0]);
  await env.ready;
  await engine.warm(() => world.compile());
  if (model) await Promise.race([model.ready, new Promise((resolve) => setTimeout(resolve, 8000))]);
  booted();
  let frames = 0;
  const t0 = performance.now();
  void world.renderer.setAnimationLoop((now: number) => {
    const t = 30 + (now - t0) / 1000;
    if (model) {
      model.mesh.visible = view.rider !== null;
      if (view.rider) model.update(riderAt(view.rider, env.ground(view.rider.x, view.rider.z, t), 14), 1 / 60);
    }
    if (televised) {
      televised(t);
      // A long lens frames `frame` m of the world at the rider.
      const reach = aim.eye.distanceTo(aim.look);
      const fov = aim.fov ?? (2 * Math.atan(aim.frame / 2 / Math.max(1, reach)) * 180) / Math.PI;
      world.renderFrom(aim.eye, aim.look, t, 1 / 60, fov, turn);
    } else if (fly) world.renderFrom(fly.eye, fly.look, t, 1 / 60, fly.fov, turn);
    else world.renderFrom(view.eye, view.look, t, 1 / 60, 55, turn);
    if (++frames === 30) Reflect.set(window, "__shotReady", true);
  });
}

/** A rider standing in for the look tests: on the snow or the water at a place, heading its way at `speed` m/s. */
function riderAt(at: { x: number; z: number; yaw: number }, y: number, speed: number): RiderView {
  return {
    slot: 0,
    x: at.x,
    y,
    z: at.z,
    yaw: at.yaw,
    pitch: 0,
    roll: 0,
    speed,
    grounded: true,
    isMe: true,
    isBot: false,
    bailing: false,
    vx: Math.sin(at.yaw) * speed,
    vy: 0,
    vz: Math.cos(at.yaw) * speed,
    charge: 0,
    grab: 0,
    lean: 0,
    steer: speed > 0 ? 0.2 : 0,
    wobble: 0,
  };
}
