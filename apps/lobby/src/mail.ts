// Sign-in codes by email. `MAIL_MODE=console` prints them to the log (and
// with `DEV_MAILBOX=1` keeps the last one per address, for tests). There is
// no mail transport otherwise yet: the code is logged as an error.
import type { AuthEnv } from "./env.ts";
import type { Locale } from "./locale.ts";

const TEXT: Record<Locale, { subject: (code: string) => string; body: (code: string) => string }> = {
  en: {
    subject: (code) => `${code} is your 23.4° Shifty code`,
    body: (code) =>
      `Your sign-in code is ${code}\n\nIt works for 10 minutes. If you didn't ask for it, you can ignore this email.`,
  },
  es: {
    subject: (code) => `${code} es tu código de 23.4° Shifty`,
    body: (code) =>
      `Tu código para entrar es ${code}\n\nSirve durante 10 minutos. Si no lo has pedido tú, puedes ignorar este correo.`,
  },
  ca: {
    subject: (code) => `${code} és el teu codi de 23.4° Shifty`,
    body: (code) =>
      `El teu codi per entrar és ${code}\n\nServeix durant 10 minuts. Si no l'has demanat tu, pots ignorar aquest correu.`,
  },
};

/** Dev only (DEV_MAILBOX=1): the last code sent to each address. */
const mailbox = new Map<string, { code: string; at: number }>();

export function devMailbox(email: string): string | null {
  return mailbox.get(email.trim().toLowerCase())?.code ?? null;
}

export async function sendSignInCode(env: AuthEnv, email: string, code: string, locale: Locale): Promise<void> {
  const text = TEXT[locale];
  if (env.DEV_MAILBOX === "1") mailbox.set(email.trim().toLowerCase(), { code, at: Date.now() });
  if (env.MAIL_MODE === "console") {
    console.log(`✉  ${email}: ${text.subject(code)}`);
    return;
  }
  console.error(`no mail transport configured; sign-in code for ${email} not sent`);
  await Promise.resolve();
}
