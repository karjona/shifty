// About and Privacy: short pages over the fly-over, reachable signed out.
import { useRouter } from "@tanstack/react-router";
import { useT } from "../../i18n/index.ts";
import { useAction, useAutoFocus, useBackdrop } from "../hooks.ts";
import { Button, Panel, Wordmark } from "../ui.tsx";
import { LanguagePicker } from "./common.tsx";

export function InfoPage({ page }: { page: "about" | "privacy" }) {
  useBackdrop("flyover");
  const t = useT();
  const router = useRouter();
  const text = t[page];
  const back = () => {
    if (window.history.length > 1) router.history.back();
    else void router.navigate({ to: "/login" });
  };
  useAction("back", back);
  useAutoFocus();
  return (
    <div className="screen login">
      <header className="screen-top">
        <Wordmark />
        <LanguagePicker />
      </header>
      <main className="login-main">
        <Panel
          className="info-card"
          title={
            <>
              {text.title}
              {page === "privacy" && <span className="badge">{t.privacy.draft}</span>}
            </>
          }
        >
          {text.body.map((p) => (
            <p key={p}>{p}</p>
          ))}
          <Button glyph="back" onClick={back} autoFocus>
            {t.common.back}
          </Button>
        </Panel>
      </main>
    </div>
  );
}
