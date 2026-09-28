import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig, RecipientsConfigSchema } from "../src/config.js";

const configDir = join(dirname(fileURLToPath(import.meta.url)), "..", "config");

const baseRecipients = { from: "d@example.com", to: ["a@example.com"], send_days: ["Mon"] };

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
    // config/recipients.yaml is on the interim connector transport until a verified domain lets the
    // Gmail OAuth app publish; see SPEC.md 2.5.
    expect(c.recipients.transport).toBe("connector");
  });

  it("fails loudly on a missing file", () => {
    expect(() => loadConfig(join(configDir, "nope"))).toThrow(/ENOENT|no such file/);
  });
});

describe("RecipientsConfigSchema.transport", () => {
  it("defaults to gmail_api when omitted", () => {
    expect(RecipientsConfigSchema.parse(baseRecipients).transport).toBe("gmail_api");
  });

  it("accepts smtp", () => {
    expect(RecipientsConfigSchema.parse({ ...baseRecipients, transport: "smtp" }).transport).toBe("smtp");
  });

  it("accepts connector", () => {
    expect(RecipientsConfigSchema.parse({ ...baseRecipients, transport: "connector" }).transport).toBe("connector");
  });

  it("rejects an unknown transport", () => {
    expect(RecipientsConfigSchema.safeParse({ ...baseRecipients, transport: "carrier_pigeon" }).success).toBe(false);
  });
});
