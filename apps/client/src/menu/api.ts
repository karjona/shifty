// The lobby, from the menus: the account (Better Auth), the player's
// profile, menu content, and getting into races.
import { queryOptions } from "@tanstack/react-query";
import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";
import { getLocale } from "../i18n/index.ts";
import { parseJoinTicket, type JoinTicket } from "../net/transport.ts";

export const auth = createAuthClient({
  basePath: "/api/auth",
  plugins: [emailOTPClient()],
});

export type EventChoice = "gp" | "summer" | "winter";
/** The modes on the mode select screen. */
export type Mode = "trial" | "single" | "room" | "matchmaking";

export interface Player {
  name: string;
  tag: number;
  handle: string;
  title: string;
  card: string;
  /** When the name may change again (ms since epoch); 0 = now. */
  renameAt: number;
}

export interface Me {
  user: { id: string; email: string; image: string | null; name: string };
  player: Player | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (o: Obj, k: string): string => (typeof o[k] === "string" ? o[k] : "");
const strOrNull = (o: Obj, k: string): string | null => (typeof o[k] === "string" ? o[k] : null);
const num = (o: Obj, k: string): number => (typeof o[k] === "number" ? o[k] : 0);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? (v as unknown[]).filter(isObj) : []);

/** Calls the lobby; its JSON answer as an object. Errors carry the lobby's error code. */
async function call(path: string, init: RequestInit = {}): Promise<Obj> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  headers.set("x-shifty-locale", getLocale());
  const res = await fetch(path, { ...init, headers });
  const body: unknown = await res.json().catch(() => null);
  const obj = isObj(body) ? body : {};
  if (!res.ok) throw new ApiError(res.status, typeof obj.error === "string" ? obj.error : `http_${res.status}`);
  return obj;
}

function parsePlayer(v: unknown): Player | null {
  if (!isObj(v) || typeof v.name !== "string" || typeof v.tag !== "number") return null;
  return {
    name: v.name,
    tag: v.tag,
    handle: str(v, "handle"),
    title: str(v, "title"),
    card: str(v, "card"),
    renameAt: num(v, "renameAt"),
  };
}

function playerOf(o: Obj): Player {
  const p = parsePlayer(o.player);
  if (!p) throw new ApiError(500, "bad_response");
  return p;
}

/** The signed-in account, or null if nobody is signed in. */
export async function fetchMe(): Promise<Me | null> {
  const me = await call("/api/me");
  const u = me.user;
  if (!isObj(u) || typeof u.id !== "string") return null;
  return {
    user: { id: u.id, email: str(u, "email"), image: strOrNull(u, "image"), name: str(u, "name") },
    player: parsePlayer(me.player),
  };
}

export const meQuery = queryOptions({ queryKey: ["me"], queryFn: fetchMe, staleTime: 30_000 });

export async function claimHandle(name: string): Promise<Player> {
  return playerOf(await call("/api/me/handle", { method: "POST", body: JSON.stringify({ name }) }));
}

export async function saveCard(title: string, card: string): Promise<Player> {
  return playerOf(await call("/api/me/card", { method: "PATCH", body: JSON.stringify({ title, card }) }));
}

export interface Banner {
  id: number;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  action: string | null;
  theme: string;
}

export interface NewsPost {
  slug: string;
  title: string;
  body: string;
  publishedAt: string;
}

export async function fetchContent(locale: string): Promise<{ banners: Banner[]; news: NewsPost[] }> {
  const c = await call(`/api/content?locale=${encodeURIComponent(locale)}`);
  return {
    banners: list(c.banners).map((b) => ({
      id: num(b, "id"),
      title: str(b, "title"),
      subtitle: strOrNull(b, "subtitle"),
      imageUrl: strOrNull(b, "imageUrl"),
      action: strOrNull(b, "action"),
      theme: str(b, "theme"),
    })),
    news: list(c.news).map((n) => ({
      slug: str(n, "slug"),
      title: str(n, "title"),
      body: str(n, "body"),
      publishedAt: str(n, "publishedAt"),
    })),
  };
}

export async function playSingle(event: EventChoice): Promise<JoinTicket> {
  const { ticket } = await call("/api/play/single", { method: "POST", body: JSON.stringify({ event }) });
  return parseJoinTicket(ticket);
}

export async function createRoom(event: EventChoice, bots: number): Promise<string> {
  const { code } = await call("/api/rooms", { method: "POST", body: JSON.stringify({ event, bots }) });
  if (typeof code !== "string") throw new ApiError(500, "bad_response");
  return code;
}

export async function roomExists(code: string): Promise<boolean> {
  try {
    await call(`/api/rooms/${encodeURIComponent(code)}`);
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return false;
    throw e;
  }
}

/** A WebSocket to the lobby (same origin). */
export function lobbySocket(path: string): WebSocket {
  const url = new URL(path, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(url);
}

/** Where a race goes back to when it's over. */
export interface PendingRace {
  ticket: JoinTicket;
  back: { to: "/play"; search: { mode: Mode } } | { to: "/room/$code"; params: { code: string } };
}

let pending: PendingRace | null = null;

/** Hands a ticket to the race screen. */
export function setPendingRace(race: PendingRace): void {
  pending = race;
}

export function takePendingRace(): PendingRace | null {
  const r = pending;
  pending = null;
  return r;
}
