import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPost, nextDigestId } from "../src/run/post.js";
import { writeRunState, readRunState } from "../src/run/state.js";
import { Store } from "../src/store/store.js";
import { loadFilters } from "../src/select/filters.js";
import type { Mailer, MailMessage } from "../src/digest/mailer.js";
import type { RecipientsConfig } from "../src/config.js";
import { sampleNormalized } from "./helpers.js";

const filters = loadFilters(readFileSync(new URL("../config/filters.yaml", import.meta.url), "utf8"));
const recipients: RecipientsConfig = { from: "d@example.com", to: ["a@example.com", "b@example.com"], send_days: ["Mon", "Tue", "Wed", "Thu", "Fri"], cap: 10, min_net_score: 3, sheet_url: null, subject_prefix: "propozaler" };
const monday = new Date("2026-09-28T11:00:00Z");
const sunday = new Date("2026-09-27T11:00:00Z");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "propozaler-post-"));
  const store = new Store(join(dir, "data"));
  const workDir = join(dir, "work");
  const { record } = store.upsert(sampleNormalized({ title: "Fire Department shift scheduling software", category_raw: "Services (other than human services)" }), "2026-09-27T11:00:00Z");
  record.prefilter = { net_score: 6, matched: ["cat:fire_ems_scheduling:shift scheduling"], stage: "candidate", filters_version: 2 };
  store.save(record);
  writeRunState(workDir, {
    run_id: "r1", started_at: "2026-09-28T11:00:00Z", git_sha: null,
    sources: { crol: { requests: 2, fetched: 5, normalized: 5, skipped: 0, new: 1, changed: 0, candidates: 1, errors: [], partial: false, checkpoint_posted_from: "2026-09-27", http_log: [] } },
    pending_count: 0, scoring: { status: "not enabled (milestone 1)", imported: 0, carried_over: 0, rejected: 0 },
    digest: null, warnings: [], finished_at: null, check: null,
  });
  return { dir, store, workDir, record };
}

function capturingMailer(fail = false): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return { sent, async send(m) { if (fail) throw new Error("smtp down"); sent.push(m); return { messageId: "<m1>" }; } };
}

describe("nextDigestId", () => {
  it("suffixes repeats on the same day", () => {
    expect(nextDigestId([], "2026-09-28")).toBe("2026-09-28");
    expect(nextDigestId(["2026-09-28"], "2026-09-28")).toBe("2026-09-28b");
    expect(nextDigestId(["2026-09-28", "2026-09-28b"], "2026-09-28")).toBe("2026-09-28c");
  });
});

describe("runPost", () => {
  it("sends on a weekday and marks entries sent", async () => {
    const { store, workDir, record } = setup();
    const mailer = capturingMailer();
    const res = await runPost({ store, recipients, filters, now: monday, workDir, mailer });
    expect(res).toMatchObject({ send_expected: true, sent: true, digest_id: "2026-09-28", entries: 1, overflow: 0, message_id: "<m1>" });
    expect(mailer.sent[0]?.to).toEqual(["a@example.com", "b@example.com"]);
    expect(mailer.sent[0]?.subject).toBe("propozaler 2026-09-28: 1 new · CROL ok");
    expect(store.get(record.id)?.digest).toEqual({ sent_in: ["2026-09-28"], sent_hash: record.content_hash });
    expect(store.readJsonl<{ digest_id: string }>("digests")[0]?.digest_id).toBe("2026-09-28");
    expect(existsSync(join(workDir, "digest.html"))).toBe(true);
    expect(readRunState(workDir).digest?.sent).toBe(true);
  });

  it("builds but does not send or allocate on a weekend", async () => {
    const { store, workDir, record } = setup();
    const mailer = capturingMailer();
    const res = await runPost({ store, recipients, filters, now: sunday, workDir, mailer });
    expect(res.send_expected).toBe(false);
    expect(res.sent).toBe(false);
    expect(res.digest_id).toBeNull();
    expect(mailer.sent).toHaveLength(0);
    expect(store.get(record.id)?.digest.sent_in).toEqual([]);
    expect(existsSync(join(workDir, "digest.html"))).toBe(true);
  });

  it("records the error and marks nothing when SMTP fails", async () => {
    const { store, workDir, record } = setup();
    const res = await runPost({ store, recipients, filters, now: monday, workDir, mailer: capturingMailer(true) });
    expect(res.sent).toBe(false);
    expect(res.error).toMatch(/smtp down/);
    expect(store.get(record.id)?.digest.sent_in).toEqual([]);
    expect(store.readJsonl("digests")).toHaveLength(0);
    expect(readRunState(workDir).digest?.error).toMatch(/smtp down/);
  });

  it("with no mailer, leaves a pending send in the meta file", async () => {
    const { store, workDir } = setup();
    const res = await runPost({ store, recipients, filters, now: monday, workDir, mailer: null });
    expect(res.sent).toBe(false);
    expect(res.digest_id).toBe("2026-09-28");
    const meta = JSON.parse(readFileSync(join(workDir, "digest.meta.json"), "utf8"));
    expect(meta.pending_send).toBe(true);
    expect(meta.entries).toEqual([{ entry_id: "2026-09-28-01", id: "crol:20260909003" }]);
  });

  it("sends an empty digest when nothing is new", async () => {
    const { store, workDir, record } = setup();
    record.feedback = { decision: "ignored", at: "x", by: "sheet" };
    store.save(record);
    const mailer = capturingMailer();
    const res = await runPost({ store, recipients, filters, now: monday, workDir, mailer });
    expect(res.entries).toBe(0);
    expect(res.sent).toBe(true);
    expect(mailer.sent[0]?.text).toContain("Nothing new today.");
  });
});
