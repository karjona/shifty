// Sign-in codes by email, through Cloudflare Email Service (the EMAIL
// binding, sending from MAIL_FROM). `MAIL_MODE=console` prints them to the log
// instead (and with `DEV_MAILBOX=1` keeps the last one per address, for
// tests). Without either, the code is logged as an error: workerd has no
// Email Service.
import type { AuthEnv } from "./env.ts";
import type { Locale } from "./locale.ts";

interface Lines {
  subject: (code: string) => string;
  intro: string;
  expiry: string;
}

const TEXT: Record<Locale, Lines> = {
  en: {
    subject: (code) => `${code} is your 23.4° Shifty code`,
    intro: "Your sign-in code is",
    expiry: "It works for 10 minutes. If you didn't ask for it, you can ignore this email.",
  },
  es: {
    subject: (code) => `${code} es tu código de 23.4° Shifty`,
    intro: "Tu código para entrar es",
    expiry: "Sirve durante 10 minutos. Si no lo has pedido tú, puedes ignorar este correo.",
  },
  ca: {
    subject: (code) => `${code} és el teu codi de 23.4° Shifty`,
    intro: "El teu codi per entrar és",
    expiry: "Serveix durant 10 minuts. Si no l'has demanat tu, pots ignorar aquest correu.",
  },
};

const SENDER_NAME = "23.4° Shifty";

/** The message for one code. Only our own strings and the code go into the HTML. */
export function signInMessage(code: string, locale: Locale) {
  const t = TEXT[locale];
  const text = `${t.intro} ${code}\n\n${t.expiry}\n`;
  const html = `<!doctype html>
<html lang="${locale}">
<body style="margin:0;padding:32px 16px;background:#e6dccb;color:#1d1b17;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:440px;margin:0 auto;background:#f3ede1;border:1px solid #1d1b17">
<tr><td style="padding:28px 32px">
<p style="margin:0 0 24px;font-size:15px;font-weight:700;font-style:italic;letter-spacing:0.06em">23.4° / SHIFTY</p>
<p style="margin:0 0 8px;font-size:16px">${t.intro}</p>
<p style="margin:0 0 24px;font-size:40px;font-weight:700;letter-spacing:0.18em;font-family:'Courier New',Courier,monospace">${code}</p>
<p style="margin:0;font-size:14px;line-height:1.5;color:#5f5a51">${t.expiry}</p>
</td></tr>
</table>
</body>
</html>
`;
  return { subject: t.subject(code), text, html };
}

/** Dev only (DEV_MAILBOX=1): the last code sent to each address. */
const mailbox = new Map<string, { code: string; at: number }>();

export function devMailbox(email: string): string | null {
  return mailbox.get(email.trim().toLowerCase())?.code ?? null;
}

/** Sends the code, or logs why it couldn't. Never throws: it runs in the background. */
export async function sendSignInCode(env: AuthEnv, email: string, code: string, locale: Locale): Promise<void> {
  const message = signInMessage(code, locale);
  if (env.DEV_MAILBOX === "1") mailbox.set(email.trim().toLowerCase(), { code, at: Date.now() });
  if (env.MAIL_MODE === "console") {
    console.log(`✉  ${email}: ${message.subject}`);
    return;
  }
  if (!env.EMAIL || !env.MAIL_FROM) {
    console.error(`no mail transport (EMAIL binding and MAIL_FROM); sign-in code for ${email} not sent`);
    return;
  }
  try {
    await env.EMAIL.send({ to: email, from: { email: env.MAIL_FROM, name: SENDER_NAME }, ...message });
  } catch (e) {
    const reason = e instanceof Error && "code" in e && typeof e.code === "string" ? `${e.code}: ` : "";
    console.error(`sign-in code for ${email} not sent: ${reason}${String(e)}`);
  }
}
