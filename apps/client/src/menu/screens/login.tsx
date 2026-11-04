// Log in or sign up: GitHub, or a code sent by email. Costa Nevada flies by
// behind.
import { useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { getLocale, useT } from "../../i18n/index.ts";
import { auth, meQuery } from "../api.ts";
import { useAction, useAutoFocus, useBackdrop } from "../hooks.ts";
import { Button, Panel, TextField, Wordmark } from "../ui.tsx";
import { Footer, LanguagePicker } from "./common.tsx";

const route = getRouteApi("/login");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function Login() {
  useBackdrop("flyover");
  const t = useT();
  const search = route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<"start" | "code">("start");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(search.error === "github" ? t.login.githubFailed : null);
  const [note, setNote] = useState<string | null>(null);
  useAutoFocus();
  useAction(
    "back",
    () => {
      setStep("start");
      setError(null);
    },
    step === "code",
  );

  const headers = { "x-shifty-locale": getLocale() };

  const github = async () => {
    setBusy(true);
    const res = await auth.signIn.social({
      provider: "github",
      callbackURL: "/",
      errorCallbackURL: "/login?error=github",
    });
    if (res.error) {
      setError(t.login.githubFailed);
      setBusy(false);
    }
  };

  const sendCode = async (e?: FormEvent) => {
    e?.preventDefault();
    const address = email.trim();
    if (!EMAIL.test(address)) {
      setError(t.login.badEmail);
      return;
    }
    setBusy(true);
    setError(null);
    const res = await auth.emailOtp.sendVerificationOtp({ email: address, type: "sign-in" }, { headers });
    setBusy(false);
    if (res.error) {
      setError(res.error.status === 429 ? t.login.tooMany : t.common.error);
      return;
    }
    if (step === "code") setNote(t.login.resent);
    setStep("code");
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await auth.signIn.emailOtp({ email: email.trim(), otp: code.trim() });
    if (res.error) {
      setBusy(false);
      setError(res.error.status === 429 ? t.login.tooMany : t.login.badCode);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
    const me = await queryClient.fetchQuery(meQuery);
    await navigate({ to: me?.player ? "/" : "/welcome" });
  };

  return (
    <div className="screen login">
      <header className="screen-top">
        <Wordmark />
        <LanguagePicker />
      </header>
      <main className="login-main">
        <Panel className="login-card" title={step === "start" ? t.login.title : t.login.codeTitle}>
          {step === "start" ? (
            <>
              <Button kind="primary" className="wide" onClick={() => void github()} disabled={busy} autoFocus>
                {t.login.github}
              </Button>
              <div className="or">
                <span>{t.login.or}</span>
              </div>
              <form onSubmit={(e) => void sendCode(e)} className="stack">
                <TextField
                  label={t.login.email}
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  placeholder={t.login.emailPlaceholder}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  hint={t.login.keyboardHint}
                />
                <Button type="submit" className="wide" disabled={busy}>
                  {t.login.sendCode} →
                </Button>
              </form>
            </>
          ) : (
            <form onSubmit={(e) => void verify(e)} className="stack">
              <p>{t.login.codeSent(email.trim())}</p>
              <TextField
                label={t.login.code}
                className="code-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                pattern="[0-9]*"
                value={code}
                onChange={(e) => setCode(e.target.value.replaceAll(/\D/gu, ""))}
                autoFocus
              />
              <Button type="submit" kind="primary" className="wide" disabled={busy || code.length !== 6}>
                {t.login.signIn}
              </Button>
              <div className="row">
                <Button kind="ghost" onClick={() => void sendCode()} disabled={busy}>
                  {t.login.resend}
                </Button>
                <Button
                  kind="ghost"
                  glyph="back"
                  onClick={() => {
                    setStep("start");
                    setError(null);
                    setCode("");
                  }}
                >
                  {t.login.otherEmail}
                </Button>
              </div>
            </form>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {note && !error && <p className="note">{note}</p>}
          <p className="consent">
            {t.login.consent}{" "}
            <Link to="/privacy" data-nav="">
              {t.login.consentLink}
            </Link>
            .
          </p>
        </Panel>
      </main>
      <Footer />
    </div>
  );
}
