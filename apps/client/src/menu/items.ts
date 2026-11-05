// How items, brands and credits read in the menus.
import { item, model, type Brand } from "@shifty/rider";
import { labelOf, type Messages } from "../i18n/index.ts";

/** Brand names are proper names: the same in every language. */
export const BRAND_NAMES: Record<Brand, string> = {
  tramuntana: "Tramuntana",
  garbi: "Garbí",
  llevant: "Llevant",
  xaloc: "Xaloc",
  ponent: "Ponent",
};

/** "Foam vest · Red". */
export function itemLabel(t: Messages, id: string): string {
  const it = item(id);
  if (!it) return id;
  const name = labelOf(t.items.models, it.model) ?? it.model;
  const colour = labelOf(t.items.colourways, it.colourway) ?? it.colourway;
  return `${name} · ${colour}`;
}

export function itemBrand(id: string): string {
  const m = model(item(id)?.model ?? "");
  return m ? BRAND_NAMES[m.brand] : "";
}

export const hexColour = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
