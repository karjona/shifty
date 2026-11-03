// Better Auth: GitHub sign-in and one-time codes by email, sessions in
// Postgres. Built per request, around that request's database pool.
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins/admin";
import { emailOTP } from "better-auth/plugins/email-otp";
import type { Db } from "./db/client.ts";
import * as schema from "./db/schema.ts";
import type { Env } from "./env.ts";
import { pickLocale } from "./locale.ts";
import { sendSignInCode } from "./mail.ts";

const DAY = 60 * 60 * 24;

export function authOptions(env: Env, db: Db, waitUntil: (p: Promise<unknown>) => void) {
  const github =
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } }
      : {};
  return {
    appName: "23.4° Shifty",
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    socialProviders: github,
    account: {
      // The same verified address through GitHub or a code is one account.
      accountLinking: { enabled: true, trustedProviders: ["github", "email-otp"] },
    },
    session: {
      expiresIn: 60 * DAY,
      updateAge: DAY,
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    user: { deleteUser: { enabled: true } },
    rateLimit: { enabled: true, storage: "database" },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 10 * 60,
        allowedAttempts: 5,
        storeOTP: "hashed",
        sendVerificationOTP: async ({ email, otp }, ctx) => {
          const locale = pickLocale(ctx?.headers?.get("x-shifty-locale") ?? ctx?.headers?.get("accept-language"));
          waitUntil(sendSignInCode(env, email, otp, locale));
        },
      }),
      admin(),
    ],
    advanced: {
      cookiePrefix: "shifty",
      backgroundTasks: { handler: waitUntil },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"] },
    },
    telemetry: { enabled: false },
  } satisfies BetterAuthOptions;
}

export function createAuth(env: Env, db: Db, waitUntil: (p: Promise<unknown>) => void) {
  return betterAuth(authOptions(env, db, waitUntil));
}

export type Auth = ReturnType<typeof createAuth>;
