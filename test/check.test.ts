import { describe, it, expect } from "vitest";
import { evaluateChecks } from "../src/check/check.js";
import type { RunState, SourceRunStats } from "../src/run/state.js";

const sources = { crol: { enabled: true, base_url: "https://x", columns_url: "https://x", limit: 1000, overlap_days: 2, default_from: "2026-09-01", max_checkpoint_age_days: 3 } };

function src(over: Partial<SourceRunStats> = {}): SourceRunStats {
  return { requests: 1, fetched: 5, normalized: 5, skipped: 0, new: 1, changed: 0, candidates: 1, errors: [], partial: false, checkpoint_posted_from: "2026-09-27", http_log: [], ...over };
}
function run(over: Partial<RunState> = {}, s: Partial<SourceRunStats> = {}): RunState {
  return {
    run_id: "r", started_at: "2026-09-28T11:00:00Z", git_sha: null, sources: { crol: src(s) }, pending_count: 0,
    scoring: { status: "not enabled (milestone 1)", imported: 0, carried_over: 0, rejected: 0 },
    digest: { digest_id: "2026-09-28", sent: true, send_expected: true, entries: 1, overflow: 0, message_id: "<m>", error: null },
    warnings: [], finished_at: null, check: null, ...over,
  };
}
const base = { today: "2026-09-28", weekday: true, sources };

describe("evaluateChecks", () => {
  it("passes a healthy run", () => {
    expect(evaluateChecks({ ...base, state: run(), previousRuns: [] })).toEqual({ ok: true, warnings: [], failures: [] });
  });

  it("warns on a single partial and fails on two in a row", () => {
    const one = evaluateChecks({ ...base, state: run({}, { partial: true, errors: ["x"] }), previousRuns: [run()] });
    expect(one.ok).toBe(true);
    expect(one.warnings).toEqual(["crol: partial or errors"]);
    const two = evaluateChecks({ ...base, state: run({}, { partial: true, errors: ["x"] }), previousRuns: [run({}, { partial: true, errors: ["x"] })] });
    expect(two.failures).toEqual(["crol: partial or errors two runs running"]);
  });

  it("warns on zero fetched on a weekday and fails after three", () => {
    const zero = { fetched: 0, normalized: 0, new: 0, candidates: 0 };
    expect(evaluateChecks({ ...base, state: run({}, zero), previousRuns: [] }).warnings).toEqual(["crol: 0 fetched"]);
    expect(evaluateChecks({ ...base, weekday: false, state: run({}, zero), previousRuns: [] }).warnings).toEqual([]);
    const three = evaluateChecks({ ...base, state: run({}, zero), previousRuns: [run({}, zero), run({}, zero)] });
    expect(three.failures).toEqual(["crol: 0 fetched three runs running"]);
  });

  it("warns when nothing has been a candidate for seven runs", () => {
    const none = { candidates: 0 };
    const prev = Array.from({ length: 6 }, () => run({}, none));
    expect(evaluateChecks({ ...base, state: run({}, none), previousRuns: prev }).warnings).toEqual(["crol: no candidates in 7 runs"]);
    expect(evaluateChecks({ ...base, state: run({}, none), previousRuns: prev.slice(1) }).warnings).toEqual([]);
  });

  it("fails when a digest was expected and not sent", () => {
    const r = run({ digest: { digest_id: "2026-09-28", sent: false, send_expected: true, entries: 1, overflow: 0, message_id: null, error: "smtp down" } });
    expect(evaluateChecks({ ...base, state: r, previousRuns: [] }).failures).toEqual(["digest expected but not sent: smtp down"]);
  });

  it("fails on a stale checkpoint but not on a first run without one", () => {
    expect(evaluateChecks({ ...base, state: run({}, { checkpoint_posted_from: "2026-09-20" }), previousRuns: [] }).failures)
      .toEqual(["crol: checkpoint stale (2026-09-20)"]);
    const lenient = { crol: { ...sources.crol, max_checkpoint_age_days: 14 } };
    expect(evaluateChecks({ ...base, sources: lenient, state: run({}, { checkpoint_posted_from: "2026-09-20" }), previousRuns: [] }).failures).toEqual([]);
    expect(evaluateChecks({ ...base, state: run({}, { checkpoint_posted_from: null }), previousRuns: [] }).failures).toEqual([]);
    expect(evaluateChecks({ ...base, state: run({}, { checkpoint_posted_from: null }), previousRuns: [run()] }).failures)
      .toEqual(["crol: checkpoint stale (none)"]);
  });

  it("fails when the digest step did not run on a send day", () => {
    const noDigest = evaluateChecks({ ...base, state: run({ digest: null }), previousRuns: [] });
    expect(noDigest.failures).toContain("digest step did not run");
    const notASendDay = evaluateChecks({ ...base, weekday: false, state: run({ digest: null }), previousRuns: [] });
    expect(notASendDay.failures).toEqual([]);
  });

  it("treats scoring status", () => {
    expect(evaluateChecks({ ...base, state: run({ scoring: { status: "rejected: schema", imported: 0, carried_over: 0, rejected: 1 } }), previousRuns: [] }).failures)
      .toEqual(["scoring rejected: schema"]);
    expect(evaluateChecks({ ...base, state: run({ scoring: { status: "partial", imported: 5, carried_over: 3, rejected: 0 } }), previousRuns: [] }).warnings)
      .toEqual(["scoring partial: 3 carried over"]);
    const both = evaluateChecks({ ...base, state: run({ scoring: { status: "rejected: schema", imported: 0, carried_over: 4, rejected: 1 } }), previousRuns: [] });
    expect(both.failures).toEqual(["scoring rejected: schema"]);
    expect(both.warnings).toEqual(["scoring partial: 4 carried over"]);
  });
});
