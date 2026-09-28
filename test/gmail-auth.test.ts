import { createServer } from "node:http";
import { describe, it, expect } from "vitest";
import { consentUrl, exchangeCode, runGmailAuth, classifyCallback } from "../src/digest/gmail-auth.js";

function fakeFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; body: string }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

describe("consentUrl", () => {
  it("builds the offline consent URL", () => {
    const u = new URL(consentUrl("cid", "http://127.0.0.1:4321/", ["https://www.googleapis.com/auth/gmail.send"]));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:4321/");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.send");
  });
});

describe("exchangeCode", () => {
  it("posts the authorization code and returns the refresh token", async () => {
    const f = fakeFetch({ access_token: "AT", refresh_token: "RT" });
    const r = await exchangeCode({ clientId: "cid", clientSecret: "csec" }, "thecode", "http://127.0.0.1:1/", f.impl);
    expect(r.refresh_token).toBe("RT");
    const body = new URLSearchParams(f.calls[0]!.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("thecode");
    expect(body.get("redirect_uri")).toBe("http://127.0.0.1:1/");
  });
  it("fails clearly when Google returns no refresh token", async () => {
    const f = fakeFetch({ access_token: "AT" });
    await expect(exchangeCode({ clientId: "cid", clientSecret: "csec" }, "c", "http://127.0.0.1:1/", f.impl)).rejects.toThrow(/no refresh_token in response/);
  });
});

describe("classifyCallback", () => {
  it("returns the code on a successful callback", () => {
    expect(classifyCallback("/?code=abc")).toEqual({ kind: "code", code: "abc" });
  });
  it("returns the error on a denied callback", () => {
    const outcome = classifyCallback("/?error=access_denied");
    expect(outcome.kind).toBe("error");
    expect((outcome as { error: string }).error).toBe("access_denied");
    expect((outcome as { status: number }).status).toBe(400);
  });
  it("ignores requests with neither code nor error", () => {
    const outcome = classifyCallback("/favicon.ico");
    expect(outcome.kind).toBe("ignore");
    expect((outcome as { status: number }).status).toBe(404);
  });
});

async function loopbackAllowed(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(0, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}
const canBind = await loopbackAllowed();

describe("runGmailAuth (real loopback server)", () => {
  it.skipIf(!canBind)("prints the consent URL, accepts the loopback callback, and resolves the refresh token", async () => {
    const printed: string[] = [];
    const f = fakeFetch({ access_token: "AT", refresh_token: "RT-from-flow" });
    const pending = runGmailAuth({ clientId: "cid", clientSecret: "csec", scopes: ["s1"], fetchImpl: f.impl, out: (s) => printed.push(s) });
    // wait for the server to announce its URL
    let url = "";
    for (let i = 0; i < 50 && !url; i += 1) { await new Promise((r) => setTimeout(r, 10)); url = printed.join("\n").match(/redirect_uri=([^&\s]+)/)?.[1] ?? ""; }
    const redirect = decodeURIComponent(url);
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const res = await fetch(`${redirect}?code=abc123`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("You can close this tab");
    expect(await pending).toBe("RT-from-flow");
    expect(printed.join("\n")).not.toContain("RT-from-flow"); // the token is returned, not printed by the flow itself
  });
  it.skipIf(!canBind)("rejects when the callback carries an error", async () => {
    const printed: string[] = [];
    const pending = runGmailAuth({ clientId: "cid", clientSecret: "csec", scopes: ["s1"], fetchImpl: fakeFetch({}).impl, out: (s) => printed.push(s) });
    let url = "";
    for (let i = 0; i < 50 && !url; i += 1) { await new Promise((r) => setTimeout(r, 10)); url = printed.join("\n").match(/redirect_uri=([^&\s]+)/)?.[1] ?? ""; }
    await fetch(`${decodeURIComponent(url)}?error=access_denied`);
    await expect(pending).rejects.toThrow(/access_denied/);
  });
});
