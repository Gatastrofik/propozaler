import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildCrolUrl, missingCrolColumns, normalizeCrolRow, crolAdapter, CROL_COLUMNS } from "../src/sources/crol.js";
import type { FetchContext, HttpClient } from "../src/sources/types.js";
import { NOW } from "./helpers.js";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/crol/${name}`, import.meta.url), "utf8"));

function fakeHttp(routes: Array<(url: string) => unknown | undefined>): HttpClient & { urls: string[] } {
  const urls: string[] = [];
  return {
    log: [],
    urls,
    async getJson<T>(url: string): Promise<T> {
      urls.push(url);
      for (const r of routes) { const v = r(url); if (v !== undefined) return v as T; }
      throw new Error(`unrouted ${url}`);
    },
  };
}

function ctx(http: HttpClient, over: Partial<FetchContext> = {}): FetchContext {
  return {
    config: { default_from: "2026-09-01", limit: 1000, overlap_days: 2 },
    checkpoint: null,
    now: new Date("2026-09-27T11:00:00Z"),
    http,
    secrets: () => undefined,
    rawSink: () => {},
    ...over,
  };
}

describe("buildCrolUrl", () => {
  it("builds the SoQL query", () => {
    const u = new URL(buildCrolUrl("https://data.cityofnewyork.us/resource/dg92-zbpx.json", "2026-09-13", 1000, 2000));
    expect(u.searchParams.get("$where")).toBe(
      "section_name='Procurement' AND start_date >= '2026-09-13T00:00:00' AND type_of_notice_description in('Solicitation','Intent to Award','Award')",
    );
    expect(u.searchParams.get("$order")).toBe("start_date ASC, request_id ASC");
    expect(u.searchParams.get("$limit")).toBe("1000");
    expect(u.searchParams.get("$offset")).toBe("2000");
  });
});

describe("missingCrolColumns", () => {
  it("is empty for the verified column list", () => {
    expect(missingCrolColumns(fx("columns.json"))).toEqual([]);
    expect(CROL_COLUMNS).toHaveLength(20);
  });
  it("names a renamed column", () => {
    const cols = (fx("columns.json") as Array<{ fieldName: string }>).filter((c) => c.fieldName !== "short_title");
    expect(missingCrolColumns(cols)).toEqual(["short_title"]);
  });
});

describe("normalizeCrolRow", () => {
  const rows = fx("page-1.json") as Record<string, unknown>[];

  it("normalizes a solicitation", () => {
    const n = normalizeCrolRow(rows[0]!, NOW)!;
    expect(n.id).toBe("crol:20260909003");
    expect(n.source_url).toBe("https://a856-cityrecord.nyc.gov/RequestDetail/20260909003");
    expect(n.notice_type).toBe("solicitation");
    expect(n.buyer_level).toBe("authority");
    expect(n.agency_path).toBe("City of New York > Brooklyn Bridge Park");
    expect(n.place).toEqual({ state: "NY", city: "New York", zip: null });
    expect(n.posted_at).toBe("2026-09-15");
    expect(n.due_at).toBe("2026-10-05T16:00:00-04:00");
    expect(n.due_at_source).toBe("crol");
    expect(n.solicitation_number).toBe("BBP Pier 1 Pavilion");
    expect(n.contacts).toEqual([{ name: "John Zhang", email: "proposals@bbp.nyc" }]); // placeholder phone dropped
    expect(n.description_text).toBe("Stair remediation work at the Pier 1 pavilion, including demolition of the existing stair.");
    expect(n.description_fetched_at).toBe(NOW);
  });

  it("joins description parts and keeps a real phone", () => {
    const n = normalizeCrolRow(rows[1]!, NOW)!;
    expect(n.buyer_level).toBe("authority");
    expect(n.description_text).toBe("NYCHA seeks a construction manager. A proposers conference will be held on October 1.\n\nSubmission requirements are in the RFP package.");
    expect(n.contacts[0]?.phone).toBe("(212) 306-4512");
  });

  it("normalizes an award with a value and no due date", () => {
    const n = normalizeCrolRow(rows[2]!, NOW)!;
    expect(n.notice_type).toBe("award");
    expect(n.buyer_level).toBe("city");
    expect(n.estimated_value).toBe(47098);
    expect(n.due_at).toBeNull();
  });

  it("returns null for a row without an id or title", () => {
    expect(normalizeCrolRow({ short_title: "x" }, NOW)).toBeNull();
    expect(normalizeCrolRow({ request_id: "1" }, NOW)).toBeNull();
  });
});

describe("crolAdapter.fetch", () => {
  it("checks columns, pages until a short page, and advances the checkpoint", async () => {
    const http = fakeHttp([
      (u) => (u.includes("/columns.json") ? fx("columns.json") : undefined),
      (u) => (u.includes("$offset=0") ? fx("page-1.json") : undefined),
      (u) => (u.includes("$offset=3") ? fx("page-empty.json") : undefined),
    ]);
    const res = await crolAdapter.fetch(ctx(http, { config: { default_from: "2026-09-01", limit: 3, overlap_days: 2 } }));
    expect(res.partial).toBe(false);
    expect(res.records).toHaveLength(3);
    expect(res.stats).toMatchObject({ requests: 3, fetched: 3, normalized: 3, skipped: 0, errors: [] });
    expect(res.checkpoint.posted_from).toBe("2026-09-16");
    expect(http.urls[1]).toContain("start_date%20%3E%3D%20%272026-08-30T00%3A00%3A00%27"); // default_from minus overlap
  });

  it("uses the checkpoint minus overlap and keeps it on failure", async () => {
    const http = fakeHttp([
      (u) => (u.includes("/columns.json") ? fx("columns.json") : undefined),
      (u) => { if (u.includes("$offset=0")) throw new Error("boom"); return undefined; },
    ]);
    const cp = { posted_from: "2026-09-20", updated_at: "2026-09-26T11:00:00Z" };
    const res = await crolAdapter.fetch(ctx(http, { checkpoint: cp }));
    expect(res.partial).toBe(true);
    expect(res.checkpoint).toEqual(cp);
    expect(res.stats.errors[0]).toMatch(/boom/);
    expect(http.urls[1]).toContain("2026-09-18T00");
  });

  it("reports a missing column as an error but still fetches", async () => {
    const cols = (fx("columns.json") as Array<{ fieldName: string }>).filter((c) => c.fieldName !== "pin");
    const http = fakeHttp([
      (u) => (u.includes("/columns.json") ? cols : undefined),
      (u) => (u.includes("$offset=0") ? fx("page-empty.json") : undefined),
    ]);
    const res = await crolAdapter.fetch(ctx(http));
    expect(res.stats.errors).toEqual(["crol columns missing: pin"]);
    expect(res.partial).toBe(false);
  });

  it("sends the app token header when the secret exists", async () => {
    const seen: Record<string, string>[] = [];
    const http: HttpClient = {
      log: [],
      async getJson<T>(url: string, init?: { headers?: Record<string, string> }): Promise<T> {
        seen.push(init?.headers ?? {});
        return (url.includes("/columns.json") ? fx("columns.json") : fx("page-empty.json")) as T;
      },
    };
    await crolAdapter.fetch(ctx(http, { secrets: (n) => (n === "SOCRATA_APP_TOKEN" ? "tok" : undefined) }));
    expect(seen.every((h) => h["X-App-Token"] === "tok")).toBe(true);
  });
});
