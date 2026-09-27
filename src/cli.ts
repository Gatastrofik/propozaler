#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateChecks } from "./check/check.js";
import { loadConfig } from "./config.js";
import { createSmtpMailer, type Mailer } from "./digest/mailer.js";
import { toCsv } from "./export/csv.js";
import { todayNewYork, weekdayNewYork } from "./model/time.js";
import { runPost, markSent } from "./run/post.js";
import { runPre } from "./run/pre.js";
import { readRunState, writeRunState, type RunState } from "./run/state.js";
import { crolAdapter } from "./sources/crol.js";
import { createHttpClient } from "./sources/http.js";
import { Store } from "./store/store.js";

export interface CliIo {
  stdout?: (s: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  mailerFactory?: (env: NodeJS.ProcessEnv) => Mailer;
}

const USAGE = `usage: propozaler <command>
  pre                      ingest enabled sources, select, write work/run.json
  post [--no-send] [--force-send] [--scores DIR]
  sent --digest-id ID [--message-id M]
  check                    evaluate invariants, append runs.jsonl, exit 1 on failure
  ingest <source> [--from YYYY-MM-DD]
  export csv [--out PATH]
  check-env
  notify-failure --step N --log PATH
`;

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i += 1; } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

function gitSha(cwd: string): string | null {
  try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8" }).trim(); } catch { return null; }
}

const ADAPTERS = [crolAdapter];

export async function main(argv: string[], env: NodeJS.ProcessEnv, cwd: string, io: CliIo = {}): Promise<number> {
  const out = io.stdout ?? ((s: string) => process.stdout.write(s));
  const now = io.now ? io.now() : new Date();
  const configDir = join(cwd, "config");
  const dataDir = join(cwd, "data");
  const workDir = join(cwd, "work");
  const { positional, flags } = parseFlags(argv);
  const cmd = positional[0];
  const httpFactory = () => createHttpClient(io.fetchImpl ? { fetchImpl: io.fetchImpl } : {});
  const mailerFactory = io.mailerFactory ?? ((e: NodeJS.ProcessEnv) => createSmtpMailer(e));

  try {
    switch (cmd) {
      case "pre": {
        const config = loadConfig(configDir);
        const state = await runPre({ store: new Store(dataDir), adapters: ADAPTERS, sources: config.sources, filters: config.filters, now, workDir, env, gitSha: gitSha(cwd), httpFactory });
        out(JSON.stringify({ run_id: state.run_id, sources: Object.fromEntries(Object.entries(state.sources).map(([k, v]) => [k, { fetched: v.fetched, new: v.new, changed: v.changed, candidates: v.candidates, partial: v.partial, errors: v.errors }])), warnings: state.warnings }) + "\n");
        return 0;
      }
      case "post": {
        const config = loadConfig(configDir);
        const mailer = flags["no-send"] ? null : mailerFactory(env);
        const res = await runPost({ store: new Store(dataDir), recipients: config.recipients, filters: config.filters, now, workDir, mailer, forceSend: flags["force-send"] === true });
        out(JSON.stringify(res) + "\n");
        return 0;
      }
      case "sent": {
        const id = flags["digest-id"];
        if (typeof id !== "string") { out("sent: --digest-id is required\n"); return 2; }
        const metaPath = join(workDir, "digest.meta.json");
        const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { digest_id: string | null; subject: string; pending_send: boolean; entries: Array<{ entry_id: string; id: string }> };
        if (!meta.pending_send || meta.digest_id !== id) { out(`sent: no pending send for ${id}\n`); return 1; }
        const store = new Store(dataDir);
        const entries = meta.entries.flatMap((e) => { const r = store.get(e.id); return r ? [{ entryId: e.entry_id, record: r }] : []; });
        const messageId = typeof flags["message-id"] === "string" ? flags["message-id"] : "connector";
        markSent(store, id, entries, meta.subject, messageId, now.toISOString());
        writeFileSync(metaPath, JSON.stringify({ ...meta, pending_send: false, sent: true }, null, 2) + "\n");
        const state = readRunState(workDir);
        if (state.digest) { state.digest.sent = true; state.digest.message_id = messageId; }
        writeRunState(workDir, state);
        out(JSON.stringify({ digest_id: id, marked: entries.length }) + "\n");
        return 0;
      }
      case "check": {
        const config = loadConfig(configDir);
        const store = new Store(dataDir);
        const state = readRunState(workDir);
        const previousRuns = store.readJsonl<RunState>("runs");
        const result = evaluateChecks({ state, previousRuns, today: todayNewYork(now), weekday: config.recipients.send_days.includes(weekdayNewYork(now)), sources: config.sources });
        state.check = result;
        state.finished_at = now.toISOString();
        writeRunState(workDir, state);
        store.appendJsonl("runs", state);
        out(JSON.stringify(result) + "\n");
        return result.ok ? 0 : 1;
      }
      case "ingest": {
        const name = positional[1];
        const adapter = ADAPTERS.find((a) => a.name === name);
        if (!adapter) { out(`ingest: unknown source ${name}\n${USAGE}`); return 2; }
        const config = loadConfig(configDir);
        const store = new Store(dataDir);
        if (typeof flags.from === "string") {
          // A backfill rewinds the checkpoint; the adapter fetches from there and pre writes the new checkpoint.
          store.writeCheckpoint(adapter.name, { posted_from: flags.from, updated_at: now.toISOString() });
        }
        const state = await runPre({ store, adapters: [adapter], sources: config.sources, filters: config.filters, now, workDir, env, gitSha: gitSha(cwd), httpFactory });
        out(JSON.stringify(state.sources[name!]) + "\n");
        return 0;
      }
      case "export": {
        if (positional[1] !== "csv") { out(USAGE); return 2; }
        mkdirSync(workDir, { recursive: true });
        const target = typeof flags.out === "string" ? flags.out : join(workDir, "opportunities.csv");
        writeFileSync(target, toCsv(new Store(dataDir).list()));
        out(`${target}\n`);
        return 0;
      }
      case "check-env": {
        const names = ["SMTP_USER", "SMTP_APP_PASSWORD", "HEALTHCHECKS_URL", "SOCRATA_APP_TOKEN"];
        for (const n of names) out(`${n}: ${env[n] ? "set" : "missing"}\n`);
        return env.SMTP_USER && env.SMTP_APP_PASSWORD ? 0 : 1;
      }
      case "notify-failure": {
        const step = typeof flags.step === "string" ? flags.step : "?";
        const logPath = typeof flags.log === "string" ? flags.log : null;
        const tail = logPath && existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").slice(-40).join("\n") : "(no log)";
        try {
          const config = loadConfig(configDir);
          const mailer = mailerFactory(env);
          const subject = `propozaler run failed at step ${step} (${todayNewYork(now)})`;
          const text = `${subject}\n\nLast log lines:\n\n${tail}\n`;
          await mailer.send({ from: config.recipients.from, to: [...config.recipients.to], subject, text, html: `<pre>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>` });
          out("failure notice sent\n");
          return 0;
        } catch (err) {
          out(`failure notice could not be sent: ${err instanceof Error ? err.message : String(err)}\n`);
          return 1;
        }
      }
      default:
        out(USAGE);
        return 2;
    }
  } catch (err) {
    out(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  main(process.argv.slice(2), process.env, process.cwd()).then((code) => process.exit(code));
}
