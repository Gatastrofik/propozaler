import type { SourcesConfig } from "../config.js";
import { addDays } from "../model/time.js";
import type { RunState } from "../run/state.js";

export interface CheckInput { state: RunState; previousRuns: RunState[]; today: string; weekday: boolean; sources: SourcesConfig }
export interface CheckResult { ok: boolean; warnings: string[]; failures: string[] }

function trouble(s: RunState["sources"][string] | undefined): boolean {
  return !!s && (s.partial || s.errors.length > 0);
}

export function evaluateChecks(input: CheckInput): CheckResult {
  const warnings: string[] = [];
  const failures: string[] = [];
  const prev = [...input.previousRuns].reverse(); // prev[0] is the most recent previous run

  for (const [name, s] of Object.entries(input.state.sources)) {
    if (trouble(s)) {
      if (trouble(prev[0]?.sources[name])) failures.push(`${name}: partial or errors two runs running`);
      else warnings.push(`${name}: partial or errors`);
    }
    if (s.fetched === 0) {
      const zeroBefore = prev.slice(0, 2).filter((r) => r.sources[name]?.fetched === 0).length;
      if (zeroBefore === 2) failures.push(`${name}: 0 fetched three runs running`);
      else if (input.weekday) warnings.push(`${name}: 0 fetched`);
    }
    if (s.fetched > 0 && s.candidates === 0) {
      const dry = prev.slice(0, 6).filter((r) => (r.sources[name]?.fetched ?? 0) > 0 && r.sources[name]?.candidates === 0).length;
      if (dry === 6) warnings.push(`${name}: no candidates in 7 runs`);
    }
    const cfg = (input.sources as Record<string, { enabled: boolean; max_checkpoint_age_days?: number }>)[name];
    const enabled = cfg?.enabled ?? true;
    if (enabled) {
      const staleBefore = addDays(input.today, -(cfg?.max_checkpoint_age_days ?? 3));
      if (s.checkpoint_posted_from === null) {
        if (input.previousRuns.length > 0) failures.push(`${name}: checkpoint stale (none)`);
      } else if (s.checkpoint_posted_from < staleBefore) {
        failures.push(`${name}: checkpoint stale (${s.checkpoint_posted_from})`);
      }
    }
  }

  const d = input.state.digest;
  if (d && d.send_expected && !d.sent) failures.push(`digest expected but not sent: ${d.error ?? "unknown error"}`);

  if (input.state.scoring.status.startsWith("rejected")) failures.push(`scoring ${input.state.scoring.status}`);
  else if (input.state.scoring.carried_over > 0) warnings.push(`scoring partial: ${input.state.scoring.carried_over} carried over`);

  return { ok: failures.length === 0, warnings, failures };
}
