// Button glyphs drawn the way the controllers print them: round face
// buttons (letters, or the PlayStation shapes), shoulder buttons, the menu
// button, and keycaps for the keyboard. They take the text colour; the
// mark inside is cut out in `--glyph-ink`.
import type { ReactNode } from "react";
import type { Pad } from "./nav.ts";

export type GlyphAction = "confirm" | "back" | "play" | "prev" | "next" | "menu";

type Mark =
  | { kind: "letter"; text: string }
  | { kind: "cross" | "circle" | "triangle" | "lines" | "plus" }
  | { kind: "shoulder"; text: string; side: "left" | "right" };

const PADS: Record<Pad, Record<GlyphAction, Mark>> = {
  xbox: {
    confirm: { kind: "letter", text: "A" },
    back: { kind: "letter", text: "B" },
    play: { kind: "letter", text: "Y" },
    prev: { kind: "shoulder", text: "LB", side: "left" },
    next: { kind: "shoulder", text: "RB", side: "right" },
    menu: { kind: "lines" },
  },
  playstation: {
    confirm: { kind: "cross" },
    back: { kind: "circle" },
    play: { kind: "triangle" },
    prev: { kind: "shoulder", text: "L1", side: "left" },
    next: { kind: "shoulder", text: "R1", side: "right" },
    menu: { kind: "lines" },
  },
  nintendo: {
    confirm: { kind: "letter", text: "B" },
    back: { kind: "letter", text: "A" },
    play: { kind: "letter", text: "X" },
    prev: { kind: "shoulder", text: "L", side: "left" },
    next: { kind: "shoulder", text: "R", side: "right" },
    menu: { kind: "plus" },
  },
};

export const KEYS: Record<GlyphAction, string> = {
  confirm: "Enter",
  back: "Esc",
  play: "P",
  prev: "Q",
  next: "E",
  menu: "Esc",
};

function Face({ children }: { children: ReactNode }) {
  return (
    <svg className="glyph-pad face" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="g-body" cx="12" cy="12" r="11.5" />
      {children}
    </svg>
  );
}

function Shoulder({ text, side }: { text: string; side: "left" | "right" }) {
  // A bumper: the outer top corner rounds off, like the real thing.
  const d = "M1.5 21.5V10.5C1.5 5.5 5 2.5 10.5 2.5H34C35.4 2.5 36.5 3.6 36.5 5V21.5Z";
  return (
    <svg className="glyph-pad shoulder" viewBox="0 0 38 24" aria-hidden="true">
      <path className="g-body" d={d} transform={side === "right" ? "matrix(-1 0 0 1 38 0)" : undefined} />
      <text className="g-ink-fill" x="19" y="13.5" dy="0.34em" textAnchor="middle">
        {text}
      </text>
    </svg>
  );
}

/** A controller button. */
export function PadGlyph({ pad, action }: { pad: Pad; action: GlyphAction }) {
  const m = PADS[pad][action];
  switch (m.kind) {
    case "shoulder":
      return <Shoulder text={m.text} side={m.side} />;
    case "letter":
      return (
        <Face>
          <text className="g-ink-fill" x="12" y="12" dy="0.36em" textAnchor="middle">
            {m.text}
          </text>
        </Face>
      );
    case "cross":
      return (
        <Face>
          <path className="g-ink-stroke" d="M7.6 7.6 16.4 16.4M16.4 7.6 7.6 16.4" />
        </Face>
      );
    case "circle":
      return (
        <Face>
          <circle className="g-ink-stroke" cx="12" cy="12" r="5" />
        </Face>
      );
    case "triangle":
      return (
        <Face>
          <path className="g-ink-stroke" d="M12 6.6 17.4 16H6.6Z" />
        </Face>
      );
    case "lines":
      return (
        <Face>
          <path className="g-ink-stroke thin" d="M7.5 8.5H16.5M7.5 12H16.5M7.5 15.5H16.5" />
        </Face>
      );
    default:
      return (
        <Face>
          <path className="g-ink-stroke" d="M12 7V17M7 12H17" />
        </Face>
      );
  }
}

/** A key on the keyboard. */
export function KeyGlyph({ action }: { action: GlyphAction }) {
  const text = KEYS[action];
  return <span className={`glyph-key ${text.length > 1 ? "wide" : ""}`}>{text}</span>;
}
