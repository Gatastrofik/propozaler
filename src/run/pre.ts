import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SourcesConfig } from "../config.js";
import { NormalizedOpportunitySchema } from "../model/opportunity.js";
import { selectOpportunity, type FiltersConfig } from "../select/filters.js";
import { createHttpClient } from "../sources/http.js";
import type { FetchContext, HttpClient, SourceAdapter } from "../sources/types.js";
import type { Store } from "../store/store.js";
import { writeRunState, type RunState, type SourceRunStats } from "./state.js";

export interface PreDeps {
  store: Store;
  adapters: SourceAdapter[];
  sources: SourcesConfig;
  filters: FiltersConfig;
  now: Date;
  workDir: string;
  env: NodeJS.ProcessEnv;
  gitSha: string | null;
  httpFactory?: () => HttpClient;
}

function emptyStats(): SourceRunStats {
  return { requests: 0, fetched: 0, normalized: 0, skipped: 0, new: 0, changed: 0, candidates: 0, errors: [], partial: false, checkpoint_posted_from: null, http_log: [] };
}

export async function runPre(deps: PreDeps): Promise<RunState> {
  const nowIso = deps.now.toISOString();
  const state: RunState = {
    run_id: nowIso, started_at: nowIso, git_sha: deps.gitSha, sources: {}, pending_count: 0,
    scoring: { status: "not enabled (milestone 1)", imported: 0, carried_over: 0, rejected: 0 },
    digest: null, warnings: [], finished_at: null, check: null,
  };
  rmSync(join(deps.workDir, "pending"), { recursive: true, force: true });
  mkdirSync(join(deps.workDir, "pending"), { recursive: true });

  for (const adapter of deps.adapters) {
    const config = (deps.sources as Record<string, { enabled: boolean } & Record<string, unknown>>)[adapter.name];
    if (!config) throw new Error(`no config block for source ${adapter.name}`);
    if (!config.enabled) { state.warnings.push(`source ${adapter.name} disabled`); continue; }

    const stats = emptyStats();
    const http = deps.httpFactory ? deps.httpFactory() : createHttpClient();
    const rawDir = join(deps.workDir, "raw", adapter.name);
    mkdirSync(rawDir, { recursive: true });
    const ctx: FetchContext = {
      config, checkpoint: deps.store.readCheckpoint(adapter.name), now: deps.now, http,
      secrets: (n) => deps.env[n],
      rawSink: (label, body) => writeFileSync(join(rawDir, `${label}.json`), JSON.stringify(body)),
    };

    try {
      const result = await adapter.fetch(ctx);
      Object.assign(stats, {
        requests: result.stats.requests, fetched: result.stats.fetched, normalized: result.stats.normalized,
        skipped: result.stats.skipped, errors: [...result.stats.errors], partial: result.partial,
      });
      for (const n of result.records) {
        const { record, isNew, changed } = deps.store.upsert(n, nowIso);
        const prefilter = selectOpportunity(NormalizedOpportunitySchema.parse(record), deps.filters);
        const prefilterChanged = JSON.stringify(record.prefilter) !== JSON.stringify(prefilter);
        if (isNew || changed.length > 0 || prefilterChanged) {
          record.prefilter = prefilter;
          deps.store.save(record);   // unchanged records are left alone so git history stays quiet
        }
        if (isNew) stats.new += 1;
        else if (changed.length > 0) stats.changed += 1;
        if (prefilter.stage === "candidate") stats.candidates += 1;
      }
      if (!result.partial) {
        deps.store.writeCheckpoint(adapter.name, result.checkpoint);
        stats.checkpoint_posted_from = result.checkpoint.posted_from;
      } else {
        stats.checkpoint_posted_from = ctx.checkpoint?.posted_from ?? null;
      }
    } catch (err) {
      stats.partial = true;
      stats.errors.push(`adapter ${adapter.name} threw: ${err instanceof Error ? err.message : String(err)}`);
      stats.checkpoint_posted_from = ctx.checkpoint?.posted_from ?? null;
    }
    stats.http_log = [...http.log];
    state.sources[adapter.name] = stats;
  }

  writeRunState(deps.workDir, state);
  return state;
}
