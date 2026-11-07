// The rider creator: body and face from rows of presets (no sliders), on
// the main menu's colours with your rider in the middle of them; the
// camera closes in on the face while a face part is picked. First time in
// it comes right after the handle; after that, from the collection.
import {
  type Appearance,
  type Body,
  EYE_COLOURS,
  HAIR_COLOURS,
  type Look,
  PARTS,
  PRESETS,
  type Part,
  SKIN_TONES,
  SPORTS,
  defaultOutfits,
  fitKit,
  partApplies,
  randomLook,
} from "@shifty/rider";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { setMenuRider, showMenuRider } from "../../game/backdrops.ts";
import { useT } from "../../i18n/index.ts";
import { meQuery, saveRider, storeRider } from "../api.ts";
import { useAction, useAutoFocus, useBackdrop, useRiderShot } from "../hooks.ts";
import { hexColour } from "../items.ts";
import { toast } from "../toast.tsx";
import { Button, Hints, Panel, Picker } from "../ui.tsx";
import { TopBar } from "./common.tsx";

const FACE: ReadonlySet<Part> = new Set([
  "hair",
  "hairColor",
  "eyes",
  "eyeColor",
  "brows",
  "nose",
  "mouth",
  "facialHair",
]);
const SWATCHES: Partial<Record<Part, readonly number[]>> = {
  skin: SKIN_TONES,
  hairColor: HAIR_COLOURS,
  eyeColor: EYE_COLOURS,
};

/** Outfits that still fit after a change of body. */
function refit(a: Appearance, body: Body): Appearance["outfits"] {
  const out = { ...a.outfits };
  for (const sport of SPORTS) out[sport] = fitKit(sport, a.outfits[sport], body);
  return out;
}

export function RiderScreen() {
  useBackdrop("shader");
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: me } = useSuspenseQuery(meQuery);
  const saved = me?.rider?.appearance ?? null;
  const first = saved === null;
  const [a, setA] = useState<Appearance>(
    () => saved ?? { look: randomLook(Math.random), outfits: defaultOutfits("male") },
  );
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState<"body" | "face">("body");
  const space = useRiderShot(focus);
  useAutoFocus();

  useEffect(() => showMenuRider(true), []);
  useEffect(() => setMenuRider(a, "summer"), [a]);

  const leave = () => void navigate({ to: "/", search: { tab: "collection" } });
  useAction("back", leave, !first);

  const setLook = (look: Look) => setA((cur) => ({ look, outfits: refit(cur, look.body) }));
  const setPart = (part: Part, v: number) => setLook({ ...a.look, [part]: v });

  const done = async () => {
    setBusy(true);
    try {
      const rider = await saveRider(a);
      storeRider(queryClient, rider);
      toast(t.rider.saved);
      await navigate({ to: "/", search: { tab: first ? "home" : "collection" } });
    } catch {
      toast(t.common.error, "error");
    } finally {
      setBusy(false);
    }
  };

  const label = (part: Part, v: number): string => {
    if (part === "height") return t.rider.heights[v] ?? "";
    if (part === "build") return t.rider.builds[v] ?? "";
    if (part === "facialHair" && v === 0) return t.rider.clean;
    return t.rider.preset(v + 1, PRESETS[part]);
  };

  return (
    <div className="screen rider-screen">
      <TopBar title={t.rider.title} kicker={t.menu.collection} sub={t.rider.body} />
      <main className="menu-body creator">
        <div className="rider-space" aria-hidden="true" ref={space} />
        <div className="creator-side">
          <Panel className="creator-panel">
            <div className="creator-rows numbered">
              <Picker
                label={t.rider.bodyType}
                autoFocus
                value={a.look.body}
                onChange={(body) => setLook({ ...a.look, body, facialHair: body === "male" ? a.look.facialHair : 0 })}
                onFocus={() => setFocus("body")}
                options={(["male", "female"] as const).map((b) => ({ value: b, label: t.rider.bodies[b] }))}
              />
              {PARTS.filter((p) => partApplies(a.look.body, p)).map((part) => (
                <Picker
                  key={part}
                  label={t.rider.parts[part]}
                  value={a.look[part]}
                  onChange={(v) => setPart(part, v)}
                  onFocus={() => setFocus(FACE.has(part) ? "face" : "body")}
                  options={Array.from({ length: PRESETS[part] }, (_, v) => {
                    const swatch = SWATCHES[part]?.[v];
                    return {
                      value: v,
                      label: label(part, v),
                      swatch: swatch === undefined ? undefined : hexColour(swatch),
                    };
                  })}
                />
              ))}
            </div>
          </Panel>
          <footer className="actions">
            <Button onClick={() => setLook({ ...randomLook(Math.random) })}>{t.rider.random}</Button>
            <Button kind="primary" glyph="confirm" disabled={busy} onClick={() => void done()}>
              {t.rider.done}
            </Button>
          </footer>
        </div>
      </main>
      <Hints
        items={
          first
            ? [["confirm", t.common.select]]
            : [
                ["confirm", t.common.select],
                ["back", t.common.back],
              ]
        }
      />
    </div>
  );
}
