// Setups: the same twelve points for everyone, spread over speed,
// handling, stability and tricks, per sport. Set before a match; a match
// keeps the setups it started with.
import { STAT_BUDGET, STAT_MAX, STATS, type Setups, type Sport, type Stat } from "@shifty/rider";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { meQuery, saveSetups, storeRider } from "../api.ts";
import { toast } from "../toast.tsx";
import { Button, Modal, Picker } from "../ui.tsx";

/** `◀ ■■■□□□ ▶`: left and right take a point off or put one on. */
function StatRow({
  label,
  about,
  value,
  canAdd,
  onStep,
}: {
  label: string;
  about: string;
  value: number;
  canAdd: boolean;
  onStep: (d: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const step = useEffectEvent((d: number) => {
    if (d < 0 ? value > 0 : canAdd && value < STAT_MAX) onStep(d);
  });
  useEffect(() => {
    const el = ref.current;
    const on = (e: Event) => {
      if (e instanceof CustomEvent && typeof e.detail === "number") step(e.detail);
    };
    el?.addEventListener("nav-lr", on);
    return () => el?.removeEventListener("nav-lr", on);
  }, []);
  return (
    <div
      ref={ref}
      className="stat-row"
      data-nav=""
      data-nav-lr=""
      tabIndex={0}
      role="spinbutton"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={STAT_MAX}
    >
      <span className="stat-label">
        <b>{label}</b>
        <span className="muted small">{about}</span>
      </span>
      <span className="stat-value">
        <button type="button" tabIndex={-1} aria-label="less" onClick={() => step(-1)}>
          ◀
        </button>
        <span className="pips" aria-hidden="true">
          {Array.from({ length: STAT_MAX }, (_, i) => (
            <i key={i} className={i < value ? "on" : ""} />
          ))}
        </span>
        <button type="button" tabIndex={-1} aria-label="more" onClick={() => step(1)}>
          ▶
        </button>
      </span>
    </div>
  );
}

export function SetupEditor({ onClose }: { onClose: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: me } = useSuspenseQuery(meQuery);
  const [setups, setSetups] = useState<Setups>(() =>
    structuredClone(me?.rider?.setups ?? { summer: balanced(), winter: balanced() }),
  );
  const [sport, setSport] = useState<Sport>("summer");
  const [busy, setBusy] = useState(false);
  const s = setups[sport];
  const used = STATS.reduce((n, k) => n + s[k], 0);
  const left = STAT_BUDGET - used;

  const bump = (stat: Stat, d: number) =>
    setSetups((cur) => ({ ...cur, [sport]: { ...cur[sport], [stat]: cur[sport][stat] + d } }));

  const save = async () => {
    setBusy(true);
    try {
      storeRider(queryClient, await saveSetups(setups));
      toast(t.setup.saved);
      onClose();
    } catch {
      toast(t.common.error, "error");
    } finally {
      setBusy(false);
    }
  };
  const complete = (["summer", "winter"] as const).every(
    (sp) => STATS.reduce((n, k) => n + setups[sp][k], 0) === STAT_BUDGET,
  );

  return (
    <Modal
      title={t.setup.title}
      onClose={onClose}
      actions={
        <>
          <Button onClick={() => setSetups((cur) => ({ ...cur, [sport]: balanced() }))}>{t.setup.balanced}</Button>
          <Button kind="primary" glyph="confirm" disabled={busy || !complete} onClick={() => void save()}>
            {t.setup.save}
          </Button>
        </>
      }
    >
      <p className="muted small">{t.setup.body}</p>
      <Picker
        label={t.wardrobe.season}
        value={sport}
        onChange={setSport}
        options={(["summer", "winter"] as const).map((sp) => ({ value: sp, label: t.seasons[sp] }))}
      />
      {STATS.map((stat) => (
        <StatRow
          key={stat}
          label={t.setup.stats[stat]}
          about={t.setup.about[stat]}
          value={s[stat]}
          canAdd={left > 0}
          onStep={(d) => bump(stat, d)}
        />
      ))}
      <p className={`points-left ${left === 0 ? "" : "warn"}`}>{t.setup.left(left)}</p>
    </Modal>
  );
}

const balanced = () => ({ speed: 3, handling: 3, stability: 3, tricks: 3 });
