import { describe, it, expect } from "vitest";
import { escapeHtml, formatDue, summaryOf, renderDigest, type DigestModel } from "../src/digest/render.js";
import { newOpportunity } from "../src/model/opportunity.js";
import { sampleNormalized } from "./helpers.js";

const base = newOpportunity(sampleNormalized({ title: "Fire <b>scheduling</b> & rostering" }), "2026-09-27T11:00:00Z");
base.prefilter = { net_score: 6, matched: ["cat:fire_ems_scheduling:shift scheduling", "bonus:home:NY"], stage: "candidate", filters_version: 2 };

const health = {
  sources: [{ name: "crol", fetched: 12, candidates: 3, scored: 0, new: 2, status: "ok" as const }],
  scoring: "not enabled (milestone 1)", durationMs: 4200, criteriaVersion: null,
};

function model(over: Partial<DigestModel> = {}): DigestModel {
  return { date: "2026-09-28", subjectPrefix: "propozaler", sheetUrl: null, entries: [{ entryId: "2026-09-28-01", record: base }], overflow: 0, dueSoon: [], health, minScore: 3, ...over };
}

describe("escapeHtml", () => {
  it("escapes the five characters", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });
});

describe("formatDue", () => {
  it("labels CROL dates and counts days", () => {
    expect(formatDue(base, "2026-09-28")).toBe("due Mon Oct 5 (7 days) per City Record; confirm in PASSPort (PIN BBP Pier 1 Pavilion)");
  });
  it("says when a date is missing", () => {
    expect(formatDue({ ...base, due_at: null, due_at_source: null }, "2026-09-28")).toBe("due date not stated");
  });
});

describe("summaryOf", () => {
  it("truncates the description to 200 characters", () => {
    const long = { ...base, description_text: "x".repeat(300) };
    expect(summaryOf(long)).toHaveLength(201); // 200 + ellipsis
    expect(summaryOf({ ...base, description_text: null })).toBe("(no description in the notice)");
  });
});

describe("renderDigest", () => {
  it("renders subject, escaped html, and plain text", () => {
    const out = renderDigest(model());
    expect(out.subject).toBe("propozaler 2026-09-28: 1 new · CROL ok");
    expect(out.html).toContain("Fire &lt;b&gt;scheduling&lt;/b&gt; &amp; rostering");
    expect(out.html).not.toContain("<b>scheduling</b>");
    expect(out.html).toContain('href="https://a856-cityrecord.nyc.gov/RequestDetail/20260909003"');
    expect(out.html).toContain("per City Record; confirm in PASSPort");
    expect(out.html).toContain("matched: shift scheduling, home NY");
    expect(out.html).toContain("crol 12 / 3 / 0 / 2");
    expect(out.text).toContain("1. Fire <b>scheduling</b> & rostering");
    expect(out.text).toContain("https://a856-cityrecord.nyc.gov/RequestDetail/20260909003");
  });

  it("renders the empty case and health warnings in the subject", () => {
    const out = renderDigest(model({ entries: [], health: { ...health, sources: [{ ...health.sources[0]!, fetched: 0, status: "warn", note: "0 fetched" }] } }));
    expect(out.subject).toBe("propozaler 2026-09-28: nothing new · CROL 0 fetched ⚠");
    expect(out.text).toContain("Nothing new today.");
  });

  it("mentions overflow", () => {
    const out = renderDigest(model({ overflow: 7 }));
    expect(out.text).toContain("7 more scored 3+ today; they carry over.");
  });
});
