import { describe, it, expect } from "vitest";
import { gmailCredentialsFromEnv, fetchAccessToken, buildRawMessage, createGmailApiMailer, GMAIL_SEND_SCOPE } from "../src/digest/gmail.js";

const env = { GMAIL_CLIENT_ID: "cid", GMAIL_CLIENT_SECRET: "csec", GMAIL_REFRESH_TOKEN: "rtok" };
const msg = { from: "jobdigest0@gmail.com", to: ["a@example.com", "b@example.com"], subject: "Sübject", text: "plain", html: "<p>plain</p>" };

function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init: init ?? {} });
    const r = handler(url, init ?? {});
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

describe("gmailCredentialsFromEnv", () => {
  it("requires all three variables, naming the first missing one", () => {
    expect(() => gmailCredentialsFromEnv({})).toThrow(/missing GMAIL_CLIENT_ID/);
    expect(() => gmailCredentialsFromEnv({ GMAIL_CLIENT_ID: "x" })).toThrow(/missing GMAIL_CLIENT_SECRET/);
    expect(() => gmailCredentialsFromEnv({ GMAIL_CLIENT_ID: "x", GMAIL_CLIENT_SECRET: "y" })).toThrow(/missing GMAIL_REFRESH_TOKEN/);
    expect(gmailCredentialsFromEnv(env)).toEqual({ clientId: "cid", clientSecret: "csec", refreshToken: "rtok" });
  });
});

describe("fetchAccessToken", () => {
  it("posts a form-encoded refresh grant and returns the access token", async () => {
    const f = fakeFetch(() => ({ status: 200, body: { access_token: "AT", expires_in: 3599 } }));
    expect(await fetchAccessToken(gmailCredentialsFromEnv(env), f.impl)).toBe("AT");
    const call = f.calls[0]!;
    expect(call.url).toBe("https://oauth2.googleapis.com/token");
    expect(call.init.method).toBe("POST");
    const body = new URLSearchParams(String(call.init.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rtok");
    expect(body.get("client_id")).toBe("cid");
  });
  it("throws a status-only error without echoing secrets", async () => {
    const f = fakeFetch(() => ({ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }));
    await expect(fetchAccessToken(gmailCredentialsFromEnv(env), f.impl)).rejects.toThrow(/gmail token request failed: HTTP 400 invalid_grant/);
    await expect(fetchAccessToken(gmailCredentialsFromEnv(env), f.impl)).rejects.not.toThrow(/rtok|csec/);
  });
});

describe("buildRawMessage", () => {
  it("produces base64url MIME with both parts and the headers", async () => {
    const raw = await buildRawMessage(msg);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toMatch(/^From: jobdigest0@gmail.com/m);
    expect(decoded).toMatch(/^To: a@example.com, b@example.com/m);
    expect(decoded).toMatch(/^Subject: =\?UTF-8\?/m); // non-ASCII subject is RFC 2047 encoded
    expect(decoded).toContain("multipart/alternative");
    expect(decoded).toContain("text/plain");
    expect(decoded).toContain("text/html");
  });
});

describe("createGmailApiMailer", () => {
  it("refreshes, then sends with a bearer token, and returns the gmail id", async () => {
    const f = fakeFetch((url) => url.includes("oauth2") ? { status: 200, body: { access_token: "AT" } } : { status: 200, body: { id: "18f1abc", threadId: "18f1abc" } });
    const res = await createGmailApiMailer(env, f.impl).send(msg);
    expect(res.messageId).toBe("gmail:18f1abc");
    const send = f.calls[1]!;
    expect(send.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect((send.init.headers as Record<string, string>).Authorization).toBe("Bearer AT");
    expect(JSON.parse(String(send.init.body)).raw).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it("throws on a send failure without the token in the message", async () => {
    const f = fakeFetch((url) => url.includes("oauth2") ? { status: 200, body: { access_token: "SECRET-AT" } } : { status: 403, body: { error: { code: 403, message: "Request had insufficient authentication scopes." } } });
    const p = createGmailApiMailer(env, f.impl).send(msg);
    await expect(p).rejects.toThrow(/gmail send failed: HTTP 403 Request had insufficient authentication scopes/);
    await expect(createGmailApiMailer(env, f.impl).send(msg)).rejects.not.toThrow(/SECRET-AT/);
  });
  it("validates env before any network call", () => {
    expect(() => createGmailApiMailer({}, fakeFetch(() => ({ status: 200, body: {} })).impl)).toThrow(/missing GMAIL_CLIENT_ID/);
  });
  it("exports the send scope", () => {
    expect(GMAIL_SEND_SCOPE).toBe("https://www.googleapis.com/auth/gmail.send");
  });
});
