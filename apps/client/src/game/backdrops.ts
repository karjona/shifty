// Behind the menus: a fly-over of Costa Nevada (login), an abstract play of
// the seasons' colours with your rider (main menu), and the country club
// where riders gather (mode select, rooms). Each is a stage; one is shown
// at a time, and they keep what they built for the next time.
import * as THREE from "three/webgpu";
import { Fn, abs, clamp, float, length, mix, screenUV, sin, smoothstep, uniform, vec2, vec3 } from "three/tsl";
import type { Appearance, Sport } from "@shifty/rider";
import { Scenery } from "../wasm/sim.js";
import { Avatar } from "../render/avatar.ts";
import { Bay } from "../render/bay.ts";
import { CLUB } from "../render/club.ts";
import { SUN_DIR, SUN_STRENGTH, inkNode, inkOnlyInPass } from "../render/cel/material.ts";
import { CelPost } from "../render/cel/post.ts";
import { PIXEL_AT_1M, SHADOW_LIFT } from "../render/cel/rider.ts";
import { devParams } from "../dev-params.ts";
import type { Engine, Stage } from "./engine.ts";
import { quietly } from "../loading.ts";
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
class Flyover implements Stage {
  private engine: Engine | null = null;
  /** Dev: `?fly=0.3` starts that far round the loop, `&freeze` holds it there. */
  private t = import.meta.env.DEV ? Number(devParams.get("fly") ?? 0) * 90 : 0;
  private frozen = import.meta.env.DEV && (devParams.has("freeze") || devParams.has("capture"));
  /** Dev: `?capture` hands the clock to `window.__celFly(seconds)`, for frame-by-frame video. */
  private capture = import.meta.env.DEV && devParams.has("capture");
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
    if (import.meta.env.DEV && this.capture) Reflect.set(window, "__celFly", (seconds: number) => (this.t = seconds));
    if (!engine.render) return;
    engine.world.setEnvironment(bay(engine));
    engine.world.setSunOffset(30, 60, 15);
  }

  compile(root?: THREE.Object3D): Promise<void> {
    return this.engine?.world.compile(root) ?? Promise.resolve();
  }

  loaded(): Promise<void> {
    return this.engine?.render ? bay(this.engine).ready : Promise.resolve();
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

/**
 * How the main menu's colours frame your rider: close, from the knees
 * up, as a fighting game's menu does (`hero`), whole (`body`), or the
 * face (`face`).
 */
export type RiderShot = "hero" | "body" | "face";

/** A box on screen, in fractions of the window (0-1 from the top left). */
export interface ScreenBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Where the rider stands when the screen gives no space of its own: the left half. */
const LEFT_HALF: ScreenBox = { left: 0.04, right: 0.52, top: 0.14, bottom: 0.96 };

/** Where the key light stands, from the rider's middle (m): the camera's left, so the rider turns half to shade. */
const KEY_OFFSET = new THREE.Vector3(-4, 4.5, 3.5);
/** Half the key light's shadow box (m): the rider, whatever their height, and no more. */
const KEY_BOX = 1.3;

/** A framing: the span of the rider shown (m from the ground), the rows of the window it fills, the column it stands
 * on (fractions of the window), and how the rider turns (their yaw, and how far it sways). */
interface Framing {
  lo: number;
  hi: number;
  top: number;
  bottom: number;
  across: number;
  yaw: number;
  sway: number;
}

const FRAMING = ["lo", "hi", "top", "bottom", "across", "yaw", "sway"] as const satisfies readonly (keyof Framing)[];

/** The framing of a shot in `box`, for a rider `h` metres tall. */
function framingOf(shot: RiderShot, box: ScreenBox, h: number): Framing {
  const across = (box.left + box.right) / 2;
  const tall = box.bottom - box.top;
  if (shot === "face") {
    // Head and shoulders fill most of the space, the head toward its top.
    return {
      lo: h - 0.34,
      hi: h + 0.04,
      top: box.top + tall * 0.06,
      bottom: box.top + tall * 0.8,
      across,
      yaw: 0.15,
      sway: 0.1,
    };
  }
  if (shot === "hero") {
    // Head near the top of the space, cut at the knees by the bottom of the window.
    return { lo: h * 0.3, hi: h + 0.07, top: box.top + tall * 0.02, bottom: 1, across, yaw: 0.3, sway: 0.14 };
  }
  return {
    lo: -0.04,
    hi: h + 0.1,
    top: box.top + tall * 0.02,
    bottom: box.bottom - tall * 0.01,
    across,
    yaw: 0.35,
    sway: 0.3,
  };
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
  /** Your rider (once their look is known) and their shadow. */
  private rider = new THREE.Group();
  private avatar: Avatar | null = null;
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
    key.castShadow = true;
    // A shadow box just round the rider (it follows them, see `frame`): texels of a millimetre or so, and
    // lookups lifted off the surface, so the shade the arms and the hair cast holds still as the rider moves.
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, {
      left: -KEY_BOX,
      right: KEY_BOX,
      top: KEY_BOX,
      bottom: -KEY_BOX,
      near: 1,
      far: 14,
    });
    key.shadow.normalBias = 0.012;
    key.shadow.bias = -0.0004;
    this.scene.add(key, key.target);
    this.key = key;
    // A soft shadow under the rider.
    const shadowMat = new THREE.MeshBasicNodeMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    });
    inkOnlyInPass(shadowMat, inkNode(0, 0, 0, 0));
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.7, 32), shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.005;
    shadow.scale.set(1, 0.6, 1);
    this.rider.add(shadow);
    this.scene.add(this.rider);
  }

  start(engine: Engine): void {
    this.engine = engine;
    this.post ??= new CelPost(engine.world.renderer, this.scene, this.camera);
  }

  compile(root?: THREE.Object3D): Promise<void> {
    return this.post?.compile(root) ?? Promise.resolve();
  }

  loaded(): Promise<void> {
    return (this.rider.visible && this.avatar?.ready) || Promise.resolve();
  }

  /** Shows the rider (home) or just the colours (the other tabs). */
  showRider(on: boolean): void {
    this.rider.visible = on;
  }

  /** Dresses the rider. */
  setRider(appearance: Appearance, sport: Sport): void {
    if (this.avatar) this.avatar.set(appearance, sport);
    else {
      this.avatar = new Avatar(appearance, 0, sport);
      this.avatar.stance = this.shot === "hero" ? "hip" : "idle";
      this.avatar.showRide(this.withRide);
      this.rider.add(this.avatar.mesh);
    }
  }

  private withRide = false;

  /** Shows the rider's ride with them, or not. */
  showRide(on: boolean): void {
    this.withRide = on;
    this.avatar?.showRide(on);
  }

  private shot: RiderShot = "body";
  private space: (() => ScreenBox | null) | null = null;
  /** The framing on screen, easing toward the shot's. */
  private framing: Framing | null = null;

  /** Frames the rider for `shot`, in the free space on screen `space` gives (the left half without one). */
  setShot(shot: RiderShot, space: (() => ScreenBox | null) | null): void {
    this.shot = shot;
    this.space = space;
    if (this.avatar) this.avatar.stance = shot === "hero" ? "hip" : "idle";
  }

  /** Eases the framing toward the shot's (snaps to it at first). */
  private reframe(dt: number): Framing {
    const want = framingOf(this.shot, this.space?.() ?? LEFT_HALF, this.avatar?.height ?? 1.78);
    const f = this.framing;
    if (!f) return (this.framing = want);
    const k = 1 - Math.exp(-dt * 4);
    for (const key of FRAMING) f[key] += (want[key] - f[key]) * k;
    return f;
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
    // A level camera, placed so the framed span of the rider fills its rows of the window, on its column.
    const aspect = innerWidth / innerHeight;
    if (this.camera.aspect !== aspect) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    const f = this.reframe(dt);
    const tan = Math.tan((this.camera.fov * Math.PI) / 360);
    const yTop = 1 - 2 * f.top;
    const yBottom = 1 - 2 * f.bottom;
    const distance = (f.hi - f.lo) / ((yTop - yBottom) * tan);
    const x = -(2 * f.across - 1) * distance * tan * aspect;
    const y = f.hi - yTop * distance * tan;
    this.camera.position.set(x, y, distance);
    this.camera.lookAt(x, y, 0);
    // Turning slowly in three-quarter view.
    this.rider.rotation.y = f.yaw + Math.sin(this.t * 0.25) * f.sway;
    this.avatar?.update(dt);
    this.post ??= new CelPost(engine.world.renderer, this.scene, this.camera);
    const k = this.key;
    k.target.position.set(0, (this.avatar?.height ?? 1.78) / 2, 0);
    k.position.copy(k.target.position).add(KEY_OFFSET);
    SUN_STRENGTH.value = (k.color.r + k.color.g + k.color.b) * k.intensity;
    SUN_DIR.value.copy(KEY_OFFSET).normalize();
    PIXEL_AT_1M.value = (2 * Math.tan((this.camera.fov * Math.PI) / 360)) / 1080;
    SHADOW_LIFT.value = 0;
    this.post.render();
  }

  stop(): void {}
}

/** The club's terrace, with the riders gathered at the front of it. */
/** Someone in your party on the terrace: their id, and how they look (null: a stand-in dressed for the seat). */
export interface PartyMember {
  id: string;
  appearance: Appearance | null;
}

class Club implements Stage {
  private engine: Engine | null = null;
  private group = new THREE.Group();
  /** You, in front. */
  private avatars: Avatar[] = [];
  /** The others, in the order they came: each on the terrace once their art is in. */
  private party: { id: string; avatar: Avatar; in: boolean }[] = [];

  private you: { appearance: Appearance; sport: Sport } | null = null;
  private closeUp = 0;
  private wantCloseUp = false;

  /** Frames your rider up close (the pro shop) instead of the whole terrace. */
  setCloseUp(on: boolean): void {
    this.wantCloseUp = on;
  }

  /** Dresses your rider (the one in front); your party dresses for the same sport. */
  setYou(appearance: Appearance, sport: Sport): void {
    const changed = this.you?.sport !== sport;
    this.you = { appearance, sport };
    this.avatars[0]?.set(appearance, sport);
    if (changed) for (const p of this.party) p.avatar.set(p.avatar.dressedAs, sport);
  }

  private withRide = false;

  /** Shows your rider's ride with them, or not. */
  showRide(on: boolean): void {
    this.withRide = on;
    this.avatars[0]?.showRide(on);
  }

  /** How many riders stand on the terrace (you and your party): the others as stand-ins. */
  setRiders(count: number): void {
    const others = Math.max(0, Math.min(3, count - 1));
    this.setParty(Array.from({ length: others }, (_, i) => ({ id: `stand-in ${i + 1}`, appearance: null })));
  }

  /** The others in your party (up to three), each as themselves. */
  setParty(members: readonly PartyMember[]): void {
    const wanted = members.slice(0, 3);
    for (const p of this.party.filter((x) => !wanted.some((m) => m.id === x.id))) {
      p.avatar.mesh.removeFromParent();
      p.avatar.dispose();
    }
    const sport = this.you?.sport ?? "summer";
    this.party = wanted.map((m, i) => {
      const had = this.party.find((x) => x.id === m.id);
      if (had) {
        if (m.appearance) had.avatar.set(m.appearance, sport);
        return had;
      }
      const p = { id: m.id, avatar: new Avatar(m.appearance, i + 1, sport), in: false };
      // They step on once their art is in (compiled ahead: see RiderFigure), never half dressed.
      void p.avatar.ready.then(() => {
        p.in = true;
        this.place();
      });
      return p;
    });
    this.place();
  }

  private place(): void {
    const spots = heroSpots();
    if (this.avatars.length === 0) {
      const a = new Avatar(this.you?.appearance ?? null, 0, this.you?.sport ?? "summer");
      a.showRide(this.withRide);
      this.avatars.push(a);
    }
    const you = this.avatars[0]!;
    const put = (a: Avatar, i: number) => {
      const spot = spots[i]!;
      a.stance = i === 0 ? "crossed" : "idle";
      a.mesh.position.set(spot.x, CLUB.floor, spot.z);
      a.mesh.rotation.y = spot.yaw;
      this.group.add(a.mesh);
    };
    put(you, 0);
    this.party.forEach((p, i) => {
      if (p.in) put(p.avatar, i + 1);
      else p.avatar.mesh.removeFromParent();
    });
  }

  start(engine: Engine): void {
    this.engine = engine;
    setAccent(SUMMER_ACCENT);
    if (engine.render) this.attach(engine);
  }

  /** Puts the terrace and its riders in the world, over the bay. */
  private attach(engine: Engine): void {
    const world = engine.world;
    world.setEnvironment(bay(engine));
    bay(engine).club?.setDetail(true);
    // A key from the camera's left, so the riders turn half to shade.
    const k = HERO_VIEW.key;
    world.setSunOffset(k.x, k.y, k.z);
    world.setShadowBox(10);
    world.scene.add(this.group);
    this.place();
  }

  private preloaded = false;

  /**
   * Sets the terrace up in the world and dresses your rider, ahead of the
   * mode select: only while the stage on screen draws a scene of its own
   * (the world's is free to set up meanwhile).
   */
  async preload(engine: Engine): Promise<void> {
    const world = engine.world;
    const host = engine.current;
    if (this.preloaded || world.environment !== null) return;
    this.preloaded = true;
    this.engine = engine;
    quietly(() => this.attach(engine));
    await engine.warm(() => world.compile(), false);
    await Promise.race([this.loaded(), new Promise((resolve) => setTimeout(resolve, 15_000))]);
    // Your rider's art compiled for the stage on screen when it arrived: compile it for the terrace too.
    await engine.warm(() => world.compile(this.group), false);
    if (engine.current === this) return;
    this.group.removeFromParent();
    bay(engine).club?.setDetail(false);
    world.setShadowBox();
    // (Unless another stage now draws the world.)
    if (engine.current === host) world.clearEnvironment();
  }

  compile(root?: THREE.Object3D): Promise<void> {
    return this.engine?.world.compile(root) ?? Promise.resolve();
  }

  loaded(): Promise<void> {
    const club = this.engine?.render ? bay(this.engine).ready : Promise.resolve();
    // (Your party steps on as each one's art comes in: the terrace doesn't wait for them.)
    return Promise.all([club, ...this.avatars.map((a) => a.ready)]).then(() => {});
  }

  frame(now: number, dt: number): void {
    const engine = this.engine;
    if (!engine?.render) return;
    for (const a of this.avatars) a.update(dt);
    for (const p of this.party) if (p.in) p.avatar.update(dt);
    this.closeUp += ((this.wantCloseUp ? 1 : 0) - this.closeUp) * (1 - Math.exp(-dt * 3));
    const h = heroView(this.closeUp * this.closeUp * (3 - 2 * this.closeUp));
    engine.world.renderFrom(h.eye, h.look, now / 1000, dt, h.fov);
  }

  stop(): void {
    this.group.removeFromParent();
    if (this.engine?.render) bay(this.engine).club?.setDetail(false);
    this.engine?.world.setShadowBox();
    this.engine?.world.clearEnvironment();
  }
}

/**
 * The mode select, framed like a character select: the camera low on the
 * terrace at the head of the stair, looking out to sea past your rider, who
 * stands large on the left, turned three-quarters, in the sun; the
 * lighthouse and the signal mast's flags stand in the open sky between the
 * rider and the menu's panels (which cover the right of the picture), and
 * friends gather behind, toward the middle.
 */
const HERO_VIEW = (() => {
  const at = new THREE.Vector3(CLUB.x + 2.5, CLUB.floor, CLUB.z - 5.2);
  // The camera stands inland of the rider, looking out over the bay (−z), a little from the east.
  const theta = 0.186;
  const fwd = new THREE.Vector3(-Math.sin(theta), 0, -Math.cos(theta));
  const right = new THREE.Vector3(Math.cos(theta), 0, -Math.sin(theta));
  // The sun from the camera's left and behind it, over the clubhouse's roof: the riders turn half to shade, and
  // nothing on the terrace stands between them and it.
  const key = right
    .clone()
    .multiplyScalar(-22)
    .addScaledVector(fwd, -24)
    .add(new THREE.Vector3(0, 30, 0));
  return { at, theta, fwd, right, key, dist: 4.4, fov: 34 };
})();

/** Where the riders stand: you, then friends behind you toward the middle of the picture, each further back. */
function heroSpots(): { x: number; z: number; yaw: number }[] {
  const { at, theta, right, fwd } = HERO_VIEW;
  const spot = (side: number, back: number, turn: number) => {
    const p = at.clone().addScaledVector(right, side).addScaledVector(fwd, back);
    return { x: p.x, z: p.z, yaw: theta + turn };
  };
  return [spot(0, 0, 0.45), spot(0.9, 1.2, 0.1), spot(1.95, 2.2, -0.25), spot(0.5, 2.7, 0.3)];
}

/**
 * The hero view; `close` (0-1) closes in on the rider (the pro shop),
 * turning a little so the mast's flags go behind the shop's panel instead
 * of under its edge. The camera holds still, as a character select's does:
 * the riders move, and the terrace's long straight edges stay put (a
 * drifting camera makes their pixel steps crawl along them).
 */
function heroView(close = 0): { eye: THREE.Vector3; look: THREE.Vector3; fov: number } {
  const { at, fwd, right, dist, fov } = HERO_VIEW;
  const eye = at
    .clone()
    .addScaledVector(fwd, -(dist - close * 1.6))
    .add(new THREE.Vector3(0, 0.82 + close * 0.45, 0));
  // Looking past the rider's left shoulder puts them left of centre.
  const look = at
    .clone()
    .addScaledVector(right, 1.35 - close * 0.86)
    .add(new THREE.Vector3(0, 1.12 + close * 0.2, 0));
  return { eye, look, fov };
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

/** Frames your rider on the main menu's colours for `shot`, in the free space on screen `space` gives. */
export function setMenuShot(shot: RiderShot, space: (() => ScreenBox | null) | null): void {
  (field ??= new SeasonField()).setShot(shot, space);
}

/** Shows your rider's ride with them on the main menu's colours (the collection). */
export function showMenuRide(on: boolean): void {
  (field ??= new SeasonField()).showRide(on);
}

/** Shows your rider's ride with them on the club's terrace (the pro shop's rides). */
export function showClubRide(on: boolean): void {
  (club ??= new Club()).showRide(on);
}

/** Frames your rider up close on the club's terrace (the pro shop). */
export function setClubCloseUp(on: boolean): void {
  (club ??= new Club()).setCloseUp(on);
}

/** Dresses your rider on the club's terrace. */
export function setClubRider(appearance: Appearance, sport: Sport): void {
  (club ??= new Club()).setYou(appearance, sport);
}

/** Gets the club's terrace ready behind the screen on show, with your rider on it, so the mode select comes up at once. */
export function preloadClub(engine: Engine, appearance: Appearance): void {
  const c = (club ??= new Club());
  if (engine.current === c) return;
  quietly(() => c.setYou(appearance, "summer"));
  void engine.preload(c);
}

/** Sets how many riders stand on the club's terrace (you, and stand-ins for the others). */
export function setClubRiders(count: number): void {
  (club ??= new Club()).setRiders(count);
}

/** Puts your party on the club's terrace beside you, each as themselves (a stand-in where their look is unknown). */
export function setClubParty(members: readonly PartyMember[]): void {
  (club ??= new Club()).setParty(members);
}
