// The menus: screens are routes. Signed out you get the login; signed in
// without a handle, you pick one; then the main menu, modes, rooms, races.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  type ErrorComponentProps,
  Outlet,
  RouterProvider,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { useT } from "../i18n/index.ts";
import { ApiError, inviteQuery, meQuery, onSessionEnded, redeemInvite } from "./api.ts";
import { useAction, useAutoFocus } from "./hooks.ts";
import { Button, Panel, Wordmark } from "./ui.tsx";
import { InfoPage } from "./screens/info.tsx";
import { Login } from "./screens/login.tsx";
import { MainMenu, type MenuTab } from "./screens/main-menu.tsx";
import { ModeSelect, type Mode } from "./screens/play.tsx";
import { RaceScreen } from "./screens/race.tsx";
import { RiderScreen } from "./screens/rider.tsx";
import { RoomScreen } from "./screens/room.tsx";
import { ShopScreen } from "./screens/shop.tsx";
import { Welcome } from "./screens/welcome.tsx";
import { Toasts } from "./toast.tsx";
import { Busy } from "./busy.tsx";
import { booted } from "../loading.ts";

interface Ctx {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<Ctx>()({
  component: () => (
    <>
      <Outlet />
      <Toasts />
      <Busy />
    </>
  ),
  errorComponent: RouteError,
  notFoundComponent: NotFound,
});

const retry = () => window.location.reload();

/** An address that isn't a screen: say so, and offer the way home. */
function NotFound() {
  const t = useT();
  const navigate = useNavigate();
  useEffect(() => booted(), []);
  useAutoFocus();
  const home = () => void navigate({ to: "/" });
  useAction("back", home);
  return (
    <div className="screen login">
      <header className="screen-top">
        <Wordmark />
      </header>
      <main className="login-main">
        <Panel className="login-card" title={t.errors.notFoundTitle}>
          <p>{t.errors.notFound}</p>
          <Button kind="primary" className="wide" glyph="back" onClick={home} autoFocus>
            {t.menu.home}
          </Button>
        </Panel>
      </main>
    </div>
  );
}

/**
 * A screen that failed to load (the lobby out of reach, most often): shown
 * at once (the boot screen would hide it), with a way to try again.
 */
function RouteError({ error }: ErrorComponentProps) {
  const t = useT();
  useEffect(() => booted(), []);
  useAutoFocus();
  useAction("play", retry);
  const offline = !(error instanceof ApiError);
  return (
    <div className="screen login">
      <header className="screen-top">
        <Wordmark />
      </header>
      <main className="login-main">
        <Panel className="login-card" title={offline ? t.errors.offlineTitle : t.errors.title}>
          <p>{offline ? t.common.offline : t.common.error}</p>
          <Button kind="primary" className="wide" glyph="play" onClick={retry} autoFocus>
            {t.common.retry}
          </Button>
        </Panel>
      </main>
    </div>
  );
}

async function signedIn(ctx: Ctx) {
  return ctx.queryClient.ensureQueryData(meQuery);
}

/** Screens for players with a handle and a rider. */
async function requirePlayer({ context }: { context: Ctx }) {
  const me = await signedIn(context);
  if (!me) throw redirect({ to: "/login" });
  if (!me.player) throw redirect({ to: "/welcome" });
  if (!me.rider?.appearance) throw redirect({ to: "/rider" });
}

/** The creator: a handle is enough (it's where new players make their rider). */
async function requireHandle({ context }: { context: Ctx }) {
  const me = await signedIn(context);
  if (!me) throw redirect({ to: "/login" });
  if (!me.player) throw redirect({ to: "/welcome" });
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** The login, started afresh when it is sent somewhere with a new reason (the session ended). */
function LoginScreen() {
  const { error } = loginRoute.useSearch();
  return <Login key={error ?? ""} />;
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (s: Record<string, unknown>): { error?: string } => ({ error: str(s.error) }),
  beforeLoad: async ({ context }) => {
    const me = await signedIn(context);
    if (me) throw redirect({ to: me.player ? (me.rider?.appearance ? "/" : "/rider") : "/welcome" });
    await context.queryClient.ensureQueryData(inviteQuery);
  },
  component: LoginScreen,
});

/** An invite link: redeems the code for this browser, then the login screen takes over. */
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/$code",
  beforeLoad: async ({ context, params }) => {
    if (await signedIn(context)) throw redirect({ to: "/" });
    let error: string | undefined;
    try {
      if (!(await redeemInvite(params.code))) error = "invalid_invite";
    } catch {
      error = "too_many";
    }
    await context.queryClient.fetchQuery(inviteQuery);
    throw redirect({ to: "/login", search: { error } });
  },
});

const welcomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/welcome",
  beforeLoad: async ({ context }) => {
    const me = await signedIn(context);
    if (!me) throw redirect({ to: "/login" });
    if (me.player) throw redirect({ to: me.rider?.appearance ? "/" : "/rider" });
  },
  component: Welcome,
});

const TABS: MenuTab[] = ["home", "collection", "settings"];
const menuRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (s: Record<string, unknown>): { tab?: MenuTab } => ({
    tab: TABS.find((t) => t === s.tab),
  }),
  beforeLoad: requirePlayer,
  component: MainMenu,
});

const MODES: Mode[] = ["trial", "single", "room", "matchmaking"];
const playRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/play",
  validateSearch: (s: Record<string, unknown>): { mode?: Mode } => ({ mode: MODES.find((m) => m === s.mode) }),
  beforeLoad: requirePlayer,
  component: ModeSelect,
});

const riderRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/rider",
  beforeLoad: requireHandle,
  component: RiderScreen,
});

const shopRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/shop",
  beforeLoad: requirePlayer,
  component: ShopScreen,
});

const roomRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/room/$code",
  beforeLoad: requirePlayer,
  component: RoomScreen,
});

const raceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/race",
  beforeLoad: requirePlayer,
  component: RaceScreen,
});

const aboutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/about",
  component: () => <InfoPage page="about" />,
});

const privacyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/privacy",
  component: () => <InfoPage page="privacy" />,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  inviteRoute,
  welcomeRoute,
  menuRoute,
  riderRoute,
  shopRoute,
  playRoute,
  roomRoute,
  raceRoute,
  aboutRoute,
  privacyRoute,
]);

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

const router = createRouter({ routeTree, context: { queryClient }, defaultPendingMinMs: 0 });

/**
 * The session ended under the menus (it expired, or you logged out
 * elsewhere): back to the login, saying so. A race runs on its ticket and
 * keeps its own screens (results, trouble), so the menus wait until you
 * leave it.
 */
let ended = false;
const inRace = () => router.state.location.pathname === "/race";
function endSession(): void {
  if (inRace()) {
    ended = true;
    return;
  }
  ended = false;
  queryClient.setQueryData(meQuery.queryKey, null);
  void router.navigate({ to: "/login", search: { error: "session" } });
}
onSessionEnded(() => {
  if (queryClient.getQueryData(meQuery.queryKey)) endSession();
});
router.subscribe("onResolved", () => {
  if (ended && !inRace()) endSession();
});
// A fresh look at the account (the tab coming back) that finds nobody signed in.
let signedInBefore = false;
queryClient.getQueryCache().subscribe((e) => {
  if (e.type !== "updated" || e.query.queryKey[0] !== meQuery.queryKey[0] || e.action.type !== "success") return;
  const now = e.query.state.data != null;
  if (!now && signedInBefore && e.action.manual !== true) endSession();
  signedInBefore = now;
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
