// Dev: a circuit in its conditions without a race, for look tests.
//  `/?celshot=course&event=snow&season=fall&weather=storm&turns=clear&time=dusk&turn=0.5&view=1`
//  (`event`, `season`, `weather`, `turns` and `time` as the quick race takes
//  them; `turn` how far the weather has turned, 0-1; `view` one of the
//  circuit's set views: a rider from behind along the course, then a wide
//  one; or `eye=x,y,z&look=x,y,z`). `window.__shotReady` turns true once
//  it is drawn.
import * as THREE from "three/webgpu";
import { NOON, SEASONS, WEATHERS, botAppearance } from "@shifty/rider";
import { Scenery } from "../wasm/sim.js";
import { Bay } from "../render/bay.ts";
import { Cape } from "../render/cape.ts";
import { Mountain } from "../render/mountain.ts";
import type { Environment, RiderView } from "../render/world.ts";
import { parseCourse } from "../wasm-json.ts";
import { type Conditions, conditionsBytes } from "./conditions.ts";
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
  const view: View =
    params.has("eye") && params.has("look")
      ? { eye: point("eye"), look: point("look"), rider: null }
      : views[Math.min(views.length - 1, Number(params.get("view") ?? 0))]!;
  const turn = Number(params.get("turn") ?? 0);
  world.setAppearance(0, botAppearance(3, 0));
  const [model] = world.addRiders([0]);
  await engine.warm(() => world.compile());
  if (model) await Promise.race([model.ready, new Promise((resolve) => setTimeout(resolve, 8000))]);
  booted();
  let frames = 0;
  const t0 = performance.now();
  void world.renderer.setAnimationLoop((now: number) => {
    const t = 30 + (now - t0) / 1000;
    if (model) {
      model.mesh.visible = view.rider !== null;
      if (view.rider) {
        const r = view.rider;
        const y = env.ground(r.x, r.z, t);
        const v = Math.sin(r.yaw) * 14;
        const w = Math.cos(r.yaw) * 14;
        const rider: RiderView = {
          slot: 0,
          x: r.x,
          y,
          z: r.z,
          yaw: r.yaw,
          pitch: 0,
          roll: 0,
          speed: 14,
          grounded: true,
          isMe: true,
          isBot: false,
          bailing: false,
          vx: v,
          vy: 0,
          vz: w,
          charge: 0,
          grab: 0,
          lean: 0,
          steer: 0.2,
          wobble: 0,
        };
        model.update(rider, 1 / 60);
      }
    }
    world.renderFrom(view.eye, view.look, t, 1 / 60, data.sport === "snow" ? 55 : 55, turn);
    if (++frames === 30) Reflect.set(window, "__shotReady", true);
  });
}
