import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/config.js";

const configDir = join(dirname(fileURLToPath(import.meta.url)), "..", "config");

describe("loadConfig", () => {
  it("loads all three files with defaults applied", () => {
    const c = loadConfig(configDir);
    expect(c.filters.version).toBe(2);
    expect(c.sources.crol.limit).toBe(1000);
    expect(c.sources.crol.default_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(c.sources.crol.max_checkpoint_age_days).toBe(14);
    expect(c.recipients.cap).toBe(10);
    expect(c.recipients.send_days).toContain("Mon");
    expect(c.recipients.to.length).toBeGreaterThan(0);
    expect(c.recipients.transport).toBe("gmail_api");
  });

  it("fails loudly on a missing file", () => {
    expect(() => loadConfig(join(configDir, "nope"))).toThrow(/ENOENT|no such file/);
  });
});
