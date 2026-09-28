import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => JSON.parse(readFileSync(join(here, "fixtures", "crol", name), "utf8"));

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "propozaler-cli-"));
  cpSync(join(here, "..", "config"), join(dir, "config"), { recursive: true });
  return dir;
}

const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  const body = url.includes("/columns.json") ? fx("columns.json") : url.includes("$offset=0") ? fx("page-1.json") : fx("page-empty.json");
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

describe("cli", () => {
  it("runs pre, post --no-send, sent, check end to end", async () => {
    const dir = project();
    const out: string[] = [];
    // Fixture rows are posted 2026-09-15/16, so "now" is the following Thursday; a later date would trip the stale-checkpoint check.
    const io = { stdout: (s: string) => out.push(s), fetchImpl: fakeFetch, now: () => new Date("2026-09-17T11:00:00Z") };

    expect(await main(["pre"], {}, dir, io)).toBe(0);
    expect(existsSync(join(dir, "work", "run.json"))).toBe(true);
    expect(existsSync(join(dir, "data", "opportunities", "crol__20260909003.json"))).toBe(true);

    expect(await main(["post", "--no-send"], {}, dir, io)).toBe(0);
    const meta = JSON.parse(readFileSync(join(dir, "work", "digest.meta.json"), "utf8"));
    expect(meta.pending_send).toBe(true);
    expect(meta.digest_id).toBe("2026-09-17");

    expect(await main(["sent", "--digest-id", "2026-09-17", "--message-id", "<x>"], {}, dir, io)).toBe(0);
    const digests = readFileSync(join(dir, "data", "digests.jsonl"), "utf8");
    expect(digests).toContain('"digest_id":"2026-09-17"');

    expect(await main(["check"], {}, dir, io)).toBe(0);
    const runs = readFileSync(join(dir, "data", "runs.jsonl"), "utf8").trim().split("\n");
    expect(runs).toHaveLength(1);
    expect(JSON.parse(runs[0]!).check.ok).toBe(true);
  });

  it("running check twice after one cycle leaves exactly one runs.jsonl line", async () => {
    const dir = project();
    const io = { stdout: () => {}, fetchImpl: fakeFetch, now: () => new Date("2026-09-17T11:00:00Z") };
    await main(["pre"], {}, dir, io);
    await main(["post", "--no-send"], {}, dir, io);
    const meta = JSON.parse(readFileSync(join(dir, "work", "digest.meta.json"), "utf8"));
    await main(["sent", "--digest-id", meta.digest_id, "--message-id", "<x>"], {}, dir, io);

    expect(await main(["check"], {}, dir, io)).toBe(0);
    expect(await main(["check"], {}, dir, io)).toBe(0);
    const runs = readFileSync(join(dir, "data", "runs.jsonl"), "utf8").trim().split("\n");
    expect(runs).toHaveLength(1);
  });

  it("check exits 1 when the digest was expected and not sent", async () => {
    const dir = project();
    const io = { stdout: () => {}, fetchImpl: fakeFetch, now: () => new Date("2026-09-17T11:00:00Z") };
    await main(["pre"], {}, dir, io);
    await main(["post"], { SMTP_USER: "u", SMTP_APP_PASSWORD: "p" }, dir, { ...io, mailerFactory: () => ({ async send() { throw new Error("smtp down"); } }) });
    expect(await main(["check"], {}, dir, io)).toBe(1);
  });

  it("check-env reports names only", async () => {
    // Default transport is gmail_api; the SMTP pair alone is not enough.
    const out: string[] = [];
    const code = await main(["check-env"], { SMTP_USER: "secret@x", SMTP_APP_PASSWORD: "pw" }, project(), { stdout: (s) => out.push(s) });
    expect(code).toBe(1);
    expect(out.join("")).toContain("GMAIL_CLIENT_ID: missing");
    expect(out.join("")).toContain("GMAIL_CLIENT_SECRET: missing");
    expect(out.join("")).toContain("GMAIL_REFRESH_TOKEN: missing");
    expect(out.join("")).not.toContain("secret@x");

    const out2: string[] = [];
    const code2 = await main(
      ["check-env"],
      { GMAIL_CLIENT_ID: "id-value", GMAIL_CLIENT_SECRET: "secret-value", GMAIL_REFRESH_TOKEN: "token-value" },
      project(),
      { stdout: (s) => out2.push(s) },
    );
    expect(code2).toBe(0);
    expect(out2.join("")).toContain("GMAIL_CLIENT_ID: set");
    expect(out2.join("")).toContain("GMAIL_CLIENT_SECRET: set");
    expect(out2.join("")).toContain("GMAIL_REFRESH_TOKEN: set");
    expect(out2.join("")).not.toContain("id-value");
    expect(out2.join("")).not.toContain("secret-value");
    expect(out2.join("")).not.toContain("token-value");

    expect(await main(["check-env"], {}, project(), { stdout: () => {} })).toBe(1);
  });

  it("export csv writes a file", async () => {
    const dir = project();
    const io = { stdout: () => {}, fetchImpl: fakeFetch, now: () => new Date("2026-09-17T11:00:00Z") };
    await main(["pre"], {}, dir, io);
    expect(await main(["export", "csv"], {}, dir, io)).toBe(0);
    expect(readFileSync(join(dir, "work", "opportunities.csv"), "utf8")).toContain("crol:20260909003");
  });

  it("prints usage for unknown commands", async () => {
    const out: string[] = [];
    expect(await main(["bogus"], {}, project(), { stdout: (s) => out.push(s) })).toBe(2);
    expect(out.join("")).toContain("usage");
  });
});
