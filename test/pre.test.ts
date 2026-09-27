import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPre } from "../src/run/pre.js";
import { readRunState } from "../src/run/state.js";
import { Store } from "../src/store/store.js";
import { loadFilters } from "../src/select/filters.js";
import type { SourceAdapter, FetchResult } from "../src/sources/types.js";
import { sampleNormalized } from "./helpers.js";

const filters = loadFilters(readFileSync(new URL("../config/filters.yaml", import.meta.url), "utf8"));
const sources = { crol: { enabled: true, base_url: "https://x.test/r.json", columns_url: "https://x.test/c.json", limit: 1000, overlap_days: 2, default_from: "2026-09-01", max_checkpoint_age_days: 14 } };

function adapter(result: FetchResult | Error): SourceAdapter {
  return { name: "crol", async fetch() { if (result instanceof Error) throw result; return result; } };
}

function deps(dir: string, a: SourceAdapter) {
  return { store: new Store(join(dir, "data")), adapters: [a], sources, filters, now: new Date("2026-09-27T11:00:00Z"), workDir: join(dir, "work"), env: {}, gitSha: "abc123" };
}

describe("runPre", () => {
  it("ingests, selects, checkpoints, and writes run.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "propozaler-pre-"));
    const rec = sampleNormalized({ title: "Fire Department shift scheduling software", category_raw: "Services (other than human services)" });
    const a = adapter({ records: [rec], checkpoint: { posted_from: "2026-09-15", updated_at: "now" }, stats: { requests: 2, fetched: 1, normalized: 1, skipped: 0, errors: [] }, partial: false });
    const d = deps(dir, a);
    const state = await runPre(d);
    expect(state.sources.crol).toMatchObject({ fetched: 1, new: 1, changed: 0, candidates: 1, partial: false, checkpoint_posted_from: "2026-09-15" });
    expect(d.store.readCheckpoint("crol")?.posted_from).toBe("2026-09-15");
    expect(d.store.get(rec.id)?.prefilter?.stage).toBe("candidate");
    expect(readRunState(d.workDir).run_id).toBe(state.run_id);
    expect(existsSync(join(d.workDir, "pending"))).toBe(true);
  });

  it("keeps the old checkpoint on a partial fetch and still stores records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "propozaler-pre-"));
    const d0 = deps(dir, adapter(new Error("unused")));
    d0.store.writeCheckpoint("crol", { posted_from: "2026-09-10", updated_at: "x" });
    const a = adapter({ records: [sampleNormalized()], checkpoint: { posted_from: "2026-09-10", updated_at: "x" }, stats: { requests: 1, fetched: 1, normalized: 1, skipped: 0, errors: ["page 1 failed"] }, partial: true });
    const state = await runPre(deps(dir, a));
    expect(state.sources.crol.partial).toBe(true);
    expect(state.sources.crol.errors).toEqual(["page 1 failed"]);
    expect(d0.store.readCheckpoint("crol")?.posted_from).toBe("2026-09-10");
    expect(d0.store.list()).toHaveLength(1);
  });

  it("survives an adapter that throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "propozaler-pre-"));
    const state = await runPre(deps(dir, adapter(new Error("network down"))));
    expect(state.sources.crol.partial).toBe(true);
    expect(state.sources.crol.errors[0]).toMatch(/network down/);
    expect(state.sources.crol.fetched).toBe(0);
  });

  it("skips disabled sources", async () => {
    const dir = mkdtempSync(join(tmpdir(), "propozaler-pre-"));
    const d = { ...deps(dir, adapter(new Error("should not run"))), sources: { crol: { ...sources.crol, enabled: false } } };
    const state = await runPre(d);
    expect(state.sources.crol).toBeUndefined();
    expect(state.warnings).toContain("source crol disabled");
  });
});
