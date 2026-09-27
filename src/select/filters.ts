import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { NoticeTypeSchema, type NormalizedOpportunity, type Prefilter } from "../model/opportunity.js";

const CategorySchema = z.object({
  weight: z.number().int().min(1),
  strong: z.array(z.string()).default([]),
  weak: z.array(z.string()).default([]),
  vendors: z.array(z.string()).default([]),
  context: z.array(z.string()).default([]),
});

export const FiltersConfigSchema = z.object({
  version: z.number().int(),
  notice_types_for_digest: z.array(NoticeTypeSchema),
  hard_exclude: z.object({
    categories_raw: z.array(z.string()).default([]),
    title_terms: z.array(z.string()).default([]),
    set_asides: z.array(z.string()).default([]),
  }),
  ordering: z.object({
    home_states: z.array(z.string()),
    home_bonus: z.number().int(),
    federal_penalty: z.number().int(),
    code_bonus: z.number().int(),
    software_signal_bonus: z.number().int(),
  }),
  categories: z.record(z.string(), CategorySchema),
  software_signals: z.array(z.string()).default([]),
  codes: z.object({ naics: z.array(z.string()).default([]), psc: z.array(z.string()).default([]) }),
});
export type FiltersConfig = z.infer<typeof FiltersConfigSchema>;

export function loadFilters(yamlText: string): FiltersConfig {
  return FiltersConfigSchema.parse(parseYaml(yamlText));
}

const cache = new Map<string, RegExp>();

export function termRegex(term: string, caseSensitive: boolean): RegExp {
  const key = `${caseSensitive ? "s" : "i"}:${term}`;
  const hit = cache.get(key);
  if (hit) { hit.lastIndex = 0; return hit; }
  const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  // Boundaries are "not a letter or digit" on both sides, Unicode-aware, so hyphenated terms work.
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, caseSensitive ? "u" : "iu");
  cache.set(key, re);
  return re;
}

function firstMatch(text: string, terms: string[], caseSensitive: boolean): string | null {
  for (const t of terms) if (termRegex(t, caseSensitive).test(text)) return t;
  return null;
}

export function selectOpportunity(o: NormalizedOpportunity, f: FiltersConfig): Prefilter {
  const title = o.title;
  const text = `${o.title}\n${o.description_text ?? ""}`;
  const matched: string[] = [];
  let excluded = false;
  let score = 0;

  if (o.category_raw && f.hard_exclude.categories_raw.includes(o.category_raw)) {
    matched.push(`exclude:category:${o.category_raw}`); excluded = true;
  }
  for (const t of f.hard_exclude.title_terms) {
    if (termRegex(t, false).test(title)) { matched.push(`exclude:title:${t}`); excluded = true; }
  }
  if (o.set_aside) {
    const sa = firstMatch(o.set_aside, f.hard_exclude.set_asides, false);
    if (sa) { matched.push(`exclude:set_aside:${sa}`); excluded = true; }
  }

  let categoryHits = 0;
  for (const [name, cat] of Object.entries(f.categories)) {
    const strong = firstMatch(text, cat.strong, false);
    const vendor = firstMatch(text, cat.vendors, true);
    let hit: string | null = null;
    if (strong) hit = `cat:${name}:${strong}`;
    else if (vendor) hit = `cat:${name}:vendor:${vendor}`;
    else {
      const weak = firstMatch(text, cat.weak, false);
      const context = weak ? firstMatch(text, cat.context, false) : null;
      if (weak && context) hit = `cat:${name}:weak:${weak}+${context}`;
    }
    if (hit) { matched.push(hit); categoryHits += 1; score += cat.weight; }
  }

  const code = [...o.naics, ...(o.psc ? [o.psc] : [])].find((c) => f.codes.naics.includes(c) || f.codes.psc.includes(c));
  if (code) { matched.push(`bonus:code:${code}`); score += f.ordering.code_bonus; }

  let signals = 0;
  for (const s of f.software_signals) {
    if (signals >= 2) break;
    if (termRegex(s, false).test(text)) { matched.push(`bonus:software:${s}`); signals += 1; }
  }
  score += signals * f.ordering.software_signal_bonus;

  if (o.buyer_level === "federal") { matched.push("penalty:federal"); score += f.ordering.federal_penalty; }
  else if (o.place.state && f.ordering.home_states.includes(o.place.state)) {
    matched.push(`bonus:home:${o.place.state}`); score += f.ordering.home_bonus;
  }

  return {
    net_score: score,
    matched,
    stage: categoryHits > 0 && !excluded ? "candidate" : "filtered_out",
    filters_version: f.version,
  };
}
