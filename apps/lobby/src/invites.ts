// The sign-up gate. Unless SIGNUPS is `open`, a new account needs an invite
// code: the login screen (or an invite link) redeems it first, a cookie
// carries it through GitHub or the email code, and creating the account takes
// one use of it. Players who already have an account sign in as usual; an
// email without an account and without an invite gets `no_account` instead of
// a code.
import type { BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import { APIError, createAuthEndpoint, createAuthMiddleware } from "better-auth/api";
import { eq } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { inviteUse, user } from "./db/schema.ts";
import type { AuthEnv } from "./env.ts";
import { inviteUsable, normalizeInviteCode, takeInvite } from "./invite-codes.ts";

/** The error code a refused sign-up carries (GitHub's comes back as `/login?error=invite_required`). */
export const INVITE_REQUIRED = "invite_required";
/** The error code for asking a sign-in code for an email without an account, without an invite. */
export const NO_ACCOUNT = "no_account";
/** How long a redeemed code waits in the browser for the sign-in to finish. */
const COOKIE_MAX_AGE = 60 * 60;
/** Redeem attempts per IP address per minute. */
const REDEEM_PER_MINUTE = 10;

export const signupsOpen = (env: AuthEnv): boolean => env.SIGNUPS === "open";

const inviteCookie = (ctx: GenericEndpointContext) =>
  ctx.context.createAuthCookie("invite", { maxAge: COOKIE_MAX_AGE });

/** The redeemed code this request carries, if any. */
function carriedCode(ctx: GenericEndpointContext | null | undefined): string | null {
  if (!ctx) return null;
  const raw = ctx.getCookie(inviteCookie(ctx).name);
  return raw ? normalizeInviteCode(raw) : null;
}

/** Whether a sign-in code may be emailed: to an existing account, or to someone carrying a usable invite. */
async function mayEmail(env: AuthEnv, db: Db, email: string, ctx: GenericEndpointContext | null | undefined) {
  if (signupsOpen(env)) return true;
  const known = await db.select({ id: user.id }).from(user).where(eq(user.email, email.trim().toLowerCase())).limit(1);
  if (known.length > 0) return true;
  const code = carriedCode(ctx);
  return code !== null && (await inviteUsable(db, code));
}

/**
 * Endpoints for the login screen (`GET /api/auth/invite/status`,
 * `POST /api/auth/invite/redeem`), and the `no_account` answer when asking
 * for a sign-in code.
 */
export function invites(env: AuthEnv, db: Db) {
  return {
    id: "invites",
    endpoints: {
      inviteStatus: createAuthEndpoint("/invite/status", { method: "GET" }, async (ctx) => {
        const code = carriedCode(ctx);
        return ctx.json({
          required: !signupsOpen(env),
          redeemed: code !== null && (await inviteUsable(db, code)),
        });
      }),
      redeemInvite: createAuthEndpoint("/invite/redeem", { method: "POST" }, async (ctx) => {
        const body: unknown = ctx.body;
        const typed =
          typeof body === "object" && body !== null && "code" in body && typeof body.code === "string" ? body.code : "";
        const code = normalizeInviteCode(typed);
        if (!code || !(await inviteUsable(db, code))) {
          throw new APIError("BAD_REQUEST", { code: "invalid_invite", message: "Unknown, used up or expired code" });
        }
        const cookie = inviteCookie(ctx);
        ctx.setCookie(cookie.name, code, cookie.attributes);
        return ctx.json({ ok: true });
      }),
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/email-otp/send-verification-otp",
          handler: createAuthMiddleware(async (ctx) => {
            const body: unknown = ctx.body;
            const email =
              typeof body === "object" && body !== null && "email" in body && typeof body.email === "string"
                ? body.email
                : "";
            if (!(await mayEmail(env, db, email, ctx))) {
              throw new APIError("FORBIDDEN", {
                code: NO_ACCOUNT,
                message: "No account with this email, and no invite",
              });
            }
          }),
        },
      ],
    },
    rateLimit: [{ pathMatcher: (path) => path === "/invite/redeem", window: 60, max: REDEEM_PER_MINUTE }],
  } satisfies BetterAuthPlugin;
}

/** Better Auth hooks that spend and record invite codes. */
export function invitesOptions(env: AuthEnv, db: Db) {
  return {
    /** Before any new account (GitHub or email code): one use of the carried code. Admins skip it. */
    validate: async (
      { source }: { source: { action: string; method: string } },
      ctx: GenericEndpointContext,
    ): Promise<{ error: string; errorDescription: string } | undefined> => {
      if (signupsOpen(env) || source.action !== "create-user" || source.method === "admin") return undefined;
      const code = carriedCode(ctx);
      if (code && (await takeInvite(db, code))) return undefined;
      return { error: INVITE_REQUIRED, errorDescription: "Sign-ups need an invite code" };
    },
    /** After a new account: which code brought it in. The browser forgets the code. */
    created: async (userId: string, ctx: GenericEndpointContext | null): Promise<void> => {
      const code = carriedCode(ctx);
      if (!ctx || !code) return;
      await db.insert(inviteUse).values({ userId, code }).onConflictDoNothing();
      const cookie = inviteCookie(ctx);
      ctx.setCookie(cookie.name, "", { ...cookie.attributes, maxAge: 0 });
    },
    /** Whether a sign-in code may be emailed (checked again when sending). */
    mayEmail: (email: string, ctx: GenericEndpointContext | null | undefined): Promise<boolean> =>
      mayEmail(env, db, email, ctx),
  };
}
