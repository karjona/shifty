// Log in or sign up: GitHub, or a code sent by email. While sign-ups are
// invite-only, the first thing you see is the invite code (an invite link
// fills it in for you); players who already have an account log in behind
// "Already invited?". Costa Nevada flies by behind.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { getLocale, useT } from "../../i18n/index.ts";
import { auth, inviteQuery, meQuery, redeemInvite } from "../api.ts";
import { useAction, useAutoFocus, useBackdrop } from "../hooks.ts";
import { Button, Panel, TextField, Wordmark } from "../ui.tsx";
import { Footer, LanguagePicker } from "./common.tsx";

const route = getRouteApi("/login");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * `invite`: enter your invite code. `signup`: invited, make your account.
 * `login`: log in (or sign up, when sign-ups are open). `code`: the code
 * from the email.
 */
type Step = "invite" | "signup" | "login" | "code";

export function Login() {
  useBackdrop("flyover");
  const t = useT();
  const search = route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const invite = useQuery(inviteQuery);
  const inviteOnly = invite.data?.required === true;
  const invited = invite.data?.redeemed === true;
  const [chosen, setChosen] = useState<Step | null>(null);
  const firstStep: Step = !inviteOnly || search.error === "invite_required" ? "login" : invited ? "signup" : "invite";
  const step = chosen ?? firstStep;
  const [inviteCode, setInviteCode] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    switch (search.error) {
      case undefined:
        return null;
      case "invite_required":
        return t.login.noAccountGithub;
      case "invalid_invite":
        return t.login.badInvite;
      case "too_many":
        return t.login.tooMany;
      default:
        return t.login.githubFailed;
    }
  });
  const [note, setNote] = useState<string | null>(null);
  useAutoFocus();

  const go = (next: Step) => {
    setChosen(next);
    setError(null);
    setNote(null);
  };
  const signInStep: Step = inviteOnly && invited ? "signup" : "login";
  useAction(
    "back",
    () => {
      if (step === "code") {
        go(signInStep);
        setCode("");
      } else {
        go("invite");
      }
    },
    step === "code" || (step === "login" && inviteOnly),
  );

  const headers = { "x-shifty-locale": getLocale() };

  const github = async () => {
    setBusy(true);
    const res = await auth.signIn.social({ provider: "github", callbackURL: "/", errorCallbackURL: "/login" });
    if (res.error) {
      setError(t.login.githubFailed);
      setBusy(false);
    }
  };

  const applyInvite = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (await redeemInvite(inviteCode)) {
        await queryClient.fetchQuery(inviteQuery);
        go("signup");
      } else {
        setError(t.login.badInvite);
      }
    } catch {
      setError(t.login.tooMany);
    }
    setBusy(false);
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
      const { status } = res.error;
      setError(status === 429 ? t.login.tooMany : status === 403 ? t.login.noAccount : t.common.error);
      return;
    }
    if (step === "code") setNote(t.login.resent);
    else go("code");
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await auth.signIn.emailOtp({ email: email.trim(), otp: code.trim() });
    if (res.error) {
      const { status } = res.error;
      setBusy(false);
      setError(status === 429 ? t.login.tooMany : status === 403 ? t.login.inviteGone : t.login.badCode);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
    const me = await queryClient.fetchQuery(meQuery);
    await navigate({ to: me?.player ? "/" : "/welcome" });
  };

  const title = {
    invite: t.login.inviteTitle,
    signup: t.login.invitedTitle,
    login: inviteOnly ? t.login.loginTitle : t.login.title,
    code: t.login.codeTitle,
  }[step];

  const signInOptions = (
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
  );

  return (
    <div className="screen login">
      <header className="screen-top">
        <Wordmark />
        <LanguagePicker />
      </header>
      <main className="login-main">
        <Panel className="login-card" title={title}>
          {step === "invite" && (
            <>
              <p>{t.login.inviteOnly}</p>
              <form onSubmit={(e) => void applyInvite(e)} className="stack">
                <TextField
                  label={t.login.invite}
                  placeholder="XXXX-XXXX"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={9}
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                  autoFocus
                />
                <Button type="submit" kind="primary" className="wide" disabled={busy || inviteCode.trim().length < 8}>
                  {t.login.continue} →
                </Button>
              </form>
            </>
          )}
          {step === "signup" && (
            <>
              <p>{t.login.invitedBody}</p>
              {signInOptions}
            </>
          )}
          {step === "login" && signInOptions}
          {step === "code" && (
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
                    go(signInStep);
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
          {step === "invite" && (
            <Button kind="ghost" className="wide" onClick={() => go("login")}>
              {t.login.alreadyInvited}
            </Button>
          )}
          {step === "login" && inviteOnly && (
            <Button kind="ghost" className="wide" glyph="back" onClick={() => go("invite")}>
              {t.login.haveInvite}
            </Button>
          )}
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
