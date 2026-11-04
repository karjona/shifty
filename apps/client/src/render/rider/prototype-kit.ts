// Stand-in garments for catalog items, until the real rider art replaces
// the code-built rider: each slot maps to the nearest prototype garment in
// the item's colours.
import type { Kit, Sport } from "@shifty/rider";
import { item } from "@shifty/rider";
import * as clothes from "./clothes.ts";
import type { Garment } from "./clothes.ts";

export function prototypeGarments(sport: Sport, kit: Kit): Garment[] {
  const out: Garment[] = [];
  const colours = (id: string | undefined) => item(id ?? "")?.colours;
  const c = (slot: keyof Kit) => colours(kit[slot]);
  if (sport === "summer") {
    const bottom = kit.bottom ? item(kit.bottom) : undefined;
    const b = c("bottom");
    if (bottom && b)
      out.push(bottom.model === "summer.bottom.swimsuit" ? clothes.swimsuit(b[0]) : clothes.boardshorts(b[0], b[2]));
    const v = c("vest");
    if (v) out.push(clothes.lifeVest(v[0], v[1]));
    const f = c("feet");
    if (f) out.push(clothes.waterShoes(f[0]));
    const h = c("head");
    if (h) out.push(clothes.cap(h[0], h[1]));
  } else {
    const t = c("top");
    if (t) out.push(clothes.jacket(t[0], t[1]));
    const b = c("bottom");
    if (b) out.push(clothes.snowPants(b[0]));
    const f = c("feet");
    if (f) out.push(clothes.boots(f[0], 0x15171a));
    const g = c("hands");
    if (g) out.push(clothes.gloves(g[0]));
    const h = c("head");
    if (h) out.push(clothes.beanie(h[0], h[1]));
    const e = c("eyes");
    if (e) out.push(clothes.goggles(0x1d1f24, e[0]));
  }
  return out;
}
