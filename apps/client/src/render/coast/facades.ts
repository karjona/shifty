// The town's drawn surfaces: one sheet of tiles painted at boot in flat
// colours with ink lines (windows with their shutters, doors, shop fronts,
// arcades, roof tiles, stone, railings, awnings, the church's portal, rose
// window and belfry), and the material that draws it. A wall is a grid of
// tiles, one per bay and storey, tinted by the house's colour.
import * as THREE from "three/webgpu";
import { FOLIAGE } from "../cel/look.ts";
import { CelMaterial, inkId } from "../cel/material.ts";

/** Tiles across and down the sheet, and a tile's size (px). */
const TILES = 8;
const PX = 128;

/** A rectangle of the sheet (u0, v0, u1, v1). */
export type Tile = readonly [number, number, number, number];

/** The tile in column `col`, row `row` (from the top), a little inside its edges so neighbours don't bleed in. */
function tile(col: number, row: number): Tile {
  const pad = 3 / (TILES * PX);
  return [col / TILES + pad, 1 - (row + 1) / TILES + pad, (col + 1) / TILES - pad, 1 - row / TILES - pad];
}

/** How many shutter colours the sheet has (a row of house tiles each). */
export const SHUTTERS = 4;

/** A house's tiles, in its shutters' colour (`variant`, 0 to `SHUTTERS` - 1). */
export const house = (variant: number) => ({
  window: tile(0, variant),
  shut: tile(1, variant),
  balcony: tile(2, variant),
  small: tile(3, variant),
  door: tile(4, variant),
  shop: tile(5, variant),
  arcade: tile(6, variant),
  wall: tile(7, variant),
});

export const TILE = {
  roof: tile(0, 4),
  roofOld: tile(1, 4),
  stone: tile(2, 4),
  paving: tile(3, 4),
  railing: tile(4, 4),
  awnings: [tile(5, 4), tile(6, 4), tile(7, 4)],
  portal: tile(0, 5),
  rose: tile(1, 5),
  belfry: tile(2, 5),
  clock: tile(3, 5),
  lancet: tile(4, 5),
  ashlar: tile(5, 5),
  boathouse: tile(6, 5),
  planks: tile(7, 5),
  sun: tile(0, 6),
  fish: tile(1, 6),
  thatch: tile(2, 6),
  flowers: tile(3, 6),
  cobbles: tile(4, 6),
  net: tile(5, 6),
  hatch: tile(6, 6),
  /** Plain: a vertex's colour as it is. */
  white: [0.97, 0.03, 0.97, 0.03] as Tile,
};

const INK = "#3a3550";
const GLASS = "#3f546c";
const GLINT = "#7396b0";
const FRAME = "#ece8de";
const STONE = "#d6cdb8";
const STONE_DARK = "#b3a88f";
const SHUTTER = ["#2f7d6b", "#3a6ea5", "#2d8a9a", "#8a5a3a"];
const SHUTTER_DARK = ["#22604f", "#2b5584", "#20707e", "#6b4229"];

type Ctx = CanvasRenderingContext2D;

function rect(g: Ctx, x: number, y: number, w: number, h: number, fill: string, ink = false): void {
  g.fillStyle = fill;
  g.fillRect(x, y, w, h);
  if (ink) {
    g.strokeStyle = INK;
    g.lineWidth = 2;
    g.strokeRect(x + 1, y + 1, w - 2, h - 2);
  }
}

/** A shutter: a louvred panel. */
function shutter(g: Ctx, x: number, y: number, w: number, h: number, v: number): void {
  rect(g, x, y, w, h, SHUTTER[v]!);
  g.fillStyle = SHUTTER_DARK[v]!;
  for (let yy = y + 5; yy < y + h - 3; yy += 6) g.fillRect(x + 3, yy, w - 6, 2);
  g.strokeStyle = INK;
  g.lineWidth = 2;
  g.strokeRect(x + 1, y + 1, w - 2, h - 2);
}

/** Glass in an opening: dark, a glint across a corner, the frame's bars. */
function glass(g: Ctx, x: number, y: number, w: number, h: number, panes = 2): void {
  rect(g, x, y, w, h, GLASS);
  g.fillStyle = GLINT;
  g.beginPath();
  g.moveTo(x, y + h * 0.55);
  g.lineTo(x + w * 0.7, y);
  g.lineTo(x + w, y);
  g.lineTo(x + w, y + h * 0.12);
  g.lineTo(x, y + h * 0.8);
  g.fill();
  // The shade of the wall above falls across the top.
  rect(g, x, y, w, 5, "#2c3c50");
  g.fillStyle = FRAME;
  g.fillRect(x + w / 2 - 1.5, y, 3, h);
  for (let i = 1; i < panes; i++) g.fillRect(x, y + (h * i) / panes - 1.5, w, 3);
  g.strokeStyle = INK;
  g.lineWidth = 2;
  g.strokeRect(x + 1, y + 1, w - 2, h - 2);
}

function sill(g: Ctx, x: number, y: number, w: number): void {
  rect(g, x, y, w, 6, STONE);
  rect(g, x, y + 6, w, 2, STONE_DARK);
}

/** An arch-topped shape from `(x, top)` to `(x + w, bottom)`. */
function arch(g: Ctx, x: number, top: number, w: number, bottom: number, fill: string, ink = true): void {
  g.fillStyle = fill;
  g.beginPath();
  g.moveTo(x, bottom);
  g.lineTo(x, top + w / 2);
  g.arc(x + w / 2, top + w / 2, w / 2, Math.PI, 0);
  g.lineTo(x + w, bottom);
  g.closePath();
  g.fill();
  if (ink) {
    g.strokeStyle = INK;
    g.lineWidth = 2;
    g.stroke();
  }
}

/** A row of house tiles for shutter colour `v`. */
function houseRow(g: Ctx, v: number): void {
  const at = (col: number, draw: () => void) => {
    g.save();
    g.translate(col * PX, v * PX);
    rect(g, 0, 0, PX, PX, "#ffffff");
    draw();
    g.restore();
  };
  at(0, () => {
    glass(g, 40, 30, 48, 62);
    shutter(g, 17, 30, 23, 62, v);
    shutter(g, 88, 30, 23, 62, v);
    sill(g, 36, 92, 56);
  });
  at(1, () => {
    shutter(g, 40, 30, 24, 62, v);
    shutter(g, 64, 30, 24, 62, v);
    sill(g, 36, 92, 56);
  });
  at(2, () => {
    glass(g, 38, 22, 52, 106, 3);
    shutter(g, 14, 22, 24, 106, v);
    shutter(g, 90, 22, 24, 106, v);
  });
  at(3, () => {
    rect(g, 48, 40, 32, 34, GLASS, true);
    g.fillStyle = INK;
    for (let x = 56; x < 80; x += 8) g.fillRect(x, 40, 2, 34);
    sill(g, 45, 74, 38);
  });
  at(4, () => {
    arch(g, 36, 28, 56, PX, STONE);
    arch(g, 43, 36, 42, PX, "#7a5236");
    g.fillStyle = "#5e3d27";
    g.fillRect(63, 44, 2, 84);
    for (const y of [70, 100]) g.fillRect(46, y, 36, 2);
    rect(g, 70, 86, 4, 6, "#e0c060");
    // A lamp over the door.
    rect(g, 98, 30, 10, 14, "#f6e2a0", true);
  });
  at(5, () => {
    rect(g, 8, 12, 112, 18, SHUTTER[v]!, true);
    rect(g, 10, 32, 108, 96, "#44506a", true);
    rect(g, 16, 40, 44, 60, GLINT);
    rect(g, 68, 40, 44, 88, "#2f3a50");
    rect(g, 16, 104, 44, 24, "#c9b28a");
    g.fillStyle = FRAME;
    g.fillRect(62, 32, 4, 96);
  });
  at(6, () => {
    arch(g, 12, 20, 104, PX, "#56597a");
    // The lit floor of the arcade, and a doorway at its back.
    rect(g, 14, 104, 100, 24, "#8f8fa6");
    arch(g, 48, 58, 32, 104, "#34364e", false);
    g.strokeStyle = STONE_DARK;
    g.lineWidth = 3;
    g.beginPath();
    g.arc(64, 72, 55, Math.PI, 0);
    g.stroke();
  });
  at(7, () => {
    rect(g, 22, 34, 3, 60, "#ebe6dc");
    rect(g, 84, 70, 26, 2, "#e6e0d4");
    rect(g, 60, 110, 40, 2, "#e6e0d4");
  });
}

/** Roof tiles: courses of terracotta, each tile's end a shade darker. */
function roofTile(g: Ctx, base: string, dark: string, light: string, patches: boolean): void {
  rect(g, 0, 0, PX, PX, base);
  for (let y = 0; y < PX; y += 16) {
    rect(g, 0, y + 12, PX, 4, dark);
    g.fillStyle = light;
    for (let x = (y / 16) % 2 === 0 ? 0 : 8; x < PX; x += 16) g.fillRect(x + 3, y + 2, 6, 9);
  }
  if (patches) {
    g.fillStyle = "#d9a060";
    for (const [x, y] of [
      [16, 32],
      [80, 16],
      [48, 80],
      [96, 96],
    ] as const)
      g.fillRect(x, y, 26, 12);
  }
}

/** Dressed stone: courses of blocks, a few lighter or darker. */
function stone(g: Ctx, base: string, joint: string, odd: string[]): void {
  rect(g, 0, 0, PX, PX, base);
  let k = 0;
  for (let y = 0; y < PX; y += 32) {
    const shift = (y / 32) % 2 === 0 ? 0 : 32;
    for (let x = -shift; x < PX; x += 64) {
      k++;
      if (k % 3 === 0) rect(g, x + 2, y + 2, 60, 28, odd[k % odd.length]!);
      rect(g, x, y, 2, 32, joint);
    }
    rect(g, 0, y, PX, 2, joint);
  }
}

function misc(g: Ctx): void {
  const at = (col: number, row: number, draw: () => void) => {
    g.save();
    g.translate(col * PX, row * PX);
    g.beginPath();
    g.rect(0, 0, PX, PX);
    g.clip();
    draw();
    g.restore();
  };
  at(0, 4, () => roofTile(g, "#c96a40", "#a5502e", "#da7e52", false));
  at(1, 4, () => roofTile(g, "#c2703f", "#9c5630", "#d08a55", true));
  at(2, 4, () => stone(g, "#cfc2a4", "#a99c82", ["#d9cdb2", "#c2b596"]));
  at(3, 4, () => stone(g, "#ded2b8", "#c4b89e", ["#e6dcc4", "#d4c8ae"]));
  at(4, 4, () => {
    // A railing: bars against the shade behind them.
    rect(g, 0, 0, PX, PX, "#cfc9c0");
    g.fillStyle = "#2e3440";
    for (let x = 4; x < PX; x += 12) g.fillRect(x, 8, 4, 112);
    g.fillRect(0, 0, PX, 12);
    g.fillRect(0, 116, PX, 12);
  });
  [
    ["#2a7fb0", "#f6f2ea"],
    ["#d2483a", "#f6f2ea"],
    ["#f0b840", "#f6f2ea"],
  ].forEach(([a, b], i) =>
    at(5 + i, 4, () => {
      for (let x = 0; x < PX; x += 32) {
        rect(g, x, 0, 16, PX, a!);
        rect(g, x + 16, 0, 16, PX, b!);
      }
      // The skirt along its lower edge.
      rect(g, 0, 112, PX, 3, INK);
    }),
  );
  at(0, 5, () => {
    rect(g, 0, 0, PX, PX, "#ffffff");
    arch(g, 14, 10, 100, PX, STONE);
    arch(g, 26, 24, 76, PX, "#6a4630");
    g.fillStyle = "#4e3222";
    g.fillRect(62, 30, 4, 98);
    for (const y of [64, 96]) g.fillRect(30, y, 68, 3);
    g.strokeStyle = STONE_DARK;
    g.lineWidth = 3;
    g.beginPath();
    g.arc(64, 62, 44, Math.PI, 0);
    g.stroke();
  });
  at(1, 5, () => {
    rect(g, 0, 0, PX, PX, "#ffffff");
    g.fillStyle = STONE;
    g.beginPath();
    g.arc(64, 64, 46, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = GLASS;
    g.beginPath();
    g.arc(64, 64, 36, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = STONE;
    g.lineWidth = 4;
    for (let i = 0; i < 8; i++) {
      g.beginPath();
      g.moveTo(64, 64);
      g.lineTo(64 + Math.cos((i * Math.PI) / 4) * 36, 64 + Math.sin((i * Math.PI) / 4) * 36);
      g.stroke();
    }
    g.fillStyle = GLINT;
    g.beginPath();
    g.arc(64, 64, 9, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = INK;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(64, 64, 46, 0, Math.PI * 2);
    g.stroke();
  });
  at(2, 5, () => {
    rect(g, 0, 0, PX, PX, "#ffffff");
    arch(g, 32, 14, 64, 116, "#3a3f58");
    // The bell.
    g.fillStyle = "#b08a3c";
    g.beginPath();
    g.moveTo(52, 86);
    g.quadraticCurveTo(52, 50, 64, 48);
    g.quadraticCurveTo(76, 50, 76, 86);
    g.closePath();
    g.fill();
    rect(g, 30, 116, 68, 6, STONE);
  });
  at(3, 5, () => {
    rect(g, 0, 0, PX, PX, "#ffffff");
    g.fillStyle = "#f4efe2";
    g.strokeStyle = INK;
    g.lineWidth = 3;
    g.beginPath();
    g.arc(64, 64, 40, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.fillStyle = INK;
    for (let i = 0; i < 12; i++) {
      const a = (i * Math.PI) / 6;
      g.fillRect(64 + Math.cos(a) * 33 - 2, 64 + Math.sin(a) * 33 - 2, 4, 4);
    }
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(64, 64);
    g.lineTo(64, 36);
    g.moveTo(64, 64);
    g.lineTo(84, 72);
    g.stroke();
  });
  at(4, 5, () => {
    rect(g, 0, 0, PX, PX, "#ffffff");
    arch(g, 44, 12, 40, 112, GLASS);
    g.fillStyle = GLINT;
    g.fillRect(50, 40, 10, 50);
    g.fillStyle = FRAME;
    g.fillRect(62, 20, 4, 92);
    sill(g, 40, 112, 48);
  });
  at(5, 5, () => stone(g, "#e4d8bc", "#c8bc9e", ["#ecdfc6", "#dccfb2"]));
  at(6, 5, () => {
    rect(g, 0, 0, PX, PX, "#ffffff");
    arch(g, 12, 16, 104, PX, "#3a6ea5");
    g.fillStyle = "#2b5584";
    g.fillRect(62, 22, 4, 106);
    for (let x = 22; x < 110; x += 12) g.fillRect(x, 60, 2, 68);
    rect(g, 56, 84, 5, 12, "#2a2f3a");
    rect(g, 67, 84, 5, 12, "#2a2f3a");
  });
  at(7, 5, () => {
    rect(g, 0, 0, PX, PX, "#c9a878");
    g.fillStyle = "#a88a5e";
    for (let y = 0; y < PX; y += 20) g.fillRect(0, y, PX, 2);
    for (let i = 0; i < 6; i++) g.fillRect(20 + ((i * 53) % 100), i * 20 + 2, 2, 18);
  });
  at(0, 6, () => {
    // The beach bar's board: a sun over the sea.
    rect(g, 0, 0, PX, PX, "#2a8fb0");
    rect(g, 0, 84, PX, 44, "#1f6f96");
    g.fillStyle = "#f6f2ea";
    for (let x = -8; x < PX; x += 32) {
      g.beginPath();
      g.arc(x + 16, 86, 16, Math.PI, 0);
      g.fill();
    }
    g.fillStyle = "#f2c14e";
    g.beginPath();
    g.arc(64, 44, 22, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = INK;
    g.lineWidth = 3;
    g.strokeRect(2, 2, PX - 4, PX - 4);
  });
  at(1, 6, () => {
    rect(g, 0, 0, PX, PX, "#f6f2ea");
    g.fillStyle = "#2f6fb0";
    g.beginPath();
    g.ellipse(58, 64, 36, 18, 0, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.moveTo(90, 64);
    g.lineTo(116, 44);
    g.lineTo(116, 84);
    g.closePath();
    g.fill();
    rect(g, 36, 56, 6, 6, "#f6f2ea");
    g.strokeStyle = INK;
    g.lineWidth = 3;
    g.strokeRect(2, 2, PX - 4, PX - 4);
  });
  at(2, 6, () => {
    rect(g, 0, 0, PX, PX, "#d2b470");
    g.fillStyle = "#b3954e";
    for (let y = 0; y < PX; y += 14) for (let x = (y / 14) % 2 === 0 ? 0 : 5; x < PX; x += 10) g.fillRect(x, y, 2, 12);
    for (let y = 26; y < PX; y += 28) g.fillRect(0, y, PX, 3);
  });
  at(3, 6, () => {
    rect(g, 0, 0, PX, PX, "#ffffff");
    glass(g, 40, 30, 48, 58);
    shutter(g, 17, 30, 23, 58, 0);
    shutter(g, 88, 30, 23, 58, 0);
    // A box of geraniums on the sill.
    rect(g, 34, 92, 60, 12, "#b8683c", true);
    g.fillStyle = "#3f8a4a";
    g.fillRect(36, 84, 56, 8);
    g.fillStyle = "#e0463a";
    for (let x = 40; x < 90; x += 9) g.fillRect(x, 80 + ((x * 7) % 5), 5, 5);
  });
  at(4, 6, () => stone(g, "#d8ccb2", "#bfb298", ["#e0d5bc", "#cdc0a4"]));
  at(5, 6, () => {
    // A fishing net heaped: knots on teal.
    rect(g, 0, 0, PX, PX, "#3f9a8c");
    g.strokeStyle = "#2b7468";
    g.lineWidth = 2;
    for (let i = -PX; i < PX * 2; i += 14) {
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i + PX, PX);
      g.moveTo(i, PX);
      g.lineTo(i + PX, 0);
      g.stroke();
    }
    g.fillStyle = "#f08a3c";
    for (const [x, y] of [
      [20, 30],
      [70, 20],
      [100, 70],
      [40, 90],
    ] as const) {
      g.beginPath();
      g.arc(x, y, 7, 0, Math.PI * 2);
      g.fill();
    }
  });
  at(6, 6, () => {
    // A hatch or a porthole on a boat's cabin.
    rect(g, 0, 0, PX, PX, "#ffffff");
    rect(g, 22, 34, 84, 50, GLASS, true);
    g.fillStyle = GLINT;
    g.fillRect(26, 38, 30, 14);
    g.fillStyle = FRAME;
    g.fillRect(62, 34, 4, 50);
  });
  rect(g, 7 * PX, 7 * PX, PX, PX, "#ffffff");
}

let sheet: THREE.CanvasTexture | null = null;

/** The sheet of tiles (painted once). */
export function facadeTexture(): THREE.CanvasTexture {
  if (sheet) return sheet;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = TILES * PX;
  const g = canvas.getContext("2d")!;
  rect(g, 0, 0, canvas.width, canvas.height, "#ffffff");
  for (let v = 0; v < SHUTTERS; v++) houseRow(g, v);
  misc(g);
  sheet = new THREE.CanvasTexture(canvas);
  sheet.colorSpace = THREE.SRGBColorSpace;
  sheet.anisotropy = 4;
  return sheet;
}

let material: CelMaterial | null = null;

/** The town's material: the sheet, tinted by each vertex's colour; snow settles on its roofs and rain wets it. */
export function townMaterial(): CelMaterial {
  material ??= new CelMaterial({
    map: facadeTexture(),
    vertexColors: true,
    outdoor: FOLIAGE.none,
    crease: 0.7,
    darkness: 0.8,
    id: inkId("town"),
  });
  material.name = "town";
  return material;
}
