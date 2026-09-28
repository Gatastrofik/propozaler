import { createServer } from "node:http";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export function consentUrl(clientId: string, redirectUri: string, scopes: string[]): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", scopes.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  return u.toString();
}

export async function exchangeCode(
  creds: { clientId: string; clientSecret: string }, code: string, redirectUri: string, fetchImpl: typeof fetch = fetch,
): Promise<{ refresh_token: string }> {
  const body = new URLSearchParams({
    client_id: creds.clientId, client_secret: creds.clientSecret, code, redirect_uri: redirectUri, grant_type: "authorization_code",
  });
  const res = await fetchImpl(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
  if (!res.ok) throw new Error(`gmail code exchange failed: HTTP ${res.status}`);
  const j = (await res.json()) as { refresh_token?: string };
  if (!j.refresh_token) throw new Error("gmail code exchange failed: no refresh_token in response (was prompt=consent and access_type=offline set?)");
  return { refresh_token: j.refresh_token };
}

export function runGmailAuth(opts: {
  clientId: string; clientSecret: string; scopes: string[]; fetchImpl?: typeof fetch; out: (s: string) => void; port?: number;
}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const pending = new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const err = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (err) {
        res.writeHead(400, { "content-type": "text/plain" }); res.end(`Consent failed: ${err}`);
        server.close(); reject(new Error(`gmail consent failed: ${err}`)); return;
      }
      if (!code) { res.writeHead(404); res.end(); return; }
      void (async () => {
        try {
          const addr = server.address();
          const port = typeof addr === "object" && addr ? addr.port : 0;
          const { refresh_token } = await exchangeCode(opts, code, `http://127.0.0.1:${port}/`, fetchImpl);
          res.writeHead(200, { "content-type": "text/plain" }); res.end("You can close this tab.");
          server.close(); resolve(refresh_token);
        } catch (e) {
          res.writeHead(500, { "content-type": "text/plain" }); res.end("Token exchange failed; see the terminal.");
          server.close(); reject(e instanceof Error ? e : new Error(String(e)));
        }
      })();
    });
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const redirect = `http://127.0.0.1:${port}/`;
      opts.out(`Open this URL in a browser signed in as the sending account:\n${consentUrl(opts.clientId, redirect, opts.scopes)}\n`);
    });
  });
  // Suppress Node's unhandledRejection tracking for this promise: the real caller may not
  // attach its own handler until after the loopback round trip completes (a few event-loop
  // turns after the request handler above calls reject()). This no-op catch only marks the
  // promise as handled; it does not consume or alter the rejection the caller receives.
  pending.catch(() => {});
  return pending;
}
