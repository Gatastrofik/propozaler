import { describe, it, expect } from "vitest";
import { createHttpClient, redactUrl, HttpError } from "../src/sources/http.js";

function fakeFetch(responses: Array<{ status: number; body: unknown } | Error>) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

const noSleep = async () => {};

describe("createHttpClient", () => {
  it("returns parsed JSON and logs the request", async () => {
    const f = fakeFetch([{ status: 200, body: { ok: 1 } }]);
    const http = createHttpClient({ fetchImpl: f.impl, sleep: noSleep });
    expect(await http.getJson("https://x.test/a?api_key=SECRET")).toEqual({ ok: 1 });
    expect(http.log).toHaveLength(1);
    expect(http.log[0]?.status).toBe(200);
    expect(http.log[0]?.url).toBe("https://x.test/a?api_key=REDACTED");
  });

  it("retries 5xx then succeeds", async () => {
    const f = fakeFetch([{ status: 503, body: {} }, { status: 200, body: { ok: 2 } }]);
    const http = createHttpClient({ fetchImpl: f.impl, sleep: noSleep });
    expect(await http.getJson("https://x.test/b")).toEqual({ ok: 2 });
    expect(f.calls).toHaveLength(2);
    expect(http.log).toHaveLength(2);
  });

  it("does not retry 429 by default and throws HttpError", async () => {
    const f = fakeFetch([{ status: 429, body: { error: "OVER_RATE_LIMIT" } }]);
    const http = createHttpClient({ fetchImpl: f.impl, sleep: noSleep });
    await expect(http.getJson("https://x.test/c")).rejects.toBeInstanceOf(HttpError);
    expect(f.calls).toHaveLength(1);
  });

  it("gives up after maxRetries on network errors", async () => {
    const f = fakeFetch([new Error("ECONNRESET"), new Error("ECONNRESET"), new Error("ECONNRESET")]);
    const http = createHttpClient({ fetchImpl: f.impl, sleep: noSleep, maxRetries: 2 });
    await expect(http.getJson("https://x.test/d")).rejects.toThrow(/ECONNRESET/);
    expect(f.calls).toHaveLength(3);
    expect(http.log.at(-1)?.error).toMatch(/ECONNRESET/);
  });

  it("does not log header values", async () => {
    const f = fakeFetch([{ status: 200, body: {} }]);
    const http = createHttpClient({ fetchImpl: f.impl, sleep: noSleep, defaultHeaders: { "X-App-Token": "TOKEN" } });
    await http.getJson("https://x.test/e");
    expect(JSON.stringify(http.log)).not.toContain("TOKEN");
  });
});

describe("redactUrl", () => {
  it("replaces listed query values only", () => {
    expect(redactUrl("https://x.test/?a=1&api_key=k&$$app_token=t", ["api_key", "$$app_token"]))
      .toBe("https://x.test/?a=1&api_key=REDACTED&%24%24app_token=REDACTED");
  });
});
