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
import { meQuery } from "./api.ts";
import { InfoPage } from "./screens/info.tsx";
import { Login } from "./screens/login.tsx";
import { MainMenu, type MenuTab } from "./screens/main-menu.tsx";
import { ModeSelect, type Mode } from "./screens/play.tsx";
import { RaceScreen } from "./screens/race.tsx";
import { RoomScreen } from "./screens/room.tsx";
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

/** Screens for players with a handle. */
async function requirePlayer({ context }: { context: Ctx }) {
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
    if (me) throw redirect({ to: me.player ? "/" : "/welcome" });
  },
  component: Login,
});

const welcomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/welcome",
  beforeLoad: async ({ context }) => {
    const me = await signedIn(context);
    if (!me) throw redirect({ to: "/login" });
    if (me.player) throw redirect({ to: "/" });
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
  welcomeRoute,
  menuRoute,
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
