// First time in: pick a rider name. The lobby adds the number.
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { labelOf, useT } from "../../i18n/index.ts";
import { ApiError, auth, claimHandle, meQuery } from "../api.ts";
import { useAutoFocus, useBackdrop } from "../hooks.ts";
import { Button, Panel, TextField, Wordmark } from "../ui.tsx";
import { LanguagePicker } from "./common.tsx";

/** A starting suggestion: the GitHub name, or the email's first part. */
function suggestion(name: string, email: string): string {
  const base = (name || email.split("@")[0] || "")
    .replaceAll(/[^\p{L}\p{M}\p{N} _.\-·]/gu, "")
    .trim()
    .slice(0, 20);
  return base.length >= 3 ? base : "";
}

export function Welcome() {
  useBackdrop("flyover");
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: me } = useSuspenseQuery(meQuery);
  const [name, setName] = useState(() => suggestion(me?.user.name ?? "", me?.user.email ?? ""));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  useAutoFocus();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const player = await claimHandle(name);
      // The creator's route checks the cached player, so it must have the handle before the button shows.
      await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
      setDone(player.handle);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setError(labelOf(t.welcome.problems, code) ?? t.common.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen login">
      <header className="screen-top">
        <Wordmark />
        <LanguagePicker />
      </header>
      <main className="login-main">
        <Panel className="login-card" title={done ? done : t.welcome.title}>
          {done ? (
            <Button
              kind="primary"
              className="wide"
              glyph="confirm"
              autoFocus
              onClick={() => void navigate({ to: "/rider" })}
            >
              {t.welcome.submit}
            </Button>
          ) : (
            <form className="stack" onSubmit={(e) => void submit(e)}>
              <p>{t.welcome.body}</p>
              <TextField
                label={t.welcome.label}
                value={name}
                maxLength={20}
                autoComplete="nickname"
                onChange={(e) => setName(e.target.value)}
                hint={t.welcome.hint}
                error={error}
                autoFocus
              />
              <Button type="submit" kind="primary" className="wide" disabled={busy || name.trim().length < 3}>
                {t.welcome.submit}
              </Button>
              <Button
                kind="ghost"
                onClick={() =>
                  void auth.signOut().then(async () => {
                    queryClient.setQueryData(meQuery.queryKey, null);
                    await navigate({ to: "/login" });
                  })
                }
              >
                {t.settings.logout}
              </Button>
            </form>
          )}
        </Panel>
      </main>
    </div>
  );
}
