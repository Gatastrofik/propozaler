import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/store.js";
import { sampleNormalized } from "./helpers.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "propozaler-store-")); });

describe("Store.upsert", () => {
  it("creates a record file for a new id", () => {
    const s = new Store(dir);
    const { record, isNew, changed } = s.upsert(sampleNormalized(), "2026-09-27T11:00:00Z");
    expect(isNew).toBe(true);
    expect(changed).toEqual([]);
    expect(existsSync(join(dir, "opportunities", "crol__20260909003.json"))).toBe(true);
    expect(s.get(record.id)?.title).toBe(record.title);
  });

  it("is idempotent for identical input and does not rewrite a record seen in the last 7 days", () => {
    const s = new Store(dir);
    s.upsert(sampleNormalized(), "2026-09-27T11:00:00Z");
    const second = s.upsert(sampleNormalized(), "2026-09-28T11:00:00Z");
    expect(second.isNew).toBe(false);
    expect(second.changed).toEqual([]);
    expect(second.record.changes).toEqual([]);
    expect(second.record.first_seen_at).toBe("2026-09-27T11:00:00Z");
    expect(second.record.last_seen_at).toBe("2026-09-27T11:00:00Z"); // unchanged: no write, no git churn
    const third = s.upsert(sampleNormalized(), "2026-10-10T11:00:00Z");
    expect(third.record.last_seen_at).toBe("2026-10-10T11:00:00Z");  // older than 7 days: refreshed
  });

  it("records an amendment when a hash field changes and keeps pipeline fields", () => {
    const s = new Store(dir);
    const first = s.upsert(sampleNormalized(), "2026-09-27T11:00:00Z");
    first.record.prefilter = { net_score: 5, matched: ["cat:parks_rec:recreation software"], stage: "candidate", filters_version: 2 };
    s.save(first.record);
    const second = s.upsert(sampleNormalized({ due_at: "2026-10-30T16:00:00-04:00" }), "2026-09-28T11:00:00Z");
    expect(second.changed).toEqual(["due_at"]);
    expect(second.record.changes).toEqual([{ at: "2026-09-28T11:00:00Z", fields: ["due_at"] }]);
    expect(second.record.prefilter?.net_score).toBe(5);
    expect(second.record.due_at).toBe("2026-10-30T16:00:00-04:00");
  });

  it("does not treat a first description as an amendment", () => {
    const s = new Store(dir);
    s.upsert(sampleNormalized({ description_text: null }), "2026-09-27T11:00:00Z");
    const second = s.upsert(sampleNormalized(), "2026-09-28T11:00:00Z");
    expect(second.changed).toEqual(["description_text"]);
    expect(second.record.changes).toEqual([]);
    expect(second.record.description_text).toContain("Stair remediation");
  });

  it("lists every record", () => {
    const s = new Store(dir);
    s.upsert(sampleNormalized(), "2026-09-27T11:00:00Z");
    s.upsert(sampleNormalized({ id: "crol:2", source_id: "2" }), "2026-09-27T11:00:00Z");
    expect(s.list().map((o) => o.id).sort()).toEqual(["crol:2", "crol:20260909003"]);
  });
});

describe("Store logs and checkpoints", () => {
  it("appends and reads JSONL", () => {
    const s = new Store(dir);
    s.appendJsonl("runs", { a: 1 });
    s.appendJsonl("runs", { a: 2 });
    expect(s.readJsonl<{ a: number }>("runs").map((x) => x.a)).toEqual([1, 2]);
    expect(readFileSync(join(dir, "runs.jsonl"), "utf8").endsWith("\n")).toBe(true);
    expect(s.readJsonl("missing")).toEqual([]);
  });

  it("round-trips a checkpoint", () => {
    const s = new Store(dir);
    expect(s.readCheckpoint("crol")).toBeNull();
    s.writeCheckpoint("crol", { posted_from: "2026-09-27", updated_at: "2026-09-27T11:00:00Z" });
    expect(s.readCheckpoint("crol")).toEqual({ posted_from: "2026-09-27", updated_at: "2026-09-27T11:00:00Z" });
  });
});
