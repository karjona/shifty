// The laurel round a winner's place, like the one on the podium's first
// block: two branches of leaves rising from the bottom round both sides.
// Drawn as SVG in a 240 × 110 box centred on the place it crowns.

/** The box the laurel is drawn in. */
export const LAUREL_BOX = { width: 240, height: 110 };

export interface Leaf {
  cx: number;
  cy: number;
  /** Degrees. */
  rotate: number;
}

const CX = 120;
const CY = 55;
const RX = 112;
const RY = 50;
/** Leaves on each branch, and where along the oval (degrees, 90 = bottom middle) a branch starts and ends. */
const LEAVES = 6;
const FROM = 102;
const TO = 206;

/** A leaf: pointed at both ends, 20 long, along x. */
export const LEAF_PATH = "M -10 0 Q 0 -4.6 10 0 Q 0 4.6 -10 0 Z";

function leavesOf(side: 1 | -1): Leaf[] {
  const out: Leaf[] = [];
  for (let i = 0; i < LEAVES; i++) {
    const deg = FROM + ((TO - FROM) * i) / (LEAVES - 1);
    const a = (deg * Math.PI) / 180;
    // Along the oval, leaves alternate either side of the stem, tipped toward the branch's end.
    const x = CX + RX * Math.cos(a);
    const y = CY + RY * Math.sin(a);
    const tangent = (Math.atan2(RY * Math.cos(a), -RX * Math.sin(a)) * 180) / Math.PI;
    const out1 = i % 2 === 0 ? 1 : -1;
    const nx = Math.cos(a) * out1 * 5;
    const ny = Math.sin(a) * out1 * 5;
    const leaf = { cx: x + nx, cy: y + ny, rotate: tangent + out1 * 28 };
    out.push(side === 1 ? leaf : { cx: 2 * CX - leaf.cx, cy: leaf.cy, rotate: 180 - leaf.rotate });
  }
  return out;
}

/** Every leaf of both branches. */
export const LAUREL_LEAVES: readonly Leaf[] = [...leavesOf(1), ...leavesOf(-1)];

/** Where a leaf goes, as an SVG transform of `LEAF_PATH`. */
export function leafTransform(l: Leaf): string {
  return `translate(${l.cx.toFixed(1)} ${l.cy.toFixed(1)}) rotate(${l.rotate.toFixed(1)})`;
}

/** A point of the oval (degrees) on one side, as SVG coordinates. */
function at(deg: number, side: 1 | -1): string {
  const a = (deg * Math.PI) / 180;
  const x = CX + RX * Math.cos(a);
  return `${(side === 1 ? x : 2 * CX - x).toFixed(1)} ${(CY + RY * Math.sin(a)).toFixed(1)}`;
}

/** The stems: an arc up each side. */
export function laurelStems(): string[] {
  return ([1, -1] as const).map(
    (side) => `M ${at(FROM - 6, side)} A ${RX} ${RY} 0 0 ${side === 1 ? 1 : 0} ${at(TO, side)}`,
  );
}

/** The laurel as SVG markup (for the HUD's plain DOM). */
export function laurelSvg(): string {
  const leaves = LAUREL_LEAVES.map((l) => `<path d="${LEAF_PATH}" transform="${leafTransform(l)}"/>`).join("");
  const stems = laurelStems()
    .map((d) => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="2.4"/>`)
    .join("");
  return `<svg class="laurel" viewBox="0 0 ${LAUREL_BOX.width} ${LAUREL_BOX.height}" aria-hidden="true" fill="currentColor">${stems}${leaves}</svg>`;
}
