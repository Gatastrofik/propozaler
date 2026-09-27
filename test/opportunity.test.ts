import { describe, it, expect } from "vitest";
import { OpportunitySchema, contentHash, idToFilename, newOpportunity } from "../src/model/opportunity.js";
import { sampleNormalized } from "./helpers.js";

describe("opportunity model", () => {
  it("applies defaults for optional fields", () => {
    const n = sampleNormalized();
    expect(n.naics).toEqual([]);
    expect(n.attachments).toEqual([]);
    expect(n.psc).toBeNull();
    expect(n.estimated_value).toBeNull();
  });

  it("hashes only the fields that matter", () => {
    const a = sampleNormalized();
    const b = sampleNormalized({ contacts: [] });          // not a hash field
    const c = sampleNormalized({ title: "Different" });    // hash field
    expect(contentHash(a)).toBe(contentHash(b));
    expect(contentHash(a)).not.toBe(contentHash(c));
    expect(contentHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("maps ids to filenames", () => {
    expect(idToFilename("crol:20260909003")).toBe("crol__20260909003.json");
  });

  it("builds a stored record with pipeline defaults", () => {
    const o = newOpportunity(sampleNormalized(), "2026-09-27T11:00:00Z");
    expect(o.first_seen_at).toBe("2026-09-27T11:00:00Z");
    expect(o.last_seen_at).toBe("2026-09-27T11:00:00Z");
    expect(o.changes).toEqual([]);
    expect(o.prefilter).toBeNull();
    expect(o.feedback).toBeNull();
    expect(o.digest).toEqual({ sent_in: [], sent_hash: null });
    expect(OpportunitySchema.parse(o)).toEqual(o);
  });

  it("rejects an unknown notice type", () => {
    expect(() => sampleNormalized({ notice_type: "rfq" as never })).toThrow();
  });
});
