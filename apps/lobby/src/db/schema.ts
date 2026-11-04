// Postgres schema: Better Auth's tables (user, session, account,
// verification, rateLimit, with the admin plugin's fields), then the game's.
// Migrations are generated from this file: `pnpm --filter lobby db:generate`.
import type { Appearance, Setups } from "@shifty/rider";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at").notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  role: text("role"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires"),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

export const rateLimit = pgTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

/**
 * A player's game profile. The handle is `name#tag` (e.g. `Lord Kylian#1234`):
 * names repeat, the pair does not (compared by `nameKey`, the name folded to
 * lower case without accents).
 */
export const player = pgTable(
  "player",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    tag: smallint("tag").notNull(),
    title: text("title").notNull().default("rookie"),
    card: text("card").notNull().default("bay"),
    /** The rider (look and outfits); null until the player makes one. */
    appearance: jsonb("appearance").$type<Appearance>(),
    /** Setup per sport; null = balanced. */
    setups: jsonb("setups").$type<Setups>(),
    /** Credits to spend: the sum of the player's ledger, kept here too. */
    credits: integer("credits").notNull().default(0),
    createdAt: createdAt(),
    nameChangedAt: timestamp("name_changed_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("player_handle_idx").on(t.nameKey, t.tag)],
);

/** Items a player owns beyond the starter kit (see `@shifty/rider`'s catalog). */
export const inventory = pgTable(
  "inventory",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    item: text("item").notNull(),
    /** `shop` or `reward`. */
    source: text("source").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.item] })],
);

/**
 * Every change to a player's credits, with why: earned in a race (`race`,
 * `style`, `grand_prix`) or spent (`purchase`). `ref` says what it was for
 * (a race, an item); a reason and ref pay out once, so retried race
 * reports never pay twice.
 */
export const ledger = pgTable(
  "ledger",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(),
    reason: text("reason").notNull(),
    ref: text("ref").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("ledger_once_idx").on(t.userId, t.reason, t.ref),
    index("ledger_user_idx").on(t.userId, t.createdAt),
  ],
);

/** Main menu banners, per language. Shown while published and in their window. */
export const banner = pgTable(
  "banner",
  {
    id: serial("id").primaryKey(),
    locale: text("locale").notNull(),
    title: text("title").notNull(),
    subtitle: text("subtitle"),
    imageUrl: text("image_url"),
    /** What pressing it does: `play`, `news:<slug>` or `url:<https url>`. */
    action: text("action"),
    /** Background colours when there is no image: `season:summer` etc. */
    theme: text("theme").notNull().default("season:summer"),
    sort: integer("sort").notNull().default(0),
    startsAt: timestamp("starts_at"),
    endsAt: timestamp("ends_at"),
    published: boolean("published").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("banner_locale_idx").on(t.locale, t.sort)],
);

/** News posts (Markdown), per language. Drafts have no `publishedAt`. */
export const newsPost = pgTable(
  "news_post",
  {
    id: serial("id").primaryKey(),
    locale: text("locale").notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    publishedAt: timestamp("published_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("news_post_slug_idx").on(t.locale, t.slug),
    index("news_post_published_idx").on(t.locale, t.publishedAt),
  ],
);

/**
 * An online race room the lobby started (a private room or a matchmade
 * one). Its id is the room id on the race server. Single player rooms are
 * not recorded.
 */
export const match = pgTable("match", {
  id: text("id").primaryKey(),
  /** `room` or `matchmaking`. */
  mode: text("mode").notNull(),
  /** `gp`, `summer` or `winter`. */
  event: text("event").notNull(),
  server: text("server").notNull(),
  createdAt: createdAt(),
});

export const matchPlayer = pgTable(
  "match_player",
  {
    matchId: text("match_id")
      .notNull()
      .references(() => match.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The rider and setups the player entered with: locked for the match. */
    look: text("look"),
    setups: jsonb("setups").$type<number[][]>(),
  },
  (t) => [uniqueIndex("match_player_idx").on(t.matchId, t.userId)],
);

/**
 * One rider's result in one race of a match, as reported by the race
 * server. `round` counts Grand Prix runs in the same room; a deleted
 * account keeps its results, without the user.
 */
export const raceResult = pgTable(
  "race_result",
  {
    id: serial("id").primaryKey(),
    matchId: text("match_id")
      .notNull()
      .references(() => match.id, { onDelete: "cascade" }),
    round: smallint("round").notNull(),
    eventIndex: smallint("event_index").notNull(),
    course: smallint("course").notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    place: smallint("place").notNull(),
    /** Race time; null if the rider didn't finish. */
    timeMs: integer("time_ms"),
    trickPoints: integer("trick_points").notNull().default(0),
    /** Grand Prix points after this race (Grand Prix rooms only). */
    gpPoints: integer("gp_points"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("race_result_entry_idx").on(t.matchId, t.round, t.eventIndex, t.userId),
    index("race_result_user_idx")
      .on(t.userId)
      .where(sql`${t.userId} is not null`),
  ],
);
