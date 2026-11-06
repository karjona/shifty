import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthEnv } from "../src/env.ts";
import { sendSignInCode, signInMessage } from "../src/mail.ts";

const base: AuthEnv = { BETTER_AUTH_SECRET: "x", BETTER_AUTH_URL: "http://localhost:5173" };

interface Sent {
  to: string;
  from: { email: string; name: string };
  subject: string;
  text: string;
  html: string;
}

/** A stand-in for the EMAIL binding. */
function binding(fail?: string) {
  const sent: Sent[] = [];
  const send = (m: Sent) => {
    if (fail) return Promise.reject(Object.assign(new Error("refused"), { code: fail }));
    sent.push(m);
    return Promise.resolve({ messageId: "m1" });
  };
  return { sent, EMAIL: { send } };
}

void test("the code goes out through the binding, in the player's language", async () => {
  const { sent, EMAIL } = binding();
  await sendSignInCode({ ...base, EMAIL, MAIL_FROM: "noreply@4shifty.gg" }, "rider@example.com", "482913", "ca");
  assert.equal(sent.length, 1);
  const [m] = sent;
  assert.equal(m?.to, "rider@example.com");
  assert.deepEqual(m?.from, { email: "noreply@4shifty.gg", name: "23.4° Shifty" });
  assert.equal(m?.subject, "482913 és el teu codi de 23.4° Shifty");
  assert.match(m?.text ?? "", /482913/);
  assert.match(m?.html ?? "", /lang="ca"[\s\S]*482913/);
});

void test("console mode never touches the binding", async () => {
  const { sent, EMAIL } = binding();
  await sendSignInCode({ ...base, EMAIL, MAIL_FROM: "noreply@4shifty.gg", MAIL_MODE: "console" }, "a@b.co", "1", "en");
  assert.equal(sent.length, 0);
});

void test("a refused send or a missing binding is logged, not thrown", async () => {
  const { EMAIL } = binding("E_RECIPIENT_SUPPRESSED");
  await sendSignInCode({ ...base, EMAIL, MAIL_FROM: "noreply@4shifty.gg" }, "a@b.co", "1", "en");
  await sendSignInCode(base, "a@b.co", "1", "en");
});

void test("every language has a subject, the code and the expiry", () => {
  for (const locale of ["en", "es", "ca"] as const) {
    const m = signInMessage("123456", locale);
    assert.match(m.subject, /^123456 .*23\.4° Shifty/);
    assert.match(m.text, /123456[\s\S]*10/);
  }
});
