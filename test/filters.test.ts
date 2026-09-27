import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { termRegex, selectOpportunity, loadFilters } from "../src/select/filters.js";
import { sampleNormalized } from "./helpers.js";

const filters = loadFilters(readFileSync(new URL("../config/filters.yaml", import.meta.url), "utf8"));

describe("termRegex", () => {
  it("matches whole words only, case-insensitively", () => {
    expect(termRegex("roster", false).test("Crew roster software")).toBe(true);
    expect(termRegex("roster", false).test("ROSTER")).toBe(true);
    expect(termRegex("roster", false).test("rostering")).toBe(false);
  });
  it("does not match inside other words", () => {
    expect(termRegex("ESO", true).test("human resources")).toBe(false);
    expect(termRegex("ESO", true).test("the ESO platform")).toBe(true);
    expect(termRegex("Cooper test", false).test("cooperative purchasing")).toBe(false);
  });
  it("is case-sensitive when asked", () => {
    expect(termRegex("ESO", true).test("eso")).toBe(false);
  });
  it("matches phrases across flexible whitespace and hyphens as typed", () => {
    expect(termRegex("shift scheduling", false).test("Shift\n scheduling system")).toBe(true);
    expect(termRegex("off-duty", false).test("Off-Duty details")).toBe(true);
  });
});

describe("selectOpportunity", () => {
  it("makes a candidate on a strong category term", () => {
    const p = selectOpportunity(sampleNormalized({
      title: "Fire Department shift scheduling software", category_raw: "Services (other than human services)",
      description_text: "Replace the spreadsheet platoon schedule.",
    }), filters);
    expect(p.stage).toBe("candidate");
    expect(p.matched).toContain("cat:fire_ems_scheduling:shift scheduling");
    expect(p.matched).toContain("bonus:home:NY");
    expect(p.matched).toContain("bonus:software:software");
    expect(p.net_score).toBe(3 + 2 + 1);
    expect(p.filters_version).toBe(2);
  });

  it("never makes a candidate from bonuses alone", () => {
    const p = selectOpportunity(sampleNormalized({
      title: "Citywide software licensing", category_raw: "Goods", description_text: "Software subscription renewal.",
    }), filters);
    expect(p.stage).toBe("filtered_out");
    expect(p.matched.some((m) => m.startsWith("cat:"))).toBe(false);
  });

  it("requires context for weak terms", () => {
    const noCtx = selectOpportunity(sampleNormalized({ title: "Volunteer roster printing", category_raw: "Goods", description_text: null }), filters);
    expect(noCtx.stage).toBe("filtered_out");
    const ctx = selectOpportunity(sampleNormalized({ title: "Roster management for the Fire Department", category_raw: "Goods", description_text: null }), filters);
    expect(ctx.stage).toBe("candidate");
    expect(ctx.matched).toContain("cat:fire_ems_scheduling:weak:roster+fire");
  });

  it("matches vendors case-sensitively", () => {
    const hit = selectOpportunity(sampleNormalized({ title: "Renewal of Telestaff licenses", category_raw: "Goods", description_text: null }), filters);
    expect(hit.matched).toContain("cat:fire_ems_scheduling:vendor:Telestaff");
    const miss = selectOpportunity(sampleNormalized({ title: "eso equipment", category_raw: "Goods", description_text: null }), filters);
    expect(miss.stage).toBe("filtered_out");
  });

  it("hard-excludes construction even with a category hit", () => {
    const p = selectOpportunity(sampleNormalized({
      title: "Recreation center HVAC and activity registration kiosk", category_raw: "Construction/Construction Services",
    }), filters);
    expect(p.stage).toBe("filtered_out");
    expect(p.matched).toContain("exclude:category:Construction/Construction Services");
    expect(p.matched).toContain("exclude:title:HVAC");
  });

  it("applies the federal penalty and caps software signals at two", () => {
    const p = selectOpportunity(sampleNormalized({
      title: "Recreation management software platform subscription", category_raw: null, buyer_level: "federal",
      place: { state: "VA", city: null, zip: null }, description_text: "cloud-based SaaS module",
    }), filters);
    expect(p.stage).toBe("candidate");
    expect(p.matched).toContain("penalty:federal");
    expect(p.matched.filter((m) => m.startsWith("bonus:software:"))).toHaveLength(2);
    expect(p.net_score).toBe(3 - 1 + 2);
  });

  it("adds the code bonus once", () => {
    const p = selectOpportunity(sampleNormalized({
      title: "Physical fitness test administration software", category_raw: null, naics: ["513210", "541511"], psc: "DA01",
    }), filters);
    expect(p.matched.filter((m) => m.startsWith("bonus:code:"))).toHaveLength(1);
  });
});
