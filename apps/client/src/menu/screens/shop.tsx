// The pro shop at the country club: everything for sale for each sport and
// slot, with its brand and price. Pointing at an item tries it on your
// rider on the terrace; buying asks first. Credits come from online races.
import { type Appearance, ITEMS, type Item, SLOTS, type Slot, type Sport, fits, model } from "@shifty/rider";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { setClubCloseUp, setClubRider, setClubRiders } from "../../game/backdrops.ts";
import { useT } from "../../i18n/index.ts";
import { ApiError, buyItem, meQuery, storeRider } from "../api.ts";
import { useAction, useAutoFocus, useBackdrop } from "../hooks.ts";
import { hexColour, itemBrand, itemLabel } from "../items.ts";
import { toast } from "../toast.tsx";
import { Button, Hints, Modal, Panel, Picker } from "../ui.tsx";
import { TopBar } from "./common.tsx";

const forSale = (sport: Sport, slot: Slot, a: Appearance): Item[] =>
  ITEMS.filter((i) => {
    const m = model(i.model);
    return m?.sport === sport && m.slot === slot && fits(i, a.look.body);
  });

export function ShopScreen() {
  useBackdrop("club");
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: me } = useSuspenseQuery(meQuery);
  const rider = me?.rider ?? null;
  const [sport, setSport] = useState<Sport>("summer");
  const [slot, setSlot] = useState<Slot>("vest");
  const [trying, setTrying] = useState<string | null>(null);
  const [buying, setBuying] = useState<Item | null>(null);
  const [busy, setBusy] = useState(false);
  useAutoFocus();
  useAction("back", () => void navigate({ to: "/", search: { tab: "collection" } }), !buying);
  useEffect(() => {
    setClubRiders(1);
    setClubCloseUp(true);
    return () => setClubCloseUp(false);
  }, []);

  const appearance = rider?.appearance ?? null;
  // Your rider on the terrace, wearing what you point at.
  useEffect(() => {
    if (!appearance) return;
    const kit = { ...appearance.outfits[sport] };
    const it = trying ? ITEMS.find((i) => i.id === trying) : undefined;
    const m = it ? model(it.model) : undefined;
    if (it && m) kit[m.slot] = it.id;
    setClubRider({ ...appearance, outfits: { ...appearance.outfits, [sport]: kit } }, sport);
  }, [appearance, sport, trying]);

  if (!rider || !appearance) return null;
  const slots = SLOTS[sport];
  const current = slots.includes(slot) ? slot : slots[0]!;
  const items = forSale(sport, current, appearance);

  const buy = async (it: Item) => {
    setBusy(true);
    try {
      storeRider(queryClient, await buyItem(it.id));
      toast(t.shop.bought(itemLabel(t, it.id)));
      setBuying(null);
    } catch (e) {
      toast(e instanceof ApiError && e.code === "credits" ? t.shop.poor : t.common.error, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen shop-screen">
      <TopBar>
        <h1 className="screen-title">{t.shop.title}</h1>
      </TopBar>
      <main className="menu-body shop">
        <Panel title={t.shop.title} className="shop-panel">
          <Picker
            label={t.wardrobe.season}
            value={sport}
            onChange={(s) => {
              setSport(s);
              setTrying(null);
            }}
            options={(["summer", "winter"] as const).map((s) => ({ value: s, label: t.seasons[s] }))}
          />
          <Picker
            label={t.shop.slot}
            value={current}
            onChange={(s) => {
              setSlot(s);
              setTrying(null);
            }}
            options={slots.map((s) => ({
              value: s,
              label: s === "ride" ? t.wardrobe.rides[sport] : t.wardrobe.slots[s],
            }))}
          />
          <ul className="shop-items">
            {items.map((it) => {
              const owned = rider.owned.has(it.id);
              return (
                <li key={it.id}>
                  <button
                    type="button"
                    data-nav=""
                    className={`shop-item ${owned ? "owned" : ""}`}
                    onFocus={() => setTrying(it.id)}
                    onMouseEnter={() => setTrying(it.id)}
                    onClick={() => {
                      if (!owned) setBuying(it);
                    }}
                  >
                    <i className="swatch" style={{ background: hexColour(it.colours[0]) }} />
                    <span className="shop-name">
                      <b>{itemLabel(t, it.id)}</b>
                      <span className="muted small">{itemBrand(it.id)}</span>
                    </span>
                    <span className="shop-price">
                      {owned ? (it.price === 0 ? t.shop.starter : t.shop.owned) : t.shop.amount(it.price)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Panel>
      </main>
      {buying && (
        <Modal
          title={t.shop.title}
          onClose={() => setBuying(null)}
          actions={
            <>
              <Button glyph="back" onClick={() => setBuying(null)}>
                {t.common.cancel}
              </Button>
              <Button
                kind="primary"
                glyph="confirm"
                disabled={busy || rider.credits < buying.price}
                onClick={() => void buy(buying)}
              >
                {t.shop.buy}
              </Button>
            </>
          }
        >
          <p>{t.shop.confirm(itemLabel(t, buying.id), t.shop.amount(buying.price))}</p>
          {rider.credits < buying.price && <p className="error">{t.shop.poor}</p>}
        </Modal>
      )}
      <Hints
        items={[
          ["confirm", t.shop.buy],
          ["back", t.common.back],
        ]}
      />
    </div>
  );
}
