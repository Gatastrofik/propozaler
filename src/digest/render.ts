import type { Opportunity } from "../model/opportunity.js";
import { effectiveDue } from "./select.js";

export interface SourceHealth {
  name: string; fetched: number; candidates: number; scored: number; new: number;
  status: "ok" | "warn" | "fail"; note?: string;
}
export interface HealthSummary { sources: SourceHealth[]; scoring: string; durationMs: number; criteriaVersion: string | null }
export interface DigestEntry { entryId: string; record: Opportunity }
export interface DigestModel {
  date: string; subjectPrefix: string; sheetUrl: string | null;
  entries: DigestEntry[]; overflow: number; dueSoon: Opportunity[]; health: HealthSummary;
  minScore: number; // the digest threshold, for the overflow line
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const DAY = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[t.getUTCDay()]} ${MONTHS[m - 1]} ${d}`;
}

function daysBetween(fromYmd: string, toIso: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`);
  return Math.round((b - a) / DAY);
}

export function formatDue(o: Opportunity, today: string): string {
  const due = effectiveDue(o);
  if (!due.at) return "due date not stated";
  const days = daysBetween(today, due.at);
  const when = `due ${shortDate(due.at)} (${days} day${days === 1 ? "" : "s"})`;
  if (due.source === "extracted") return `${when} (from notice text)`;
  if (o.due_at_source === "crol") {
    const pin = o.solicitation_number ? ` (PIN ${o.solicitation_number})` : "";
    return `${when} per City Record; confirm in PASSPort${pin}`;
  }
  return when;
}

export function summaryOf(o: Opportunity): string {
  if (!o.description_text) return "(no description in the notice)";
  const one = o.description_text.replace(/\s+/g, " ").trim();
  return one.length > 200 ? `${one.slice(0, 200)}…` : one;
}

function matchedLabel(o: Opportunity): string {
  const parts = (o.prefilter?.matched ?? [])
    .filter((m) => m.startsWith("cat:") || m.startsWith("bonus:home:"))
    .map((m) => m.startsWith("bonus:home:") ? `home ${m.slice("bonus:home:".length)}` : m.split(":").slice(2).join(":").replace(/^vendor:/, "").replace(/^weak:/, ""));
  return parts.length > 0 ? `matched: ${parts.join(", ")}` : "";
}

function valueLabel(o: Opportunity): string {
  return o.estimated_value !== null ? `value $${Math.round(o.estimated_value).toLocaleString("en-US")}` : "value not stated";
}

function sourceLabel(s: string): string {
  return s === "crol" ? "CROL" : s === "sam" ? "SAM.gov" : s;
}

function subjectFor(m: DigestModel): string {
  const n = m.entries.length;
  const head = n === 0 ? "nothing new" : `${n} new`;
  const health = m.health.sources.map((s) =>
    s.status === "ok" ? `${sourceLabel(s.name)} ok` : `${sourceLabel(s.name)} ${s.note ?? s.status} ⚠`).join(" · ");
  return `${m.subjectPrefix} ${m.date}: ${head} · ${health}`;
}

function entryText(i: number, e: DigestEntry, today: string): string {
  const o = e.record;
  const lines = [
    `${i}. ${o.title}    net ${o.prefilter?.net_score ?? 0}`,
    `   ${o.agency} (${o.buyer_level}) · ${o.notice_type_raw}${o.selection_method ? ` · ${o.selection_method}` : ""} · ${formatDue(o, today)} · ${valueLabel(o)}`,
    `   ${summaryOf(o)}`,
  ];
  const ml = matchedLabel(o);
  if (ml) lines.push(`   ${ml}`);
  const c = o.contacts[0];
  if (c) lines.push(`   Contact: ${[c.name, c.email, c.phone].filter(Boolean).join(", ")}`);
  lines.push(`   Source: ${sourceLabel(o.source)} ${o.source_url}`);
  return lines.join("\n");
}

function entryHtml(i: number, e: DigestEntry, today: string): string {
  const o = e.record;
  const c = o.contacts[0];
  const ml = matchedLabel(o);
  return `
<div style="margin:0 0 20px 0;padding:0 0 16px 0;border-bottom:1px solid #e5e5e5;">
  <div style="font-weight:600;font-size:16px;">${i}. <a href="${escapeHtml(o.source_url)}" style="color:#1a1a1a;">${escapeHtml(o.title)}</a>
    <span style="float:right;font-weight:400;color:#555;">net ${o.prefilter?.net_score ?? 0}</span></div>
  <div style="color:#555;font-size:14px;margin-top:2px;">${escapeHtml(o.agency)} (${escapeHtml(o.buyer_level)}) · ${escapeHtml(o.notice_type_raw)}${o.selection_method ? ` · ${escapeHtml(o.selection_method)}` : ""}<br>${escapeHtml(formatDue(o, today))} · ${escapeHtml(valueLabel(o))}</div>
  <div style="margin-top:6px;">${escapeHtml(summaryOf(o))}</div>
  ${ml ? `<div style="color:#555;font-size:13px;margin-top:4px;">${escapeHtml(ml)}</div>` : ""}
  ${c ? `<div style="font-size:13px;margin-top:4px;">Contact: ${escapeHtml([c.name, c.email, c.phone].filter(Boolean).join(", "))}</div>` : ""}
  <div style="font-size:13px;margin-top:4px;">Source: <a href="${escapeHtml(o.source_url)}">${escapeHtml(sourceLabel(o.source))}</a></div>
</div>`;
}

export function renderDigest(m: DigestModel): { subject: string; html: string; text: string } {
  const subject = subjectFor(m);
  const today = m.date;
  const healthLines = m.health.sources.map((s) =>
    `${s.name} ${s.fetched} / ${s.candidates} / ${s.scored} / ${s.new}${s.status === "ok" ? "" : ` (${s.note ?? s.status})`}`);
  const footerText = [
    "Health (fetched / candidates / scored / new):",
    ...healthLines.map((l) => `  ${l}`),
    `  scoring: ${m.health.scoring} · run ${Math.round(m.health.durationMs / 1000)}s${m.health.criteriaVersion ? ` · criteria ${m.health.criteriaVersion}` : ""}`,
  ].join("\n");

  const textParts: string[] = [`${m.subjectPrefix} digest for ${m.date}`];
  if (m.sheetUrl) textParts.push(`Tracker sheet: ${m.sheetUrl}`);
  if (m.entries.length === 0) textParts.push("Nothing new today.");
  else textParts.push(m.entries.map((e, i) => entryText(i + 1, e, today)).join("\n\n"));
  if (m.overflow > 0) textParts.push(`${m.overflow} more scored ${m.minScore}+ today; they carry over.`);
  if (m.dueSoon.length > 0) textParts.push(["Due soon (pursued):", ...m.dueSoon.map((o) => `  ${o.title} — ${formatDue(o, today)}`)].join("\n"));
  textParts.push(footerText);
  const text = textParts.join("\n\n") + "\n";

  const htmlBody = [
    `<h2 style="margin:0 0 12px 0;font-size:18px;">${escapeHtml(m.subjectPrefix)} digest for ${m.date}</h2>`,
    m.sheetUrl ? `<p><a href="${escapeHtml(m.sheetUrl)}">Tracker sheet</a></p>` : "",
    m.entries.length === 0 ? `<p>Nothing new today.</p>` : m.entries.map((e, i) => entryHtml(i + 1, e, today)).join(""),
    m.overflow > 0 ? `<p style="color:#555;">${m.overflow} more scored ${m.minScore}+ today; they carry over.</p>` : "",
    m.dueSoon.length > 0 ? `<p><b>Due soon (pursued)</b><br>${m.dueSoon.map((o) => `${escapeHtml(o.title)} — ${escapeHtml(formatDue(o, today))}`).join("<br>")}</p>` : "",
    `<pre style="font-size:12px;color:#555;white-space:pre-wrap;">${escapeHtml(footerText)}</pre>`,
  ].join("\n");

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;"><div style="max-width:600px;margin:0 auto;padding:20px;background:#fff;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;">
${htmlBody}
</div></body></html>`;
  return { subject, html, text };
}
