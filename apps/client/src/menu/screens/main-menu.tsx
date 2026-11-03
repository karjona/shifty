// The main menu: Play, the tabs (home, collection, settings) and your card
// along the top; on Home your rider stands over the seasons' colours with
// a banner, missions and news around.
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { showMenuRider } from "../../game/backdrops.ts";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useEffect, useReducer, useState } from "react";
import { type Locale, LOCALES, setLocale, useLocale, useT } from "../../i18n/index.ts";
import { auth, type Banner, fetchContent, meQuery, type NewsPost } from "../api.ts";
import { DiamondIcon, GearIcon, HomeIcon } from "../icons.tsx";
import { useAction, useAutoFocus, useBackdrop, useEngine } from "../hooks.ts";
import { Button, Hints, Modal, Panel, Picker, TabBar } from "../ui.tsx";
import { TopBar } from "./common.tsx";

export type MenuTab = "home" | "collection" | "settings";
const route = getRouteApi("/");

export function MainMenu() {
  useBackdrop("shader");
  const t = useT();
  const navigate = useNavigate();
  const { tab = "home" } = route.useSearch();
  useEffect(() => showMenuRider(tab === "home"), [tab]);
  const setTab = (next: MenuTab) => void navigate({ to: "/", search: { tab: next }, replace: true });
  const play = () => void navigate({ to: "/play" });
  useAction("play", play);
  useAutoFocus();

  return (
    <div className="screen main-menu">
      <TopBar>
        <Button kind="primary" glyph="play" className="play-button" onClick={play} autoFocus>
          {t.common.play}
        </Button>
        <TabBar
          iconsOnly
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "home", label: t.menu.home, icon: <HomeIcon /> },
            { id: "collection", label: t.menu.collection, icon: <DiamondIcon /> },
            { id: "settings", label: t.menu.settings, icon: <GearIcon /> },
          ]}
        />
      </TopBar>
      {tab === "home" && <HomeTab />}
      {tab === "collection" && (
        <main className="menu-body centered">
          <Panel title={t.menu.collection}>
            <p>{t.menu.collectionEmpty}</p>
          </Panel>
        </main>
      )}
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

function HomeTab() {
  const t = useT();
  const locale = useLocale();
  const { data } = useQuery({ queryKey: ["content", locale], queryFn: () => fetchContent(locale), staleTime: 60_000 });
  const [reading, setReading] = useState<NewsPost | null>(null);
  const navigate = useNavigate();

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
        <div className="rider-space" aria-hidden="true" />
        {data && data.banners.length > 0 && <HeroBanner banners={data.banners} onOpen={open} />}
      </div>
      <div className="home-right">
        <Panel title={t.home.missions} className="missions">
          <p className="muted">{t.home.missionsEmpty}</p>
        </Panel>
        <Panel title={t.home.news} className="news">
          {data && data.news.length === 0 && <p className="muted">{t.home.newsEmpty}</p>}
          <ul>
            {data?.news.slice(0, 4).map((n) => (
              <li key={n.slug}>
                <button type="button" data-nav="" className="news-item" onClick={() => setReading(n)}>
                  <time>{new Date(n.publishedAt).toLocaleDateString(locale)}</time>
                  <b>{n.title}</b>
                </button>
              </li>
            ))}
          </ul>
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
  return (
    <button
      type="button"
      data-nav=""
      className={`hero season-${season}`}
      style={b.imageUrl ? { backgroundImage: `url("${encodeURI(b.imageUrl)}")` } : undefined}
      onClick={() => onOpen(b)}
    >
      <b>{b.title}</b>
      {b.subtitle && <span>{b.subtitle}</span>}
      {banners.length > 1 && (
        <span className="dots" aria-hidden="true">
          {banners.map((x, n) => (
            <i key={x.id} className={n === i % banners.length ? "on" : ""} />
          ))}
        </span>
      )}
    </button>
  );
}

const SCALES = [0.5, 0.75, 1];

function SettingsTab() {
  const t = useT();
  const locale = useLocale();
  const engine = useEngine();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: me } = useSuspenseQuery(meQuery);
  // The view settings live in the engine; re-render after changing them.
  const [, changed] = useReducer((n: number) => n + 1, 0);
  const now = engine?.view.scale ?? 1;
  const scale = SCALES.reduce((a, b) => (Math.abs(b - now) < Math.abs(a - now) ? b : a));
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
        <Picker
          label={t.settings.scale}
          options={SCALES.map((s) => ({ value: s, label: `${Math.round(s * 100)}%` }))}
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
      <Panel title={t.settings.controls}>
        <p className="muted">{t.settings.controlsBody}</p>
      </Panel>
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
