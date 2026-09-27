import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const HttpLogEntrySchema = z.object({
  method: z.string(), url: z.string(), status: z.number().nullable(), ms: z.number(), error: z.string().optional(),
});

export const SourceRunStatsSchema = z.object({
  requests: z.number(), fetched: z.number(), normalized: z.number(), skipped: z.number(),
  new: z.number(), changed: z.number(), candidates: z.number(),
  errors: z.array(z.string()), partial: z.boolean(),
  checkpoint_posted_from: z.string().nullable(),
  http_log: z.array(HttpLogEntrySchema),
});
export type SourceRunStats = z.infer<typeof SourceRunStatsSchema>;

export const RunStateSchema = z.object({
  run_id: z.string(),
  started_at: z.string(),
  git_sha: z.string().nullable(),
  sources: z.record(z.string(), SourceRunStatsSchema),
  pending_count: z.number().default(0),
  scoring: z.object({ status: z.string(), imported: z.number(), carried_over: z.number(), rejected: z.number() })
    .default({ status: "not enabled (milestone 1)", imported: 0, carried_over: 0, rejected: 0 }),
  digest: z.object({
    digest_id: z.string().nullable(), sent: z.boolean(), send_expected: z.boolean(),
    entries: z.number(), overflow: z.number(), message_id: z.string().nullable(), error: z.string().nullable(),
  }).nullable().default(null),
  warnings: z.array(z.string()).default([]),
  finished_at: z.string().nullable().default(null),
  check: z.object({ ok: z.boolean(), warnings: z.array(z.string()), failures: z.array(z.string()) }).nullable().default(null),
});
export type RunState = z.infer<typeof RunStateSchema>;

export function readRunState(workDir: string): RunState {
  const p = join(workDir, "run.json");
  if (!existsSync(p)) throw new Error("no work/run.json; run `pre` first");
  return RunStateSchema.parse(JSON.parse(readFileSync(p, "utf8")));
}

export function writeRunState(workDir: string, s: RunState): void {
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, "run.json"), JSON.stringify(RunStateSchema.parse(s), null, 2) + "\n");
}
