import { describe, it, expect } from "vitest";
import { toCsv } from "../src/export/csv.js";
import { newOpportunity } from "../src/model/opportunity.js";
import { sampleNormalized } from "./helpers.js";

describe("toCsv", () => {
  it("quotes fields with commas and quotes", () => {
    const o = newOpportunity(sampleNormalized({ title: 'Say "hi", please' }), "2026-09-27T11:00:00Z");
    o.prefilter = { net_score: 4, matched: ["cat:parks_rec:activity registration", "bonus:home:NY"], stage: "candidate", filters_version: 2 };
    const csv = toCsv([o]);
    const [header, row] = csv.trimEnd().split("\n");
    expect(header).toBe("id,source,notice_type,agency,title,posted_at,due_at,net_score,stage,matched,feedback,sent_in,source_url");
    expect(row).toContain('"Say ""hi"", please"');
    expect(row).toContain("cat:parks_rec:activity registration; bonus:home:NY");
    expect(row?.startsWith("crol:20260909003,crol,solicitation,Brooklyn Bridge Park,")).toBe(true);
  });
});
