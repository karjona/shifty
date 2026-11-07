// The end of a Tilt, over the podium scene: the year's card while the
// podium comes up behind it, then the champion's name standing on the
// scene, the final standings on paper, and a prompt to go back where the
// players came from.
import "../podium.css";
import "../../ui/results.css";
import { useEffect, useState } from "react";
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

export function PodiumScreen({ data, onDone }: { data: PodiumData; onDone: () => void }) {
  const t = useT();
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const m = messages();
    const card = new PodiumCard(m.podium.card, m.place);
    let stage: Podium | null = null;
    let live = true;
    void Promise.all([Engine.get(), card.covered()]).then(([engine]) => {
      if (!live) return;
      const podium = new Podium(data);
      stage = podium;
      engine.show(podium);
      void podium.shown.then(() => {
        if (!live) return;
        card.hide();
        setShown(true);
      });
    });
    return () => {
      live = false;
      card.hide();
      const s = stage;
      if (s) void Engine.get().then((engine) => engine.hide(s));
    };
  }, [data]);

  useAction("back", onDone, shown);
  useAutoFocus();

  if (!shown) return null;
  const champion = data.riders[0];
  return (
    <div className="screen podium-screen">
      {champion && (
        <div className="podium-title">
          <span className="podium-year">
            {t.podium.card} · {t.place}
          </span>
          <b>{/^(.*?)(?:#\d{4})?$/u.exec(champion.name)?.[1] ?? champion.name}</b>
          <span className="podium-champion">{t.podium.champion(champion.look.look.body === "female")}</span>
        </div>
      )}
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
      <div className="podium-actions">
        <Button kind="primary" glyph="confirm" onClick={onDone} autoFocus>
          {t.podium.continue}
        </Button>
      </div>
    </div>
  );
}
