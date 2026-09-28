# propozaler

Internal government bid finder for a two-person company. Reads public procurement sources, stores normalized
opportunities in git, has Claude score them against our bid/no-bid criteria, and emails a short daily digest.
Not a product. Read `SPEC.md` before changing anything; it is the design of record and the place to update
when a decision changes. Go/no-go on the business is 2026-12-31; the build plan is ordered around it, and
`SPEC.md` section 1 lists what is deferred until after that date. Do not build deferred items early.

## Who uses it

- The engineer (TypeScript/Node/React Native background) maintains it alone.
- The partner (outreach and communications) reads the digest on a phone and marks decisions in a shared
  Google Sheet. No Claude account, no terminal. The user-facing surfaces are that email and that sheet.

## Hard constraints

- Zero marginal cost. Runs as a Claude Code cloud routine on the engineer's Max subscription. No servers, no paid
  services, no Anthropic API spend unless `SPEC.md` section 2.6 fallback is invoked deliberately.
- The CLI never calls an LLM in v1. Scoring (and, from milestone 3, extraction from alert emails the parser
  cannot handle) happens inside the routine through file contracts in `work/`: `pending/NN.json` -> `scores/NN.json`,
  `alerts/unparsed/` -> `alerts/extracted/`. The CLI validates every file it reads back with zod.
- All mail and sheet I/O is CLI code: send through the Gmail REST API over HTTPS as a dedicated account (SMTP
  is the local development fallback; interim: `transport: connector` hands the rendered digest to the
  routine's Gmail connector), IMAP read from that account, Sheets API with a service account. Other than
  that interim connector send, the routine has no connectors. The routine agent runs the CLI, scores batch
  files, runs the CLI.
- Deterministic things live in code with offline tests. The routine agent gets a numbered procedure
  (`ROUTINE.md`), not a goal. If the agent keeps improvising a step, move that step into the CLI.
- Boring tech. Node 22 (the cloud environment's default; local may be newer), npm, strict TypeScript, ESM.
  Runtime dependencies are `zod`, `yaml`, `html-to-text`, and `nodemailer`; dev tooling is `typescript`,
  `vitest`, and type packages. No framework, no ORM, no native modules (they will not build in the sandbox).
- Secrets only in environment variables: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`
  (SMTP's `SMTP_USER`/`SMTP_APP_PASSWORD` locally only), `HEALTHCHECKS_URL`, optional `SOCRATA_APP_TOKEN`.
  Never in `data/`, `config/`, fixtures, or logs. `ctx.http` redacts `api_key` and tokens from anything it logs.
- Sources are used within their terms. Public APIs and our own alert emails only. No scraping of BidNet,
  DemandStar, or any site whose terms forbid it. See `SPEC.md` section 9.

## Layout

```
config/    filters.yaml (pre-filter), criteria.md (model-read criteria), sources.yaml, recipients.yaml
prompts/   score.md, extract_alert.md (milestone 3)
src/       cli.ts, model/, sources/, select/, store/, digest/, sheet/, mail/, check/
data/      one JSON per opportunity + runs.jsonl, feedback.jsonl, digests.jsonl, state/
eval/      labeled.jsonl
test/      fixtures/ (recorded source responses), unit tests
work/      gitignored scratch: raw fetches and handoff files for the current run
ROUTINE.md the routine's prompt, verbatim
```

`data/` is committed only on the state branch (`claude/state` unless milestone 1 shows the routine can push to
`main`). Code changes go to `main`; the routine merges `main` into the state branch at the start of each run.

## Commands

```
npm test                      offline; fixtures only, no network, no secrets
propozaler pre                read sheet decisions, ingest all enabled sources, select, write work/pending/NN.json
propozaler post --scores DIR  import scores, render digest, send through the Gmail API, append sheet rows, write run record
propozaler sent --digest-id ID   marks a digest sent when post ran with --no-send and the mail was sent by hand
propozaler notify-failure --step N --log F
propozaler check              post-run invariants; exit code drives the healthchecks ping
propozaler ingest <source> [--from DATE]   one adapter, used for backfills and debugging
propozaler eval prepare | eval compare DIR | report disagreements | export csv | check-env
```

## Conventions

- One adapter per file in `src/sources/`, implementing `SourceAdapter` from `SPEC.md` section 4.1. Adapters are
  pure: no storage, no LLM, all HTTP through `ctx.http`, checkpoint never advances past a failure.
- Adding a source: adapter file, fixture directory with at least one recorded page and one error response,
  a block in `config/sources.yaml`, a row in the field table in `SPEC.md` section 3, a legal note in section 9.
- Every record change appends to `changes[]`; nothing is overwritten silently. Model-extracted values live
  under `score.extracted`, never over source fields.
- Pre-filter matching is whole-word or whole-phrase, case-insensitive, except vendor names which are
  case-sensitive and exact. A record is a candidate only on a category term match; bonuses only order.
- Model output is untrusted text. Every model-written field is schema-validated on import and HTML-escaped
  by the renderer. Source descriptions are public-web content; prompts frame them as data.
- Due dates: `due_at`, then `score.extracted.due_at`, then "not stated". CROL dates render with a
  "per City Record; confirm in PASSPort" label because the City Record does not track addenda.
- Scoring batches are files: `work/pending/NN.json` with at most 10 items each. The CLI enforces the batch
  size and the per-run cap, not the agent. A pending id missing from the scores is a warning and carries over.
- IDs: `${source}:${source_id}`. Digest ids: `YYYY-MM-DD` plus a letter for a same-day repeat; entry ids:
  `<digest id>-NN`. Criteria and prompt versions: first 12 hex chars of the file's sha256, stored on every score.
- Dates are ISO strings. Source-local dates without a zone are America/New_York.
- Tests are fixture-based and run in under ten seconds. Record a fixture from the real source once, commit it,
  never hit the network in tests.
- Config changes that affect scoring (`criteria.md`, `prompts/score.md`) re-queue previously emailed items on
  purpose. Mention this in the commit message.
- Commit messages: imperative, one line, what and why. State commits by the routine follow
  `run <date>: <stats>`.
- Style in docs and prompts: plain, specific, no marketing language.

## Things not to do

- Do not add a web UI, database server, queue, or auth. If it feels necessary, it belongs in `SPEC.md`
  section 10, not in the code.
- Do not tune scoring from feedback automatically. Feedback is reported; a human edits `criteria.md`.
- Do not let the routine edit `src/`, `config/`, or `prompts/`.
- Do not widen the pre-filter or add a source without a fixture and a legal note.
- Do not send anything other than the rendered digest or the failure notice, and only from the CLI's sender.
- Do not commit generated views (CSV exports) to the state branch; regenerate on demand.

## Working with Claude Code on this repo

- Design changes: update `SPEC.md` first, then code. Keep the rejected-alternative notes; they are why.
- Prefer small, single-purpose modules; the file handoff contracts and the adapter interface are the seams.
- When measuring (token use per run, SAM request headroom, score drift), write the number into `SPEC.md`
  with the date. Numbers in the spec marked "to be measured" are placeholders until then.
