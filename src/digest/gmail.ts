import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { MailMessage, Mailer } from "./mailer.js";

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export interface GmailCredentials { clientId: string; clientSecret: string; refreshToken: string }

export function gmailCredentialsFromEnv(env: NodeJS.ProcessEnv): GmailCredentials {
  const clientId = env.GMAIL_CLIENT_ID;
  const clientSecret = env.GMAIL_CLIENT_SECRET;
  const refreshToken = env.GMAIL_REFRESH_TOKEN;
  if (!clientId) throw new Error("missing GMAIL_CLIENT_ID");
  if (!clientSecret) throw new Error("missing GMAIL_CLIENT_SECRET");
  if (!refreshToken) throw new Error("missing GMAIL_REFRESH_TOKEN");
  return { clientId, clientSecret, refreshToken };
}

async function errorField(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string | { message?: string } };
    if (typeof j.error === "string") return j.error;
    if (j.error && typeof j.error.message === "string") return j.error.message;
  } catch { /* not JSON */ }
  return "";
}

export async function fetchAccessToken(creds: GmailCredentials, fetchImpl: typeof fetch = fetch): Promise<string> {
  const body = new URLSearchParams({
    client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: creds.refreshToken, grant_type: "refresh_token",
  });
  const res = await fetchImpl(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
  if (!res.ok) throw new Error(`gmail token request failed: HTTP ${res.status} ${await errorField(res)}`.trim());
  const j = (await res.json()) as { access_token?: string };
  if (!j.access_token) throw new Error("gmail token request failed: no access_token in response");
  return j.access_token;
}

export async function buildRawMessage(msg: MailMessage): Promise<string> {
  const mail = new MailComposer({ from: msg.from, to: msg.to.join(", "), subject: msg.subject, text: msg.text, html: msg.html });
  const buf: Buffer = await mail.compile().build();
  return buf.toString("base64url");
}

export function createGmailApiMailer(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): Mailer {
  const creds = gmailCredentialsFromEnv(env);
  return {
    async send(msg) {
      const token = await fetchAccessToken(creds, fetchImpl);
      const raw = await buildRawMessage(msg);
      const res = await fetchImpl(SEND_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ raw }),
      });
      if (!res.ok) throw new Error(`gmail send failed: HTTP ${res.status} ${await errorField(res)}`.trim());
      const j = (await res.json()) as { id?: string };
      return { messageId: `gmail:${j.id ?? "unknown"}` };
    },
  };
}
