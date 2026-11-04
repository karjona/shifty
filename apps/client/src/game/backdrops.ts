// Behind the menus: a fly-over of Costa Nevada (login), an abstract play of
// the seasons' colours with your rider (main menu), and the country club
// where riders gather (mode select, rooms). Each is a stage; one is shown
// at a time, and they keep what they built for the next time.
import * as THREE from "three/webgpu";
import { Fn, abs, clamp, float, length, mix, screenUV, sin, smoothstep, uniform, vec2, vec3 } from "three/tsl";
import { Scenery } from "../wasm/sim.js";
import { Avatar } from "../render/avatar.ts";
import { Bay } from "../render/bay.ts";
import { CLUB, CLUB_VIEW, buildClub, riderSpots } from "../render/club.ts";
import type { Engine, Stage } from "./engine.ts";
import { PALETTE, accentBetween, seasonAt, setAccent } from "./seasons.ts";
import { parseCourse } from "../wasm-json.ts";

export type BackdropKind = "flyover" | "shader" | "club";

/** The summer bay without a race, shared by the fly-over and the club. */
let menuBay: { bay: Bay; water: "sea" | "basic" } | null = null;

function bay(engine: Engine): Bay {
  if (menuBay?.water === engine.view.water) return menuBay.bay;
  const scenery = new Scenery(0, 1, 7);
  const course = parseCourse(scenery.courseJson());
  if (course.sport !== "jetski") throw new Error("the menu bay is a jetski course");
  const b = new Bay({
    water: engine.view.water,
    topSpeed: scenery.topSpeed(),
    waves: scenery.waveParams(),
    course: course.bay,
  });
  scenery.free();
  menuBay = { bay: b, water: engine.view.water };
  return b;
}

const SUMMER_ACCENT = PALETTE.summer.accent;

/** A slow loop over the bay, the town and the mountains behind. */
class Flyover implements Stage {
  private engine: Engine | null = null;
  private t = 0;
  private eye = new THREE.CatmullRomCurve3(
    [
      new THREE.Vector3(-300, 16, -150),
      new THREE.Vector3(-150, 26, -95),
      new THREE.Vector3(30, 20, -150),
      new THREE.Vector3(170, 34, -110),
      new THREE.Vector3(250, 46, 10),
      new THREE.Vector3(120, 60, -30),
      new THREE.Vector3(-90, 40, -10),
      new THREE.Vector3(-250, 30, -60),
    ],
    true,
    "centripetal",
  );
  private look = new THREE.CatmullRomCurve3(
    [
      new THREE.Vector3(-60, 6, 80),
      new THREE.Vector3(40, 4, 40),
      new THREE.Vector3(85, 3, -60),
      new THREE.Vector3(40, 8, 90),
      new THREE.Vector3(-40, 10, 140),
      new THREE.Vector3(150, 8, 100),
      new THREE.Vector3(-160, 8, 120),
      new THREE.Vector3(-100, 6, 110),
    ],
    true,
    "centripetal",
  );

  start(engine: Engine): void {
    this.engine = engine;
    setAccent(SUMMER_ACCENT);
    if (!engine.render) return;
    engine.world.setEnvironment(bay(engine));
    engine.world.setSunOffset(30, 60, 15);
  }

  frame(now: number, dt: number): void {
    const engine = this.engine;
    if (!engine?.render) return;
    this.t += dt;
    const u = (this.t / 90) % 1;
    engine.world.renderFrom(this.eye.getPointAt(u), this.look.getPointAt(u), now / 1000, dt, 52);
  }

  stop(): void {
    this.engine?.world.clearEnvironment();
  }
}

/** Your rider on a field of the seasons' colours, drifting from one season to the next. */
class SeasonField implements Stage {
  private engine: Engine | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  private time = uniform(0);
  private deep = uniform(new THREE.Color());
  private mid = uniform(new THREE.Color());
  private bright = uniform(new THREE.Color());
  private avatar = new Avatar(null, 0);
  private t = Math.random() * 40;
  private accentAt = 0;

  constructor() {
    const t = this.time;
    const deep = this.deep;
    const mid = this.mid;
    const bright = this.bright;
    // Soft bands of colour that drift and fold over each other, a light
    // from the upper right, and a vignette.
    this.scene.backgroundNode = Fn(() => {
      const uv = screenUV;
      const x = uv.x.mul(1.6);
      const y = uv.y;
      const w1 = sin(
        x
          .mul(2.2)
          .add(t.mul(0.11))
          .add(sin(y.mul(3.1).sub(t.mul(0.07))).mul(1.4)),
      );
      const w2 = sin(
        x
          .mul(3.7)
          .sub(t.mul(0.09))
          .add(y.mul(5.3))
          .add(sin(x.mul(1.3).add(t.mul(0.05))).mul(2.0)),
      );
      const w3 = sin(x.mul(1.1).add(y.mul(1.7)).add(t.mul(0.04)));
      const base = mix(deep, mid, clamp(y.oneMinus().mul(0.9).add(w3.mul(0.25)), 0, 1));
      const band1 = smoothstep(0.55, 0.98, w1.mul(0.5).add(0.5)).mul(0.55);
      const band2 = smoothstep(0.75, 1.0, w2.mul(0.5).add(0.5)).mul(0.35);
      const glow = smoothstep(1.1, 0.0, length(uv.sub(vec2(0.85, 0.15)))).mul(0.45);
      const lit = mix(base, bright, clamp(band1.add(band2).add(glow), 0, 1));
      // Faint, slow ripples of light, like sun through water or snow.
      const ripple = smoothstep(0.97, 1.0, abs(sin(x.mul(9).add(y.mul(5)).add(w3.mul(2)).add(t.mul(0.2))))).mul(0.035);
      const vignette = smoothstep(1.15, 0.35, length(uv.sub(vec2(0.5, 0.45))));
      return lit.add(vec3(ripple)).mul(mix(float(0.55), float(1), vignette));
    })();

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.6));
    const key = new THREE.DirectionalLight(0xfff2e0, 2.4);
    key.position.set(3, 5, 4);
    key.castShadow = true;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfe3ff, 1.4);
    rim.position.set(-4, 3, -3);
    this.scene.add(rim);
    // A soft shadow under the rider.
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.7, 32),
      new THREE.MeshBasicNodeMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.005;
    shadow.scale.set(1, 0.6, 1);
    this.avatar.mesh.add(shadow);
    this.scene.add(this.avatar.mesh);
  }

  start(engine: Engine): void {
    this.engine = engine;
  }

  /** Shows the rider (home) or just the colours (the other tabs). */
  showRider(on: boolean): void {
    this.avatar.mesh.visible = on;
  }

  frame(now: number, dt: number): void {
    const engine = this.engine;
    if (!engine?.render) return;
    this.t += dt;
    this.time.value = this.t;
    const s = seasonAt(this.t);
    const a = PALETTE[s.from];
    const b = PALETTE[s.to];
    this.deep.value.set(a.deep).lerp(new THREE.Color(b.deep), s.mix);
    this.mid.value.set(a.mid).lerp(new THREE.Color(b.mid), s.mix);
    this.bright.value.set(a.bright).lerp(new THREE.Color(b.bright), s.mix);
    if (now - this.accentAt > 120) {
      this.accentAt = now;
      setAccent(accentBetween(s.from, s.to, s.mix));
    }
    // The rider stands left of centre, turning slowly in three-quarter view.
    const w = innerWidth;
    const h = innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const distance = 6.4;
    const halfW = Math.tan((this.camera.fov * Math.PI) / 360) * distance * this.camera.aspect;
    this.avatar.mesh.position.set(-halfW * 0.5, 0, 0);
    this.avatar.mesh.rotation.y = 0.35 + Math.sin(this.t * 0.25) * 0.3;
    this.avatar.update(dt);
    this.camera.position.set(0, 0.95, distance);
    this.camera.lookAt(0, 0.85, 0);
    engine.world.renderer.render(this.scene, this.camera);
  }

  stop(): void {}
}

/** The club's terrace, with the riders gathered at the front of it. */
class Club implements Stage {
  private engine: Engine | null = null;
  private group = buildClub();
  private avatars: Avatar[] = [];
  private t = 0;
  private count = 1;

  /** How many riders stand on the terrace (you and your party). */
  setRiders(count: number): void {
    this.count = Math.max(1, Math.min(4, count));
    this.place();
  }

  private place(): void {
    const spots = riderSpots();
    while (this.avatars.length < this.count) {
      const a = new Avatar(null, this.avatars.length);
      this.avatars.push(a);
    }
    this.avatars.forEach((a, i) => {
      const spot = spots[i]!;
      a.mesh.position.set(spot.x, CLUB.floor, spot.z);
      a.mesh.rotation.y = spot.yaw;
      if (i < this.count) this.group.add(a.mesh);
      else a.mesh.removeFromParent();
    });
  }

  start(engine: Engine): void {
    this.engine = engine;
    setAccent(SUMMER_ACCENT);
    if (!engine.render) return;
    engine.world.setEnvironment(bay(engine));
    engine.world.setSunOffset(-25, 55, -30);
    engine.world.scene.add(this.group);
    this.place();
  }

  frame(now: number, dt: number): void {
    const engine = this.engine;
    if (!engine?.render) return;
    this.t += dt;
    for (const a of this.avatars) a.update(dt);
    // Swaying a little, like a handheld camera.
    const sway = Math.sin(this.t * 0.3);
    const { eye: e, look: l } = CLUB_VIEW;
    const eye = new THREE.Vector3(e.x, e.y + Math.sin(this.t * 0.5) * 0.04, e.z + sway * 0.25);
    const look = new THREE.Vector3(l.x, l.y, l.z);
    engine.world.renderFrom(eye, look, now / 1000, dt, 50);
  }

  stop(): void {
    this.group.removeFromParent();
    this.engine?.world.clearEnvironment();
  }
}

let flyover: Flyover | null = null;
let field: SeasonField | null = null;
let club: Club | null = null;

export function backdrop(kind: BackdropKind): Stage {
  if (kind === "flyover") return (flyover ??= new Flyover());
  if (kind === "shader") return (field ??= new SeasonField());
  return (club ??= new Club());
}

/** Shows or hides the rider on the main menu's colours. */
export function showMenuRider(on: boolean): void {
  (field ??= new SeasonField()).showRider(on);
}

/** Sets how many riders stand on the club's terrace. */
export function setClubRiders(count: number): void {
  (club ??= new Club()).setRiders(count);
}
