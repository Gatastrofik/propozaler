import type { Opportunity } from "../model/opportunity.js";

const HEADER = ["id", "source", "notice_type", "agency", "title", "posted_at", "due_at", "net_score", "stage", "matched", "feedback", "sent_in", "source_url"];

function cell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(records: Opportunity[]): string {
  const rows = records.map((o) => [
    o.id, o.source, o.notice_type, o.agency, o.title, o.posted_at, o.due_at ?? "",
    o.prefilter?.net_score ?? "", o.prefilter?.stage ?? "", (o.prefilter?.matched ?? []).join("; "),
    o.feedback?.decision ?? "", o.digest.sent_in.join("; "), o.source_url,
  ].map(cell).join(","));
  return [HEADER.join(","), ...rows].join("\n") + "\n";
}
