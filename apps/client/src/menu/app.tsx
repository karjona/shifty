// The menus: screens are routes. Signed out you get the login; signed in
// without a handle, you pick one; then the main menu, modes, rooms, races.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { inviteQuery, meQuery, redeemInvite } from "./api.ts";
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

interface Ctx {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<Ctx>()({
  component: () => (
    <>
      <Outlet />
      <Toasts />
    </>
  ),
});

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

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (s: Record<string, unknown>): { error?: string } => ({ error: str(s.error) }),
  beforeLoad: async ({ context }) => {
    const me = await signedIn(context);
    if (me) throw redirect({ to: me.player ? (me.rider?.appearance ? "/" : "/rider") : "/welcome" });
    await context.queryClient.ensureQueryData(inviteQuery);
  },
  component: Login,
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
