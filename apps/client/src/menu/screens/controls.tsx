// The race's controls for the sport on now: rows of the buttons the player
// rides with (a pad's, in its maker's marks; the keyboard's keys) and what
// each does, or the touch screen's own lines.
import "../controls.css";
import type { ReactNode } from "react";
import { useT } from "../../i18n/index.ts";
import { touchSettings } from "../../touch/device.ts";
import { ButtonGlyph, KeyCap, type PadButton } from "../glyphs.tsx";
import { useDevice } from "../hooks.ts";

/** A row: the buttons (alternatives split by a slash), and what they do. */
interface Row {
  keys: ReactNode;
  text: string;
}

/** A pad's buttons: alternatives (a slash between), or a `pair` that does the two halves of a row. */
function Pads({ buttons, pair = false }: { buttons: PadButton[]; pair?: boolean }) {
  const { pad } = useDevice();
  return (
    <>
      {buttons.map((b, i) => (
        <span key={b} className="ctl-alt">
          {i > 0 && !pair && <i>/</i>}
          <ButtonGlyph pad={pad} button={b} />
        </span>
      ))}
    </>
  );
}

function Keys({ keys }: { keys: string[][] }) {
  return (
    <>
      {keys.map((group, i) => (
        <span key={group.join()} className="ctl-alt">
          {i > 0 && <i>/</i>}
          {group.map((k) => (
            <KeyCap key={k} text={k} />
          ))}
        </span>
      ))}
    </>
  );
}

export function RaceControls({
  sport,
  device,
  className = "",
}: {
  sport: "jetski" | "snow";
  /** What the player rides with. */
  device: "keyboard" | "gamepad" | "touch";
  className?: string;
}) {
  const t = useT();
  const k = t.race.keys;
  let rows: Row[];
  let tip: string;
  if (device === "touch") {
    const lines = t.race.helpTouch[sport === "jetski" && touchSettings().gas === "hold" ? "jetskiHold" : sport];
    rows = lines.slice(0, -1).map((text) => ({ keys: null, text }));
    tip = lines.at(-1) ?? "";
  } else if (sport === "jetski") {
    const h = t.race.help.jetski;
    tip = h.tip;
    rows =
      device === "gamepad"
        ? [
            { keys: <Pads buttons={["stick"]} />, text: h.steer },
            { keys: <Pads buttons={["rt", "lt"]} pair />, text: h.gas },
            { keys: <Pads buttons={["south", "rb"]} />, text: h.spin },
            { keys: <Pads buttons={["west"]} />, text: h.roll },
            { keys: <Pads buttons={["east", "lb"]} />, text: h.stunt },
          ]
        : [
            { keys: <Keys keys={[["W", "S"]]} />, text: h.gas },
            {
              keys: (
                <Keys
                  keys={[
                    ["A", "D"],
                    ["←", "→"],
                  ]}
                />
              ),
              text: h.keySteer,
            },
            { keys: <Keys keys={[["↑", "↓"]]} />, text: h.keyLean },
            { keys: <Keys keys={[[k.space]]} />, text: h.spin },
            { keys: <Keys keys={[[k.shift]]} />, text: h.roll },
            { keys: <Keys keys={[["E"], ["K"]]} />, text: h.stunt },
          ];
  } else {
    const h = t.race.help.snow;
    tip = h.tip;
    rows =
      device === "gamepad"
        ? [
            { keys: <Pads buttons={["stick"]} />, text: h.steer },
            { keys: <Pads buttons={["south"]} />, text: h.jump },
            { keys: <Pads buttons={["west", "rb"]} />, text: h.spin },
            { keys: <Pads buttons={["east", "lb"]} />, text: h.grab },
          ]
        : [
            {
              keys: (
                <Keys
                  keys={[
                    ["A", "D"],
                    ["←", "→"],
                  ]}
                />
              ),
              text: h.keySteer,
            },
            {
              keys: (
                <Keys
                  keys={[
                    ["W", "S"],
                    ["↑", "↓"],
                  ]}
                />
              ),
              text: h.keyTuck,
            },
            { keys: <Keys keys={[[k.space]]} />, text: h.jump },
            { keys: <Keys keys={[["J"], [k.shift]]} />, text: h.spin },
            { keys: <Keys keys={[["K"], ["E"]]} />, text: h.grab },
          ];
  }
  return (
    <section className={`race-controls ${device} ${className}`}>
      <h2 className="ctl-title">{t.race.controls}</h2>
      <ol className="ctl-rows">
        {rows.map((r) => (
          <li key={r.text}>
            {r.keys !== null && <span className="ctl-keys">{r.keys}</span>}
            <span className="ctl-text">{r.text}</span>
          </li>
        ))}
      </ol>
      {tip && <p className="ctl-tip">{tip}</p>}
    </section>
  );
}
