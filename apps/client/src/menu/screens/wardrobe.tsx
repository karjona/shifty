// The collection tab: what your rider wears for each sport, from the items
// you own (the starter kit and what you've bought), shown on your rider as
// you pick. Links to the creator and the pro shop.
import { type Appearance, ITEMS, type Kit, REQUIRED, SLOTS, type Slot, type Sport, fits, model } from "@shifty/rider";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { setMenuRider } from "../../game/backdrops.ts";
import { useT } from "../../i18n/index.ts";
import { meQuery, saveRider, storeRider } from "../api.ts";
import { hexColour, itemLabel } from "../items.ts";
import { toast } from "../toast.tsx";
import { Button, Panel, Picker } from "../ui.tsx";

/** Items you own for a sport's slot that fit your body. */
export function choices(sport: Sport, slot: Slot, a: Appearance, owned: Set<string>): string[] {
  return ITEMS.filter((i) => {
    const m = model(i.model);
    return m?.sport === sport && m.slot === slot && fits(i, a.look.body) && owned.has(i.id);
  }).map((i) => i.id);
}

export function Wardrobe() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: me } = useSuspenseQuery(meQuery);
  const rider = me?.rider ?? null;
  const [sport, setSport] = useState<Sport>("summer");
  const [a, setA] = useState<Appearance | null>(rider?.appearance ?? null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (a) setMenuRider(a, sport);
  }, [a, sport]);
  if (!rider || !a) return null;
  const changed = JSON.stringify(a) !== JSON.stringify(rider.appearance);

  const wear = (slot: Slot, id: string) =>
    setA((cur) => {
      if (!cur) return cur;
      const kit: Kit = { ...cur.outfits[sport] };
      if (id === "") delete kit[slot];
      else kit[slot] = id;
      return { ...cur, outfits: { ...cur.outfits, [sport]: kit } };
    });

  const save = async () => {
    setBusy(true);
    try {
      storeRider(queryClient, await saveRider(a));
      toast(t.wardrobe.saved);
    } catch {
      toast(t.common.error, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="menu-body home">
      <div className="home-left">
        <div className="rider-space" aria-hidden="true" />
      </div>
      <div className="home-right">
        <Panel title={t.wardrobe.title} className="wardrobe">
          <Picker
            label={t.wardrobe.season}
            value={sport}
            onChange={setSport}
            options={(["summer", "winter"] as const).map((s) => ({ value: s, label: t.seasons[s] }))}
          />
          <div className="wardrobe-rows">
            {SLOTS[sport].map((slot) => {
              const ids = choices(sport, slot, a, rider.owned);
              const optional = !REQUIRED[sport].includes(slot);
              const options = [
                ...(optional ? [{ value: "", label: t.wardrobe.nothing }] : []),
                ...ids.map((id) => {
                  const c = ITEMS.find((i) => i.id === id)?.colours[0];
                  return { value: id, label: itemLabel(t, id), swatch: c === undefined ? undefined : hexColour(c) };
                }),
              ];
              return (
                <Picker
                  key={slot}
                  label={slot === "ride" ? t.wardrobe.rides[sport] : t.wardrobe.slots[slot]}
                  value={a.outfits[sport][slot] ?? ""}
                  onChange={(id) => wear(slot, id)}
                  options={options}
                />
              );
            })}
          </div>
          <div className="row">
            <Button kind="primary" glyph="confirm" disabled={busy || !changed} onClick={() => void save()}>
              {t.wardrobe.save}
            </Button>
            <Button onClick={() => void navigate({ to: "/rider" })}>{t.rider.edit}</Button>
            <Button onClick={() => void navigate({ to: "/shop" })}>{t.wardrobe.shop}</Button>
          </div>
        </Panel>
      </div>
    </main>
  );
}
