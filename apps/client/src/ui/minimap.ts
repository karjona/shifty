// Minimaps, seen from above with +X to the right and +Z down. Summer: the
// oval, with buoys, ramps and every rider (the race runs clockwise).
// Winter: the run snaking down the mountain, with its checkpoints.
import type { CourseData } from "../render/course.ts";
import type { RunData } from "../render/mountain.ts";
import type { RiderView } from "../render/world.ts";

const SVG = "http://www.w3.org/2000/svg";
const WIDTH = 300;
const MARGIN = 6;
const SLOT_COLORS = ["#ff5a36", "#2bb3ff", "#ffd23f", "#7ae582", "#c77dff", "#ff8fab", "#f4a261", "#e9edf2"];

function node<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  parent: Element,
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent.append(e);
  return e;
}

/** A stadium (two straights and two half circles) at `r` from the breakwater axis. */
function stadium(half: number, r: number): string {
  return `M ${-half} ${-r} L ${half} ${-r} A ${r} ${r} 0 0 1 ${half} ${r} L ${-half} ${r} A ${r} ${r} 0 0 1 ${-half} ${-r} Z`;
}

export interface CourseMap {
  update(riders: RiderView[], nextBuoy: number | null): void;
}

export class Minimap implements CourseMap {
  private svg: SVGSVGElement;
  private dots = new Map<number, SVGCircleElement>();
  private nextRing: SVGCircleElement;
  private buoys: { x: number; z: number }[];

  constructor(root: HTMLElement, course: CourseData) {
    const half = course.straightHalf;
    const outer = course.outerLimit;
    const w = (half + outer) * 2 + MARGIN * 2;
    const h = outer * 2 + MARGIN * 2;
    this.svg = node(
      "svg",
      { id: "minimap", viewBox: `${-w / 2} ${-h / 2} ${w} ${h}`, width: WIDTH, height: (WIDTH * h) / w },
      root,
    );
    node("path", { d: stadium(half, outer), class: "sea" }, this.svg);
    const lane = course.radius;
    node("path", { d: stadium(half, lane + course.laneHalf), class: "lane" }, this.svg);
    node("path", { d: stadium(half, lane - course.laneHalf), class: "lane" }, this.svg);
    node("path", { d: stadium(half, course.breakwaterRadius), class: "rock" }, this.svg);
    // Land: a capsule is a line with round caps, as thick as it is wide.
    for (const l of course.land) {
      const line = { x1: l.ax, y1: l.az, x2: l.bx, y2: l.bz, "stroke-width": l.radius * 2 };
      node("line", { ...line, class: `land ${l.kind}` }, this.svg);
    }
    const s = course.start;
    const rx = -Math.cos(s.yaw);
    const rz = Math.sin(s.yaw);
    node(
      "line",
      {
        x1: s.x - rx * course.laneHalf,
        y1: s.z - rz * course.laneHalf,
        x2: s.x + rx * course.laneHalf,
        y2: s.z + rz * course.laneHalf,
        class: "start",
      },
      this.svg,
    );
    for (const r of course.ramps) node("circle", { cx: r.x, cy: r.z, r: 4, class: "ramp" }, this.svg);
    this.buoys = course.buoys;
    for (const b of course.buoys) node("circle", { cx: b.x, cy: b.z, r: 3.5, class: `buoy ${b.keep}` }, this.svg);
    this.nextRing = node("circle", { r: 9, class: "next" }, this.svg);
  }

  update(riders: RiderView[], nextBuoy: number | null): void {
    const seen = new Set<number>();
    for (const r of riders) {
      seen.add(r.slot);
      let dot = this.dots.get(r.slot);
      if (!dot) {
        dot = node("circle", { r: 7, fill: SLOT_COLORS[r.slot % SLOT_COLORS.length] ?? "#fff" }, this.svg);
        this.dots.set(r.slot, dot);
      }
      dot.setAttribute("cx", r.x.toFixed(1));
      dot.setAttribute("cy", r.z.toFixed(1));
      dot.classList.toggle("me", r.isMe);
      // Keep my dot on top.
      if (r.isMe) this.svg.append(dot);
    }
    for (const [slot, dot] of this.dots) dot.style.display = seen.has(slot) ? "" : "none";
    const b = nextBuoy === null ? undefined : this.buoys[nextBuoy];
    this.nextRing.style.display = b ? "" : "none";
    if (b) {
      this.nextRing.setAttribute("cx", String(b.x));
      this.nextRing.setAttribute("cy", String(b.z));
    }
  }
}

/** Winter: the run from the top of the screen to the bottom. */
export class RunMap implements CourseMap {
  private svg: SVGSVGElement;
  private dots = new Map<number, SVGCircleElement>();

  constructor(root: HTMLElement, run: RunData) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of run.path) {
      minX = Math.min(minX, p.x - p.half);
      maxX = Math.max(maxX, p.x + p.half);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const pad = 30;
    const w = maxX - minX + pad * 2;
    const h = maxZ - minZ + pad * 2;
    const height = Math.min(innerHeight * 0.6, 520);
    this.svg = node(
      "svg",
      {
        id: "minimap",
        class: "run",
        viewBox: `${minX - pad} ${minZ - pad} ${w} ${h}`,
        width: (height * w) / h,
        height,
      },
      root,
    );
    const line = run.path.map((p) => `${p.x.toFixed(1)},${p.z.toFixed(1)}`).join(" ");
    node("polyline", { points: line, class: "run-edge" }, this.svg);
    node("polyline", { points: line, class: "run-snow" }, this.svg);
    const tick = (g: { x: number; z: number; yaw: number; half: number }, cls: string) => {
      const rx = -Math.cos(g.yaw);
      const rz = Math.sin(g.yaw);
      node(
        "line",
        {
          x1: g.x - rx * (g.half + 8),
          y1: g.z - rz * (g.half + 8),
          x2: g.x + rx * (g.half + 8),
          y2: g.z + rz * (g.half + 8),
          class: cls,
        },
        this.svg,
      );
    };
    for (const c of run.checkpoints) tick(c, "checkpoint");
    tick(run.startGate, "start");
    tick(run.finish, "start");
  }

  update(riders: RiderView[]): void {
    const seen = new Set<number>();
    for (const r of riders) {
      seen.add(r.slot);
      let dot = this.dots.get(r.slot);
      if (!dot) {
        dot = node("circle", { r: 16, fill: SLOT_COLORS[r.slot % SLOT_COLORS.length] ?? "#fff" }, this.svg);
        this.dots.set(r.slot, dot);
      }
      dot.setAttribute("cx", r.x.toFixed(1));
      dot.setAttribute("cy", r.z.toFixed(1));
      dot.classList.toggle("me", r.isMe);
      if (r.isMe) this.svg.append(dot);
    }
    for (const [slot, dot] of this.dots) dot.style.display = seen.has(slot) ? "" : "none";
  }
}
