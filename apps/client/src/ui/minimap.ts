// Minimap: the oval from above, with buoys, ramps and every rider. Seen
// with +X to the right and +Z down, so the race runs clockwise.
import type { CourseData } from "../render/course.ts";
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

export class Minimap {
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
