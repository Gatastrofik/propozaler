import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { CrolConfigSchema } from "./sources/crol.js";
import { FiltersConfigSchema, type FiltersConfig } from "./select/filters.js";

export const SourcesConfigSchema = z.object({ crol: CrolConfigSchema });
export type SourcesConfig = z.infer<typeof SourcesConfigSchema>;

export const WeekdaySchema = z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);

export const RecipientsConfigSchema = z.object({
  from: z.string().email(),
  to: z.array(z.string().email()).min(1),
  send_days: z.array(WeekdaySchema).min(1),
  cap: z.number().int().min(1).default(10),
  min_net_score: z.number().int().default(3),
  sheet_url: z.string().url().nullable().default(null),
  subject_prefix: z.string().default("propozaler"),
  transport: z.enum(["gmail_api", "smtp"]).default("gmail_api"),
});
export type RecipientsConfig = z.infer<typeof RecipientsConfigSchema>;

export interface AppConfig {
  filters: FiltersConfig;
  sources: SourcesConfig;
  recipients: RecipientsConfig;
}

export function loadYamlFile<T>(path: string, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(parseYaml(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`invalid config ${path}: ${parsed.error.message}`);
  return parsed.data;
}

export function loadConfig(configDir: string): AppConfig {
  return {
    filters: loadYamlFile(join(configDir, "filters.yaml"), FiltersConfigSchema),
    sources: loadYamlFile(join(configDir, "sources.yaml"), SourcesConfigSchema),
    recipients: loadYamlFile(join(configDir, "recipients.yaml"), RecipientsConfigSchema),
  };
}
