import { describe, it, expect } from "vitest";
import { selectDigestEntries, effectiveDue } from "../src/digest/select.js";
import { newOpportunity, type Opportunity, type Prefilter } from "../src/model/opportunity.js";
import { sampleNormalized } from "./helpers.js";

function rec(over: Partial<Opportunity> & { id: string; net?: number; stage?: Prefilter["stage"] }): Opportunity {
  const { net = 5, stage = "candidate", ...rest } = over;
  const base = newOpportunity(sampleNormalized({ id: rest.id, source_id: rest.id.split(":")[1]! }), "2026-09-27T11:00:00Z");
  return { ...base, ...rest, prefilter: { net_score: net, matched: [], stage, filters_version: 2 } };
}

const opts = { today: "2026-09-28", minNetScore: 3, cap: 2, noticeTypes: ["solicitation", "presolicitation", "sources_sought", "combined_synopsis"] as const };

describe("effectiveDue", () => {
  it("prefers the source date, then the extracted date, then null", () => {
    expect(effectiveDue(rec({ id: "crol:1" })).at).toBe("2026-10-05T16:00:00-04:00");
    expect(effectiveDue(rec({ id: "crol:2", due_at: null, due_at_source: null, score: { extracted: { due_at: "2026-11-01T00:00:00-04:00" } } })))
      .toEqual({ at: "2026-11-01T00:00:00-04:00", source: "extracted" });
    expect(effectiveDue(rec({ id: "crol:3", due_at: null, due_at_source: null })).at).toBeNull();
  });
});

describe("selectDigestEntries", () => {
  it("filters, orders, caps, and counts overflow", () => {
    const records = [
      rec({ id: "crol:a", net: 4 }),
      rec({ id: "crol:b", net: 9 }),
      rec({ id: "crol:c", net: 6, due_at: "2026-09-29T00:00:00-04:00" }),
      rec({ id: "crol:d", net: 6, due_at: null, due_at_source: null }),
      rec({ id: "crol:e", net: 2 }),                               // below threshold
      rec({ id: "crol:f", net: 8, stage: "filtered_out" }),        // not a candidate
      rec({ id: "crol:g", net: 8, notice_type: "award" }),         // wrong type
      rec({ id: "crol:h", net: 8, due_at: "2026-09-20T00:00:00-04:00" }), // past due
      rec({ id: "crol:i", net: 8, feedback: { decision: "ignored", at: "x", by: "sheet" } }),
    ];
    const { entries, overflow } = selectDigestEntries(records, { ...opts, cap: 10 });
    expect(entries.map((e) => e.id)).toEqual(["crol:b", "crol:c", "crol:d", "crol:a"]);
    expect(overflow).toBe(0);
    const capped = selectDigestEntries(records, opts);
    expect(capped.entries.map((e) => e.id)).toEqual(["crol:b", "crol:c"]);
    expect(capped.overflow).toBe(2);
  });

  it("excludes already-sent records unless they changed", () => {
    const sent = rec({ id: "crol:s", digest: { sent_in: ["2026-09-26"], sent_hash: "same" }, content_hash: "same" });
    const changed = rec({ id: "crol:t", digest: { sent_in: ["2026-09-26"], sent_hash: "old" }, content_hash: "new" });
    const { entries } = selectDigestEntries([sent, changed], opts);
    expect(entries.map((e) => e.id)).toEqual(["crol:t"]);
  });
});
