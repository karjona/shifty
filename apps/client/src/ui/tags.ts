// Name tags over the other people in the race: small paper tags pointing
// down at their heads, only while they are near, fading out with distance
// and behind the ground (a roller, a swell). Bots go untagged. Plain DOM in
// the HUD, placed every frame from the camera.
import * as THREE from "three/webgpu";
import { uiZoom } from "../menu/scale.ts";
import type { Environment, RiderView } from "../render/world.ts";

/** Fully shown up to this far from the camera (m)... */
const NEAR = 28;
/** ...and gone from this far. */
const FAR = 42;
/** Where a tag points, above the ride, along the rider's up (m): just over the head. */
const HEAD = { jetski: 1.75, snow: 1.85 };
/** Leaning, the tag follows the head this far out at most (share of its height). */
const MAX_LEAN = 0.6;
/** How fast a tag follows the head (per second): flips and bails don't throw it about. */
const FOLLOW = 10;
/** Tags fade out over this much of the screen's edges (in NDC, -1 to 1), instead of hanging off them. */
const EDGE = 0.12;
/** Ground samples along the line of sight, for what hides a rider. */
const SIGHT_SAMPLES = 8;
/** A rider counts as hidden when the ground rises this close to the line of sight (m). */
const SIGHT_CLEARANCE = 0.2;
/** How fast a tag fades in and out (per second). */
const FADE = 6;

/** "Name#1234" → "Name": the number tells handles apart in lists, not over a rider. */
const shortName = (name: string) => name.replace(/#\d+$/u, "");

interface Tag {
  el: HTMLDivElement;
  /** Shown 0-1, eased toward where it should be. */
  shown: number;
  /** Where it points, from the ride (m), eased toward the head. */
  offset: THREE.Vector3;
  fresh: boolean;
  text: string;
  transform: string;
  opacity: string;
}

export class NameTags {
  /** Off: cameras other than the chase camera (intros, flyovers). */
  hidden = false;
  /** The sport on screen: how tall the riders stand. */
  sport: "jetski" | "snow" = "jetski";
  private root: HTMLDivElement;
  private tags = new Map<number, Tag>();
  private seen = new Set<number>();
  private at = new THREE.Vector3();
  private up = new THREE.Vector3();
  private ndc = new THREE.Vector3();
  private tilt = new THREE.Euler(0, 0, 0, "YXZ");

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "name-tags";
    parent.append(this.root);
  }

  /** Places the tags for this frame: `t` is the sim time (s) the riders are at. */
  update(
    camera: THREE.PerspectiveCamera,
    env: Environment | null,
    riders: RiderView[],
    names: Map<number, string>,
    t: number,
    dt: number,
  ): void {
    this.seen.clear();
    const fade = 1 - Math.exp(-dt * FADE);
    const follow = 1 - Math.exp(-dt * FOLLOW);
    const zoom = uiZoom();
    for (const r of riders) {
      if (r.isMe || r.isBot) continue;
      this.seen.add(r.slot);
      const tag = this.tag(r.slot);
      this.head(tag, r, follow);
      const p = this.at.set(r.x, r.y, r.z).add(tag.offset);
      const distance = camera.position.distanceTo(p);
      const ndc = this.ndc.copy(p).project(camera);
      const onScreen = !this.hidden && ndc.z < 1 && Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1;
      let want = 0;
      if (onScreen && distance < FAR && !(env && this.hiddenBy(env, camera.position, p, t))) {
        const edge = Math.min(1 - Math.abs(ndc.x), 1 - Math.abs(ndc.y)) / EDGE;
        want = Math.min(1, (FAR - distance) / (FAR - NEAR), edge);
      }
      tag.shown = onScreen ? tag.shown + (want - tag.shown) * fade : 0;
      if (tag.shown < 0.01) {
        this.set(tag, "opacity", "0");
        continue;
      }
      const name = shortName(names.get(r.slot) ?? `#${r.slot + 1}`);
      if (tag.text !== name) {
        tag.text = name;
        tag.el.textContent = name;
      }
      const x = ((ndc.x + 1) / 2) * innerWidth;
      const y = ((1 - ndc.y) / 2) * innerHeight;
      this.set(tag, "transform", `translate(${(x / zoom).toFixed(1)}px, ${(y / zoom).toFixed(1)}px)`);
      this.set(tag, "opacity", tag.shown.toFixed(2));
    }
    for (const [slot, tag] of this.tags) {
      if (this.seen.has(slot)) continue;
      tag.shown = 0;
      tag.fresh = true;
      this.set(tag, "opacity", "0");
    }
  }

  /** Eases the tag toward the rider's head: up from the ride as it tilts, never far out or under it. */
  private head(tag: Tag, r: RiderView, follow: number): void {
    const height = HEAD[this.sport];
    const up = this.up.set(0, 1, 0).applyEuler(this.tilt.set(-r.pitch, r.yaw, r.roll));
    const out = Math.hypot(up.x, up.z);
    const lean = up.y > 0.2 && out > 0 ? Math.min(out, MAX_LEAN) / out : 0;
    up.set(up.x * lean, Math.min(1, Math.max(0.75, up.y)), up.z * lean).multiplyScalar(height);
    if (tag.fresh) tag.offset.copy(up);
    else tag.offset.lerp(up, follow);
    tag.fresh = false;
  }

  private tag(slot: number): Tag {
    let tag = this.tags.get(slot);
    if (!tag) {
      const el = document.createElement("div");
      el.className = "name-tag";
      el.style.opacity = "0";
      this.root.append(el);
      tag = { el, shown: 0, offset: new THREE.Vector3(), fresh: true, text: "", transform: "", opacity: "0" };
      this.tags.set(slot, tag);
    }
    return tag;
  }

  /** Writes a style only when it changes. */
  private set(tag: Tag, key: "transform" | "opacity", value: string): void {
    if (tag[key] === value) return;
    tag[key] = value;
    tag.el.style[key] = value;
  }

  /** Whether the ground rises into the line of sight from `eye` to `p`. */
  private hiddenBy(env: Environment, eye: THREE.Vector3, p: THREE.Vector3, t: number): boolean {
    for (let i = 1; i < SIGHT_SAMPLES; i++) {
      const k = i / SIGHT_SAMPLES;
      const x = eye.x + (p.x - eye.x) * k;
      const y = eye.y + (p.y - eye.y) * k;
      const z = eye.z + (p.z - eye.z) * k;
      if (env.ground(x, z, t) > y - SIGHT_CLEARANCE) return true;
    }
    return false;
  }
}
