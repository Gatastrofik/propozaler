import { convert } from "html-to-text";
import { z } from "zod";
import { NormalizedOpportunitySchema, type BuyerLevel, type NoticeType, type NormalizedOpportunity } from "../model/opportunity.js";
import { addDays, datePart, fromNewYorkLocal } from "../model/time.js";
import type { Checkpoint, FetchContext, FetchResult, SourceAdapter, SourceStats } from "./types.js";

export const CROL_COLUMNS = [
  "request_id", "start_date", "end_date", "agency_name", "type_of_notice_description", "category_description",
  "short_title", "selection_method_description", "section_name", "special_case_reason_description", "pin",
  "due_date", "address_to_request", "contact_name", "contact_phone", "email", "contract_amount", "contact_fax",
  "additional_description_1", "additional_description_2",
] as const;

export const CrolConfigSchema = z.object({
  enabled: z.boolean().default(true),
  base_url: z.string().url().default("https://data.cityofnewyork.us/resource/dg92-zbpx.json"),
  columns_url: z.string().url().default("https://data.cityofnewyork.us/api/views/dg92-zbpx/columns.json"),
  limit: z.number().int().min(1).max(1000).default(1000),
  overlap_days: z.number().int().min(0).default(2),
  default_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  max_checkpoint_age_days: z.number().int().min(1).default(14),
});
export type CrolConfig = z.infer<typeof CrolConfigSchema>;

const NOTICE_TYPES = ["Solicitation", "Intent to Award", "Award"];

// Socrata's $-prefixed SoQL params must stay literal (URLSearchParams would percent-encode the
// "$" to "%24"), so the query string is built by hand; encodeURIComponent leaves "'" unescaped,
// so it is escaped separately to match the percent-encoding Socrata/tests expect.
function encodeQueryValue(v: string): string {
  return encodeURIComponent(v).replace(/'/g, "%27");
}

export function buildCrolUrl(base: string, postedFrom: string, limit: number, offset: number): string {
  const types = NOTICE_TYPES.map((t) => `'${t}'`).join(",");
  const params: Array<[string, string]> = [
    ["$where", `section_name='Procurement' AND start_date >= '${postedFrom}T00:00:00' AND type_of_notice_description in(${types})`],
    ["$order", "start_date ASC, request_id ASC"],
    ["$limit", String(limit)],
    ["$offset", String(offset)],
  ];
  const qs = params.map(([k, v]) => `${k}=${encodeQueryValue(v)}`).join("&");
  return `${base}?${qs}`;
}

export function missingCrolColumns(columns: Array<{ fieldName: string }>): string[] {
  const have = new Set(columns.map((c) => c.fieldName));
  return CROL_COLUMNS.filter((c) => !have.has(c));
}

const NOTICE_MAP: Record<string, NoticeType> = {
  "Solicitation": "solicitation",
  "Intent to Award": "intent_to_award",
  "Award": "award",
  "Vendor List": "other",
};

const AUTHORITIES = new Set([
  "Housing Authority", "Health and Hospitals Corporation", "Economic Development Corporation",
  "School Construction Authority", "Brooklyn Bridge Park", "Hudson River Park Trust", "Trust for Governors Island",
  "Brooklyn Navy Yard Development Corporation", "Housing Development Corporation",
]);

function buyerLevel(agency: string): BuyerLevel {
  if (AUTHORITIES.has(agency)) return "authority";
  if (agency === "Education") return "school";
  return "city";
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
    ],
  })
    // html-to-text renders "&nbsp;" as a literal U+00A0 rather than a plain space; collapse it so
    // output has single regular spaces only, per the no-tags/no-&nbsp; requirement.
    .replace(/ /g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeCrolRow(row: Record<string, unknown>, nowIso: string): NormalizedOpportunity | null {
  const requestId = str(row.request_id);
  const title = str(row.short_title);
  const agency = str(row.agency_name);
  const startDate = str(row.start_date);
  if (!requestId || !title || !agency || !startDate) return null;

  const descParts = ["additional_description_1", "additional_description_2", "other_info_1"]
    .map((k) => str(row[k]))
    .filter((x): x is string => x !== null)
    .map(htmlToText)
    .filter((x) => x.length > 0);
  const description = descParts.length > 0 ? descParts.join("\n\n") : null;

  const phone = str(row.contact_phone);
  const contact = {
    ...(str(row.contact_name) ? { name: str(row.contact_name)! } : {}),
    ...(str(row.email) ? { email: str(row.email)! } : {}),
    ...(phone && !/^\(?0{3}\)?[ -]?0{3}-?0{4}$/.test(phone) ? { phone } : {}),
  };
  const amount = str(row.contract_amount);
  const dueDate = str(row.due_date);
  const rawType = str(row.type_of_notice_description) ?? "";

  return NormalizedOpportunitySchema.parse({
    id: `crol:${requestId}`,
    source: "crol",
    source_id: requestId,
    source_url: `https://a856-cityrecord.nyc.gov/RequestDetail/${requestId}`,
    title,
    notice_type: NOTICE_MAP[rawType] ?? "other",
    notice_type_raw: rawType,
    agency,
    agency_path: `City of New York > ${agency}`,
    buyer_level: buyerLevel(agency),
    place: { state: "NY", city: "New York", zip: null },
    posted_at: datePart(startDate),
    due_at: dueDate ? fromNewYorkLocal(dueDate) : null,
    due_at_source: dueDate ? "crol" : null,
    archive_at: str(row.end_date) ? datePart(str(row.end_date)!) : null,
    solicitation_number: str(row.pin),
    category_raw: str(row.category_description),
    selection_method: str(row.selection_method_description),
    estimated_value: amount && !Number.isNaN(Number(amount)) ? Number(amount) : null,
    contacts: Object.keys(contact).length > 0 ? [contact] : [],
    submit_to: str(row.address_to_request),
    description_text: description,
    description_fetched_at: description ? nowIso : null,
  });
}

export const crolAdapter: SourceAdapter = {
  name: "crol",
  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const cfg = CrolConfigSchema.parse(ctx.config);
    const stats: SourceStats = { requests: 0, fetched: 0, normalized: 0, skipped: 0, errors: [] };
    const token = ctx.secrets("SOCRATA_APP_TOKEN");
    const headers: Record<string, string> = token ? { "X-App-Token": token } : {};
    const previous: Checkpoint = ctx.checkpoint ?? { posted_from: cfg.default_from, updated_at: ctx.now.toISOString() };
    const from = addDays(previous.posted_from, -cfg.overlap_days);
    const records: NormalizedOpportunity[] = [];
    let newest = previous.posted_from;
    let partial = false;

    try {
      stats.requests += 1;
      const cols = await ctx.http.getJson<Array<{ fieldName: string }>>(cfg.columns_url, { headers });
      const missing = missingCrolColumns(cols);
      if (missing.length > 0) stats.errors.push(`crol columns missing: ${missing.join(", ")}`);
    } catch (err) {
      stats.errors.push(`crol columns check failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    for (let offset = 0; ; offset += cfg.limit) {
      let rows: Record<string, unknown>[];
      try {
        stats.requests += 1;
        rows = await ctx.http.getJson<Record<string, unknown>[]>(buildCrolUrl(cfg.base_url, from, cfg.limit, offset), { headers });
      } catch (err) {
        stats.errors.push(`crol page offset=${offset}: ${err instanceof Error ? err.message : String(err)}`);
        partial = true;
        break;
      }
      ctx.rawSink(`page-${offset}`, rows);
      stats.fetched += rows.length;
      for (const row of rows) {
        const n = normalizeCrolRow(row, ctx.now.toISOString());
        if (!n) { stats.skipped += 1; continue; }
        records.push(n);
        stats.normalized += 1;
        if (n.posted_at > newest) newest = n.posted_at;
      }
      if (rows.length < cfg.limit) break;
    }

    const checkpoint: Checkpoint = partial ? previous : { posted_from: newest, updated_at: ctx.now.toISOString() };
    return { records, checkpoint, stats, partial };
  },
};
