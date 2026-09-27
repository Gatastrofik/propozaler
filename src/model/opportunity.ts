import { createHash } from "node:crypto";
import { z } from "zod";

export const NoticeTypeSchema = z.enum([
  "solicitation", "presolicitation", "sources_sought", "combined_synopsis",
  "intent_to_award", "award", "special_notice", "other",
]);
export type NoticeType = z.infer<typeof NoticeTypeSchema>;

export const BuyerLevelSchema = z.enum([
  "federal", "state", "county", "city", "authority", "school", "special_district", "other",
]);
export type BuyerLevel = z.infer<typeof BuyerLevelSchema>;

export const ContactSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  role: z.string().optional(),
});

export const AttachmentSchema = z.object({ url: z.string(), name: z.string().optional() });

export const NormalizedOpportunitySchema = z.object({
  id: z.string().regex(/^[a-z_]+:.+$/),
  source: z.string(),
  source_id: z.string(),
  source_url: z.string().url(),
  title: z.string().min(1),
  notice_type: NoticeTypeSchema,
  notice_type_raw: z.string(),
  agency: z.string().min(1),
  agency_path: z.string().nullable().default(null),
  buyer_level: BuyerLevelSchema,
  place: z.object({
    state: z.string().nullable().default(null),
    city: z.string().nullable().default(null),
    zip: z.string().nullable().default(null),
  }).default(() => ({ state: null, city: null, zip: null })),
  posted_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  due_at: z.string().nullable().default(null),
  due_at_source: z.string().nullable().default(null),
  archive_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  solicitation_number: z.string().nullable().default(null),
  naics: z.array(z.string()).default([]),
  psc: z.string().nullable().default(null),
  category_raw: z.string().nullable().default(null),
  selection_method: z.string().nullable().default(null),
  set_aside: z.string().nullable().default(null),
  estimated_value: z.number().nullable().default(null),
  contacts: z.array(ContactSchema).default([]),
  submit_to: z.string().nullable().default(null),
  attachments: z.array(AttachmentSchema).default([]),
  description_text: z.string().nullable().default(null),
  description_fetched_at: z.string().nullable().default(null),
});
export type NormalizedOpportunity = z.infer<typeof NormalizedOpportunitySchema>;

export const PrefilterSchema = z.object({
  net_score: z.number().int(),
  matched: z.array(z.string()),
  stage: z.enum(["candidate", "filtered_out"]),
  filters_version: z.number().int(),
});
export type Prefilter = z.infer<typeof PrefilterSchema>;

export const FeedbackSchema = z.object({
  decision: z.enum(["pursued", "ignored"]),
  at: z.string(),
  by: z.string(),
  note: z.string().optional(),
});
export type Feedback = z.infer<typeof FeedbackSchema>;

export const OpportunitySchema = NormalizedOpportunitySchema.extend({
  content_hash: z.string().length(64),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
  changes: z.array(z.object({ at: z.string(), fields: z.array(z.string()) })).default([]),
  duplicate_of: z.string().nullable().default(null),
  prefilter: PrefilterSchema.nullable().default(null),
  score: z.unknown().nullable().default(null), // defined in milestone 2
  feedback: FeedbackSchema.nullable().default(null),
  digest: z.object({
    sent_in: z.array(z.string()).default([]),
    sent_hash: z.string().nullable().default(null),
  }).default(() => ({ sent_in: [], sent_hash: null })),
});
export type Opportunity = z.infer<typeof OpportunitySchema>;

export const HASH_FIELDS = ["title", "due_at", "description_text", "attachments", "notice_type"] as const;

export function contentHash(n: Pick<NormalizedOpportunity, (typeof HASH_FIELDS)[number]>): string {
  const material = {
    title: n.title,
    due_at: n.due_at,
    description_text: n.description_text,
    attachments: [...n.attachments.map((a) => a.url)].sort(),
    notice_type: n.notice_type,
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

export function idToFilename(id: string): string {
  return `${id.replace(":", "__")}.json`;
}

export function newOpportunity(n: NormalizedOpportunity, now: string): Opportunity {
  return OpportunitySchema.parse({
    ...n,
    content_hash: contentHash(n),
    first_seen_at: now,
    last_seen_at: now,
  });
}
