import { describe, it, expect } from "vitest";
import { newYorkOffset, fromNewYorkLocal, datePart, todayNewYork, weekdayNewYork, addDays } from "../src/model/time.js";

describe("time", () => {
  it("knows the New York offset in summer and winter", () => {
    expect(newYorkOffset(new Date("2026-07-01T12:00:00Z"))).toBe("-04:00");
    expect(newYorkOffset(new Date("2026-01-15T12:00:00Z"))).toBe("-05:00");
  });

  it("converts Socrata local datetimes to ISO with offset", () => {
    expect(fromNewYorkLocal("2026-09-15T00:00:00.000")).toBe("2026-09-15T00:00:00-04:00");
    expect(fromNewYorkLocal("2026-10-05T16:00:00.000")).toBe("2026-10-05T16:00:00-04:00");
    expect(fromNewYorkLocal("2026-12-01")).toBe("2026-12-01T00:00:00-05:00");
    // Transition days: hours after the switch must carry the new offset.
    expect(fromNewYorkLocal("2026-03-08T03:30:00")).toBe("2026-03-08T03:30:00-04:00");
    expect(fromNewYorkLocal("2026-03-08T06:00:00")).toBe("2026-03-08T06:00:00-04:00");
    expect(fromNewYorkLocal("2026-11-01T03:30:00")).toBe("2026-11-01T03:30:00-05:00");
    expect(fromNewYorkLocal("2026-11-01T00:30:00")).toBe("2026-11-01T00:30:00-04:00");
  });

  it("rejects garbage", () => {
    expect(() => fromNewYorkLocal("yesterday")).toThrow(/bad local datetime/);
  });

  it("takes the date part", () => {
    expect(datePart("2026-09-15T00:00:00.000")).toBe("2026-09-15");
  });

  it("reports today and weekday in New York", () => {
    // 2026-09-27 is a Sunday. 03:00Z on the 28th is still Sunday 23:00 in New York.
    const late = new Date("2026-09-28T03:00:00Z");
    expect(todayNewYork(late)).toBe("2026-09-27");
    expect(weekdayNewYork(late)).toBe("Sun");
    const morning = new Date("2026-09-28T11:00:00Z");
    expect(todayNewYork(morning)).toBe("2026-09-28");
    expect(weekdayNewYork(morning)).toBe("Mon");
  });

  it("adds days across month ends", () => {
    expect(addDays("2026-09-30", 2)).toBe("2026-10-02");
    expect(addDays("2026-03-01", -2)).toBe("2026-02-27");
  });
});
