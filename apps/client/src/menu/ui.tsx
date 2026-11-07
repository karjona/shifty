// The menus' building blocks. Everything you can pick carries `data-nav`
// (see nav.ts), so the controller, the keyboard and the mouse all reach it.
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { labelOf, useT } from "../i18n/index.ts";
import type { Player } from "./api.ts";
import { useAction, useAutoFocus, useDevice } from "./hooks.ts";
import { type GlyphAction, KeyGlyph, PadGlyph } from "./glyphs.tsx";
import { ChevronLeft } from "./icons.tsx";
import { nav } from "./nav.ts";

/** The button that does `action` on the device in use (nothing for the mouse). */
export function Glyph({ action }: { action: GlyphAction }) {
  const { device, pad } = useDevice();
  if (device === "mouse") return null;
  return (
    <span className={`glyph ${device}`} aria-hidden="true">
      {device === "gamepad" ? <PadGlyph pad={pad} action={action} /> : <KeyGlyph action={action} />}
    </span>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: "default" | "primary" | "ghost" | "danger" | "tab";
  glyph?: GlyphAction;
  autoFocus?: boolean;
};

export function Button({ kind = "default", glyph, autoFocus, children, className = "", type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      data-nav=""
      data-nav-autofocus={autoFocus ? "" : undefined}
      className={`btn btn-${kind} ${className}`}
      {...rest}
    >
      {glyph && <Glyph action={glyph} />}
      <span className="btn-label">{children}</span>
    </button>
  );
}

export interface Tab<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
  /** A tag after the label, for tabs that aren't there yet ("Soon"). */
  tag?: string;
}

/** Tabs with their shoulder buttons on either side; LB / RB (Q / E) step through them. */
export function TabBar<T extends string>({
  tabs,
  value,
  onChange,
  className = "",
  iconsOnly = false,
  lead,
}: {
  tabs: Tab<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
  iconsOnly?: boolean;
  /** Something that comes first in the strip, before the tabs (the Play button). */
  lead?: ReactNode;
}) {
  const i = Math.max(
    0,
    tabs.findIndex((t) => t.id === value),
  );
  const step = (d: number) => onChange(tabs[(i + d + tabs.length) % tabs.length]!.id);
  useAction("prev", () => step(-1));
  useAction("next", () => step(1));
  return (
    <div className={`tabbar ${className}`} role="tablist">
      <Glyph action="prev" />
      {lead}
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          data-nav=""
          aria-selected={t.id === value}
          aria-label={iconsOnly ? t.label : undefined}
          title={iconsOnly ? t.label : undefined}
          className={`tab ${t.id === value ? "on" : ""} ${t.tag ? "tagged" : ""}`}
          onClick={() => onChange(t.id)}
        >
          {t.icon}
          {!iconsOnly && <span>{t.label}</span>}
          {t.tag && <span className="badge">{t.tag}</span>}
        </button>
      ))}
      <Glyph action="next" />
    </div>
  );
}

export function Panel({
  title,
  children,
  className = "",
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title && <h2 className="panel-title">{title}</h2>}
      {children}
    </section>
  );
}

/** `◀ value ▶`: left and right (or a click on the arrows) step through the options. */
export function Picker<T extends string | number>({
  label,
  options,
  value,
  onChange,
  onFocus,
  autoFocus,
}: {
  label: string;
  autoFocus?: boolean;
  /** Options; a `swatch` (CSS colour) shows a dot of that colour by the label. */
  options: { value: T; label: string; swatch?: string }[];
  value: T;
  onChange: (v: T) => void;
  onFocus?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const i = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const step = (d: number) => onChange(options[(i + d + options.length) % options.length]!.value);
  const onStep = useEffectEvent((d: number) => step(d));
  useEffect(() => {
    const el = ref.current;
    const on = (e: Event) => {
      if (e instanceof CustomEvent && typeof e.detail === "number") onStep(e.detail);
    };
    el?.addEventListener("nav-lr", on);
    return () => el?.removeEventListener("nav-lr", on);
  }, []);
  return (
    <div
      ref={ref}
      className="picker"
      data-nav=""
      data-nav-autofocus={autoFocus ? "" : undefined}
      data-nav-lr=""
      tabIndex={0}
      role="spinbutton"
      aria-label={label}
      aria-valuetext={options[i]?.label}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") step(1);
      }}
      onClick={() => step(1)}
      onFocus={onFocus}
      onMouseEnter={onFocus}
    >
      <span className="picker-label">{label}</span>
      <span className="picker-value">
        <button
          type="button"
          tabIndex={-1}
          aria-label="previous"
          onClick={(e) => {
            e.stopPropagation();
            step(-1);
          }}
        >
          ◀
        </button>
        <b key={String(value)}>
          {options[i]?.swatch && <i className="swatch" style={{ background: options[i].swatch }} />}
          {options[i]?.label}
        </b>
        <button
          type="button"
          tabIndex={-1}
          aria-label="next"
          onClick={(e) => {
            e.stopPropagation();
            step(1);
          }}
        >
          ▶
        </button>
      </span>
    </div>
  );
}

export function TextField({
  label,
  hint,
  error,
  autoFocus,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string | null }) {
  const id = useId();
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <input id={id} data-nav="" data-nav-autofocus={autoFocus ? "" : undefined} {...input} />
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

/** A dialog that holds the focus until it closes. Back closes it. */
export function Modal({
  title,
  children,
  onClose,
  actions,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  actions?: ReactNode;
}) {
  useAction("back", onClose);
  useAutoFocus();
  // On the page's root: animated screens would otherwise hold it in place.
  return createPortal(
    <div className="modal-backdrop" data-nav-scope="" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <div className="modal-body">{children}</div>
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>,
    document.querySelector("#root") ?? document.body,
  );
}

/** 23.4°, the axis (a bar tilted 23.4° in the season's colour), SHIFTY. */
export function Wordmark({ small = false }: { small?: boolean }) {
  return (
    <div className={`wordmark ${small ? "small" : ""}`} aria-label="23.4° Shifty">
      <span className="deg">23.4°</span>
      <span className="axis" aria-hidden="true" />
      <span className="name">SHIFTY</span>
    </div>
  );
}

/** The player's calling card: handle, title and background. */
export function SocialCard({ player, onClick }: { player: Player; onClick?: () => void }) {
  const t = useT();
  const title = labelOf(t.card.titles, player.title) ?? player.title;
  return (
    <button
      type="button"
      data-nav={onClick ? "" : undefined}
      tabIndex={onClick ? undefined : -1}
      className={`social-card card-${player.card}`}
      onClick={onClick}
    >
      <span className="avatar" aria-hidden="true">
        {player.name.slice(0, 1).toUpperCase()}
      </span>
      <span className="who">
        <b>
          {player.name}
          <i>#{String(player.tag).padStart(4, "0")}</i>
        </b>
        <span>{title}</span>
      </span>
    </button>
  );
}

/** What the buttons do, in the corner. */
export function Hints({ items }: { items: [GlyphAction, string][] }) {
  const { device } = useDevice();
  // The mouse picks and plays with what is on screen: what it can't reach otherwise is going back.
  const shown = device === "mouse" ? items.filter(([action]) => action === "back") : items;
  if (shown.length === 0) return null;
  return (
    <div className="hints">
      {shown.map(([action, label]) => {
        const glyph =
          action === "prev" ? (
            <span className="pair">
              <Glyph action="prev" />
              <Glyph action="next" />
            </span>
          ) : (
            <Glyph action={action} />
          );
        // "Select" picks what has the focus; the others are buttons too (out of the stick's way: B, Esc...).
        if (action === "confirm")
          return (
            <span key={action}>
              {glyph}
              {label}
            </span>
          );
        return (
          <button key={action} type="button" tabIndex={-1} className="hint" onClick={() => nav.fire(action)}>
            {device === "mouse" && action === "back" && <ChevronLeft />}
            {glyph}
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

/** Your credits, to spend in the pro shop. */
export function Credits({ credits }: { credits: number }) {
  const t = useT();
  return (
    <span className="credits" title={t.shop.credits}>
      {t.shop.amount(credits)}
    </span>
  );
}
