// Behind the menus: a fly-over of Costa Nevada (login), an abstract play of
// the seasons' colours with your rider (main menu), and the country club
// where riders gather (mode select, rooms). Each is a stage; one is shown
// at a time, and they keep what they built for the next time.
import * as THREE from "three/webgpu";
import {
  Fn,
  abs,
  clamp,
  float,
  fwidth,
  length,
  min,
  mix,
  mx_noise_float,
  positionWorld,
  screenUV,
  sin,
  smoothstep,
  uniform,
  vec2,
  vec3,
} from "three/tsl";
import type { Appearance, Sport } from "@shifty/rider";
import { Scenery } from "../wasm/sim.js";
import { Avatar } from "../render/avatar.ts";
import { Bay } from "../render/bay.ts";
import { CLUB, CLUB_VIEW, buildClub, riderSpots } from "../render/club.ts";
import { CEL } from "../render/cel/look.ts";
import { SUN_DIR, SUN_STRENGTH, celify, inkNode, inkOnlyInPass } from "../render/cel/material.ts";
import { CelPost } from "../render/cel/post.ts";
import { PIXEL_AT_1M } from "../render/cel/rider.ts";
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

/** The summer bay of the menus (dev look tests use it too). */
export function sharedBay(engine: Engine): Bay {
  return bay(engine);
}

const SUMMER_ACCENT = PALETTE.summer.accent;

/** A slow loop over the bay, the town and the mountains behind. */
const devParams = new URLSearchParams(location.search);

class Flyover implements Stage {
  private engine: Engine | null = null;
  /** Dev: `?fly=0.3` starts that far round the loop, `&freeze` holds it there. */
  private t = Number(devParams.get("fly") ?? 0) * 90;
  private frozen = devParams.has("freeze") || devParams.has("capture");
  /** Dev: `?capture` hands the clock to `window.__celFly(seconds)`, for frame-by-frame video. */
  private capture = devParams.has("capture");
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
    if (this.capture) Reflect.set(window, "__celFly", (seconds: number) => (this.t = seconds));
    if (!engine.render) return;
    engine.world.setEnvironment(bay(engine));
    engine.world.setSunOffset(30, 60, 15);
  }

  frame(now: number, dt: number): void {
    const engine = this.engine;
    if (!engine?.render) return;
    if (!this.frozen) this.t += dt;
    const u = (this.t / 90) % 1;
    const t = this.capture ? this.t : now / 1000;
    engine.world.renderFrom(this.eye.getPointAt(u), this.look.getPointAt(u), t, this.capture ? 1 / 30 : dt, 52);
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
  private key: THREE.DirectionalLight;
  private post: CelPost | null = null;
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
    // The cel look keys from the camera's left, so the rider turns half to shade.
    if (CEL) key.position.set(-4, 4.5, 3.5);
    else key.position.set(3, 5, 4);
    key.castShadow = true;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfe3ff, 1.4);
    rim.position.set(-4, 3, -3);
    // Cel shading takes one key light; its rim comes from the material.
    if (!CEL) this.scene.add(rim);
    this.key = key;
    // A soft shadow under the rider.
    const shadowMat = new THREE.MeshBasicNodeMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    });
    if (CEL) inkOnlyInPass(shadowMat, inkNode(0, 0, 0, 0));
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.7, 32), shadowMat);
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

  /** Dresses the rider. */
  setRider(appearance: Appearance, sport: Sport): void {
    this.avatar.set(appearance, sport);
  }

  /** Frames the whole rider, or their face (the creator, on face parts). */
  setFocus(focus: "body" | "face"): void {
    this.focus = focus;
  }

  private focus: "body" | "face" = "body";
  private zoom = 0;

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
    // Closing in on the face eases in and out.
    this.zoom += ((this.focus === "face" ? 1 : 0) - this.zoom) * (1 - Math.exp(-dt * 4));
    const z = this.zoom * this.zoom * (3 - 2 * this.zoom);
    const distance = 6.4 - z * 4.9;
    const halfW = Math.tan((this.camera.fov * Math.PI) / 360) * distance * this.camera.aspect;
    this.avatar.mesh.position.set(-halfW * 0.5, 0, 0);
    this.avatar.mesh.rotation.y = 0.35 * (1 - z) + Math.sin(this.t * 0.25) * 0.3 * (1 - z * 0.6);
    this.avatar.update(dt);
    const lookY = 0.85 + z * 0.62;
    this.camera.position.set(0, 0.95 + z * 0.52, distance);
    this.camera.lookAt(0, lookY, 0);
    if (CEL) {
      this.post ??= new CelPost(engine.world.renderer, this.scene, this.camera);
      const k = this.key;
      SUN_STRENGTH.value = (k.color.r + k.color.g + k.color.b) * k.intensity;
      SUN_DIR.value.copy(k.position).normalize();
      PIXEL_AT_1M.value = (2 * Math.tan((this.camera.fov * Math.PI) / 360)) / 1080;
      this.post.render();
    } else engine.world.renderer.render(this.scene, this.camera);
  }

  stop(): void {}
}

/** The club's terrace, with the riders gathered at the front of it. */
class Club implements Stage {
  private engine: Engine | null = null;
  private group = CEL ? celifyClub(buildClub()) : buildClub();
  private avatars: Avatar[] = [];
  private t = 0;
  private count = 1;

  private you: { appearance: Appearance; sport: Sport } | null = null;
  private closeUp = 0;
  private wantCloseUp = false;

  /** Frames your rider up close (the pro shop) instead of the whole terrace. */
  setCloseUp(on: boolean): void {
    this.wantCloseUp = on;
  }

  /** Dresses your rider (the one in front). */
  setYou(appearance: Appearance, sport: Sport): void {
    this.you = { appearance, sport };
    this.avatars[0]?.set(appearance, sport);
  }

  /** How many riders stand on the terrace (you and your party). */
  setRiders(count: number): void {
    this.count = Math.max(1, Math.min(4, count));
    this.place();
  }

  private place(): void {
    const spots = HERO ? heroSpots() : riderSpots();
    while (this.avatars.length < this.count) {
      const you = this.avatars.length === 0 ? this.you : null;
      const a = new Avatar(you?.appearance ?? null, this.avatars.length, you?.sport ?? "summer");
      this.avatars.push(a);
    }
    this.avatars.forEach((a, i) => {
      const spot = spots[i]!;
      a.crossed = HERO && i === 0;
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
    // The cel look wants a key from the camera's left, so the riders turn half to shade.
    if (HERO) {
      const k = HERO_VIEW.key;
      engine.world.setSunOffset(k.x, k.y, k.z);
      const shadow = engine.world.sunLight.shadow.camera;
      Object.assign(shadow, { left: -10, right: 10, top: 10, bottom: -10 });
      shadow.updateProjectionMatrix();
    } else if (CEL) engine.world.setSunOffset(36, 30, -4);
    else engine.world.setSunOffset(-25, 55, -30);
    engine.world.scene.add(this.group);
    this.place();
  }

  frame(now: number, dt: number): void {
    const engine = this.engine;
    if (!engine?.render) return;
    this.t += dt;
    for (const a of this.avatars) a.update(dt);
    if (HERO) {
      this.closeUp += ((this.wantCloseUp ? 1 : 0) - this.closeUp) * (1 - Math.exp(-dt * 3));
      const h = heroView(this.t, this.closeUp * this.closeUp * (3 - 2 * this.closeUp));
      engine.world.renderFrom(h.eye, h.look, now / 1000, dt, h.fov);
      return;
    }
    // Swaying a little, like a handheld camera.
    const sway = Math.sin(this.t * 0.3);
    const { eye: e, look: l } = CLUB_VIEW;
    const eye = new THREE.Vector3(e.x, e.y + Math.sin(this.t * 0.5) * 0.04, e.z + sway * 0.25);
    const look = new THREE.Vector3(l.x, l.y, l.z);
    // Up close: in front of your rider, who stands left of the shop's panel.
    this.closeUp += ((this.wantCloseUp ? 1 : 0) - this.closeUp) * (1 - Math.exp(-dt * 3));
    if (this.closeUp > 1e-3) {
      const spot = riderSpots()[0]!;
      const k = this.closeUp * this.closeUp * (3 - 2 * this.closeUp);
      const toward = new THREE.Vector3(Math.sin(spot.yaw), 0, Math.cos(spot.yaw));
      const side = new THREE.Vector3(toward.z, 0, -toward.x);
      const at = new THREE.Vector3(spot.x, CLUB.floor + 1.05, spot.z);
      // Looking past the rider's shoulder puts them left of the panel.
      eye.lerp(
        at
          .clone()
          .addScaledVector(toward, 3.6)
          .add(new THREE.Vector3(0, 0.25, 0)),
        k,
      );
      look.lerp(at.clone().addScaledVector(side, 1.15), k);
    }
    engine.world.renderFrom(eye, look, now / 1000, dt, 50);
  }

  stop(): void {
    this.group.removeFromParent();
    this.engine?.world.clearEnvironment();
  }
}

/**
 * The cel look's mode select, framed like a character select: the camera
 * low on the terrace looking out to sea, your rider large on the left,
 * turned three-quarters, friends beside and behind. `?frame=classic`
 * keeps the usual view of the clubhouse.
 */
const HERO = CEL && devParams.get("frame") !== "classic";
const HERO_VIEW = (() => {
  const at = new THREE.Vector3(CLUB.x + 2.5, CLUB.floor, CLUB.z - 5.2);
  // The camera stands inland of the rider, looking out over the bay (−z), a little from the east.
  const theta = 0.42;
  const fwd = new THREE.Vector3(-Math.sin(theta), 0, -Math.cos(theta));
  const right = new THREE.Vector3(Math.cos(theta), 0, -Math.sin(theta));
  const key = right
    .clone()
    .multiplyScalar(-22)
    .addScaledVector(fwd, -24)
    .add(new THREE.Vector3(0, 30, 0));
  return { at, theta, fwd, right, key, dist: 4.4, fov: 34 };
})();

function heroSpots(): { x: number; z: number; yaw: number }[] {
  const { at, theta, right, fwd } = HERO_VIEW;
  const spot = (side: number, back: number, turn: number) => {
    const p = at.clone().addScaledVector(right, side).addScaledVector(fwd, back);
    return { x: p.x, z: p.z, yaw: theta + turn };
  };
  return [spot(0, 0, 0.45), spot(-1.1, 1.3, 0.2), spot(1.2, 1.5, -0.3), spot(-2.2, 2.6, 0.1)];
}

/** The hero view at time `t`; `close` (0-1) closes in on the rider (the pro shop). */
function heroView(t: number, close = 0): { eye: THREE.Vector3; look: THREE.Vector3; fov: number } {
  const { at, fwd, right, dist, fov } = HERO_VIEW;
  const sway = Math.sin(t * 0.3) * 0.08;
  const eye = at
    .clone()
    .addScaledVector(fwd, -(dist - close * 1.6))
    .addScaledVector(right, sway)
    .add(new THREE.Vector3(0, 0.82 + close * 0.45 + Math.sin(t * 0.5) * 0.02, 0));
  // Looking past the rider's left shoulder puts them left of centre.
  const look = at
    .clone()
    .addScaledVector(right, 1.55 - close * 0.55)
    .add(new THREE.Vector3(0, 1.12 + close * 0.2, 0));
  return { eye, look, fov };
}

function celifyClub(g: THREE.Group): THREE.Group {
  celify(g, (m) => {
    // The terrace's paving: square slabs with grout, each a touch different.
    if (m.color.getHex() !== 0xe9dcc2) return {};
    const colorNode = Fn(() => {
      const q = positionWorld.xz.div(0.75);
      const cell = q.floor();
      const f = q.fract();
      const edge = min(min(f.x, f.y), min(f.x.oneMinus(), f.y.oneMinus()));
      const aa = fwidth(edge);
      const grout = smoothstep(float(0.02).add(aa), float(0.02).sub(aa), edge);
      const v = mx_noise_float(vec3(cell.mul(3.7), 0.5)).mul(0.05);
      const slab = vec3(0.8, 0.72, 0.58).mul(float(1).add(v));
      return mix(slab, vec3(0.62, 0.55, 0.45), grout);
    })();
    return { colorNode, crease: 0 };
  });
  return g;
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

/** Dresses your rider on the main menu. */
export function setMenuRider(appearance: Appearance, sport: Sport): void {
  (field ??= new SeasonField()).setRider(appearance, sport);
}

/** Frames your rider whole or close on the face (main menu backdrop). */
export function setMenuFocus(focus: "body" | "face"): void {
  (field ??= new SeasonField()).setFocus(focus);
}

/** Frames your rider up close on the club's terrace (the pro shop). */
export function setClubCloseUp(on: boolean): void {
  (club ??= new Club()).setCloseUp(on);
}

/** Dresses your rider on the club's terrace. */
export function setClubRider(appearance: Appearance, sport: Sport): void {
  (club ??= new Club()).setYou(appearance, sport);
}

/** Sets how many riders stand on the club's terrace. */
export function setClubRiders(count: number): void {
  (club ??= new Club()).setRiders(count);
}
