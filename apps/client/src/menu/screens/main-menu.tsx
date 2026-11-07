// The main menu: Play, the tabs (home, collection, settings) and your card
// along the top; on Home your rider stands over the seasons' colours with
// a banner, missions and news around.
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { audio } from "../../audio/index.ts";
import { preloadClub, setMenuRider, showMenuRider } from "../../game/backdrops.ts";
import { SEASONS, onSeasonShown, shownSeason } from "../../game/seasons.ts";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useEffect, useReducer, useState, useSyncExternalStore } from "react";
import { type Locale, LOCALES, setLocale, useLocale, useT } from "../../i18n/index.ts";
import { auth, type Banner, fetchContent, meQuery, type NewsPost } from "../api.ts";
import { useAction, useAutoFocus, useBackdrop, useEngine, useRiderShot } from "../hooks.ts";
import { Button, Glyph, Hints, Modal, Panel, Picker, TabBar } from "../ui.tsx";
import { TopBar } from "./common.tsx";
import { Wardrobe } from "./wardrobe.tsx";
import {
  apple,
  canFullscreen,
  canInstall,
  canTouch,
  enterFullscreen,
  exitFullscreen,
  fullscreen,
  type GasMode,
  install,
  onScreenChange,
  screenVersion,
  setGasMode,
  standalone,
  touchSettings,
} from "../../touch/device.ts";

export type MenuTab = "home" | "collection" | "settings";
const route = getRouteApi("/");

export function MainMenu() {
  useBackdrop("shader");
  const t = useT();
  const navigate = useNavigate();
  const { tab = "home" } = route.useSearch();
  const { data: me } = useSuspenseQuery(meQuery);
  const appearance = me?.rider?.appearance ?? null;
  const engine = useEngine();
  useEffect(() => {
    // The mode select is where Play goes: its terrace gets ready meanwhile.
    if (engine && appearance) preloadClub(engine, appearance);
  }, [engine, appearance]);
  useEffect(() => showMenuRider(tab !== "settings"), [tab]);
  useEffect(() => {
    if (appearance && tab === "home") setMenuRider(appearance, "summer");
  }, [appearance, tab]);
  const setTab = (next: MenuTab) => void navigate({ to: "/", search: { tab: next }, replace: true });
  const play = () => void navigate({ to: "/play" });
  useAction("play", play);
  useAutoFocus();

  return (
    <div className="screen main-menu">
      <TopBar />
      <TabBar
        className="menu-tabs"
        value={tab}
        onChange={setTab}
        lead={
          <Button kind="primary" glyph="play" className="play-button" onClick={play} autoFocus>
            {t.common.play}
          </Button>
        }
        tabs={[
          { id: "home", label: t.menu.home },
          { id: "collection", label: t.menu.collection },
          { id: "settings", label: t.menu.settings },
        ]}
      />
      {tab === "home" && <HomeTab />}
      {tab === "collection" && <Wardrobe />}
      {tab === "settings" && <SettingsTab />}
      <Hints
        items={[
          ["confirm", t.common.select],
          ["play", t.common.play],
          ["prev", t.common.tabs],
        ]}
      />
    </div>
  );
}

/** The season on the backdrop, as a poster word on the scene. */
function SeasonWord() {
  const t = useT();
  const season = useSyncExternalStore(onSeasonShown, shownSeason);
  return (
    <div className="season-word" aria-hidden="true">
      <b key={season}>{t.seasons[season]}</b>
      <span>{String(SEASONS.indexOf(season) + 1).padStart(2, "0")} / 04</span>
    </div>
  );
}

function HomeTab() {
  const t = useT();
  const locale = useLocale();
  const { data } = useQuery({ queryKey: ["content", locale], queryFn: () => fetchContent(locale), staleTime: 60_000 });
  const [reading, setReading] = useState<NewsPost | null>(null);
  const navigate = useNavigate();
  const space = useRiderShot("hero");

  const open = (b: Banner) => {
    const action = b.action ?? "";
    if (action === "play") void navigate({ to: "/play" });
    else if (action.startsWith("news:")) {
      const post = data?.news.find((n) => n.slug === action.slice(5));
      if (post) setReading(post);
    } else if (action.startsWith("url:https://")) window.open(action.slice(4), "_blank", "noreferrer");
  };

  return (
    <main className="menu-body home">
      <div className="home-left">
        <div className="rider-space" aria-hidden="true" ref={space} />
        <SeasonWord />
      </div>
      <div className="home-right">
        {data && data.banners.length > 0 && <HeroBanner banners={data.banners} onOpen={open} />}
        <Panel title={t.home.news} className="news">
          {data && data.news.length === 0 && <p className="muted">{t.home.newsEmpty}</p>}
          <ul>
            {data?.news.slice(0, 3).map((n) => (
              <li key={n.slug}>
                <button type="button" data-nav="" className="news-item" onClick={() => setReading(n)}>
                  <time>{new Date(n.publishedAt).toLocaleDateString(locale, { day: "numeric", month: "short" })}</time>
                  <b>{n.title}</b>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title={t.home.missions} className="missions">
          <span className="badge">{t.common.soonTag}</span>
        </Panel>
      </div>
      {reading && (
        <Modal
          title={reading.title}
          onClose={() => setReading(null)}
          actions={
            <Button glyph="back" onClick={() => setReading(null)} autoFocus>
              {t.common.close}
            </Button>
          }
        >
          {reading.body.split(/\n{2,}/u).map((p) => (
            <p key={p}>{p}</p>
          ))}
        </Modal>
      )}
    </main>
  );
}

/** The banner: one at a time, turning every few seconds. */
function HeroBanner({ banners, onOpen }: { banners: Banner[]; onOpen: (b: Banner) => void }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = banners.length > 1 ? setInterval(() => setI((n) => (n + 1) % banners.length), 7000) : undefined;
    return () => clearInterval(id);
  }, [banners.length]);
  const b = banners[i % banners.length]!;
  const season = b.theme.startsWith("season:") ? b.theme.slice(7) : "summer";
  const t = useT();
  return (
    <button
      type="button"
      data-nav=""
      className={`hero season-${season} ${b.imageUrl ? "with-image" : ""}`}
      onClick={() => onOpen(b)}
    >
      <span className="hero-head">
        <span className="label">{t.home.featured}</span>
        {banners.length > 1 && (
          <span className="dots" aria-hidden="true">
            <span className="num">
              {(i % banners.length) + 1} / {banners.length}
            </span>
            {banners.map((x, n) => (
              <i key={x.id} className={n === i % banners.length ? "on" : ""} />
            ))}
          </span>
        )}
      </span>
      {b.imageUrl && <span className="hero-image" style={{ backgroundImage: `url("${encodeURI(b.imageUrl)}")` }} />}
      <span className="hero-block" key={b.id}>
        <Glyph action="confirm" />
        <b>{b.title}</b>
        {b.subtitle && <span>{b.subtitle}</span>}
      </span>
    </button>
  );
}

/**
 * The touch screen's settings, and full screen: a setting where the browser
 * has it, on an iPhone (which hasn't) how to get it from the Home Screen,
 * and Chrome's install.
 */
function TouchPanels() {
  const t = useT();
  useSyncExternalStore(onScreenChange, screenVersion);
  const away = !standalone();
  const toggle = canFullscreen() && away;
  const homeScreen = apple() && away && !canFullscreen();
  return (
    <>
      {canTouch() && (
        <Panel title={t.settings.touch}>
          <p className="muted">{t.settings.touchBody}</p>
          <Picker<GasMode>
            label={t.settings.gas}
            options={[
              { value: "auto", label: t.settings.gasAuto },
              { value: "hold", label: t.settings.gasHold },
            ]}
            value={touchSettings().gas}
            onChange={setGasMode}
          />
        </Panel>
      )}
      {(toggle || homeScreen || canInstall()) && (
        <Panel title={t.settings.screen} className="screen-panel">
          {toggle && (
            <Picker<"on" | "off">
              label={t.settings.fullscreen}
              options={[
                { value: "on", label: t.settings.on },
                { value: "off", label: t.settings.off },
              ]}
              value={fullscreen() ? "on" : "off"}
              onChange={(v) => (v === "on" ? enterFullscreen() : exitFullscreen())}
            />
          )}
          {homeScreen && <p className="muted">{t.settings.homeScreen}</p>}
          {canInstall() && (
            <>
              <p className="muted">{t.settings.installBody}</p>
              <Button onClick={install}>{t.settings.install}</Button>
            </>
          )}
        </Panel>
      )}
    </>
  );
}

const SCALES = [0.5, 0.75, 1];
/** Volume steps (0-1). */
const VOLUMES = Array.from({ length: 11 }, (_, i) => i / 10);
const VOLUME_KINDS = ["master", "effects", "music"] as const;

function SettingsTab() {
  const t = useT();
  const locale = useLocale();
  const engine = useEngine();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: me } = useSuspenseQuery(meQuery);
  // The view settings live in the engine, the volumes in the sound system; re-render after changing them.
  const [, changed] = useReducer((n: number) => n + 1, 0);
  const now = engine?.view.scale ?? "auto";
  const scale = now === "auto" ? now : SCALES.reduce((a, b) => (Math.abs(b - now) < Math.abs(a - now) ? b : a));
  const water = engine?.view.water ?? "sea";
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const signOut = async () => {
    await auth.signOut();
    queryClient.setQueryData(meQuery.queryKey, null);
    await navigate({ to: "/login" });
  };

  const remove = async () => {
    const res = await auth.deleteUser();
    if (res.error) {
      setDeleteError(t.settings.deleteFresh);
      return;
    }
    queryClient.setQueryData(meQuery.queryKey, null);
    await navigate({ to: "/login" });
  };

  return (
    <main className="menu-body settings">
      <Panel title={t.menu.settings}>
        <Picker<Locale>
          label={t.settings.language}
          options={LOCALES.map((l) => ({ value: l, label: t.languages[l] }))}
          value={locale}
          onChange={setLocale}
        />
        <Picker<number | "auto">
          label={t.settings.scale}
          options={[
            { value: "auto", label: t.settings.scaleAuto },
            ...SCALES.map((s) => ({ value: s, label: `${Math.round(s * 100)}%` })),
          ]}
          value={scale}
          onChange={(s) => {
            engine?.setScale(s);
            changed();
          }}
        />
        <Picker<"sea" | "basic">
          label={t.settings.water}
          options={[
            { value: "sea", label: t.settings.waterSea },
            { value: "basic", label: t.settings.waterBasic },
          ]}
          value={water}
          onChange={(w) => {
            engine?.setWater(w);
            changed();
          }}
        />
      </Panel>
      <Panel title={t.settings.sound}>
        {VOLUME_KINDS.map((kind) => (
          <Picker<number>
            key={kind}
            label={t.settings.volume[kind]}
            wrap={false}
            options={VOLUMES.map((v) => ({ value: v, label: `${Math.round(v * 100)}%` }))}
            value={Math.round(audio.volume(kind) * 10) / 10}
            onChange={(v) => {
              audio.setVolume(kind, v);
              changed();
            }}
          />
        ))}
      </Panel>
      <Panel title={t.settings.controls}>
        <p className="muted">{t.settings.controlsBody}</p>
      </Panel>
      <TouchPanels />
      <Panel title={t.settings.account}>
        <p className="muted">{t.settings.signedInAs(me?.user.email ?? "")}</p>
        <div className="row">
          <Button onClick={() => void signOut()}>{t.settings.logout}</Button>
          <Button kind="danger" onClick={() => setDeleting(true)}>
            {t.settings.delete}
          </Button>
        </div>
      </Panel>
      {deleting && (
        <Modal
          title={t.settings.deleteTitle}
          onClose={() => setDeleting(false)}
          actions={
            <>
              <Button glyph="back" onClick={() => setDeleting(false)} autoFocus>
                {t.common.cancel}
              </Button>
              <Button kind="danger" onClick={() => void remove()}>
                {t.settings.deleteConfirm}
              </Button>
            </>
          }
        >
          <p>{t.settings.deleteBody}</p>
          {deleteError && <p className="error">{deleteError}</p>}
        </Modal>
      )}
    </main>
  );
}
