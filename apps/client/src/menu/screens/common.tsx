// Pieces several screens share: the language picker, the footer links, the
// top bar, and the social card's editor.
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { labelOf, type Locale, LOCALES, setLocale, useLocale, useT } from "../../i18n/index.ts";
import { ApiError, claimHandle, meQuery, type Player, saveCard } from "../api.ts";
import { GlobeIcon } from "../icons.tsx";
import { toast } from "../toast.tsx";
import { Button, Credits, Modal, Picker, SocialCard, TextField, Wordmark } from "../ui.tsx";

export function LanguagePicker() {
  const t = useT();
  const locale = useLocale();
  return (
    <div className="language">
      <GlobeIcon />
      <Picker<Locale>
        label={t.settings.language}
        options={LOCALES.map((l) => ({ value: l, label: t.languages[l] }))}
        value={locale}
        onChange={setLocale}
      />
    </div>
  );
}

export function Footer() {
  const t = useT();
  return (
    <footer className="footer">
      <Link to="/about" data-nav="">
        {t.footer.about}
      </Link>
      <Link to="/privacy" data-nav="">
        {t.footer.privacy}
      </Link>
      <a href="https://github.com/karjona/shifty" target="_blank" rel="noreferrer" data-nav="">
        {t.footer.github}
      </a>
      <a href="https://itch.io/jam/game-off-2026" target="_blank" rel="noreferrer" data-nav="">
        {t.footer.gameOff}
      </a>
    </footer>
  );
}

/** The signed-in player (null for a moment while signing out). */
export function usePlayer(): Player | null {
  const { data } = useSuspenseQuery(meQuery);
  return data?.player ?? null;
}

/**
 * The logo (or the screen's title, on paper, with a kicker over it), a slot
 * for the screen's controls, and your card and credits.
 */
export function TopBar({
  title,
  kicker,
  sub,
  children,
}: {
  title?: string;
  kicker?: string;
  sub?: string;
  children?: ReactNode;
}) {
  const player = usePlayer();
  const { data: me } = useSuspenseQuery(meQuery);
  const [editing, setEditing] = useState(false);
  return (
    <header className="topbar">
      {title ? (
        <div className="title-panel">
          {kicker && <span className="label">{kicker}</span>}
          <h1 className="screen-title">{title}</h1>
          {sub && <p className="muted">{sub}</p>}
        </div>
      ) : (
        <Link to="/" className="topbar-logo" tabIndex={-1}>
          <Wordmark />
        </Link>
      )}
      <div className="topbar-middle">{children}</div>
      {player && (
        <div className="account">
          <SocialCard player={player} onClick={() => setEditing(true)} />
          {me?.rider && <Credits credits={me.rider.credits} />}
        </div>
      )}
      {player && editing && <CardEditor player={player} onClose={() => setEditing(false)} />}
    </header>
  );
}

const TITLE_IDS = ["rookie", "local", "regular", "all_seasons"] as const;
const CARD_IDS = ["bay", "peaks", "sunset", "night"] as const;

/** Pick a title and a background for your card, or change your name. */
function CardEditor({ player, onClose }: { player: Player; onClose: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(player.title);
  const [card, setCard] = useState(player.card);
  const [name, setName] = useState(player.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locale = useLocale();
  const preview: Player = { ...player, title, card };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (name.trim() !== player.name) await claimHandle(name);
      await saveCard(title, card);
      await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
      onClose();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "";
      setError(labelOf(t.welcome.problems, code) ?? t.common.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t.card.edit}
      onClose={onClose}
      actions={
        <>
          <Button kind="ghost" glyph="back" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button kind="primary" onClick={() => void save()} disabled={busy}>
            {t.card.save}
          </Button>
        </>
      }
    >
      <div className="card-preview">
        <SocialCard player={preview} />
      </div>
      <Picker<string>
        label={t.card.title}
        options={TITLE_IDS.map((id) => ({ value: id, label: t.card.titles[id] }))}
        value={title}
        onChange={setTitle}
      />
      <Picker<string>
        label={t.card.background}
        options={CARD_IDS.map((id) => ({ value: id, label: t.card.cards[id] }))}
        value={card}
        onChange={setCard}
      />
      <TextField
        label={t.card.name}
        value={name}
        maxLength={20}
        onChange={(e) => setName(e.target.value)}
        disabled={player.renameAt > 0}
        hint={
          player.renameAt > 0 ? t.card.renameAt(new Date(player.renameAt).toLocaleDateString(locale)) : t.welcome.hint
        }
        error={error}
      />
    </Modal>
  );
}

/** "Coming soon" for things that are on their way. */
export function soon(t: ReturnType<typeof useT>): void {
  toast(t.common.soon);
}

export function useGoBack() {
  const navigate = useNavigate();
  return (to: "/" | "/play" | "/login") => void navigate({ to });
}
