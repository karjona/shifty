// Everything a rider can wear or ride, per sport. A model is one garment
// or board shape; an item is a model in one colourway, and that is what is
// owned, bought and worn. Item numbers are stable forever (they go in join
// tokens): add new items at the end, never reuse a number.
import type { Body } from "./look.ts";

export type Sport = "summer" | "winter";
export const SPORTS: readonly Sport[] = ["summer", "winter"];

export type Slot = "head" | "eyes" | "top" | "vest" | "bottom" | "hands" | "feet" | "ride";

/** The slots each sport dresses, in the order the wardrobe shows them. */
export const SLOTS: Record<Sport, readonly Slot[]> = {
  summer: ["head", "eyes", "top", "vest", "bottom", "feet", "ride"],
  winter: ["head", "eyes", "top", "bottom", "hands", "feet", "ride"],
};

/** Slots that can't be left empty. */
export const REQUIRED: Record<Sport, readonly Slot[]> = {
  summer: ["vest", "bottom", "ride"],
  winter: ["top", "bottom", "feet", "ride"],
};

/** Made-up Costa Nevada brands, named after the Mediterranean winds. */
export const BRANDS = ["tramuntana", "garbi", "llevant", "xaloc", "ponent"] as const;
export type Brand = (typeof BRANDS)[number];

/** A garment or board shape: what the art builds. */
export interface Model {
  id: string;
  sport: Sport;
  slot: Slot;
  brand: Brand;
  /** Bodies it fits; both if absent. */
  body?: Body;
}

/** Colours: [main, second, accent] as 0xRRGGBB. */
export type Colourway = readonly [number, number, number];

export interface Item {
  /** Stable number (join tokens, the database). */
  n: number;
  /** `model.colourway`, e.g. `summer.vest.foam.red`. */
  id: string;
  model: string;
  colourway: string;
  colours: Colourway;
  /** Price in credits; 0 = in everyone's starter kit. */
  price: number;
}

export const MODELS: readonly Model[] = [
  // Summer.
  { id: "summer.head.cap", sport: "summer", slot: "head", brand: "garbi" },
  { id: "summer.head.visor", sport: "summer", slot: "head", brand: "xaloc" },
  { id: "summer.head.bandana", sport: "summer", slot: "head", brand: "ponent" },
  { id: "summer.eyes.shades", sport: "summer", slot: "eyes", brand: "llevant" },
  { id: "summer.eyes.wrap", sport: "summer", slot: "eyes", brand: "xaloc" },
  { id: "summer.top.rashguard", sport: "summer", slot: "top", brand: "garbi" },
  { id: "summer.top.tee", sport: "summer", slot: "top", brand: "ponent" },
  { id: "summer.vest.foam", sport: "summer", slot: "vest", brand: "garbi" },
  { id: "summer.vest.race", sport: "summer", slot: "vest", brand: "xaloc" },
  { id: "summer.bottom.boardshorts", sport: "summer", slot: "bottom", brand: "garbi" },
  { id: "summer.bottom.swimsuit", sport: "summer", slot: "bottom", brand: "llevant", body: "female" },
  { id: "summer.bottom.wetsuit", sport: "summer", slot: "bottom", brand: "tramuntana" },
  { id: "summer.feet.watershoes", sport: "summer", slot: "feet", brand: "llevant" },
  { id: "summer.ride.runabout", sport: "summer", slot: "ride", brand: "garbi" },
  { id: "summer.ride.racer", sport: "summer", slot: "ride", brand: "xaloc" },
  { id: "summer.ride.cruiser", sport: "summer", slot: "ride", brand: "ponent" },
  // Winter.
  { id: "winter.head.beanie", sport: "winter", slot: "head", brand: "tramuntana" },
  { id: "winter.head.helmet", sport: "winter", slot: "head", brand: "llevant" },
  { id: "winter.eyes.goggles", sport: "winter", slot: "eyes", brand: "llevant" },
  { id: "winter.top.puffer", sport: "winter", slot: "top", brand: "tramuntana" },
  { id: "winter.top.shell", sport: "winter", slot: "top", brand: "ponent" },
  { id: "winter.top.anorak", sport: "winter", slot: "top", brand: "garbi" },
  { id: "winter.bottom.pants", sport: "winter", slot: "bottom", brand: "tramuntana" },
  { id: "winter.bottom.bibs", sport: "winter", slot: "bottom", brand: "ponent" },
  { id: "winter.hands.gloves", sport: "winter", slot: "hands", brand: "tramuntana" },
  { id: "winter.hands.mittens", sport: "winter", slot: "hands", brand: "garbi" },
  { id: "winter.feet.boots", sport: "winter", slot: "feet", brand: "tramuntana" },
  { id: "winter.ride.freestyle", sport: "winter", slot: "ride", brand: "tramuntana" },
  { id: "winter.ride.freeride", sport: "winter", slot: "ride", brand: "llevant" },
  { id: "winter.ride.carver", sport: "winter", slot: "ride", brand: "xaloc" },
];

const RED = 0xd9382e;
const ORANGE = 0xf07a1e;
const YELLOW = 0xf2c230;
const LIME = 0x8fd13a;
const GREEN = 0x2f8a4e;
const TEAL = 0x1e9aa6;
const BLUE = 0x2a6fd1;
const NAVY = 0x1f2b4d;
const PURPLE = 0x7a3fb0;
const PINK = 0xe85a9a;
const WHITE = 0xf2f0ea;
const GREY = 0x8a8f96;
const BLACK = 0x1c1d21;
const SAND = 0xd8c39a;

/** Named colourways: [main, second, accent]. */
export const COLOURWAYS: Record<string, Colourway> = {
  red: [RED, BLACK, WHITE],
  orange: [ORANGE, NAVY, WHITE],
  yellow: [YELLOW, BLACK, RED],
  lime: [LIME, BLACK, WHITE],
  green: [GREEN, SAND, WHITE],
  teal: [TEAL, WHITE, ORANGE],
  blue: [BLUE, WHITE, YELLOW],
  navy: [NAVY, RED, WHITE],
  purple: [PURPLE, BLACK, LIME],
  pink: [PINK, WHITE, TEAL],
  white: [WHITE, BLUE, RED],
  grey: [GREY, BLACK, ORANGE],
  black: [BLACK, GREY, RED],
  sand: [SAND, NAVY, ORANGE],
};

/**
 * The shop: [number, model, colourway, price]. Starter items cost 0.
 * Append only.
 */
const ROWS: readonly (readonly [number, string, keyof typeof COLOURWAYS, number])[] = [
  [1, "summer.head.cap", "navy", 0],
  [2, "summer.head.cap", "red", 900],
  [3, "summer.head.cap", "white", 900],
  [4, "summer.head.visor", "white", 0],
  [5, "summer.head.visor", "teal", 900],
  [6, "summer.head.bandana", "red", 800],
  [7, "summer.head.bandana", "blue", 800],
  [8, "summer.eyes.shades", "black", 0],
  [9, "summer.eyes.shades", "white", 900],
  [10, "summer.eyes.wrap", "orange", 1100],
  [11, "summer.eyes.wrap", "purple", 1100],
  [12, "summer.top.rashguard", "blue", 0],
  [13, "summer.top.rashguard", "black", 1000],
  [14, "summer.top.rashguard", "pink", 1000],
  [15, "summer.top.tee", "white", 0],
  [16, "summer.top.tee", "yellow", 900],
  [17, "summer.top.tee", "green", 900],
  [18, "summer.vest.foam", "yellow", 0],
  [19, "summer.vest.foam", "red", 0],
  [20, "summer.vest.foam", "blue", 1200],
  [21, "summer.vest.foam", "lime", 1200],
  [22, "summer.vest.race", "orange", 1500],
  [23, "summer.vest.race", "black", 1500],
  [24, "summer.vest.race", "teal", 1500],
  [25, "summer.bottom.boardshorts", "navy", 0],
  [26, "summer.bottom.boardshorts", "teal", 0],
  [27, "summer.bottom.boardshorts", "red", 1100],
  [28, "summer.bottom.boardshorts", "sand", 1100],
  [29, "summer.bottom.boardshorts", "purple", 1100],
  [30, "summer.bottom.swimsuit", "black", 0],
  [31, "summer.bottom.swimsuit", "red", 0],
  [32, "summer.bottom.swimsuit", "teal", 1100],
  [33, "summer.bottom.swimsuit", "yellow", 1100],
  [34, "summer.bottom.wetsuit", "black", 1400],
  [35, "summer.bottom.wetsuit", "blue", 1400],
  [36, "summer.feet.watershoes", "grey", 0],
  [37, "summer.feet.watershoes", "orange", 800],
  [38, "summer.ride.runabout", "yellow", 0],
  [39, "summer.ride.runabout", "blue", 0],
  [40, "summer.ride.runabout", "red", 2000],
  [41, "summer.ride.racer", "orange", 2600],
  [42, "summer.ride.racer", "black", 2600],
  [43, "summer.ride.cruiser", "white", 2400],
  [44, "summer.ride.cruiser", "green", 2400],
  [45, "winter.head.beanie", "white", 0],
  [46, "winter.head.beanie", "red", 0],
  [47, "winter.head.beanie", "yellow", 800],
  [48, "winter.head.beanie", "green", 800],
  [49, "winter.head.helmet", "black", 1200],
  [50, "winter.head.helmet", "white", 1200],
  [51, "winter.eyes.goggles", "orange", 0],
  [52, "winter.eyes.goggles", "blue", 1000],
  [53, "winter.eyes.goggles", "pink", 1000],
  [54, "winter.top.puffer", "red", 0],
  [55, "winter.top.puffer", "blue", 0],
  [56, "winter.top.puffer", "black", 1300],
  [57, "winter.top.puffer", "yellow", 1300],
  [58, "winter.top.shell", "teal", 1400],
  [59, "winter.top.shell", "orange", 1400],
  [60, "winter.top.anorak", "purple", 1400],
  [61, "winter.top.anorak", "green", 1400],
  [62, "winter.bottom.pants", "navy", 0],
  [63, "winter.bottom.pants", "grey", 0],
  [64, "winter.bottom.pants", "sand", 1100],
  [65, "winter.bottom.bibs", "black", 1300],
  [66, "winter.bottom.bibs", "red", 1300],
  [67, "winter.hands.gloves", "black", 0],
  [68, "winter.hands.gloves", "white", 700],
  [69, "winter.hands.mittens", "red", 800],
  [70, "winter.feet.boots", "black", 0],
  [71, "winter.feet.boots", "white", 1000],
  [72, "winter.ride.freestyle", "lime", 0],
  [73, "winter.ride.freestyle", "pink", 0],
  [74, "winter.ride.freestyle", "black", 2000],
  [75, "winter.ride.freeride", "navy", 2400],
  [76, "winter.ride.freeride", "white", 2400],
  [77, "winter.ride.carver", "red", 2600],
  [78, "winter.ride.carver", "teal", 2600],
  [79, "summer.ride.runabout", "teal", 2000],
  [80, "summer.ride.runabout", "white", 2000],
  [81, "summer.ride.runabout", "black", 2000],
  [82, "summer.ride.racer", "red", 2600],
  [83, "summer.ride.racer", "lime", 2600],
  [84, "summer.ride.racer", "white", 2600],
  [85, "summer.ride.cruiser", "navy", 2400],
  [86, "summer.ride.cruiser", "sand", 2400],
  [87, "winter.ride.freestyle", "teal", 2000],
  [88, "winter.ride.freestyle", "orange", 2000],
  [89, "winter.ride.freestyle", "white", 2000],
  [90, "winter.ride.freeride", "red", 2400],
  [91, "winter.ride.freeride", "yellow", 2400],
  [92, "winter.ride.carver", "black", 2600],
  [93, "winter.ride.carver", "blue", 2600],
];

export const ITEMS: readonly Item[] = ROWS.map(([n, model, colourway, price]) => ({
  n,
  id: `${model}.${colourway}`,
  model,
  colourway,
  colours: COLOURWAYS[colourway]!,
  price,
}));

const byId = new Map(ITEMS.map((i) => [i.id, i]));
const byN = new Map(ITEMS.map((i) => [i.n, i]));
const models = new Map(MODELS.map((m) => [m.id, m]));

export const item = (id: string): Item | undefined => byId.get(id);
export const itemByNumber = (n: number): Item | undefined => byN.get(n);
export const model = (id: string): Model | undefined => models.get(id);

/** Items everyone owns from the start. */
export const STARTER: readonly Item[] = ITEMS.filter((i) => i.price === 0);

/** An item's model fits this body. */
export const fits = (i: Item, body: Body) => {
  const m = models.get(i.model);
  return m !== undefined && (m.body === undefined || m.body === body);
};

/** What is worn for one sport: slot → item id (absent = nothing in that slot). */
export type Kit = Partial<Record<Slot, string>>;
export type Outfits = Record<Sport, Kit>;

/** The kit a new rider starts in. */
export function defaultOutfits(body: Body): Outfits {
  return {
    summer: {
      head: "summer.head.cap.navy",
      eyes: "summer.eyes.shades.black",
      vest: "summer.vest.foam.yellow",
      bottom: body === "female" ? "summer.bottom.swimsuit.black" : "summer.bottom.boardshorts.navy",
      feet: "summer.feet.watershoes.grey",
      ride: "summer.ride.runabout.yellow",
    },
    winter: {
      head: "winter.head.beanie.white",
      eyes: "winter.eyes.goggles.orange",
      top: "winter.top.puffer.red",
      bottom: "winter.bottom.pants.navy",
      hands: "winter.hands.gloves.black",
      feet: "winter.feet.boots.black",
      ride: "winter.ride.freestyle.lime",
    },
  };
}

/**
 * Why a kit can't be worn, or null if it can: every item exists, is for
 * this sport and slot, fits the body and is owned; required slots are filled.
 */
export function kitProblem(sport: Sport, kit: Kit, body: Body, owns: (id: string) => boolean): string | null {
  for (const slot of SLOTS[sport]) {
    const id = kit[slot];
    if (id === undefined) continue;
    const i = byId.get(id);
    const m = i && models.get(i.model);
    if (!i || !m) return `unknown item ${id}`;
    if (m.sport !== sport || m.slot !== slot) return `${id} doesn't go in ${sport} ${slot}`;
    if (!fits(i, body)) return `${id} doesn't fit`;
    if (!owns(id)) return `${id} not owned`;
  }
  for (const slot of REQUIRED[sport]) if (!kit[slot]) return `${sport} ${slot} is required`;
  if (Object.keys(kit).some((k) => !(SLOTS[sport] as readonly string[]).includes(k))) return `not a ${sport} slot`;
  return null;
}

/** The kit with anything that no longer fits the body swapped for the starter item in that slot. */
export function fitKit(sport: Sport, kit: Kit, body: Body): Kit {
  const out: Kit = {};
  const starter = defaultOutfits(body)[sport];
  for (const slot of SLOTS[sport]) {
    const id = kit[slot];
    const i = id ? byId.get(id) : undefined;
    if (i && fits(i, body)) out[slot] = id;
    else if (id || REQUIRED[sport].includes(slot)) {
      if (starter[slot]) out[slot] = starter[slot];
    }
  }
  return out;
}
