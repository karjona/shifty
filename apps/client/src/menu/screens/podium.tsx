// The end of a Tilt, over the podium scene: the year's card while the
// podium comes up behind it, then the champion's name standing on the
// scene and the final standings on paper. After a beat (so a button still
// held from the race doesn't skip it) Continue moves on, and what comes
// after the Tilt (`children`) takes the screen with the podium behind it.
import "../podium.css";
import "../../ui/results.css";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Engine } from "../../game/engine.ts";
import { Podium, PodiumCard, type PodiumData } from "../../game/podium.ts";
import { messages, useT } from "../../i18n/index.ts";
import { useAction, useAutoFocus } from "../hooks.ts";
import { Button } from "../ui.tsx";

/** A rider's name: a handle's tag (`#1234`) set apart; bots in a lighter hand than people. */
function Name({ name, bot }: { name: string; bot: boolean }) {
  const tagged = /^(.*)(#\d{4})$/u.exec(name);
  return (
    <span className={`c-name${bot ? " bot" : ""}`}>
      {tagged ? tagged[1] : name}
      {tagged && <i>{tagged[2]}</i>}
    </span>
  );
}

/** The smallest the champion's name is set on one line, and on two, as a share of its full size. */
const ONE_LINE_MIN = 0.5;
const TWO_LINES_MIN = 0.34;

/**
 * The champion's name (without its handle's tag), as large as fits left of
 * the podium's gate: smaller, then on two lines, for a long name (keyed by
 * it: a new name fits anew).
 */
function ChampionName({ name, podium }: { name: string; podium: Podium | null }) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const screen = el?.closest(".podium-screen");
    if (!el || !screen || !podium) return undefined;
    const fit = () => {
      el.style.fontSize = "";
      el.style.maxWidth = "";
      el.classList.remove("wrapped");
      // Measured whole on one line, in the window's pixels.
      el.classList.add("fitted");
      const box = screen.getBoundingClientRect();
      const text = el.getBoundingClientRect();
      // (Window pixels per canvas pixel.)
      const zoom = box.width / (screen.clientWidth || box.width);
      const room = box.left + podium.gateLeft(box.width / box.height) * box.width - text.left - 24 * zoom;
      const full = Number.parseFloat(getComputedStyle(el).fontSize);
      if (text.width <= room || room <= 0) return;
      const one = room / text.width;
      if (one >= ONE_LINE_MIN) {
        el.style.fontSize = `${full * one}px`;
        return;
      }
      el.classList.add("wrapped");
      el.style.maxWidth = `${room / zoom}px`;
      // Two lines, each a little short of the room, and its longest word (by its share of the letters) on one.
      const word = Math.max(...name.split(/\s+/u).map((w) => w.length)) / Math.max(1, name.length);
      const two = Math.min(ONE_LINE_MIN, (1.8 * room) / text.width, (0.95 * room) / (word * text.width));
      el.style.fontSize = `${full * Math.max(TWO_LINES_MIN, two)}px`;
    };
    fit();
    addEventListener("resize", fit);
    return () => removeEventListener("resize", fit);
  }, [name, podium]);
  return <b ref={ref}>{name}</b>;
}

/** How long (ms) the ceremony plays before Continue shows. */
const BEAT_MS = 2500;

export function PodiumScreen({
  data,
  onContinue,
  children,
}: {
  data: PodiumData;
  onContinue: () => void;
  /** What comes after the ceremony, once the player has moved on. */
  children?: ReactNode;
}) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const [beat, setBeat] = useState(false);
  const [podium, setPodium] = useState<Podium | null>(null);

  useEffect(() => {
    const m = messages();
    const card = new PodiumCard(m.podium.card, m.place);
    let stage: Podium | null = null;
    let live = true;
    void Promise.all([Engine.get(), card.covered()]).then(([engine]) => {
      if (!live) return;
      const scene = new Podium(data);
      stage = scene;
      engine.show(scene);
      // The champion's name stands on the scene once the card has cleared.
      void scene.shown.then(async () => {
        if (!live) return;
        await card.hide();
        if (!live) return;
        setPodium(scene);
        setShown(true);
      });
    });
    return () => {
      live = false;
      void card.hide();
      const s = stage;
      if (s) void Engine.get().then((engine) => engine.hide(s));
    };
  }, [data]);

  useEffect(() => {
    if (!shown) return undefined;
    const id = setTimeout(() => setBeat(true), BEAT_MS);
    return () => clearTimeout(id);
  }, [shown]);

  const after = children !== undefined && children !== null && children !== false;
  useAction("back", onContinue, beat && !after);
  useAutoFocus();

  if (!shown) return null;
  const champion = data.riders[0];
  const championName = champion ? (/^(.*?)(?:#\d{4})?$/u.exec(champion.name)?.[1] ?? champion.name) : "";
  return (
    <div className={`screen podium-screen${after ? " after" : ""}`}>
      {champion && (
        <div className="podium-title">
          <span className="podium-year">
            {t.podium.card} · {t.place}
          </span>
          <ChampionName key={championName} name={championName} podium={podium} />
          <span className="podium-champion">{t.podium.champion(champion.look.look.body === "female")}</span>
        </div>
      )}
      {after ? (
        children
      ) : (
        <section className="panel podium-standings">
          <h2 className="panel-title">{t.podium.standings}</h2>
          <div className="podium-rows">
            {data.riders.map((r, i) => (
              <div key={r.slot} className={`board-row${r.me ? " me" : ""}${i < 3 ? " top" : ""}`}>
                <span className="c-place">{i + 1}</span>
                <Name name={r.name} bot={r.bot} />
                <span className="c-total">{r.points}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      {beat && !after && (
        <div className="podium-actions">
          <Button kind="primary" glyph="confirm" onClick={onContinue} autoFocus>
            {t.podium.continue}
          </Button>
        </div>
      )}
    </div>
  );
}
