import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RecipientsConfig } from "../config.js";
import type { Mailer } from "../digest/mailer.js";
import { renderDigest, type DigestEntry, type DigestModel, type HealthSummary, type SourceHealth } from "../digest/render.js";
import { effectiveDue, selectDigestEntries } from "../digest/select.js";
import { addDays, todayNewYork, weekdayNewYork } from "../model/time.js";
import type { FiltersConfig } from "../select/filters.js";
import type { Store } from "../store/store.js";
import { readRunState, writeRunState, type RunState } from "./state.js";

export interface PostDeps {
  store: Store; recipients: RecipientsConfig; filters: FiltersConfig; now: Date; workDir: string;
  mailer: Mailer | null; forceSend?: boolean;
}

export interface PostResult {
  send_expected: boolean; sent: boolean; digest_id: string | null; entries: number; overflow: number;
  subject: string; message_id: string | null; error: string | null; html_path: string; text_path: string;
  note: string | null;
}

// Keeps a raw error (which can carry a URL, a stack fragment, or newlines) out of the subject line:
// the text before the first ":" if that is under 40 characters, else the first 40 characters.
export function shortNote(s: string): string {
  const idx = s.indexOf(":");
  const head = idx >= 0 && idx < 40 ? s.slice(0, idx) : s.slice(0, 40);
  return head.replace(/[\r\n]+/g, " ").trim();
}

export function nextDigestId(existing: string[], today: string): string {
  const used = new Set(existing);
  if (!used.has(today)) return today;
  for (const suffix of "bcdefghijklmnopqrstuvwxyz") {
    if (!used.has(`${today}${suffix}`)) return `${today}${suffix}`;
  }
  throw new Error(`too many digests on ${today}`);
}

function healthFrom(state: RunState, weekday: boolean, now: Date): HealthSummary {
  const sources: SourceHealth[] = Object.entries(state.sources).map(([name, s]) => {
    let status: SourceHealth["status"] = "ok";
    let note: string | undefined;
    if (s.partial && s.errors.length > 0) { status = "fail"; note = shortNote(s.errors[0]!); }
    else if (s.errors.length > 0) { status = "warn"; note = shortNote(s.errors[0]!); }
    else if (s.fetched === 0 && weekday) { status = "warn"; note = "0 fetched"; }
    return { name, fetched: s.fetched, candidates: s.candidates, scored: 0, new: s.new, status, ...(note ? { note } : {}) };
  });
  const durationMs = Date.parse(state.started_at) ? Math.max(0, now.getTime() - Date.parse(state.started_at)) : 0;
  return { sources, scoring: state.scoring.status, durationMs, criteriaVersion: null };
}

export async function runPost(deps: PostDeps): Promise<PostResult> {
  const state = readRunState(deps.workDir);
  const today = todayNewYork(deps.now);
  const weekday = deps.recipients.send_days.includes(weekdayNewYork(deps.now));
  let sendExpected = deps.forceSend === true || weekday;
  const records = deps.store.list();

  const { entries, overflow } = selectDigestEntries(records, {
    today, minNetScore: deps.recipients.min_net_score, cap: deps.recipients.cap, noticeTypes: deps.filters.notice_types_for_digest,
  });
  const soonCutoff = addDays(today, 5);
  const dueSoon = records.filter((o) => {
    const due = effectiveDue(o).at;
    return o.feedback?.decision === "pursued" && due !== null && due.slice(0, 10) >= today && due.slice(0, 10) <= soonCutoff;
  });

  const existingIds = deps.store.readJsonl<{ digest_id: string }>("digests").map((d) => d.digest_id);
  let note: string | null = null;
  if (sendExpected && !deps.forceSend && existingIds.some((id) => id.startsWith(today))) {
    sendExpected = false;
    note = "already sent today; use --force-send to send again";
  }
  const digestId = sendExpected ? nextDigestId(existingIds, today) : null;
  const digestEntries: DigestEntry[] = entries.map((record, i) => ({
    entryId: `${digestId ?? today}-${String(i + 1).padStart(2, "0")}`, record,
  }));
  const model: DigestModel = {
    date: today, subjectPrefix: deps.recipients.subject_prefix, sheetUrl: deps.recipients.sheet_url,
    entries: digestEntries, overflow, dueSoon, health: healthFrom(state, weekday, deps.now), minScore: deps.recipients.min_net_score,
  };
  const rendered = renderDigest(model);

  mkdirSync(deps.workDir, { recursive: true });
  const htmlPath = join(deps.workDir, "digest.html");
  const textPath = join(deps.workDir, "digest.txt");
  writeFileSync(htmlPath, rendered.html);
  writeFileSync(textPath, rendered.text);

  let sent = false;
  let messageId: string | null = null;
  let error: string | null = null;
  const entryRefs = digestEntries.map((e) => ({ entry_id: e.entryId, id: e.record.id }));

  if (sendExpected && digestId && deps.mailer) {
    try {
      const res = await deps.mailer.send({
        from: deps.recipients.from, to: [...deps.recipients.to], subject: rendered.subject, text: rendered.text, html: rendered.html,
      });
      sent = true;
      messageId = res.messageId;
      markSent(deps.store, digestId, digestEntries, rendered.subject, messageId, deps.now.toISOString());
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  writeFileSync(join(deps.workDir, "digest.meta.json"), JSON.stringify({
    digest_id: digestId, subject: rendered.subject, to: deps.recipients.to, from: deps.recipients.from,
    send_expected: sendExpected, sent, pending_send: sendExpected && !sent && !error && deps.mailer === null,
    entries: entryRefs, overflow, error, note,
  }, null, 2) + "\n");

  if (note === null) {
    // Only update the run-state digest block for an actual attempt this call; the already-sent-today
    // guard above must leave a prior `sent: true` block untouched rather than clobber it with `false`.
    state.digest = { digest_id: digestId, sent, send_expected: sendExpected, entries: entries.length, overflow, message_id: messageId, error };
    writeRunState(deps.workDir, state);
  }

  return { send_expected: sendExpected, sent, digest_id: digestId, entries: entries.length, overflow, subject: rendered.subject, message_id: messageId, error, html_path: htmlPath, text_path: textPath, note };
}

export function markSent(store: Store, digestId: string, entries: DigestEntry[], subject: string, messageId: string, sentAt: string): void {
  for (const e of entries) {
    const rec = store.get(e.record.id);
    if (!rec) continue;
    rec.digest = { sent_in: [...rec.digest.sent_in, digestId], sent_hash: rec.content_hash };
    store.save(rec);
  }
  store.appendJsonl("digests", {
    digest_id: digestId, sent_at: sentAt, message_id: messageId, subject,
    entries: entries.map((e) => ({ entry_id: e.entryId, id: e.record.id })),
  });
}
