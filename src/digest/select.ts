import type { NoticeType, Opportunity } from "../model/opportunity.js";

export function effectiveDue(o: Opportunity): { at: string | null; source: "source" | "extracted" | null } {
  if (o.due_at) return { at: o.due_at, source: "source" };
  const score = o.score as { extracted?: { due_at?: string | null } } | null;
  const extracted = score?.extracted?.due_at ?? null;
  if (extracted) return { at: extracted, source: "extracted" };
  return { at: null, source: null };
}

export interface DigestSelectOptions {
  today: string;            // YYYY-MM-DD in New York
  minNetScore: number;
  cap: number;
  noticeTypes: readonly NoticeType[];
}

export function selectDigestEntries(records: Opportunity[], opts: DigestSelectOptions): { entries: Opportunity[]; overflow: number } {
  const eligible = records.filter((o) => {
    if (!opts.noticeTypes.includes(o.notice_type)) return false;
    if (!o.prefilter || o.prefilter.stage !== "candidate") return false;
    if (o.prefilter.net_score < opts.minNetScore) return false;
    if (o.feedback) return false;
    const due = effectiveDue(o).at;
    if (due && due.slice(0, 10) < opts.today) return false;
    const sentBefore = o.digest.sent_in.length > 0;
    if (sentBefore && o.digest.sent_hash === o.content_hash) return false;
    return true;
  });
  eligible.sort((a, b) => {
    const s = (b.prefilter?.net_score ?? 0) - (a.prefilter?.net_score ?? 0);
    if (s !== 0) return s;
    const da = effectiveDue(a).at, db = effectiveDue(b).at;
    if (da && db && da !== db) return da < db ? -1 : 1;
    if (da && !db) return -1;
    if (!da && db) return 1;
    if (a.posted_at !== b.posted_at) return a.posted_at < b.posted_at ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  });
  return { entries: eligible.slice(0, opts.cap), overflow: Math.max(0, eligible.length - opts.cap) };
}
