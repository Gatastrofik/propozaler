# Milestone 1: CROL to Inbox, Unscored — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code cloud routine runs a TypeScript CLI every morning that fetches NYC City Record procurement notices, stores them as JSON in git, pre-filters them with word-boundary rules, emails a capped digest to two people over SMTP, and pings a dead-man's switch only when post-run checks pass.

**Architecture:** One CLI (`propozaler`) owns everything deterministic: adapter → store → select → digest → send → check. A routine is the scheduler; in milestone 1 it runs `pre`, `post`, `check`, commits the state branch, and pings healthchecks. No LLM is involved until milestone 2, so the digest threshold is the pre-filter `net_score` and the summary is the first 200 characters of the description.

**Tech Stack:** Node 22, TypeScript (strict, ESM, NodeNext), npm, `zod` 4, `yaml` 2, `html-to-text` 10, `nodemailer` 10, `vitest` 5. No native modules.

**Spec:** `SPEC.md` (sections 2, 3, 4.1, 4.2, 4.4, 6, 7, 8 milestone 1). Read it before starting. `CLAUDE.md` holds the conventions.

## Global Constraints

- Runtime dependencies are exactly `zod`, `yaml`, `html-to-text`, `nodemailer`. Dev: `typescript`, `vitest`, `@types/node`, `@types/nodemailer`, `@types/html-to-text`. Nothing else without editing `SPEC.md` first.
- `engines.node >= 22`. Local machine has Node 25; the cloud sandbox has Node 22 on `PATH`. Do not use APIs newer than 22 (no `node:sqlite`, no unflagged type stripping; always run built JS).
- ESM only. TypeScript source imports use `.js` extensions (`import { x } from "./y.js"`).
- The CLI never calls an LLM. Nothing in `src/` imports an Anthropic SDK.
- `npm test` runs offline in under ten seconds. Tests never touch the network; adapters get an injected `fetch`.
- Secrets only via environment variables: `SMTP_USER`, `SMTP_APP_PASSWORD`, `HEALTHCHECKS_URL`, `SOCRATA_APP_TOKEN` (optional). Never logged, never in `data/`.
- Pre-filter matching is whole-word or whole-phrase; vendor names are case-sensitive; a record is a candidate only on a category match (SPEC 4.4).
- Every model-written or source-written string that reaches HTML is escaped (SPEC 6.3). In milestone 1 that means every source string.
- Dates: ISO strings. Source-local datetimes without a zone are America/New_York. `posted_at` and `archive_at` are `YYYY-MM-DD`; `due_at` is a full ISO datetime with offset.
- `data/` is committed only on the state branch. `work/` is gitignored.
- Commit after every task with a one-line imperative message. Do not push the state branch by hand during development; the routine owns it.
- Plain language in all user-facing text and docs. No marketing.

## File Structure

```
package.json, tsconfig.json, .gitignore (exists), README.md
config/
  filters.yaml            pre-filter rules (SPEC 4.4 starter content)
  sources.yaml            { crol: { enabled, base_url, limit, overlap_days, default_from } }
  recipients.yaml         { from, to[], send_days[], cap, min_net_score, sheet_url }
src/
  cli.ts                  argv parsing, subcommand dispatch, path resolution
  config.ts               loadYamlFile + schemas for sources.yaml and recipients.yaml
  model/time.ts           New York offset, local→ISO, date parts, weekday
  model/opportunity.ts    zod schemas, types, contentHash, idToFilename, newOpportunity
  store/store.ts          per-record JSON files, JSONL logs, checkpoints, upsert semantics
  sources/types.ts        SourceAdapter, FetchContext, FetchResult, Checkpoint, HttpClient
  sources/http.ts         createHttpClient: timeout, retry, throttle, redacted request log
  sources/crol.ts         CROL adapter: URL, paging, column drift, normalize
  select/filters.ts       filters.yaml schema, termRegex, selectOpportunity
  digest/select.ts        effectiveDue, selectDigestEntries (threshold, cap, ordering)
  digest/render.ts        escapeHtml, formatDue, renderDigest → { subject, html, text }
  digest/mailer.ts        Mailer interface, createSmtpMailer (nodemailer, smtps 465)
  run/state.ts            RunState schema, read/write work/run.json
  run/pre.ts              runPre: adapters → upsert → select → checkpoint → run.json
  run/post.ts             runPost: select entries → render → send → digests.jsonl → meta
  check/check.ts          evaluateChecks over run.json + runs.jsonl → ok/warnings/failures
  export/csv.ts           toCsv(records)
test/
  fixtures/crol/columns.json, page-1.json, page-empty.json
  *.test.ts               one per src module
ROUTINE.md                the routine prompt, verbatim
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `README.md`, `test/smoke.test.ts`
- Modify: `.gitignore` (already excludes `node_modules/`, `dist/`, `work/`, `.env`)

**Interfaces:**
- Produces: `npm run build` → `dist/`, `npm test` → vitest, `npm run propozaler -- <cmd>` → `node dist/cli.js <cmd>`.

- [ ] **Step 1: Write package.json**

```json
{
  "name": "propozaler",
  "version": "0.1.0",
  "private": true,
  "description": "Internal government bid finder: daily digest of relevant solicitations",
  "type": "module",
  "engines": { "node": ">=22" },
  "bin": { "propozaler": "dist/cli.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "propozaler": "node dist/cli.js"
  },
  "dependencies": {
    "html-to-text": "^10.0.1",
    "nodemailer": "^10.0.11",
    "yaml": "^2.9.1",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@types/html-to-text": "^9.0.4",
    "@types/node": "^22.0.0",
    "@types/nodemailer": "^6.4.17",
    "typescript": "^5.6.0",
    "vitest": "^5.0.2"
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "types": ["node"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Write a smoke test**

`test/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";

describe("toolchain", () => {
  it("runs vitest", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 4: Write README.md**

```markdown
# propozaler

Internal government bid finder. See `SPEC.md` for the design and `CLAUDE.md` for conventions.

## Develop

    npm ci
    npm test          # offline unit tests
    npm run build     # compile to dist/
    npm run propozaler -- check-env

## Run locally

Copy `.env.example` to `.env`, fill it in, then `set -a; source .env; set +a` and:

    npm run propozaler -- pre
    npm run propozaler -- post --no-send   # writes work/digest.html without sending
    npm run propozaler -- check

Production runs happen in a Claude Code routine; see `ROUTINE.md`.
```

- [ ] **Step 5: Install and verify**

Run: `npm install && npm test && npm run typecheck`
Expected: vitest reports 1 passed; typecheck exits 0 (no files yet is fine, tsc reports nothing).

If `npm install` reports a peer or version conflict on any pinned version, use the newest version that installs cleanly and note it in the commit message; do not add packages.

- [ ] **Step 6: Add .env.example**

```
SMTP_USER=propozaler.digest@gmail.com
SMTP_APP_PASSWORD=
HEALTHCHECKS_URL=https://hc-ping.com/REPLACE-ME
SOCRATA_APP_TOKEN=
```

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json README.md .env.example test/smoke.test.ts
git commit -m "Scaffold TypeScript project with vitest"
```

---

### Task 2: Time helpers

**Files:**
- Create: `src/model/time.ts`
- Test: `test/time.test.ts`

**Interfaces:**
- Produces:
  - `newYorkOffset(at: Date): string` → `"-04:00"` or `"-05:00"`
  - `fromNewYorkLocal(local: string): string` → ISO with offset, e.g. `"2026-09-15T00:00:00-04:00"`
  - `datePart(s: string): string` → first 10 chars `YYYY-MM-DD`
  - `todayNewYork(now: Date): string` → `YYYY-MM-DD` in America/New_York
  - `weekdayNewYork(now: Date): Weekday` where `type Weekday = "Mon"|"Tue"|"Wed"|"Thu"|"Fri"|"Sat"|"Sun"`
  - `addDays(ymd: string, n: number): string`

- [ ] **Step 1: Write the failing tests**

`test/time.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { newYorkOffset, fromNewYorkLocal, datePart, todayNewYork, weekdayNewYork, addDays } from "../src/model/time.js";

describe("time", () => {
  it("knows the New York offset in summer and winter", () => {
    expect(newYorkOffset(new Date("2026-07-01T12:00:00Z"))).toBe("-04:00");
    expect(newYorkOffset(new Date("2026-01-15T12:00:00Z"))).toBe("-05:00");
  });

  it("converts Socrata local datetimes to ISO with offset", () => {
    expect(fromNewYorkLocal("2026-09-15T00:00:00.000")).toBe("2026-09-15T00:00:00-04:00");
    expect(fromNewYorkLocal("2026-10-05T16:00:00.000")).toBe("2026-10-05T16:00:00-04:00");
    expect(fromNewYorkLocal("2026-12-01")).toBe("2026-12-01T00:00:00-05:00");
  });

  it("rejects garbage", () => {
    expect(() => fromNewYorkLocal("yesterday")).toThrow(/bad local datetime/);
  });

  it("takes the date part", () => {
    expect(datePart("2026-09-15T00:00:00.000")).toBe("2026-09-15");
  });

  it("reports today and weekday in New York", () => {
    // 2026-09-27 is a Sunday. 03:00Z on the 28th is still Sunday 23:00 in New York.
    const late = new Date("2026-09-28T03:00:00Z");
    expect(todayNewYork(late)).toBe("2026-09-27");
    expect(weekdayNewYork(late)).toBe("Sun");
    const morning = new Date("2026-09-28T11:00:00Z");
    expect(todayNewYork(morning)).toBe("2026-09-28");
    expect(weekdayNewYork(morning)).toBe("Mon");
  });

  it("adds days across month ends", () => {
    expect(addDays("2026-09-30", 2)).toBe("2026-10-02");
    expect(addDays("2026-03-01", -2)).toBe("2026-02-27");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/time.test.ts`
Expected: FAIL, cannot find module `../src/model/time.js`.

- [ ] **Step 3: Implement**

`src/model/time.ts`:
```ts
const NY = "America/New_York";

export type Weekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

export function newYorkOffset(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: NY, timeZoneName: "longOffset" }).formatToParts(at);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-05:00";
  const m = /GMT([+-]\d{2}:\d{2})/.exec(name);
  return m?.[1] ?? "-05:00";
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/;

export function fromNewYorkLocal(local: string): string {
  const m = LOCAL_RE.exec(local);
  if (!m) throw new Error(`bad local datetime: ${local}`);
  const [, y, mo, d, h = "00", mi = "00", s = "00"] = m;
  // Approximate the instant by reading the wall-clock time as UTC, then ask for the offset there.
  // Only wrong inside the one repeated hour in November, which no due date lands on.
  const approx = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${newYorkOffset(approx)}`;
}

export function datePart(s: string): string {
  return s.slice(0, 10);
}

function nyParts(now: Date): { ymd: string; weekday: Weekday } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday as Weekday };
}

export function todayNewYork(now: Date): string {
  return nyParts(now).ymd;
}

export function weekdayNewYork(now: Date): Weekday {
  return nyParts(now).weekday;
}

export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/time.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src/model/time.ts test/time.test.ts
git commit -m "Add New York time helpers"
```

---

### Task 3: Opportunity model

**Files:**
- Create: `src/model/opportunity.ts`
- Test: `test/opportunity.test.ts`

**Interfaces:**
- Produces:
  - `NoticeTypeSchema`, `NoticeType`; `BuyerLevelSchema`, `BuyerLevel`
  - `NormalizedOpportunitySchema`, `NormalizedOpportunity` (what adapters return)
  - `PrefilterSchema`, `Prefilter` = `{ net_score: number; matched: string[]; stage: "candidate"|"filtered_out"; filters_version: number }`
  - `FeedbackSchema`, `Feedback`
  - `OpportunitySchema`, `Opportunity` (stored record = normalized + pipeline fields)
  - `HASH_FIELDS`, `contentHash(n): string`
  - `idToFilename(id: string): string` (`"crol:123"` → `"crol__123.json"`)
  - `newOpportunity(n: NormalizedOpportunity, now: string): Opportunity`

- [ ] **Step 1: Write the shared fixture helper and the failing tests**

`test/helpers.ts` (imported by most later tests; it is not a test file):
```ts
import { NormalizedOpportunitySchema, type NormalizedOpportunity } from "../src/model/opportunity.js";

export const NOW = "2026-09-27T11:00:00Z";

export function sampleNormalized(over: Partial<NormalizedOpportunity> = {}): NormalizedOpportunity {
  return NormalizedOpportunitySchema.parse({
    id: "crol:20260909003",
    source: "crol",
    source_id: "20260909003",
    source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260909003",
    title: "Brooklyn Bridge Park Pier 1 Pavilion Stair Replacement",
    notice_type: "solicitation",
    notice_type_raw: "Solicitation",
    agency: "Brooklyn Bridge Park",
    agency_path: "City of New York > Brooklyn Bridge Park",
    buyer_level: "authority",
    place: { state: "NY", city: "New York" },
    posted_at: "2026-09-15",
    due_at: "2026-10-05T16:00:00-04:00",
    due_at_source: "crol",
    archive_at: "2026-09-15",
    solicitation_number: "BBP Pier 1 Pavilion",
    category_raw: "Construction/Construction Services",
    selection_method: "Request for Proposals",
    contacts: [{ name: "John Zhang", email: "proposals@bbp.nyc" }],
    submit_to: "334 Furman Street, Brooklyn, NY 11201",
    description_text: "Stair remediation work at the Pier 1 pavilion.",
    description_fetched_at: "2026-09-27T11:00:00Z",
    ...over,
  });
}
```

`test/opportunity.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { OpportunitySchema, contentHash, idToFilename, newOpportunity } from "../src/model/opportunity.js";
import { sampleNormalized } from "./helpers.js";

describe("opportunity model", () => {
  it("applies defaults for optional fields", () => {
    const n = sampleNormalized();
    expect(n.naics).toEqual([]);
    expect(n.attachments).toEqual([]);
    expect(n.psc).toBeNull();
    expect(n.estimated_value).toBeNull();
  });

  it("hashes only the fields that matter", () => {
    const a = sampleNormalized();
    const b = sampleNormalized({ contacts: [] });          // not a hash field
    const c = sampleNormalized({ title: "Different" });    // hash field
    expect(contentHash(a)).toBe(contentHash(b));
    expect(contentHash(a)).not.toBe(contentHash(c));
    expect(contentHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("maps ids to filenames", () => {
    expect(idToFilename("crol:20260909003")).toBe("crol__20260909003.json");
  });

  it("builds a stored record with pipeline defaults", () => {
    const o = newOpportunity(sampleNormalized(), "2026-09-27T11:00:00Z");
    expect(o.first_seen_at).toBe("2026-09-27T11:00:00Z");
    expect(o.last_seen_at).toBe("2026-09-27T11:00:00Z");
    expect(o.changes).toEqual([]);
    expect(o.prefilter).toBeNull();
    expect(o.feedback).toBeNull();
    expect(o.digest).toEqual({ sent_in: [], sent_hash: null });
    expect(OpportunitySchema.parse(o)).toEqual(o);
  });

  it("rejects an unknown notice type", () => {
    expect(() => sampleNormalized({ notice_type: "rfq" as never })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/opportunity.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/model/opportunity.ts`:
```ts
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
  }).default({ state: null, city: null, zip: null }),
  posted_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  due_at: z.string().nullable().default(null),
  due_at_source: z.string().nullable().default(null),
  archive_at: z.string().nullable().default(null),
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
  }).default({ sent_in: [], sent_hash: null }),
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/opportunity.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/model/opportunity.ts test/helpers.ts test/opportunity.test.ts
git commit -m "Add normalized opportunity schema and content hash"
```

---

### Task 4: Adapter types and the store

**Files:**
- Create: `src/sources/types.ts`, `src/store/store.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Produces (`src/sources/types.ts`):
  ```ts
  export interface Checkpoint { posted_from: string; updated_at: string }   // posted_from is YYYY-MM-DD
  export interface HttpRequestLog { method: string; url: string; status: number | null; ms: number; error?: string }
  export interface HttpClient { getJson<T = unknown>(url: string, init?: { headers?: Record<string, string> }): Promise<T>; readonly log: HttpRequestLog[] }
  export interface SourceStats { requests: number; fetched: number; normalized: number; skipped: number; errors: string[] }
  export interface FetchContext { config: Record<string, unknown>; checkpoint: Checkpoint | null; now: Date; http: HttpClient; secrets: (name: string) => string | undefined; rawSink: (label: string, body: unknown) => void }
  export interface FetchResult { records: NormalizedOpportunity[]; checkpoint: Checkpoint; stats: SourceStats; partial: boolean }
  export interface SourceAdapter { name: string; fetch(ctx: FetchContext): Promise<FetchResult> }
  ```
- Produces (`src/store/store.ts`): `class Store` with
  - `constructor(dataDir: string)` (creates `opportunities/` and `state/` on demand)
  - `list(): Opportunity[]`, `get(id): Opportunity | null`, `save(o): void`
  - `upsert(n: NormalizedOpportunity, now: string): { record: Opportunity; isNew: boolean; changed: string[] }`
  - `appendJsonl(name: string, obj: unknown): void`, `readJsonl<T>(name: string): T[]`
  - `readCheckpoint(source): Checkpoint | null`, `writeCheckpoint(source, cp): void`

Upsert rules (SPEC 3, 4.1): new id → `newOpportunity`. Existing id → copy every normalized field from `n`, keep pipeline fields (`changes`, `duplicate_of`, `prefilter`, `score`, `feedback`, `digest`, `first_seen_at`), set `last_seen_at = now`, recompute `content_hash`. If the hash differs, `changed` lists the `HASH_FIELDS` whose JSON differs. Append `{ at: now, fields }` to `changes` unless the only change is `description_text` going from `null` to text. Git churn rule: if the hash is unchanged and `last_seen_at` is less than 7 days old, return the existing record untouched and write nothing, so the two-day overlap window does not rewrite files every run.

- [ ] **Step 1: Write the failing tests**

`test/store.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/store.js";
import { sampleNormalized } from "./helpers.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "propozaler-store-")); });

describe("Store.upsert", () => {
  it("creates a record file for a new id", () => {
    const s = new Store(dir);
    const { record, isNew, changed } = s.upsert(sampleNormalized(), "2026-09-27T11:00:00Z");
    expect(isNew).toBe(true);
    expect(changed).toEqual([]);
    expect(existsSync(join(dir, "opportunities", "crol__20260909003.json"))).toBe(true);
    expect(s.get(record.id)?.title).toBe(record.title);
  });

  it("is idempotent for identical input and does not rewrite a record seen in the last 7 days", () => {
    const s = new Store(dir);
    s.upsert(sampleNormalized(), "2026-09-27T11:00:00Z");
    const second = s.upsert(sampleNormalized(), "2026-09-28T11:00:00Z");
    expect(second.isNew).toBe(false);
    expect(second.changed).toEqual([]);
    expect(second.record.changes).toEqual([]);
    expect(second.record.first_seen_at).toBe("2026-09-27T11:00:00Z");
    expect(second.record.last_seen_at).toBe("2026-09-27T11:00:00Z"); // unchanged: no write, no git churn
    const third = s.upsert(sampleNormalized(), "2026-10-10T11:00:00Z");
    expect(third.record.last_seen_at).toBe("2026-10-10T11:00:00Z");  // older than 7 days: refreshed
  });

  it("records an amendment when a hash field changes and keeps pipeline fields", () => {
    const s = new Store(dir);
    const first = s.upsert(sampleNormalized(), "2026-09-27T11:00:00Z");
    first.record.prefilter = { net_score: 5, matched: ["cat:parks_rec:recreation software"], stage: "candidate", filters_version: 2 };
    s.save(first.record);
    const second = s.upsert(sampleNormalized({ due_at: "2026-10-30T16:00:00-04:00" }), "2026-09-28T11:00:00Z");
    expect(second.changed).toEqual(["due_at"]);
    expect(second.record.changes).toEqual([{ at: "2026-09-28T11:00:00Z", fields: ["due_at"] }]);
    expect(second.record.prefilter?.net_score).toBe(5);
    expect(second.record.due_at).toBe("2026-10-30T16:00:00-04:00");
  });

  it("does not treat a first description as an amendment", () => {
    const s = new Store(dir);
    s.upsert(sampleNormalized({ description_text: null }), "2026-09-27T11:00:00Z");
    const second = s.upsert(sampleNormalized(), "2026-09-28T11:00:00Z");
    expect(second.changed).toEqual(["description_text"]);
    expect(second.record.changes).toEqual([]);
    expect(second.record.description_text).toContain("Stair remediation");
  });

  it("lists every record", () => {
    const s = new Store(dir);
    s.upsert(sampleNormalized(), "2026-09-27T11:00:00Z");
    s.upsert(sampleNormalized({ id: "crol:2", source_id: "2" }), "2026-09-27T11:00:00Z");
    expect(s.list().map((o) => o.id).sort()).toEqual(["crol:2", "crol:20260909003"]);
  });
});

describe("Store logs and checkpoints", () => {
  it("appends and reads JSONL", () => {
    const s = new Store(dir);
    s.appendJsonl("runs", { a: 1 });
    s.appendJsonl("runs", { a: 2 });
    expect(s.readJsonl<{ a: number }>("runs").map((x) => x.a)).toEqual([1, 2]);
    expect(readFileSync(join(dir, "runs.jsonl"), "utf8").endsWith("\n")).toBe(true);
    expect(s.readJsonl("missing")).toEqual([]);
  });

  it("round-trips a checkpoint", () => {
    const s = new Store(dir);
    expect(s.readCheckpoint("crol")).toBeNull();
    s.writeCheckpoint("crol", { posted_from: "2026-09-27", updated_at: "2026-09-27T11:00:00Z" });
    expect(s.readCheckpoint("crol")).toEqual({ posted_from: "2026-09-27", updated_at: "2026-09-27T11:00:00Z" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/store.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement types**

`src/sources/types.ts`:
```ts
import type { NormalizedOpportunity } from "../model/opportunity.js";

export interface Checkpoint {
  posted_from: string; // YYYY-MM-DD, the newest posted date fully covered
  updated_at: string;  // ISO
}

export interface HttpRequestLog {
  method: string;
  url: string; // secrets redacted
  status: number | null;
  ms: number;
  error?: string;
}

export interface HttpClient {
  getJson<T = unknown>(url: string, init?: { headers?: Record<string, string> }): Promise<T>;
  readonly log: HttpRequestLog[];
}

export interface SourceStats {
  requests: number;
  fetched: number;
  normalized: number;
  skipped: number;
  errors: string[];
}

export interface FetchContext {
  config: Record<string, unknown>;
  checkpoint: Checkpoint | null;
  now: Date;
  http: HttpClient;
  secrets: (name: string) => string | undefined;
  rawSink: (label: string, body: unknown) => void;
}

export interface FetchResult {
  records: NormalizedOpportunity[];
  checkpoint: Checkpoint;
  stats: SourceStats;
  partial: boolean;
}

export interface SourceAdapter {
  name: string;
  fetch(ctx: FetchContext): Promise<FetchResult>;
}
```

- [ ] **Step 4: Implement the store**

`src/store/store.ts`:
```ts
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  HASH_FIELDS, OpportunitySchema, contentHash, idToFilename, newOpportunity,
  type NormalizedOpportunity, type Opportunity,
} from "../model/opportunity.js";
import type { Checkpoint } from "../sources/types.js";

export class Store {
  private readonly oppDir: string;
  private readonly stateDir: string;

  constructor(readonly dataDir: string) {
    this.oppDir = join(dataDir, "opportunities");
    this.stateDir = join(dataDir, "state");
    mkdirSync(this.oppDir, { recursive: true });
    mkdirSync(this.stateDir, { recursive: true });
  }

  list(): Opportunity[] {
    return readdirSync(this.oppDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => OpportunitySchema.parse(JSON.parse(readFileSync(join(this.oppDir, f), "utf8"))));
  }

  get(id: string): Opportunity | null {
    const p = join(this.oppDir, idToFilename(id));
    if (!existsSync(p)) return null;
    return OpportunitySchema.parse(JSON.parse(readFileSync(p, "utf8")));
  }

  save(o: Opportunity): void {
    const clean = OpportunitySchema.parse(o);
    writeFileSync(join(this.oppDir, idToFilename(o.id)), JSON.stringify(clean, null, 2) + "\n");
  }

  upsert(n: NormalizedOpportunity, now: string): { record: Opportunity; isNew: boolean; changed: string[] } {
    const existing = this.get(n.id);
    if (!existing) {
      const record = newOpportunity(n, now);
      this.save(record);
      return { record, isNew: true, changed: [] };
    }
    const newHash = contentHash(n);
    const seenRecently = Date.parse(now) - Date.parse(existing.last_seen_at) < 7 * 24 * 60 * 60 * 1000;
    if (newHash === existing.content_hash && seenRecently) {
      return { record: existing, isNew: false, changed: [] };
    }
    const changed = newHash === existing.content_hash
      ? []
      : HASH_FIELDS.filter((f) => JSON.stringify(existing[f]) !== JSON.stringify(n[f]));
    const onlyFirstDescription =
      changed.length === 1 && changed[0] === "description_text" && existing.description_text === null;
    const record: Opportunity = OpportunitySchema.parse({
      ...existing,
      ...n,
      content_hash: newHash,
      last_seen_at: now,
      changes: changed.length > 0 && !onlyFirstDescription
        ? [...existing.changes, { at: now, fields: [...changed] }]
        : existing.changes,
    });
    this.save(record);
    return { record, isNew: false, changed: [...changed] };
  }

  appendJsonl(name: string, obj: unknown): void {
    appendFileSync(join(this.dataDir, `${name}.jsonl`), JSON.stringify(obj) + "\n");
  }

  readJsonl<T>(name: string): T[] {
    const p = join(this.dataDir, `${name}.jsonl`);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as T);
  }

  readCheckpoint(source: string): Checkpoint | null {
    const p = join(this.stateDir, `${source}.json`);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as Checkpoint;
  }

  writeCheckpoint(source: string, cp: Checkpoint): void {
    writeFileSync(join(this.stateDir, `${source}.json`), JSON.stringify(cp, null, 2) + "\n");
  }
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/store.test.ts`
Expected: 7 passed.

- [ ] **Step 6: Commit**

```bash
git add src/sources/types.ts src/store/store.ts test/store.test.ts
git commit -m "Add adapter types and per-record JSON store with upsert semantics"
```

---

### Task 5: HTTP client with retry, throttle, and redacted log

**Files:**
- Create: `src/sources/http.ts`
- Test: `test/http.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class HttpError extends Error { constructor(readonly status: number, readonly url: string, readonly bodySnippet: string) }
  export interface HttpClientOptions {
    fetchImpl?: typeof fetch;        // injected in tests
    timeoutMs?: number;              // default 30000
    minIntervalMs?: number;          // default 250; wait between requests
    maxRetries?: number;             // default 2; applies to 5xx and network errors
    retryOn429?: boolean;            // default false (SAM treats 429 as terminal)
    sleep?: (ms: number) => Promise<void>;
    redactParams?: string[];         // default ["api_key", "$$app_token"]
    defaultHeaders?: Record<string, string>;
  }
  export function createHttpClient(opts?: HttpClientOptions): HttpClient
  export function redactUrl(url: string, params: string[]): string
  ```

- [ ] **Step 1: Write the failing tests**

`test/http.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createHttpClient, redactUrl, HttpError } from "../src/sources/http.js";

function fakeFetch(responses: Array<{ status: number; body: unknown } | Error>) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

const noSleep = async () => {};

describe("createHttpClient", () => {
  it("returns parsed JSON and logs the request", async () => {
    const f = fakeFetch([{ status: 200, body: { ok: 1 } }]);
    const http = createHttpClient({ fetchImpl: f.impl, sleep: noSleep });
    expect(await http.getJson("https://x.test/a?api_key=SECRET")).toEqual({ ok: 1 });
    expect(http.log).toHaveLength(1);
    expect(http.log[0]?.status).toBe(200);
    expect(http.log[0]?.url).toBe("https://x.test/a?api_key=REDACTED");
  });

  it("retries 5xx then succeeds", async () => {
    const f = fakeFetch([{ status: 503, body: {} }, { status: 200, body: { ok: 2 } }]);
    const http = createHttpClient({ fetchImpl: f.impl, sleep: noSleep });
    expect(await http.getJson("https://x.test/b")).toEqual({ ok: 2 });
    expect(f.calls).toHaveLength(2);
    expect(http.log).toHaveLength(2);
  });

  it("does not retry 429 by default and throws HttpError", async () => {
    const f = fakeFetch([{ status: 429, body: { error: "OVER_RATE_LIMIT" } }]);
    const http = createHttpClient({ fetchImpl: f.impl, sleep: noSleep });
    await expect(http.getJson("https://x.test/c")).rejects.toBeInstanceOf(HttpError);
    expect(f.calls).toHaveLength(1);
  });

  it("gives up after maxRetries on network errors", async () => {
    const f = fakeFetch([new Error("ECONNRESET"), new Error("ECONNRESET"), new Error("ECONNRESET")]);
    const http = createHttpClient({ fetchImpl: f.impl, sleep: noSleep, maxRetries: 2 });
    await expect(http.getJson("https://x.test/d")).rejects.toThrow(/ECONNRESET/);
    expect(f.calls).toHaveLength(3);
    expect(http.log.at(-1)?.error).toMatch(/ECONNRESET/);
  });

  it("does not log header values", async () => {
    const f = fakeFetch([{ status: 200, body: {} }]);
    const http = createHttpClient({ fetchImpl: f.impl, sleep: noSleep, defaultHeaders: { "X-App-Token": "TOKEN" } });
    await http.getJson("https://x.test/e");
    expect(JSON.stringify(http.log)).not.toContain("TOKEN");
  });
});

describe("redactUrl", () => {
  it("replaces listed query values only", () => {
    expect(redactUrl("https://x.test/?a=1&api_key=k&$$app_token=t", ["api_key", "$$app_token"]))
      .toBe("https://x.test/?a=1&api_key=REDACTED&%24%24app_token=REDACTED");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/http.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/sources/http.ts`:
```ts
import type { HttpClient, HttpRequestLog } from "./types.js";

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string, readonly bodySnippet: string) {
    super(`HTTP ${status} for ${url}: ${bodySnippet}`);
    this.name = "HttpError";
  }
}

export interface HttpClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  minIntervalMs?: number;
  maxRetries?: number;
  retryOn429?: boolean;
  sleep?: (ms: number) => Promise<void>;
  redactParams?: string[];
  defaultHeaders?: Record<string, string>;
}

export function redactUrl(url: string, params: string[]): string {
  const u = new URL(url);
  for (const p of params) if (u.searchParams.has(p)) u.searchParams.set(p, "REDACTED");
  return u.toString();
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createHttpClient(opts: HttpClientOptions = {}): HttpClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const minIntervalMs = opts.minIntervalMs ?? 250;
  const maxRetries = opts.maxRetries ?? 2;
  const retryOn429 = opts.retryOn429 ?? false;
  const sleep = opts.sleep ?? defaultSleep;
  const redactParams = opts.redactParams ?? ["api_key", "$$app_token"];
  const log: HttpRequestLog[] = [];
  let lastAt = 0;

  async function once(url: string, headers: Record<string, string>): Promise<Response> {
    const wait = lastAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { headers, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    log,
    async getJson<T>(url: string, init: { headers?: Record<string, string> } = {}): Promise<T> {
      const headers = { accept: "application/json", ...(opts.defaultHeaders ?? {}), ...(init.headers ?? {}) };
      const safeUrl = redactUrl(url, redactParams);
      let attempt = 0;
      for (;;) {
        const started = Date.now();
        try {
          const res = await once(url, headers);
          const ms = Date.now() - started;
          log.push({ method: "GET", url: safeUrl, status: res.status, ms });
          if (res.ok) return (await res.json()) as T;
          const snippet = (await res.text()).slice(0, 200);
          const retryable = res.status >= 500 || (res.status === 429 && retryOn429);
          if (retryable && attempt < maxRetries) {
            attempt += 1;
            await sleep(500 * 2 ** attempt);
            continue;
          }
          throw new HttpError(res.status, safeUrl, snippet);
        } catch (err) {
          if (err instanceof HttpError) throw err;
          const ms = Date.now() - started;
          const message = err instanceof Error ? err.message : String(err);
          log.push({ method: "GET", url: safeUrl, status: null, ms, error: message });
          if (attempt < maxRetries) {
            attempt += 1;
            await sleep(500 * 2 ** attempt);
            continue;
          }
          throw new Error(`request failed for ${safeUrl}: ${message}`);
        }
      }
    },
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/http.test.ts`
Expected: 6 passed. If the `redactUrl` expectation on `%24%24app_token` differs on your Node, adjust the expected string to whatever `URL.toString()` produces for `$$app_token` and keep the assertion that the value is `REDACTED`.

- [ ] **Step 5: Commit**

```bash
git add src/sources/http.ts test/http.test.ts
git commit -m "Add HTTP client with retry, throttle, and redacted request log"
```

---

### Task 6: CROL adapter

**Files:**
- Create: `src/sources/crol.ts`, `test/fixtures/crol/columns.json`, `test/fixtures/crol/page-1.json`, `test/fixtures/crol/page-empty.json`
- Test: `test/crol.test.ts`

**Interfaces:**
- Consumes: `createHttpClient` (Task 5), `Store` types (Task 4), `fromNewYorkLocal`, `datePart`, `addDays`, `todayNewYork` (Task 2), `NormalizedOpportunitySchema` (Task 3).
- Produces:
  ```ts
  export const CROL_COLUMNS: readonly string[]                 // the 20 verified field names
  export const CrolConfigSchema = z.object({ enabled: z.boolean().default(true), base_url: z.string().url().default("https://data.cityofnewyork.us/resource/dg92-zbpx.json"), columns_url: z.string().url().default("https://data.cityofnewyork.us/api/views/dg92-zbpx/columns.json"), limit: z.number().int().min(1).max(1000).default(1000), overlap_days: z.number().int().min(0).default(2), default_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
  export type CrolConfig = z.infer<typeof CrolConfigSchema>
  export function buildCrolUrl(base: string, postedFrom: string, limit: number, offset: number): string
  export function missingCrolColumns(columns: Array<{ fieldName: string }>): string[]
  export function normalizeCrolRow(row: Record<string, unknown>, nowIso: string): NormalizedOpportunity | null   // null when unusable
  export const crolAdapter: SourceAdapter                     // name "crol"
  ```

- [ ] **Step 1: Write fixtures**

`test/fixtures/crol/columns.json` (the 20 verified field names in the shape Socrata returns; other properties omitted on purpose):
```json
[
  {"fieldName": "request_id", "dataTypeName": "number"},
  {"fieldName": "start_date", "dataTypeName": "calendar_date"},
  {"fieldName": "end_date", "dataTypeName": "calendar_date"},
  {"fieldName": "agency_name", "dataTypeName": "text"},
  {"fieldName": "type_of_notice_description", "dataTypeName": "text"},
  {"fieldName": "category_description", "dataTypeName": "text"},
  {"fieldName": "short_title", "dataTypeName": "text"},
  {"fieldName": "selection_method_description", "dataTypeName": "text"},
  {"fieldName": "section_name", "dataTypeName": "text"},
  {"fieldName": "special_case_reason_description", "dataTypeName": "text"},
  {"fieldName": "pin", "dataTypeName": "text"},
  {"fieldName": "due_date", "dataTypeName": "calendar_date"},
  {"fieldName": "address_to_request", "dataTypeName": "text"},
  {"fieldName": "contact_name", "dataTypeName": "text"},
  {"fieldName": "contact_phone", "dataTypeName": "text"},
  {"fieldName": "email", "dataTypeName": "text"},
  {"fieldName": "contract_amount", "dataTypeName": "number"},
  {"fieldName": "contact_fax", "dataTypeName": "text"},
  {"fieldName": "additional_description_1", "dataTypeName": "text"},
  {"fieldName": "additional_description_2", "dataTypeName": "text"}
]
```

`test/fixtures/crol/page-1.json` (three real rows observed 2026-09-27, lightly trimmed):
```json
[
  {
    "request_id": "20260909003",
    "start_date": "2026-09-15T00:00:00.000",
    "end_date": "2026-09-15T00:00:00.000",
    "agency_name": "Brooklyn Bridge Park",
    "type_of_notice_description": "Solicitation",
    "category_description": "Construction/Construction Services",
    "short_title": "Brooklyn Bridge Park Pier 1 Pavilion Stair Replacement",
    "selection_method_description": "Request for Proposals",
    "section_name": "Procurement",
    "pin": "BBP Pier 1 Pavilion",
    "due_date": "2026-10-05T16:00:00.000",
    "address_to_request": "334 Furman Street, Brooklyn, NY 11201",
    "contact_name": "John Zhang",
    "contact_phone": "(000) 000-0000",
    "email": "proposals@bbp.nyc",
    "additional_description_1": "<p><strong>Stair remediation</strong> work at the Pier&nbsp;1 pavilion, including demolition of the existing stair.</p>"
  },
  {
    "request_id": "20260901026",
    "start_date": "2026-09-15T00:00:00.000",
    "end_date": "2026-09-15T00:00:00.000",
    "agency_name": "Housing Authority",
    "type_of_notice_description": "Solicitation",
    "category_description": "Services (other than human services)",
    "short_title": "RFP 523138 - Construction Management Services",
    "selection_method_description": "Request for Proposals",
    "section_name": "Procurement",
    "pin": "523138",
    "due_date": "2026-10-13T14:00:00.000",
    "address_to_request": "90 Church Street, 6th Floor, New York, NY 10007",
    "contact_name": "Alexander Davila",
    "contact_phone": "(212) 306-4512",
    "email": "professionalservices.procurement@nycha.nyc.gov",
    "additional_description_1": "<p>NYCHA seeks a construction manager. A proposers conference will be held on October 1.</p>",
    "additional_description_2": "<p>Submission requirements are in the RFP package.</p>"
  },
  {
    "request_id": "20260910013",
    "start_date": "2026-09-16T00:00:00.000",
    "end_date": "2026-09-16T00:00:00.000",
    "agency_name": "Emergency Management",
    "type_of_notice_description": "Award",
    "category_description": "Services (other than human services)",
    "short_title": "Security System at NYCEM ESC",
    "selection_method_description": "Intergovernmental Purchase",
    "section_name": "Procurement",
    "pin": "01727O0002001",
    "contact_name": "Gregory Gaske",
    "email": "ggaske@oem.nyc.gov",
    "contract_amount": "47098",
    "additional_description_1": "<p>NYCEM has identified the need to purchase new intercoms and access control for the security system at the NYCEM ESC.</p>",
    "vendor_name": "A+ Technology & Security Solutions Inc",
    "vendor_address": "1490 North Clinton Avenue"
  }
]
```

`test/fixtures/crol/page-empty.json`:
```json
[]
```

- [ ] **Step 2: Write the failing tests**

`test/crol.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildCrolUrl, missingCrolColumns, normalizeCrolRow, crolAdapter, CROL_COLUMNS } from "../src/sources/crol.js";
import type { FetchContext, HttpClient } from "../src/sources/types.js";
import { NOW } from "./helpers.js";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/crol/${name}`, import.meta.url), "utf8"));

function fakeHttp(routes: Array<(url: string) => unknown | undefined>): HttpClient & { urls: string[] } {
  const urls: string[] = [];
  return {
    log: [],
    urls,
    async getJson<T>(url: string): Promise<T> {
      urls.push(url);
      for (const r of routes) { const v = r(url); if (v !== undefined) return v as T; }
      throw new Error(`unrouted ${url}`);
    },
  };
}

function ctx(http: HttpClient, over: Partial<FetchContext> = {}): FetchContext {
  return {
    config: { default_from: "2026-09-01", limit: 1000, overlap_days: 2 },
    checkpoint: null,
    now: new Date("2026-09-27T11:00:00Z"),
    http,
    secrets: () => undefined,
    rawSink: () => {},
    ...over,
  };
}

describe("buildCrolUrl", () => {
  it("builds the SoQL query", () => {
    const u = new URL(buildCrolUrl("https://data.cityofnewyork.us/resource/dg92-zbpx.json", "2026-09-13", 1000, 2000));
    expect(u.searchParams.get("$where")).toBe(
      "section_name='Procurement' AND start_date >= '2026-09-13T00:00:00' AND type_of_notice_description in('Solicitation','Intent to Award','Award')",
    );
    expect(u.searchParams.get("$order")).toBe("start_date ASC, request_id ASC");
    expect(u.searchParams.get("$limit")).toBe("1000");
    expect(u.searchParams.get("$offset")).toBe("2000");
  });
});

describe("missingCrolColumns", () => {
  it("is empty for the verified column list", () => {
    expect(missingCrolColumns(fx("columns.json"))).toEqual([]);
    expect(CROL_COLUMNS).toHaveLength(20);
  });
  it("names a renamed column", () => {
    const cols = (fx("columns.json") as Array<{ fieldName: string }>).filter((c) => c.fieldName !== "short_title");
    expect(missingCrolColumns(cols)).toEqual(["short_title"]);
  });
});

describe("normalizeCrolRow", () => {
  const rows = fx("page-1.json") as Record<string, unknown>[];

  it("normalizes a solicitation", () => {
    const n = normalizeCrolRow(rows[0]!, NOW)!;
    expect(n.id).toBe("crol:20260909003");
    expect(n.source_url).toBe("https://a856-cityrecord.nyc.gov/RequestDetail/20260909003");
    expect(n.notice_type).toBe("solicitation");
    expect(n.buyer_level).toBe("authority");
    expect(n.agency_path).toBe("City of New York > Brooklyn Bridge Park");
    expect(n.place).toEqual({ state: "NY", city: "New York", zip: null });
    expect(n.posted_at).toBe("2026-09-15");
    expect(n.due_at).toBe("2026-10-05T16:00:00-04:00");
    expect(n.due_at_source).toBe("crol");
    expect(n.solicitation_number).toBe("BBP Pier 1 Pavilion");
    expect(n.contacts).toEqual([{ name: "John Zhang", email: "proposals@bbp.nyc" }]); // placeholder phone dropped
    expect(n.description_text).toBe("Stair remediation work at the Pier 1 pavilion, including demolition of the existing stair.");
    expect(n.description_fetched_at).toBe(NOW);
  });

  it("joins description parts and keeps a real phone", () => {
    const n = normalizeCrolRow(rows[1]!, NOW)!;
    expect(n.buyer_level).toBe("authority");
    expect(n.description_text).toBe("NYCHA seeks a construction manager. A proposers conference will be held on October 1.\n\nSubmission requirements are in the RFP package.");
    expect(n.contacts[0]?.phone).toBe("(212) 306-4512");
  });

  it("normalizes an award with a value and no due date", () => {
    const n = normalizeCrolRow(rows[2]!, NOW)!;
    expect(n.notice_type).toBe("award");
    expect(n.buyer_level).toBe("city");
    expect(n.estimated_value).toBe(47098);
    expect(n.due_at).toBeNull();
  });

  it("returns null for a row without an id or title", () => {
    expect(normalizeCrolRow({ short_title: "x" }, NOW)).toBeNull();
    expect(normalizeCrolRow({ request_id: "1" }, NOW)).toBeNull();
  });
});

describe("crolAdapter.fetch", () => {
  it("checks columns, pages until a short page, and advances the checkpoint", async () => {
    const http = fakeHttp([
      (u) => (u.includes("/columns.json") ? fx("columns.json") : undefined),
      (u) => (u.includes("$offset=0") ? fx("page-1.json") : undefined),
      (u) => (u.includes("$offset=3") ? fx("page-empty.json") : undefined),
    ]);
    const res = await crolAdapter.fetch(ctx(http, { config: { default_from: "2026-09-01", limit: 3, overlap_days: 2 } }));
    expect(res.partial).toBe(false);
    expect(res.records).toHaveLength(3);
    expect(res.stats).toMatchObject({ requests: 3, fetched: 3, normalized: 3, skipped: 0, errors: [] });
    expect(res.checkpoint.posted_from).toBe("2026-09-16");
    expect(http.urls[1]).toContain("start_date%20%3E%3D%20%272026-08-30T00%3A00%3A00%27"); // default_from minus overlap
  });

  it("uses the checkpoint minus overlap and keeps it on failure", async () => {
    const http = fakeHttp([
      (u) => (u.includes("/columns.json") ? fx("columns.json") : undefined),
      (u) => { if (u.includes("$offset=0")) throw new Error("boom"); return undefined; },
    ]);
    const cp = { posted_from: "2026-09-20", updated_at: "2026-09-26T11:00:00Z" };
    const res = await crolAdapter.fetch(ctx(http, { checkpoint: cp }));
    expect(res.partial).toBe(true);
    expect(res.checkpoint).toEqual(cp);
    expect(res.stats.errors[0]).toMatch(/boom/);
    expect(http.urls[1]).toContain("2026-09-18T00");
  });

  it("reports a missing column as an error but still fetches", async () => {
    const cols = (fx("columns.json") as Array<{ fieldName: string }>).filter((c) => c.fieldName !== "pin");
    const http = fakeHttp([
      (u) => (u.includes("/columns.json") ? cols : undefined),
      (u) => (u.includes("$offset=0") ? fx("page-empty.json") : undefined),
    ]);
    const res = await crolAdapter.fetch(ctx(http));
    expect(res.stats.errors).toEqual(["crol columns missing: pin"]);
    expect(res.partial).toBe(false);
  });

  it("sends the app token header when the secret exists", async () => {
    const seen: Record<string, string>[] = [];
    const http: HttpClient = {
      log: [],
      async getJson<T>(url: string, init?: { headers?: Record<string, string> }): Promise<T> {
        seen.push(init?.headers ?? {});
        return (url.includes("/columns.json") ? fx("columns.json") : fx("page-empty.json")) as T;
      },
    };
    await crolAdapter.fetch(ctx(http, { secrets: (n) => (n === "SOCRATA_APP_TOKEN" ? "tok" : undefined) }));
    expect(seen.every((h) => h["X-App-Token"] === "tok")).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/crol.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

`src/sources/crol.ts`:
```ts
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
});
export type CrolConfig = z.infer<typeof CrolConfigSchema>;

const NOTICE_TYPES = ["Solicitation", "Intent to Award", "Award"];

export function buildCrolUrl(base: string, postedFrom: string, limit: number, offset: number): string {
  const u = new URL(base);
  const types = NOTICE_TYPES.map((t) => `'${t}'`).join(",");
  u.searchParams.set("$where",
    `section_name='Procurement' AND start_date >= '${postedFrom}T00:00:00' AND type_of_notice_description in(${types})`);
  u.searchParams.set("$order", "start_date ASC, request_id ASC");
  u.searchParams.set("$limit", String(limit));
  u.searchParams.set("$offset", String(offset));
  return u.toString();
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
  }).replace(/\n{3,}/g, "\n\n").trim();
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
    const headers = token ? { "X-App-Token": token } : {};
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
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/crol.test.ts`
Expected: 11 passed. If the html-to-text output for the first fixture differs in whitespace, print it and adjust the expected string once; the requirement is no tags, no `&nbsp;`, single spaces.

- [ ] **Step 6: Commit**

```bash
git add src/sources/crol.ts test/crol.test.ts test/fixtures/crol
git commit -m "Add CROL adapter with paging, column drift check, and normalization"
```

---

### Task 7: Pre-filter (filters.yaml schema, word-boundary matching, select)

**Files:**
- Create: `src/select/filters.ts`, `config/filters.yaml`
- Test: `test/filters.test.ts`

**Interfaces:**
- Consumes: `Prefilter`, `NormalizedOpportunity` (Task 3).
- Produces:
  ```ts
  export const FiltersConfigSchema: z.ZodType<FiltersConfig>
  export interface FiltersConfig { version: number; notice_types_for_digest: NoticeType[]; hard_exclude: { categories_raw: string[]; title_terms: string[]; set_asides: string[] }; ordering: { home_states: string[]; home_bonus: number; federal_penalty: number; code_bonus: number; software_signal_bonus: number }; categories: Record<string, { weight: number; strong: string[]; weak: string[]; vendors: string[]; context: string[] }>; software_signals: string[]; codes: { naics: string[]; psc: string[] } }
  export function termRegex(term: string, caseSensitive: boolean): RegExp
  export function selectOpportunity(o: NormalizedOpportunity, f: FiltersConfig): Prefilter
  export function loadFilters(yamlText: string): FiltersConfig
  ```
- `matched` entry formats: `exclude:category:<raw>`, `exclude:title:<term>`, `exclude:set_aside:<term>`, `cat:<name>:<term>`, `cat:<name>:vendor:<term>`, `cat:<name>:weak:<term>+<context>`, `bonus:code:<code>`, `bonus:software:<term>`, `bonus:home:<state>`, `penalty:federal`.

- [ ] **Step 1: Write config/filters.yaml**

Copy the YAML block from `SPEC.md` section 4.4 verbatim into `config/filters.yaml` (version 2). It is the starter rule set; do not edit the terms in this task.

- [ ] **Step 2: Write the failing tests**

`test/filters.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { termRegex, selectOpportunity, loadFilters } from "../src/select/filters.js";
import { sampleNormalized } from "./helpers.js";

const filters = loadFilters(readFileSync(new URL("../config/filters.yaml", import.meta.url), "utf8"));

describe("termRegex", () => {
  it("matches whole words only, case-insensitively", () => {
    expect(termRegex("roster", false).test("Crew roster software")).toBe(true);
    expect(termRegex("roster", false).test("ROSTER")).toBe(true);
    expect(termRegex("roster", false).test("rostering")).toBe(false);
  });
  it("does not match inside other words", () => {
    expect(termRegex("ESO", true).test("human resources")).toBe(false);
    expect(termRegex("ESO", true).test("the ESO platform")).toBe(true);
    expect(termRegex("Cooper test", false).test("cooperative purchasing")).toBe(false);
  });
  it("is case-sensitive when asked", () => {
    expect(termRegex("ESO", true).test("eso")).toBe(false);
  });
  it("matches phrases across flexible whitespace and hyphens as typed", () => {
    expect(termRegex("shift scheduling", false).test("Shift\n scheduling system")).toBe(true);
    expect(termRegex("off-duty", false).test("Off-Duty details")).toBe(true);
  });
});

describe("selectOpportunity", () => {
  it("makes a candidate on a strong category term", () => {
    const p = selectOpportunity(sampleNormalized({
      title: "Fire Department shift scheduling software", category_raw: "Services (other than human services)",
      description_text: "Replace the spreadsheet platoon schedule.",
    }), filters);
    expect(p.stage).toBe("candidate");
    expect(p.matched).toContain("cat:fire_ems_scheduling:shift scheduling");
    expect(p.matched).toContain("bonus:home:NY");
    expect(p.matched).toContain("bonus:software:software");
    expect(p.net_score).toBe(3 + 2 + 1);
    expect(p.filters_version).toBe(2);
  });

  it("never makes a candidate from bonuses alone", () => {
    const p = selectOpportunity(sampleNormalized({
      title: "Citywide software licensing", category_raw: "Goods", description_text: "Software subscription renewal.",
    }), filters);
    expect(p.stage).toBe("filtered_out");
    expect(p.matched.some((m) => m.startsWith("cat:"))).toBe(false);
  });

  it("requires context for weak terms", () => {
    const noCtx = selectOpportunity(sampleNormalized({ title: "Volunteer roster printing", category_raw: "Goods", description_text: null }), filters);
    expect(noCtx.stage).toBe("filtered_out");
    const ctx = selectOpportunity(sampleNormalized({ title: "Roster management for the Fire Department", category_raw: "Goods", description_text: null }), filters);
    expect(ctx.stage).toBe("candidate");
    expect(ctx.matched).toContain("cat:fire_ems_scheduling:weak:roster+fire");
  });

  it("matches vendors case-sensitively", () => {
    const hit = selectOpportunity(sampleNormalized({ title: "Renewal of Telestaff licenses", category_raw: "Goods", description_text: null }), filters);
    expect(hit.matched).toContain("cat:fire_ems_scheduling:vendor:Telestaff");
    const miss = selectOpportunity(sampleNormalized({ title: "eso equipment", category_raw: "Goods", description_text: null }), filters);
    expect(miss.stage).toBe("filtered_out");
  });

  it("hard-excludes construction even with a category hit", () => {
    const p = selectOpportunity(sampleNormalized({
      title: "Recreation center HVAC and activity registration kiosk", category_raw: "Construction/Construction Services",
    }), filters);
    expect(p.stage).toBe("filtered_out");
    expect(p.matched).toContain("exclude:category:Construction/Construction Services");
    expect(p.matched).toContain("exclude:title:HVAC");
  });

  it("applies the federal penalty and caps software signals at two", () => {
    const p = selectOpportunity(sampleNormalized({
      title: "Recreation management software platform subscription", category_raw: null, buyer_level: "federal",
      place: { state: "VA", city: null, zip: null }, description_text: "cloud-based SaaS module",
    }), filters);
    expect(p.stage).toBe("candidate");
    expect(p.matched).toContain("penalty:federal");
    expect(p.matched.filter((m) => m.startsWith("bonus:software:"))).toHaveLength(2);
    expect(p.net_score).toBe(3 - 1 + 2);
  });

  it("adds the code bonus once", () => {
    const p = selectOpportunity(sampleNormalized({
      title: "Physical fitness test administration software", category_raw: null, naics: ["513210", "541511"], psc: "DA01",
    }), filters);
    expect(p.matched.filter((m) => m.startsWith("bonus:code:"))).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/filters.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

`src/select/filters.ts`:
```ts
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
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/filters.test.ts`
Expected: 11 passed. If a test fails because the starter YAML lacks a term the test assumes (for example `software` in `software_signals`), fix the YAML to match SPEC 4.4, not the test.

- [ ] **Step 6: Commit**

```bash
git add src/select/filters.ts config/filters.yaml test/filters.test.ts
git commit -m "Add word-boundary pre-filter with category gating and ordering bonuses"
```

---

### Task 8: Config loading (sources.yaml, recipients.yaml)

**Files:**
- Create: `src/config.ts`, `config/sources.yaml`, `config/recipients.yaml`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `CrolConfigSchema` (Task 6), `loadFilters` (Task 7).
- Produces:
  ```ts
  export const SourcesConfigSchema = z.object({ crol: CrolConfigSchema })
  export type SourcesConfig = z.infer<typeof SourcesConfigSchema>
  export const RecipientsConfigSchema = z.object({ from: z.string().email(), to: z.array(z.string().email()).min(1), send_days: z.array(z.enum(["Mon","Tue","Wed","Thu","Fri","Sat","Sun"])).min(1), cap: z.number().int().min(1).default(10), min_net_score: z.number().int().default(3), sheet_url: z.string().url().nullable().default(null), subject_prefix: z.string().default("propozaler") })
  export type RecipientsConfig = z.infer<typeof RecipientsConfigSchema>
  export interface AppConfig { filters: FiltersConfig; sources: SourcesConfig; recipients: RecipientsConfig }
  export function loadYamlFile<T>(path: string, schema: z.ZodType<T>): T
  export function loadConfig(configDir: string): AppConfig
  ```

- [ ] **Step 1: Write the config files**

`config/sources.yaml`:
```yaml
crol:
  enabled: true
  base_url: https://data.cityofnewyork.us/resource/dg92-zbpx.json
  columns_url: https://data.cityofnewyork.us/api/views/dg92-zbpx/columns.json
  limit: 1000
  overlap_days: 2
  default_from: "2026-09-01"     # first run fetches from here; the checkpoint takes over after that
  max_checkpoint_age_days: 14    # City Record publishes in batches; an 11-day gap was observed on 2026-09-27
```

Also add the field to `CrolConfigSchema` in `src/sources/crol.ts` (this task owns the config surface):

```ts
  max_checkpoint_age_days: z.number().int().min(1).default(14),
```

The adapter does not read it; `check` (Task 13) does.

`config/recipients.yaml` (replace the addresses before the first real run):
```yaml
from: propozaler.digest@gmail.com
to:
  - anthony.olivence@gmail.com
  - partner@example.com        # REPLACE with the partner's real address before the first real run
send_days: [Mon, Tue, Wed, Thu, Fri]
cap: 10
min_net_score: 3          # milestone 1 threshold on prefilter net_score; milestone 2 switches to fit_score
sheet_url: null           # milestone 2
subject_prefix: propozaler
```

- [ ] **Step 2: Write the failing tests**

`test/config.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/config.js";

const configDir = join(dirname(fileURLToPath(import.meta.url)), "..", "config");

describe("loadConfig", () => {
  it("loads all three files with defaults applied", () => {
    const c = loadConfig(configDir);
    expect(c.filters.version).toBe(2);
    expect(c.sources.crol.limit).toBe(1000);
    expect(c.sources.crol.default_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(c.sources.crol.max_checkpoint_age_days).toBe(14);
    expect(c.recipients.cap).toBe(10);
    expect(c.recipients.send_days).toContain("Mon");
    expect(c.recipients.to.length).toBeGreaterThan(0);
  });

  it("fails loudly on a missing file", () => {
    expect(() => loadConfig(join(configDir, "nope"))).toThrow(/ENOENT|no such file/);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

`src/config.ts`:
```ts
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
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/config.test.ts`
Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/sources/crol.ts config/sources.yaml config/recipients.yaml test/config.test.ts
git commit -m "Add config loading for sources and recipients"
```

---

### Task 9: Digest selection and rendering

**Files:**
- Create: `src/digest/select.ts`, `src/digest/render.ts`
- Test: `test/digest-select.test.ts`, `test/digest-render.test.ts`

**Interfaces:**
- Consumes: `Opportunity`, `NoticeType` (Task 3), `datePart`, `addDays` (Task 2).
- Produces (`select.ts`):
  ```ts
  export function effectiveDue(o: Opportunity): { at: string | null; source: "source" | "extracted" | null }
  export interface DigestSelectOptions { today: string; minNetScore: number; cap: number; noticeTypes: NoticeType[] }
  export function selectDigestEntries(records: Opportunity[], opts: DigestSelectOptions): { entries: Opportunity[]; overflow: number }
  ```
- Produces (`render.ts`):
  ```ts
  export interface SourceHealth { name: string; fetched: number; candidates: number; scored: number; new: number; status: "ok" | "warn" | "fail"; note?: string }
  export interface HealthSummary { sources: SourceHealth[]; scoring: string; durationMs: number; criteriaVersion: string | null }
  export interface DigestEntry { entryId: string; record: Opportunity }
  export interface DigestModel { date: string; subjectPrefix: string; sheetUrl: string | null; entries: DigestEntry[]; overflow: number; dueSoon: Opportunity[]; health: HealthSummary; minScore: number }
  export function escapeHtml(s: string): string
  export function formatDue(o: Opportunity, today: string): string
  export function summaryOf(o: Opportunity): string          // milestone 1: first 200 chars of description_text
  export function renderDigest(m: DigestModel): { subject: string; html: string; text: string }
  ```
- Selection rules (SPEC 6.1, milestone 1 variant): `notice_type` in `noticeTypes`; `prefilter.stage === "candidate"`; `prefilter.net_score >= minNetScore`; `feedback === null`; effective due is null or `>= today`; not previously sent (`digest.sent_in` empty) or `content_hash !== digest.sent_hash`. Order: `net_score` desc, then due soonest with nulls last, then `posted_at` desc, then `id`. Cap; `overflow` = count beyond cap.

- [ ] **Step 1: Write the failing selection tests**

`test/digest-select.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { selectDigestEntries, effectiveDue } from "../src/digest/select.js";
import { newOpportunity, type Opportunity, type Prefilter } from "../src/model/opportunity.js";
import { sampleNormalized } from "./helpers.js";

function rec(over: Partial<Opportunity> & { id: string; net?: number; stage?: Prefilter["stage"] }): Opportunity {
  const { net = 5, stage = "candidate", ...rest } = over;
  const base = newOpportunity(sampleNormalized({ id: rest.id, source_id: rest.id.split(":")[1]! }), "2026-09-27T11:00:00Z");
  return { ...base, ...rest, prefilter: { net_score: net, matched: [], stage, filters_version: 2 } };
}

const opts = { today: "2026-09-28", minNetScore: 3, cap: 2, noticeTypes: ["solicitation", "presolicitation", "sources_sought", "combined_synopsis"] as const };

describe("effectiveDue", () => {
  it("prefers the source date, then the extracted date, then null", () => {
    expect(effectiveDue(rec({ id: "crol:1" })).at).toBe("2026-10-05T16:00:00-04:00");
    expect(effectiveDue(rec({ id: "crol:2", due_at: null, due_at_source: null, score: { extracted: { due_at: "2026-11-01T00:00:00-04:00" } } })))
      .toEqual({ at: "2026-11-01T00:00:00-04:00", source: "extracted" });
    expect(effectiveDue(rec({ id: "crol:3", due_at: null, due_at_source: null })).at).toBeNull();
  });
});

describe("selectDigestEntries", () => {
  it("filters, orders, caps, and counts overflow", () => {
    const records = [
      rec({ id: "crol:a", net: 4 }),
      rec({ id: "crol:b", net: 9 }),
      rec({ id: "crol:c", net: 6, due_at: "2026-09-29T00:00:00-04:00" }),
      rec({ id: "crol:d", net: 6, due_at: null, due_at_source: null }),
      rec({ id: "crol:e", net: 2 }),                               // below threshold
      rec({ id: "crol:f", net: 8, stage: "filtered_out" }),        // not a candidate
      rec({ id: "crol:g", net: 8, notice_type: "award" }),         // wrong type
      rec({ id: "crol:h", net: 8, due_at: "2026-09-20T00:00:00-04:00" }), // past due
      rec({ id: "crol:i", net: 8, feedback: { decision: "ignored", at: "x", by: "sheet" } }),
    ];
    const { entries, overflow } = selectDigestEntries(records, { ...opts, cap: 10 });
    expect(entries.map((e) => e.id)).toEqual(["crol:b", "crol:c", "crol:d", "crol:a"]);
    expect(overflow).toBe(0);
    const capped = selectDigestEntries(records, opts);
    expect(capped.entries.map((e) => e.id)).toEqual(["crol:b", "crol:c"]);
    expect(capped.overflow).toBe(2);
  });

  it("excludes already-sent records unless they changed", () => {
    const sent = rec({ id: "crol:s", digest: { sent_in: ["2026-09-26"], sent_hash: "same" }, content_hash: "same" });
    const changed = rec({ id: "crol:t", digest: { sent_in: ["2026-09-26"], sent_hash: "old" }, content_hash: "new" });
    const { entries } = selectDigestEntries([sent, changed], opts);
    expect(entries.map((e) => e.id)).toEqual(["crol:t"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/digest-select.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement selection**

`src/digest/select.ts`:
```ts
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
```

- [ ] **Step 4: Run selection tests**

Run: `npx vitest run test/digest-select.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Write the failing render tests**

`test/digest-render.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { escapeHtml, formatDue, summaryOf, renderDigest, type DigestModel } from "../src/digest/render.js";
import { newOpportunity } from "../src/model/opportunity.js";
import { sampleNormalized } from "./helpers.js";

const base = newOpportunity(sampleNormalized({ title: "Fire <b>scheduling</b> & rostering" }), "2026-09-27T11:00:00Z");
base.prefilter = { net_score: 6, matched: ["cat:fire_ems_scheduling:shift scheduling", "bonus:home:NY"], stage: "candidate", filters_version: 2 };

const health = {
  sources: [{ name: "crol", fetched: 12, candidates: 3, scored: 0, new: 2, status: "ok" as const }],
  scoring: "not enabled (milestone 1)", durationMs: 4200, criteriaVersion: null,
};

function model(over: Partial<DigestModel> = {}): DigestModel {
  return { date: "2026-09-28", subjectPrefix: "propozaler", sheetUrl: null, entries: [{ entryId: "2026-09-28-01", record: base }], overflow: 0, dueSoon: [], health, minScore: 3, ...over };
}

describe("escapeHtml", () => {
  it("escapes the five characters", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });
});

describe("formatDue", () => {
  it("labels CROL dates and counts days", () => {
    expect(formatDue(base, "2026-09-28")).toBe("due Mon Oct 5 (7 days) per City Record; confirm in PASSPort (PIN BBP Pier 1 Pavilion)");
  });
  it("says when a date is missing", () => {
    expect(formatDue({ ...base, due_at: null, due_at_source: null }, "2026-09-28")).toBe("due date not stated");
  });
});

describe("summaryOf", () => {
  it("truncates the description to 200 characters", () => {
    const long = { ...base, description_text: "x".repeat(300) };
    expect(summaryOf(long)).toHaveLength(201); // 200 + ellipsis
    expect(summaryOf({ ...base, description_text: null })).toBe("(no description in the notice)");
  });
});

describe("renderDigest", () => {
  it("renders subject, escaped html, and plain text", () => {
    const out = renderDigest(model());
    expect(out.subject).toBe("propozaler 2026-09-28: 1 new · CROL ok");
    expect(out.html).toContain("Fire &lt;b&gt;scheduling&lt;/b&gt; &amp; rostering");
    expect(out.html).not.toContain("<b>scheduling</b>");
    expect(out.html).toContain('href="https://a856-cityrecord.nyc.gov/RequestDetail/20260909003"');
    expect(out.html).toContain("per City Record; confirm in PASSPort");
    expect(out.html).toContain("matched: shift scheduling, home NY");
    expect(out.html).toContain("crol 12 / 3 / 0 / 2");
    expect(out.text).toContain("1. Fire <b>scheduling</b> & rostering");
    expect(out.text).toContain("https://a856-cityrecord.nyc.gov/RequestDetail/20260909003");
  });

  it("renders the empty case and health warnings in the subject", () => {
    const out = renderDigest(model({ entries: [], health: { ...health, sources: [{ ...health.sources[0]!, fetched: 0, status: "warn", note: "0 fetched" }] } }));
    expect(out.subject).toBe("propozaler 2026-09-28: nothing new · CROL 0 fetched ⚠");
    expect(out.text).toContain("Nothing new today.");
  });

  it("mentions overflow", () => {
    const out = renderDigest(model({ overflow: 7 }));
    expect(out.text).toContain("7 more scored 3+ today; they carry over.");
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run test/digest-render.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 7: Implement rendering**

`src/digest/render.ts`:
```ts
import type { Opportunity } from "../model/opportunity.js";
import { effectiveDue } from "./select.js";

export interface SourceHealth {
  name: string; fetched: number; candidates: number; scored: number; new: number;
  status: "ok" | "warn" | "fail"; note?: string;
}
export interface HealthSummary { sources: SourceHealth[]; scoring: string; durationMs: number; criteriaVersion: string | null }
export interface DigestEntry { entryId: string; record: Opportunity }
export interface DigestModel {
  date: string; subjectPrefix: string; sheetUrl: string | null;
  entries: DigestEntry[]; overflow: number; dueSoon: Opportunity[]; health: HealthSummary;
  minScore: number; // the digest threshold, for the overflow line
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const DAY = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[t.getUTCDay()]} ${MONTHS[m - 1]} ${d}`;
}

function daysBetween(fromYmd: string, toIso: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`);
  return Math.round((b - a) / DAY);
}

export function formatDue(o: Opportunity, today: string): string {
  const due = effectiveDue(o);
  if (!due.at) return "due date not stated";
  const days = daysBetween(today, due.at);
  const when = `due ${shortDate(due.at)} (${days} day${days === 1 ? "" : "s"})`;
  if (due.source === "extracted") return `${when} (from notice text)`;
  if (o.due_at_source === "crol") {
    const pin = o.solicitation_number ? ` (PIN ${o.solicitation_number})` : "";
    return `${when} per City Record; confirm in PASSPort${pin}`;
  }
  return when;
}

export function summaryOf(o: Opportunity): string {
  if (!o.description_text) return "(no description in the notice)";
  const one = o.description_text.replace(/\s+/g, " ").trim();
  return one.length > 200 ? `${one.slice(0, 200)}…` : one;
}

function matchedLabel(o: Opportunity): string {
  const parts = (o.prefilter?.matched ?? [])
    .filter((m) => m.startsWith("cat:") || m.startsWith("bonus:home:"))
    .map((m) => m.startsWith("bonus:home:") ? `home ${m.slice("bonus:home:".length)}` : m.split(":").slice(2).join(":").replace(/^vendor:/, "").replace(/^weak:/, ""));
  return parts.length > 0 ? `matched: ${parts.join(", ")}` : "";
}

function valueLabel(o: Opportunity): string {
  return o.estimated_value !== null ? `value $${Math.round(o.estimated_value).toLocaleString("en-US")}` : "value not stated";
}

function sourceLabel(s: string): string {
  return s === "crol" ? "CROL" : s === "sam" ? "SAM.gov" : s;
}

function subjectFor(m: DigestModel): string {
  const n = m.entries.length;
  const head = n === 0 ? "nothing new" : `${n} new`;
  const health = m.health.sources.map((s) =>
    s.status === "ok" ? `${sourceLabel(s.name)} ok` : `${sourceLabel(s.name)} ${s.note ?? s.status} ⚠`).join(" · ");
  return `${m.subjectPrefix} ${m.date}: ${head} · ${health}`;
}

function entryText(i: number, e: DigestEntry, today: string): string {
  const o = e.record;
  const lines = [
    `${i}. ${o.title}    net ${o.prefilter?.net_score ?? 0}`,
    `   ${o.agency} (${o.buyer_level}) · ${o.notice_type_raw}${o.selection_method ? ` · ${o.selection_method}` : ""} · ${formatDue(o, today)} · ${valueLabel(o)}`,
    `   ${summaryOf(o)}`,
  ];
  const ml = matchedLabel(o);
  if (ml) lines.push(`   ${ml}`);
  const c = o.contacts[0];
  if (c) lines.push(`   Contact: ${[c.name, c.email, c.phone].filter(Boolean).join(", ")}`);
  lines.push(`   Source: ${sourceLabel(o.source)} ${o.source_url}`);
  return lines.join("\n");
}

function entryHtml(i: number, e: DigestEntry, today: string): string {
  const o = e.record;
  const c = o.contacts[0];
  const ml = matchedLabel(o);
  return `
<div style="margin:0 0 20px 0;padding:0 0 16px 0;border-bottom:1px solid #e5e5e5;">
  <div style="font-weight:600;font-size:16px;">${i}. <a href="${escapeHtml(o.source_url)}" style="color:#1a1a1a;">${escapeHtml(o.title)}</a>
    <span style="float:right;font-weight:400;color:#555;">net ${o.prefilter?.net_score ?? 0}</span></div>
  <div style="color:#555;font-size:14px;margin-top:2px;">${escapeHtml(o.agency)} (${escapeHtml(o.buyer_level)}) · ${escapeHtml(o.notice_type_raw)}${o.selection_method ? ` · ${escapeHtml(o.selection_method)}` : ""}<br>${escapeHtml(formatDue(o, today))} · ${escapeHtml(valueLabel(o))}</div>
  <div style="margin-top:6px;">${escapeHtml(summaryOf(o))}</div>
  ${ml ? `<div style="color:#555;font-size:13px;margin-top:4px;">${escapeHtml(ml)}</div>` : ""}
  ${c ? `<div style="font-size:13px;margin-top:4px;">Contact: ${escapeHtml([c.name, c.email, c.phone].filter(Boolean).join(", "))}</div>` : ""}
  <div style="font-size:13px;margin-top:4px;">Source: <a href="${escapeHtml(o.source_url)}">${escapeHtml(sourceLabel(o.source))}</a></div>
</div>`;
}

export function renderDigest(m: DigestModel): { subject: string; html: string; text: string } {
  const subject = subjectFor(m);
  const today = m.date;
  const healthLines = m.health.sources.map((s) =>
    `${s.name} ${s.fetched} / ${s.candidates} / ${s.scored} / ${s.new}${s.status === "ok" ? "" : ` (${s.note ?? s.status})`}`);
  const footerText = [
    "Health (fetched / candidates / scored / new):",
    ...healthLines.map((l) => `  ${l}`),
    `  scoring: ${m.health.scoring} · run ${Math.round(m.health.durationMs / 1000)}s${m.health.criteriaVersion ? ` · criteria ${m.health.criteriaVersion}` : ""}`,
  ].join("\n");

  const textParts: string[] = [`${m.subjectPrefix} digest for ${m.date}`];
  if (m.sheetUrl) textParts.push(`Tracker sheet: ${m.sheetUrl}`);
  if (m.entries.length === 0) textParts.push("Nothing new today.");
  else textParts.push(m.entries.map((e, i) => entryText(i + 1, e, today)).join("\n\n"));
  if (m.overflow > 0) textParts.push(`${m.overflow} more scored ${m.minScore}+ today; they carry over.`);
  if (m.dueSoon.length > 0) textParts.push(["Due soon (pursued):", ...m.dueSoon.map((o) => `  ${o.title} — ${formatDue(o, today)}`)].join("\n"));
  textParts.push(footerText);
  const text = textParts.join("\n\n") + "\n";

  const htmlBody = [
    `<h2 style="margin:0 0 12px 0;font-size:18px;">${escapeHtml(m.subjectPrefix)} digest for ${m.date}</h2>`,
    m.sheetUrl ? `<p><a href="${escapeHtml(m.sheetUrl)}">Tracker sheet</a></p>` : "",
    m.entries.length === 0 ? `<p>Nothing new today.</p>` : m.entries.map((e, i) => entryHtml(i + 1, e, today)).join(""),
    m.overflow > 0 ? `<p style="color:#555;">${m.overflow} more scored ${m.minScore}+ today; they carry over.</p>` : "",
    m.dueSoon.length > 0 ? `<p><b>Due soon (pursued)</b><br>${m.dueSoon.map((o) => `${escapeHtml(o.title)} — ${escapeHtml(formatDue(o, today))}`).join("<br>")}</p>` : "",
    `<pre style="font-size:12px;color:#555;white-space:pre-wrap;">${escapeHtml(footerText)}</pre>`,
  ].join("\n");

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;"><div style="max-width:600px;margin:0 auto;padding:20px;background:#fff;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;">
${htmlBody}
</div></body></html>`;
  return { subject, html, text };
}
```

- [ ] **Step 8: Run to verify pass**

Run: `npx vitest run test/digest-render.test.ts`
Expected: 8 passed.

- [ ] **Step 9: Commit**

```bash
git add src/digest/select.ts src/digest/render.ts test/digest-select.test.ts test/digest-render.test.ts
git commit -m "Add digest selection, ordering, cap, and escaped HTML/text rendering"
```

---

### Task 10: SMTP mailer

**Files:**
- Create: `src/digest/mailer.ts`
- Test: `test/mailer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface MailMessage { from: string; to: string[]; subject: string; text: string; html: string }
  export interface Mailer { send(msg: MailMessage): Promise<{ messageId: string }> }
  export function createSmtpMailer(env: NodeJS.ProcessEnv, transportFactory?: (opts: SMTPTransport.Options) => Transporter): Mailer
  export function createFileMailer(outPath: string): Mailer   // writes the message as JSON; used by --no-send and tests
  ```
- `createSmtpMailer` reads `SMTP_USER` and `SMTP_APP_PASSWORD`; throws `missing SMTP_USER` / `missing SMTP_APP_PASSWORD` if absent. Transport: host `smtp.gmail.com`, port 465, `secure: true`, auth user/pass. The `from` header uses `msg.from`.

- [ ] **Step 1: Write the failing tests**

`test/mailer.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSmtpMailer, createFileMailer } from "../src/digest/mailer.js";

const msg = { from: "a@example.com", to: ["b@example.com", "c@example.com"], subject: "s", text: "t", html: "<p>t</p>" };

describe("createSmtpMailer", () => {
  it("requires both env vars", () => {
    expect(() => createSmtpMailer({})).toThrow(/missing SMTP_USER/);
    expect(() => createSmtpMailer({ SMTP_USER: "u" })).toThrow(/missing SMTP_APP_PASSWORD/);
  });

  it("builds a Gmail smtps transport and sends multipart", async () => {
    const captured: { opts?: unknown; mail?: unknown } = {};
    const factory = (opts: unknown) => {
      captured.opts = opts;
      return { sendMail: async (mail: unknown) => { captured.mail = mail; return { messageId: "<id@test>" }; } } as never;
    };
    const mailer = createSmtpMailer({ SMTP_USER: "u@gmail.com", SMTP_APP_PASSWORD: "pw" }, factory);
    const res = await mailer.send(msg);
    expect(res.messageId).toBe("<id@test>");
    expect(captured.opts).toMatchObject({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: "u@gmail.com", pass: "pw" } });
    expect(captured.mail).toMatchObject({ from: "a@example.com", to: "b@example.com, c@example.com", subject: "s", text: "t", html: "<p>t</p>" });
  });
});

describe("createFileMailer", () => {
  it("writes the message to disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "propozaler-mail-"));
    const p = join(dir, "sent.json");
    const res = await createFileMailer(p).send(msg);
    expect(res.messageId).toMatch(/^file:/);
    expect(JSON.parse(readFileSync(p, "utf8")).subject).toBe("s");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/mailer.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/digest/mailer.ts`:
```ts
import { writeFileSync } from "node:fs";
import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";

export interface MailMessage { from: string; to: string[]; subject: string; text: string; html: string }
export interface Mailer { send(msg: MailMessage): Promise<{ messageId: string }> }

type TransportFactory = (opts: SMTPTransport.Options) => Transporter;

export function createSmtpMailer(env: NodeJS.ProcessEnv, transportFactory?: TransportFactory): Mailer {
  const user = env.SMTP_USER;
  const pass = env.SMTP_APP_PASSWORD;
  if (!user) throw new Error("missing SMTP_USER");
  if (!pass) throw new Error("missing SMTP_APP_PASSWORD");
  const factory: TransportFactory = transportFactory ?? ((opts) => nodemailer.createTransport(opts));
  const transport = factory({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass } });
  return {
    async send(msg) {
      const info = await transport.sendMail({
        from: msg.from, to: msg.to.join(", "), subject: msg.subject, text: msg.text, html: msg.html,
      });
      return { messageId: String(info.messageId) };
    },
  };
}

export function createFileMailer(outPath: string): Mailer {
  return {
    async send(msg) {
      writeFileSync(outPath, JSON.stringify(msg, null, 2) + "\n");
      return { messageId: `file:${outPath}` };
    },
  };
}
```

If TypeScript cannot resolve `nodemailer/lib/smtp-transport/index.js` types, import the options type as `Parameters<typeof nodemailer.createTransport>[0]` instead and drop the SMTPTransport import.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/mailer.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/digest/mailer.ts test/mailer.test.ts
git commit -m "Add SMTP and file mailers"
```

---

### Task 11: Run state and the `pre` step

**Files:**
- Create: `src/run/state.ts`, `src/run/pre.ts`
- Test: `test/pre.test.ts`

**Interfaces:**
- Consumes: `Store` (Task 4), `SourceAdapter`, `FetchContext` (Task 4), `createHttpClient` (Task 5), `selectOpportunity`, `FiltersConfig` (Task 7), `SourcesConfig` (Task 8).
- Produces (`state.ts`):
  ```ts
  export const SourceRunStatsSchema = z.object({ requests: z.number(), fetched: z.number(), normalized: z.number(), skipped: z.number(), new: z.number(), changed: z.number(), candidates: z.number(), errors: z.array(z.string()), partial: z.boolean(), checkpoint_posted_from: z.string().nullable(), http_log: z.array(z.object({ method: z.string(), url: z.string(), status: z.number().nullable(), ms: z.number(), error: z.string().optional() })) })
  export const RunStateSchema = z.object({ run_id: z.string(), started_at: z.string(), git_sha: z.string().nullable(), sources: z.record(z.string(), SourceRunStatsSchema), pending_count: z.number().default(0), scoring: z.object({ status: z.string(), imported: z.number(), carried_over: z.number(), rejected: z.number() }).default({ status: "not enabled (milestone 1)", imported: 0, carried_over: 0, rejected: 0 }), digest: z.object({ digest_id: z.string().nullable(), sent: z.boolean(), send_expected: z.boolean(), entries: z.number(), overflow: z.number(), message_id: z.string().nullable(), error: z.string().nullable() }).nullable().default(null), warnings: z.array(z.string()).default([]), finished_at: z.string().nullable().default(null), check: z.object({ ok: z.boolean(), warnings: z.array(z.string()), failures: z.array(z.string()) }).nullable().default(null) })
  export type RunState = z.infer<typeof RunStateSchema>; export type SourceRunStats = z.infer<typeof SourceRunStatsSchema>
  export function readRunState(workDir: string): RunState          // throws "no work/run.json; run `pre` first"
  export function writeRunState(workDir: string, s: RunState): void
  ```
- Produces (`pre.ts`):
  ```ts
  export interface PreDeps { store: Store; adapters: SourceAdapter[]; sources: SourcesConfig; filters: FiltersConfig; now: Date; workDir: string; env: NodeJS.ProcessEnv; gitSha: string | null; httpFactory?: () => HttpClient }
  export async function runPre(deps: PreDeps): Promise<RunState>
  ```
- Behavior: for each adapter whose config block has `enabled: true`: build `FetchContext` (checkpoint from store, `secrets = (n) => env[n]`, `rawSink` writes `work/raw/<source>/<label>.json`), call `fetch`, upsert every record, run `selectOpportunity` on the upserted record's normalized fields and store the result in `record.prefilter`, count `new`, `changed` (non-empty `changed` array on an existing record), `candidates`. Write the checkpoint only when `!partial`. An adapter that throws is caught: its stats get the error, `partial: true`, and the run continues with the next adapter. Write `work/run.json`. Also empty and recreate `work/pending/` (milestone 2 fills it). Never throws for adapter failures; throws only for programmer errors (missing config block).

- [ ] **Step 1: Write the failing tests**

`test/pre.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPre } from "../src/run/pre.js";
import { readRunState } from "../src/run/state.js";
import { Store } from "../src/store/store.js";
import { loadFilters } from "../src/select/filters.js";
import type { SourceAdapter, FetchResult } from "../src/sources/types.js";
import { sampleNormalized } from "./helpers.js";

const filters = loadFilters(readFileSync(new URL("../config/filters.yaml", import.meta.url), "utf8"));
const sources = { crol: { enabled: true, base_url: "https://x.test/r.json", columns_url: "https://x.test/c.json", limit: 1000, overlap_days: 2, default_from: "2026-09-01" } };

function adapter(result: FetchResult | Error): SourceAdapter {
  return { name: "crol", async fetch() { if (result instanceof Error) throw result; return result; } };
}

function deps(dir: string, a: SourceAdapter) {
  return { store: new Store(join(dir, "data")), adapters: [a], sources, filters, now: new Date("2026-09-27T11:00:00Z"), workDir: join(dir, "work"), env: {}, gitSha: "abc123" };
}

describe("runPre", () => {
  it("ingests, selects, checkpoints, and writes run.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "propozaler-pre-"));
    const rec = sampleNormalized({ title: "Fire Department shift scheduling software", category_raw: "Services (other than human services)" });
    const a = adapter({ records: [rec], checkpoint: { posted_from: "2026-09-15", updated_at: "now" }, stats: { requests: 2, fetched: 1, normalized: 1, skipped: 0, errors: [] }, partial: false });
    const d = deps(dir, a);
    const state = await runPre(d);
    expect(state.sources.crol).toMatchObject({ fetched: 1, new: 1, changed: 0, candidates: 1, partial: false, checkpoint_posted_from: "2026-09-15" });
    expect(d.store.readCheckpoint("crol")?.posted_from).toBe("2026-09-15");
    expect(d.store.get(rec.id)?.prefilter?.stage).toBe("candidate");
    expect(readRunState(d.workDir).run_id).toBe(state.run_id);
    expect(existsSync(join(d.workDir, "pending"))).toBe(true);
  });

  it("keeps the old checkpoint on a partial fetch and still stores records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "propozaler-pre-"));
    const d0 = deps(dir, adapter(new Error("unused")));
    d0.store.writeCheckpoint("crol", { posted_from: "2026-09-10", updated_at: "x" });
    const a = adapter({ records: [sampleNormalized()], checkpoint: { posted_from: "2026-09-10", updated_at: "x" }, stats: { requests: 1, fetched: 1, normalized: 1, skipped: 0, errors: ["page 1 failed"] }, partial: true });
    const state = await runPre(deps(dir, a));
    expect(state.sources.crol.partial).toBe(true);
    expect(state.sources.crol.errors).toEqual(["page 1 failed"]);
    expect(d0.store.readCheckpoint("crol")?.posted_from).toBe("2026-09-10");
    expect(d0.store.list()).toHaveLength(1);
  });

  it("survives an adapter that throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "propozaler-pre-"));
    const state = await runPre(deps(dir, adapter(new Error("network down"))));
    expect(state.sources.crol.partial).toBe(true);
    expect(state.sources.crol.errors[0]).toMatch(/network down/);
    expect(state.sources.crol.fetched).toBe(0);
  });

  it("skips disabled sources", async () => {
    const dir = mkdtempSync(join(tmpdir(), "propozaler-pre-"));
    const d = { ...deps(dir, adapter(new Error("should not run"))), sources: { crol: { ...sources.crol, enabled: false } } };
    const state = await runPre(d);
    expect(state.sources.crol).toBeUndefined();
    expect(state.warnings).toContain("source crol disabled");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pre.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement state**

`src/run/state.ts`:
```ts
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
```

- [ ] **Step 4: Implement pre**

`src/run/pre.ts`:
```ts
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
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/pre.test.ts`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add src/run/state.ts src/run/pre.ts test/pre.test.ts
git commit -m "Add run state and the pre step: ingest, select, checkpoint"
```

---

### Task 12: The `post` step: select entries, render, send, record

**Files:**
- Create: `src/run/post.ts`
- Test: `test/post.test.ts`

**Interfaces:**
- Consumes: `Store`, `readRunState`/`writeRunState` (Task 11), `selectDigestEntries`, `effectiveDue` (Task 9), `renderDigest` and model types (Task 9), `Mailer` (Task 10), `RecipientsConfig`, `FiltersConfig` (Tasks 7, 8), `todayNewYork`, `weekdayNewYork`, `addDays` (Task 2).
- Produces:
  ```ts
  export interface PostDeps { store: Store; recipients: RecipientsConfig; filters: FiltersConfig; now: Date; workDir: string; mailer: Mailer | null; forceSend?: boolean }
  export interface PostResult { send_expected: boolean; sent: boolean; digest_id: string | null; entries: number; overflow: number; subject: string; message_id: string | null; error: string | null; html_path: string; text_path: string }
  export async function runPost(deps: PostDeps): Promise<PostResult>
  export function nextDigestId(existing: string[], today: string): string   // "2026-09-28", then "2026-09-28b", "2026-09-28c"
  ```
- Behavior: read `work/run.json` (throws if missing). Load all records. `today = todayNewYork(now)`. Select entries with `minNetScore = recipients.min_net_score`, `cap`, `noticeTypes = filters.notice_types_for_digest`. `dueSoon` = records with `feedback.decision === "pursued"` and effective due within 5 days of today. Build `HealthSummary` from run state: per source `status` is `fail` if `partial` and errors non-empty, `warn` if `fetched === 0` on a weekday or `errors` non-empty, else `ok`; `note` is the first error or `0 fetched`. `send_expected = forceSend || send_days.includes(weekdayNewYork(now))`. Always write `work/digest.html`, `work/digest.txt`, `work/digest.meta.json`. If `send_expected && mailer`: allocate `digest_id`, send; on success append `digests.jsonl` `{ digest_id, sent_at, message_id, subject, entries: [{ entry_id, id }] }`, set each entry's `digest.sent_in += digest_id`, `digest.sent_hash = content_hash`, save; set `sent: true`. On mailer error: `sent: false`, `error` set, nothing marked. If `send_expected && !mailer` (`--no-send`): allocate the id, write `work/digest.meta.json` with `pending_send: true`, mark nothing; the `sent` command finalizes (Task 14). Update run state `digest` block and write it. Print nothing; the CLI prints.

- [ ] **Step 1: Write the failing tests**

`test/post.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPost, nextDigestId } from "../src/run/post.js";
import { writeRunState, readRunState } from "../src/run/state.js";
import { Store } from "../src/store/store.js";
import { loadFilters } from "../src/select/filters.js";
import type { Mailer, MailMessage } from "../src/digest/mailer.js";
import { sampleNormalized } from "./helpers.js";

const filters = loadFilters(readFileSync(new URL("../config/filters.yaml", import.meta.url), "utf8"));
const recipients = { from: "d@example.com", to: ["a@example.com", "b@example.com"], send_days: ["Mon", "Tue", "Wed", "Thu", "Fri"] as const, cap: 10, min_net_score: 3, sheet_url: null, subject_prefix: "propozaler" };
const monday = new Date("2026-09-28T11:00:00Z");
const sunday = new Date("2026-09-27T11:00:00Z");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "propozaler-post-"));
  const store = new Store(join(dir, "data"));
  const workDir = join(dir, "work");
  const { record } = store.upsert(sampleNormalized({ title: "Fire Department shift scheduling software", category_raw: "Services (other than human services)" }), "2026-09-27T11:00:00Z");
  record.prefilter = { net_score: 6, matched: ["cat:fire_ems_scheduling:shift scheduling"], stage: "candidate", filters_version: 2 };
  store.save(record);
  writeRunState(workDir, {
    run_id: "r1", started_at: "2026-09-28T11:00:00Z", git_sha: null,
    sources: { crol: { requests: 2, fetched: 5, normalized: 5, skipped: 0, new: 1, changed: 0, candidates: 1, errors: [], partial: false, checkpoint_posted_from: "2026-09-27", http_log: [] } },
    pending_count: 0, scoring: { status: "not enabled (milestone 1)", imported: 0, carried_over: 0, rejected: 0 },
    digest: null, warnings: [], finished_at: null, check: null,
  });
  return { dir, store, workDir, record };
}

function capturingMailer(fail = false): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return { sent, async send(m) { if (fail) throw new Error("smtp down"); sent.push(m); return { messageId: "<m1>" }; } };
}

describe("nextDigestId", () => {
  it("suffixes repeats on the same day", () => {
    expect(nextDigestId([], "2026-09-28")).toBe("2026-09-28");
    expect(nextDigestId(["2026-09-28"], "2026-09-28")).toBe("2026-09-28b");
    expect(nextDigestId(["2026-09-28", "2026-09-28b"], "2026-09-28")).toBe("2026-09-28c");
  });
});

describe("runPost", () => {
  it("sends on a weekday and marks entries sent", async () => {
    const { store, workDir, record } = setup();
    const mailer = capturingMailer();
    const res = await runPost({ store, recipients, filters, now: monday, workDir, mailer });
    expect(res).toMatchObject({ send_expected: true, sent: true, digest_id: "2026-09-28", entries: 1, overflow: 0, message_id: "<m1>" });
    expect(mailer.sent[0]?.to).toEqual(["a@example.com", "b@example.com"]);
    expect(mailer.sent[0]?.subject).toBe("propozaler 2026-09-28: 1 new · CROL ok");
    expect(store.get(record.id)?.digest).toEqual({ sent_in: ["2026-09-28"], sent_hash: record.content_hash });
    expect(store.readJsonl<{ digest_id: string }>("digests")[0]?.digest_id).toBe("2026-09-28");
    expect(existsSync(join(workDir, "digest.html"))).toBe(true);
    expect(readRunState(workDir).digest?.sent).toBe(true);
  });

  it("builds but does not send or allocate on a weekend", async () => {
    const { store, workDir, record } = setup();
    const mailer = capturingMailer();
    const res = await runPost({ store, recipients, filters, now: sunday, workDir, mailer });
    expect(res.send_expected).toBe(false);
    expect(res.sent).toBe(false);
    expect(res.digest_id).toBeNull();
    expect(mailer.sent).toHaveLength(0);
    expect(store.get(record.id)?.digest.sent_in).toEqual([]);
    expect(existsSync(join(workDir, "digest.html"))).toBe(true);
  });

  it("records the error and marks nothing when SMTP fails", async () => {
    const { store, workDir, record } = setup();
    const res = await runPost({ store, recipients, filters, now: monday, workDir, mailer: capturingMailer(true) });
    expect(res.sent).toBe(false);
    expect(res.error).toMatch(/smtp down/);
    expect(store.get(record.id)?.digest.sent_in).toEqual([]);
    expect(store.readJsonl("digests")).toHaveLength(0);
    expect(readRunState(workDir).digest?.error).toMatch(/smtp down/);
  });

  it("with no mailer, leaves a pending send in the meta file", async () => {
    const { store, workDir } = setup();
    const res = await runPost({ store, recipients, filters, now: monday, workDir, mailer: null });
    expect(res.sent).toBe(false);
    expect(res.digest_id).toBe("2026-09-28");
    const meta = JSON.parse(readFileSync(join(workDir, "digest.meta.json"), "utf8"));
    expect(meta.pending_send).toBe(true);
    expect(meta.entries).toEqual([{ entry_id: "2026-09-28-01", id: "crol:20260909003" }]);
  });

  it("sends an empty digest when nothing is new", async () => {
    const { store, workDir, record } = setup();
    record.feedback = { decision: "ignored", at: "x", by: "sheet" };
    store.save(record);
    const mailer = capturingMailer();
    const res = await runPost({ store, recipients, filters, now: monday, workDir, mailer });
    expect(res.entries).toBe(0);
    expect(res.sent).toBe(true);
    expect(mailer.sent[0]?.text).toContain("Nothing new today.");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/post.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/run/post.ts`:
```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RecipientsConfig } from "../config.js";
import type { Mailer } from "../digest/mailer.js";
import { renderDigest, type DigestEntry, type DigestModel, type HealthSummary, type SourceHealth } from "../digest/render.js";
import { effectiveDue, selectDigestEntries } from "../digest/select.js";
import { addDays, todayNewYork, weekdayNewYork } from "../model/time.js";
import type { FiltersConfig } from "../select/filters.js";
import type { Store } from "../store/store.js";
import { readRunState, writeRunState, type RunState } from "./state.js";

export interface PostDeps {
  store: Store; recipients: RecipientsConfig; filters: FiltersConfig; now: Date; workDir: string;
  mailer: Mailer | null; forceSend?: boolean;
}

export interface PostResult {
  send_expected: boolean; sent: boolean; digest_id: string | null; entries: number; overflow: number;
  subject: string; message_id: string | null; error: string | null; html_path: string; text_path: string;
}

export function nextDigestId(existing: string[], today: string): string {
  const used = new Set(existing);
  if (!used.has(today)) return today;
  for (const suffix of "bcdefghijklmnopqrstuvwxyz") {
    if (!used.has(`${today}${suffix}`)) return `${today}${suffix}`;
  }
  throw new Error(`too many digests on ${today}`);
}

function healthFrom(state: RunState, weekday: boolean): HealthSummary {
  const sources: SourceHealth[] = Object.entries(state.sources).map(([name, s]) => {
    let status: SourceHealth["status"] = "ok";
    let note: string | undefined;
    if (s.partial && s.errors.length > 0) { status = "fail"; note = s.errors[0]; }
    else if (s.errors.length > 0) { status = "warn"; note = s.errors[0]; }
    else if (s.fetched === 0 && weekday) { status = "warn"; note = "0 fetched"; }
    return { name, fetched: s.fetched, candidates: s.candidates, scored: 0, new: s.new, status, ...(note ? { note } : {}) };
  });
  const durationMs = Date.parse(state.started_at) ? Date.now() - Date.parse(state.started_at) : 0;
  return { sources, scoring: state.scoring.status, durationMs, criteriaVersion: null };
}

export async function runPost(deps: PostDeps): Promise<PostResult> {
  const state = readRunState(deps.workDir);
  const today = todayNewYork(deps.now);
  const weekday = deps.recipients.send_days.includes(weekdayNewYork(deps.now));
  const sendExpected = deps.forceSend === true || weekday;
  const records = deps.store.list();

  const { entries, overflow } = selectDigestEntries(records, {
    today, minNetScore: deps.recipients.min_net_score, cap: deps.recipients.cap, noticeTypes: deps.filters.notice_types_for_digest,
  });
  const soonCutoff = addDays(today, 5);
  const dueSoon = records.filter((o) => {
    const due = effectiveDue(o).at;
    return o.feedback?.decision === "pursued" && due !== null && due.slice(0, 10) >= today && due.slice(0, 10) <= soonCutoff;
  });

  const existingIds = deps.store.readJsonl<{ digest_id: string }>("digests").map((d) => d.digest_id);
  const digestId = sendExpected ? nextDigestId(existingIds, today) : null;
  const digestEntries: DigestEntry[] = entries.map((record, i) => ({
    entryId: `${digestId ?? today}-${String(i + 1).padStart(2, "0")}`, record,
  }));
  const model: DigestModel = {
    date: today, subjectPrefix: deps.recipients.subject_prefix, sheetUrl: deps.recipients.sheet_url,
    entries: digestEntries, overflow, dueSoon, health: healthFrom(state, weekday), minScore: deps.recipients.min_net_score,
  };
  const rendered = renderDigest(model);

  mkdirSync(deps.workDir, { recursive: true });
  const htmlPath = join(deps.workDir, "digest.html");
  const textPath = join(deps.workDir, "digest.txt");
  writeFileSync(htmlPath, rendered.html);
  writeFileSync(textPath, rendered.text);

  let sent = false;
  let messageId: string | null = null;
  let error: string | null = null;
  const entryRefs = digestEntries.map((e) => ({ entry_id: e.entryId, id: e.record.id }));

  if (sendExpected && digestId && deps.mailer) {
    try {
      const res = await deps.mailer.send({
        from: deps.recipients.from, to: [...deps.recipients.to], subject: rendered.subject, text: rendered.text, html: rendered.html,
      });
      sent = true;
      messageId = res.messageId;
      markSent(deps.store, digestId, digestEntries, rendered.subject, messageId, deps.now.toISOString());
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  writeFileSync(join(deps.workDir, "digest.meta.json"), JSON.stringify({
    digest_id: digestId, subject: rendered.subject, to: deps.recipients.to, from: deps.recipients.from,
    send_expected: sendExpected, sent, pending_send: sendExpected && !sent && !error && deps.mailer === null,
    entries: entryRefs, overflow, error,
  }, null, 2) + "\n");

  state.digest = { digest_id: digestId, sent, send_expected: sendExpected, entries: entries.length, overflow, message_id: messageId, error };
  writeRunState(deps.workDir, state);

  return { send_expected: sendExpected, sent, digest_id: digestId, entries: entries.length, overflow, subject: rendered.subject, message_id: messageId, error, html_path: htmlPath, text_path: textPath };
}

export function markSent(store: Store, digestId: string, entries: DigestEntry[], subject: string, messageId: string, sentAt: string): void {
  for (const e of entries) {
    const rec = store.get(e.record.id);
    if (!rec) continue;
    rec.digest = { sent_in: [...rec.digest.sent_in, digestId], sent_hash: rec.content_hash };
    store.save(rec);
  }
  store.appendJsonl("digests", {
    digest_id: digestId, sent_at: sentAt, message_id: messageId, subject,
    entries: entries.map((e) => ({ entry_id: e.entryId, id: e.record.id })),
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/post.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src/run/post.ts test/post.test.ts
git commit -m "Add the post step: select, render, send, record digest"
```

---

### Task 13: Post-run checks

**Files:**
- Create: `src/check/check.ts`
- Test: `test/check.test.ts`

**Interfaces:**
- Consumes: `RunState` (Task 11), `SourcesConfig` (Task 8), `addDays` (Task 2).
- Produces:
  ```ts
  export interface CheckInput { state: RunState; previousRuns: RunState[]; today: string; weekday: boolean; sources: SourcesConfig }
  export interface CheckResult { ok: boolean; warnings: string[]; failures: string[] }
  export function evaluateChecks(input: CheckInput): CheckResult
  ```
- Rules (SPEC 7.4), where "previous run" means the last entry of `previousRuns` and "consecutive" counts back from the current run:
  - source `partial` or `errors.length > 0` → warning `"<src>: partial or errors"`; if the previous run also had it → failure `"<src>: partial or errors two runs running"`.
  - source `fetched === 0` and `weekday` → warning `"<src>: 0 fetched"`; three consecutive runs (this plus two previous) with `fetched === 0` → failure `"<src>: 0 fetched three runs running"`.
  - source `candidates === 0` while `fetched > 0`, for this and the previous 6 runs → warning `"<src>: no candidates in 7 runs"`.
  - `state.digest?.send_expected && !state.digest.sent` → failure `"digest expected but not sent: <error>"`.
  - `state.scoring.status` starts with `"rejected"` → failure; `state.scoring.carried_over > 0` → warning (both are milestone 2 inputs; wire them now).
  - for each enabled source, `checkpoint_posted_from` older than `addDays(today, -maxAge)` → failure `"<src>: checkpoint stale (<date>)"`, where `maxAge` is that source's `max_checkpoint_age_days` from `sources.yaml` (default 3 when absent). CROL uses 14 because the City Record publishes in batches. A missing checkpoint on the very first run (no previous runs) is not a failure.
  - `ok` is `failures.length === 0`.

- [ ] **Step 1: Write the failing tests**

`test/check.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { evaluateChecks } from "../src/check/check.js";
import type { RunState, SourceRunStats } from "../src/run/state.js";

const sources = { crol: { enabled: true, base_url: "https://x", columns_url: "https://x", limit: 1000, overlap_days: 2, default_from: "2026-09-01", max_checkpoint_age_days: 3 } };

function src(over: Partial<SourceRunStats> = {}): SourceRunStats {
  return { requests: 1, fetched: 5, normalized: 5, skipped: 0, new: 1, changed: 0, candidates: 1, errors: [], partial: false, checkpoint_posted_from: "2026-09-27", http_log: [], ...over };
}
function run(over: Partial<RunState> = {}, s: Partial<SourceRunStats> = {}): RunState {
  return {
    run_id: "r", started_at: "2026-09-28T11:00:00Z", git_sha: null, sources: { crol: src(s) }, pending_count: 0,
    scoring: { status: "not enabled (milestone 1)", imported: 0, carried_over: 0, rejected: 0 },
    digest: { digest_id: "2026-09-28", sent: true, send_expected: true, entries: 1, overflow: 0, message_id: "<m>", error: null },
    warnings: [], finished_at: null, check: null, ...over,
  };
}
const base = { today: "2026-09-28", weekday: true, sources };

describe("evaluateChecks", () => {
  it("passes a healthy run", () => {
    expect(evaluateChecks({ ...base, state: run(), previousRuns: [] })).toEqual({ ok: true, warnings: [], failures: [] });
  });

  it("warns on a single partial and fails on two in a row", () => {
    const one = evaluateChecks({ ...base, state: run({}, { partial: true, errors: ["x"] }), previousRuns: [run()] });
    expect(one.ok).toBe(true);
    expect(one.warnings).toEqual(["crol: partial or errors"]);
    const two = evaluateChecks({ ...base, state: run({}, { partial: true, errors: ["x"] }), previousRuns: [run({}, { partial: true, errors: ["x"] })] });
    expect(two.failures).toEqual(["crol: partial or errors two runs running"]);
  });

  it("warns on zero fetched on a weekday and fails after three", () => {
    const zero = { fetched: 0, normalized: 0, new: 0, candidates: 0 };
    expect(evaluateChecks({ ...base, state: run({}, zero), previousRuns: [] }).warnings).toEqual(["crol: 0 fetched"]);
    expect(evaluateChecks({ ...base, weekday: false, state: run({}, zero), previousRuns: [] }).warnings).toEqual([]);
    const three = evaluateChecks({ ...base, state: run({}, zero), previousRuns: [run({}, zero), run({}, zero)] });
    expect(three.failures).toEqual(["crol: 0 fetched three runs running"]);
  });

  it("warns when nothing has been a candidate for seven runs", () => {
    const none = { candidates: 0 };
    const prev = Array.from({ length: 6 }, () => run({}, none));
    expect(evaluateChecks({ ...base, state: run({}, none), previousRuns: prev }).warnings).toEqual(["crol: no candidates in 7 runs"]);
    expect(evaluateChecks({ ...base, state: run({}, none), previousRuns: prev.slice(1) }).warnings).toEqual([]);
  });

  it("fails when a digest was expected and not sent", () => {
    const r = run({ digest: { digest_id: "2026-09-28", sent: false, send_expected: true, entries: 1, overflow: 0, message_id: null, error: "smtp down" } });
    expect(evaluateChecks({ ...base, state: r, previousRuns: [] }).failures).toEqual(["digest expected but not sent: smtp down"]);
  });

  it("fails on a stale checkpoint but not on a first run without one", () => {
    expect(evaluateChecks({ ...base, state: run({}, { checkpoint_posted_from: "2026-09-20" }), previousRuns: [] }).failures)
      .toEqual(["crol: checkpoint stale (2026-09-20)"]);
    const lenient = { crol: { ...sources.crol, max_checkpoint_age_days: 14 } };
    expect(evaluateChecks({ ...base, sources: lenient, state: run({}, { checkpoint_posted_from: "2026-09-20" }), previousRuns: [] }).failures).toEqual([]);
    expect(evaluateChecks({ ...base, state: run({}, { checkpoint_posted_from: null }), previousRuns: [] }).failures).toEqual([]);
    expect(evaluateChecks({ ...base, state: run({}, { checkpoint_posted_from: null }), previousRuns: [run()] }).failures)
      .toEqual(["crol: checkpoint stale (none)"]);
  });

  it("treats scoring status", () => {
    expect(evaluateChecks({ ...base, state: run({ scoring: { status: "rejected: schema", imported: 0, carried_over: 0, rejected: 1 } }), previousRuns: [] }).failures)
      .toEqual(["scoring rejected: schema"]);
    expect(evaluateChecks({ ...base, state: run({ scoring: { status: "partial", imported: 5, carried_over: 3, rejected: 0 } }), previousRuns: [] }).warnings)
      .toEqual(["scoring partial: 3 carried over"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/check.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/check/check.ts`:
```ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/check.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src/check/check.ts test/check.test.ts
git commit -m "Add post-run invariants"
```

---

### Task 14: CLI wiring, CSV export, sent, notify-failure, check-env

**Files:**
- Create: `src/cli.ts`, `src/export/csv.ts`
- Test: `test/csv.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces (`csv.ts`): `toCsv(records: Opportunity[]): string` with header `id,source,notice_type,agency,title,posted_at,due_at,net_score,stage,matched,feedback,sent_in,source_url` and RFC 4180 quoting.
- Produces (`cli.ts`): `main(argv: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<number>` (exit code), plus the `#!/usr/bin/env node` entry that calls it. Subcommands:
  - `pre` → `runPre` with `adapters = [crolAdapter]`, prints one JSON line of per-source stats.
  - `post [--no-send] [--force-send] [--scores DIR]` → `runPost` with `createSmtpMailer(env)` unless `--no-send`; `--scores` is accepted and ignored in milestone 1; prints the `PostResult` as one JSON line. Exit 0 even when `sent` is false (the check decides).
  - `sent --digest-id ID [--message-id M]` → reads `work/digest.meta.json`, requires `pending_send` and a matching id, calls `markSent` with the entries and the subject, sets `pending_send: false` in the meta file, updates run state `digest.sent = true`.
  - `check` → `readRunState`, `previousRuns = store.readJsonl<RunState>("runs")`, `evaluateChecks`, sets `state.check` and `finished_at`, appends the state to `runs.jsonl`, prints the result as one JSON line, exit 0 if `ok` else 1.
  - `ingest <source> [--from YYYY-MM-DD]` → runs only that adapter with `default_from` overridden and no checkpoint when `--from` is given; prints stats. Used for backfills.
  - `export csv [--out PATH]` → writes `toCsv(store.list())` to `PATH` (default `work/opportunities.csv`) and prints the path.
  - `check-env` → prints each of `SMTP_USER`, `SMTP_APP_PASSWORD`, `HEALTHCHECKS_URL`, `SOCRATA_APP_TOKEN` as `set` or `missing`, never values. Exit 1 if `SMTP_USER` or `SMTP_APP_PASSWORD` is missing.
  - `notify-failure --step N --log PATH` → sends a plain-text email "propozaler run failed at step N" with the last 40 lines of `PATH` to `recipients.to` via `createSmtpMailer(env)`. Exit 0 on send, 1 on failure (but never throws).
  - Paths: `configDir = <cwd>/config`, `dataDir = <cwd>/data`, `workDir = <cwd>/work`. `gitSha` from `git rev-parse --short HEAD` via `execFileSync`, `null` on error.
  - Unknown command or `--help` prints usage and exits 2.

- [ ] **Step 1: Write the failing CSV test**

`test/csv.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { toCsv } from "../src/export/csv.js";
import { newOpportunity } from "../src/model/opportunity.js";
import { sampleNormalized } from "./helpers.js";

describe("toCsv", () => {
  it("quotes fields with commas and quotes", () => {
    const o = newOpportunity(sampleNormalized({ title: 'Say "hi", please' }), "2026-09-27T11:00:00Z");
    o.prefilter = { net_score: 4, matched: ["cat:parks_rec:activity registration", "bonus:home:NY"], stage: "candidate", filters_version: 2 };
    const csv = toCsv([o]);
    const [header, row] = csv.trimEnd().split("\n");
    expect(header).toBe("id,source,notice_type,agency,title,posted_at,due_at,net_score,stage,matched,feedback,sent_in,source_url");
    expect(row).toContain('"Say ""hi"", please"');
    expect(row).toContain('"cat:parks_rec:activity registration; bonus:home:NY"');
    expect(row?.startsWith("crol:20260909003,crol,solicitation,Brooklyn Bridge Park,")).toBe(true);
  });
});
```

- [ ] **Step 2: Implement CSV**

`src/export/csv.ts`:
```ts
import type { Opportunity } from "../model/opportunity.js";

const HEADER = ["id", "source", "notice_type", "agency", "title", "posted_at", "due_at", "net_score", "stage", "matched", "feedback", "sent_in", "source_url"];

function cell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(records: Opportunity[]): string {
  const rows = records.map((o) => [
    o.id, o.source, o.notice_type, o.agency, o.title, o.posted_at, o.due_at ?? "",
    o.prefilter?.net_score ?? "", o.prefilter?.stage ?? "", (o.prefilter?.matched ?? []).join("; "),
    o.feedback?.decision ?? "", o.digest.sent_in.join("; "), o.source_url,
  ].map(cell).join(","));
  return [HEADER.join(","), ...rows].join("\n") + "\n";
}
```

Run: `npx vitest run test/csv.test.ts` → 1 passed.

- [ ] **Step 3: Write the failing CLI tests**

`test/cli.test.ts` (tests the wiring through `main`, with the CROL adapter served from fixtures by an injected fetch):
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => JSON.parse(readFileSync(join(here, "fixtures", "crol", name), "utf8"));

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "propozaler-cli-"));
  cpSync(join(here, "..", "config"), join(dir, "config"), { recursive: true });
  return dir;
}

const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  const body = url.includes("/columns.json") ? fx("columns.json") : url.includes("$offset=0") ? fx("page-1.json") : fx("page-empty.json");
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

describe("cli", () => {
  it("runs pre, post --no-send, sent, check end to end", async () => {
    const dir = project();
    const out: string[] = [];
    // Fixture rows are posted 2026-09-15/16, so "now" is the following Thursday; a later date would trip the stale-checkpoint check.
    const io = { stdout: (s: string) => out.push(s), fetchImpl: fakeFetch, now: () => new Date("2026-09-17T11:00:00Z") };

    expect(await main(["pre"], {}, dir, io)).toBe(0);
    expect(existsSync(join(dir, "work", "run.json"))).toBe(true);
    expect(existsSync(join(dir, "data", "opportunities", "crol__20260909003.json"))).toBe(true);

    expect(await main(["post", "--no-send"], {}, dir, io)).toBe(0);
    const meta = JSON.parse(readFileSync(join(dir, "work", "digest.meta.json"), "utf8"));
    expect(meta.pending_send).toBe(true);
    expect(meta.digest_id).toBe("2026-09-17");

    expect(await main(["sent", "--digest-id", "2026-09-17", "--message-id", "<x>"], {}, dir, io)).toBe(0);
    const digests = readFileSync(join(dir, "data", "digests.jsonl"), "utf8");
    expect(digests).toContain('"digest_id":"2026-09-17"');

    expect(await main(["check"], {}, dir, io)).toBe(0);
    const runs = readFileSync(join(dir, "data", "runs.jsonl"), "utf8").trim().split("\n");
    expect(runs).toHaveLength(1);
    expect(JSON.parse(runs[0]!).check.ok).toBe(true);
  });

  it("check exits 1 when the digest was expected and not sent", async () => {
    const dir = project();
    const io = { stdout: () => {}, fetchImpl: fakeFetch, now: () => new Date("2026-09-17T11:00:00Z") };
    await main(["pre"], {}, dir, io);
    await main(["post"], { SMTP_USER: "u", SMTP_APP_PASSWORD: "p" }, dir, { ...io, mailerFactory: () => ({ async send() { throw new Error("smtp down"); } }) });
    expect(await main(["check"], {}, dir, io)).toBe(1);
  });

  it("check-env reports names only", async () => {
    const out: string[] = [];
    const code = await main(["check-env"], { SMTP_USER: "secret@x", SMTP_APP_PASSWORD: "pw" }, project(), { stdout: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(out.join("")).toContain("SMTP_USER: set");
    expect(out.join("")).not.toContain("secret@x");
    expect(await main(["check-env"], {}, project(), { stdout: () => {} })).toBe(1);
  });

  it("export csv writes a file", async () => {
    const dir = project();
    const io = { stdout: () => {}, fetchImpl: fakeFetch, now: () => new Date("2026-09-17T11:00:00Z") };
    await main(["pre"], {}, dir, io);
    expect(await main(["export", "csv"], {}, dir, io)).toBe(0);
    expect(readFileSync(join(dir, "work", "opportunities.csv"), "utf8")).toContain("crol:20260909003");
  });

  it("prints usage for unknown commands", async () => {
    const out: string[] = [];
    expect(await main(["bogus"], {}, project(), { stdout: (s) => out.push(s) })).toBe(2);
    expect(out.join("")).toContain("usage");
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 5: Implement the CLI**

`src/cli.ts`:
```ts
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
```

If the `invokedDirectly` check misfires on macOS symlinks after `npm link`, replace it with `if (process.argv[1]?.endsWith("cli.js"))`.

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run test/cli.test.ts test/csv.test.ts`
Expected: 6 passed.

- [ ] **Step 7: Run the whole suite, typecheck, and build**

Run: `npm test && npm run typecheck && npm run build && node dist/cli.js --help; echo "exit=$?"`
Expected: all tests pass, typecheck clean, `dist/cli.js` exists, usage printed with exit 2.

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts src/export/csv.ts test/cli.test.ts test/csv.test.ts
git commit -m "Wire the CLI: pre, post, sent, check, ingest, export, check-env, notify-failure"
```

---

### Task 15: Routine prompt, deployment, and the live proof

This task is operational. It has commands and checks, not TDD, and it needs the accounts from the pre-milestone list in `SPEC.md` section 8: the dedicated Gmail account with an app password, the healthchecks.io check, and both recipient addresses in `config/recipients.yaml`.

**Files:**
- Create: `ROUTINE.md`
- Modify: `config/recipients.yaml` (real addresses), `README.md` (routine section)

- [ ] **Step 1: Write ROUTINE.md**

```markdown
# propozaler daily routine

You are running the propozaler daily pipeline. Follow these steps exactly, in order. Do not edit any file
under src/, config/, prompts/, or test/. Do not fetch sources by hand. Do not send email yourself; the CLI does.
Everything below runs from the repository root.

1. Get on the state branch with current code:
   git fetch origin
   git checkout claude/state 2>/dev/null || git checkout -b claude/state origin/main
   git merge --no-edit origin/main
2. Install and build:
   npm ci && npm run build
3. Announce the start:
   curl -fsS -m 10 "$HEALTHCHECKS_URL/start" || true
4. Ingest and select:
   node dist/cli.js pre 2>&1 | tee work/run.log
   If the exit code is not 0, skip to step 8.
5. (Milestone 2 will add scoring here. Nothing to do yet.)
6. Build and send the digest:
   node dist/cli.js post 2>&1 | tee -a work/run.log
7. Evaluate the run:
   node dist/cli.js check 2>&1 | tee -a work/run.log
   Remember the exit code as CHECK.
8. Commit state:
   git add data && git commit -m "run $(date -u +%F): $(tail -1 work/run.log | cut -c1-120)" || true
   git push origin claude/state
   Remember whether the push succeeded as PUSH.
9. Ping healthchecks:
   If CHECK was 0 and PUSH succeeded:   curl -fsS -m 10 "$HEALTHCHECKS_URL"
   Otherwise:                            curl -fsS -m 10 --data-binary @work/run.log "$HEALTHCHECKS_URL/fail"
10. If any step above failed in a way you could not continue from, run
    node dist/cli.js notify-failure --step <N> --log work/run.log
    and stop.

Report in one line what happened: fetched/new/candidates per source, whether the digest was sent, and the
check result.
```

If milestone 1 step 5 below shows that the routine may push to `main`, replace step 1 with `git checkout main && git pull` and push to `main` in step 8, and update `SPEC.md` sections 2.4, 7.2 and `CLAUDE.md` to say the state lives on `main`.

- [ ] **Step 2: Fill in recipients and commit config**

Edit `config/recipients.yaml`: real `from` (the dedicated account) and both `to` addresses. Run `npm test` (the config test parses it). Commit:

```bash
git add ROUTINE.md config/recipients.yaml
git commit -m "Add routine procedure and real recipients"
git push origin main
```

- [ ] **Step 3: Create the cloud environment variables**

In the claude.ai Claude Code environment used by routines (Default), add: `SMTP_USER`, `SMTP_APP_PASSWORD`, `HEALTHCHECKS_URL`, and optionally `SOCRATA_APP_TOKEN`. Values come from the dedicated Gmail account's app password and the healthchecks.io check's ping URL (the check: name `propozaler-daily`, period 1 day, grace 3 hours, alert both addresses by email).

- [ ] **Step 4: Prove connectivity from the sandbox before creating the daily routine**

Create a one-off routine (via `/schedule` in a Claude Code session, "run once" a few minutes ahead, repo `https://github.com/Gatastrofik/propozaler`, model `claude-sonnet-5`, no connectors) with this prompt:

```
Run each command from the repository root and report the exit code and the first line of output for each. Do not fix anything.
1. node --version
2. npm ci && npm run build && node dist/cli.js check-env
3. curl -sS -m 10 -o /dev/null -w "%{http_code}\n" "https://data.cityofnewyork.us/resource/dg92-zbpx.json?\$limit=1"
4. curl -sS -m 10 -o /dev/null -w "%{http_code}\n" https://sheets.googleapis.com/
5. node -e "const s=require('node:net').connect(465,'smtp.gmail.com',()=>{console.log('smtp 465 open');s.end()});s.on('error',e=>{console.log('smtp 465 error',e.code);});s.setTimeout(8000,()=>{console.log('smtp 465 timeout');s.destroy()})"
6. node -e "const s=require('node:net').connect(993,'imap.gmail.com',()=>{console.log('imap 993 open');s.end()});s.on('error',e=>{console.log('imap 993 error',e.code);});s.setTimeout(8000,()=>{console.log('imap 993 timeout');s.destroy()})"
7. curl -fsS -m 10 "$HEALTHCHECKS_URL/start" && echo ping ok
8. git checkout -b claude/state && git commit --allow-empty -m "state branch probe" && git push origin claude/state && echo push-state ok
9. git checkout main && git commit --allow-empty -m "main push probe" && git push origin main && echo push-main ok
```

Read the run log (`/schedule` → list runs → run log). Record the outcomes in `SPEC.md` section 9 open questions 1 and the sandbox risk line: Node version, SMTP 465 reachable or not, IMAP 993 reachable or not, `sheets.googleapis.com` reachable, healthchecks reachable, state-branch push ok, main push ok or refused. If `push-main ok`, apply the simplification noted under Step 1. If SMTP is not reachable, stop here and switch delivery to the Gmail connector fallback (SPEC 7.2 step 7) before continuing; that is a design change worth a short session of its own.

Delete the probe commits afterwards if they landed on `main` (`git push origin :claude/state` for the branch; for `main`, `git revert` is unnecessary since the commits are empty, leave them).

- [ ] **Step 5: Create the daily routine**

Via `/schedule`: name `propozaler-daily`, cron `0 11 * * *` (07:00 EDT), repo `https://github.com/Gatastrofik/propozaler`, model `claude-sonnet-5`, no connectors, allowed tools Bash/Read/Glob/Grep, prompt = the exact contents of `ROUTINE.md`. Record the routine URL in `README.md` under a "Routine" heading.

- [ ] **Step 6: First real run, on demand**

Trigger "run now". Expected within a few minutes: both inboxes receive `propozaler <date>: N new · CROL ok` with real NYC solicitations, the `claude/state` branch on GitHub has `data/opportunities/*.json`, `data/runs.jsonl` with one line whose `check.ok` is `true`, `data/digests.jsonl` with one line, and healthchecks shows a fresh success ping.

Open the email on a phone. The entry title links must open the City Record page. The health footer must read `crol <fetched> / <candidates> / 0 / <new>`.

- [ ] **Step 7: Break it on purpose**

Temporarily rename the `SMTP_APP_PASSWORD` environment variable in the cloud environment, run the routine again, and confirm: `post` reports `sent: false` with the SMTP error, `check` exits 1, the routine pings `/fail`, healthchecks emails both of you, and `notify-failure` cannot send either (it uses the same credentials) and says so in the run log. Restore the variable, run again, confirm a success ping.

- [ ] **Step 8: Two consecutive scheduled mornings**

Let the cron fire on two consecutive weekdays. Milestone 1 is done when both digests arrive without intervention, `runs.jsonl` has both runs with `check.ok: true`, and the second run's `crol.new` count is plausible (a handful, not zero and not hundreds). Write the observed per-run duration and fetched counts into `SPEC.md` section 7.6.

- [ ] **Step 9: Commit docs**

```bash
git add README.md SPEC.md
git commit -m "Record milestone 1 deployment results"
git push origin main
```

---

## Self-review notes

- Spec coverage for milestone 1: adapter interface and CROL rules (Tasks 4–6), pre-filter (Task 7), storage layout and JSONL logs (Task 4), digest selection, cap, ordering, escaping, CROL date label, health footer (Task 9), SMTP delivery (Tasks 10, 12), weekend no-allocate rule (Task 12), run record and check invariants (Tasks 11, 13), CSV on demand (Task 14), routine procedure, secrets, dead-man's switch, proof steps (Task 15). Sheet feedback, scoring, and `work/pending` contents are milestone 2 and are only stubbed (empty `pending/` directory, `scoring` block in run state, `--scores` flag accepted).
- Type names used across tasks: `NormalizedOpportunity`, `Opportunity`, `Prefilter`, `Checkpoint`, `HttpClient`, `SourceAdapter`, `FetchContext`, `FetchResult`, `FiltersConfig`, `SourcesConfig`, `RecipientsConfig`, `RunState`, `SourceRunStats`, `DigestModel`, `DigestEntry`, `HealthSummary`, `Mailer`, `MailMessage`, `PostResult`, `CheckResult`.
- `sampleNormalized` and `NOW` live in `test/helpers.ts` (Task 3) and are imported by later tests.

---

## Addendum (2026-09-27 evening): Gmail REST API delivery

The Task 15 probe showed the routine sandbox blocks raw TCP to Gmail on ports 465 and 993, while HTTPS to Google APIs is allowed once the host is allowlisted. Decision: the CLI sends through the Gmail REST API over HTTPS as `jobdigest0@gmail.com`, authenticated with an OAuth refresh token. SMTP stays as the local development path. Milestone 3's alert reading will use the same client with a read scope, subject to the open question in SPEC.md section 9 about Google's restricted-scope verification.

Additional constraints for these tasks:
- No new dependencies. OAuth token refresh and the Gmail send call use the global `fetch`; the MIME body is built with nodemailer's bundled `MailComposer` (`nodemailer/lib/mail-composer/index.js`), which is part of the already-installed package.
- New environment variables: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`. Never printed, never logged, never in an error message.
- Hosts the routine environment must allowlist: `oauth2.googleapis.com`, `gmail.googleapis.com` (plus `data.cityofnewyork.us` and `hc-ping.com`, already added).
- The refresh token is obtained once, locally, by `propozaler gmail-auth`, printed to the terminal for the engineer to paste into the environment, and never written to disk by the CLI.

### Task 16: Gmail API mailer and the one-time consent flow

**Files:**
- Create: `src/digest/gmail.ts`, `src/digest/gmail-auth.ts`
- Test: `test/gmail.test.ts`, `test/gmail-auth.test.ts`

**Interfaces:**
- Consumes: `Mailer`, `MailMessage` (Task 10).
- Produces (`gmail.ts`):
  ```ts
  export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
  export interface GmailCredentials { clientId: string; clientSecret: string; refreshToken: string }
  export function gmailCredentialsFromEnv(env: NodeJS.ProcessEnv): GmailCredentials   // throws "missing GMAIL_CLIENT_ID" etc.
  export async function fetchAccessToken(creds: GmailCredentials, fetchImpl?: typeof fetch): Promise<string>
  export async function buildRawMessage(msg: MailMessage): Promise<string>   // RFC 2822 via MailComposer, base64url
  export function createGmailApiMailer(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Mailer   // messageId = "gmail:<id>"
  ```
- Produces (`gmail-auth.ts`):
  ```ts
  export function consentUrl(clientId: string, redirectUri: string, scopes: string[]): string
  export async function exchangeCode(creds: { clientId: string; clientSecret: string }, code: string, redirectUri: string, fetchImpl?: typeof fetch): Promise<{ refresh_token: string }>
  export async function runGmailAuth(opts: { clientId: string; clientSecret: string; scopes: string[]; fetchImpl?: typeof fetch; out: (s: string) => void; port?: number }): Promise<string>
  ```
  `runGmailAuth` starts an HTTP server on `127.0.0.1` (port 0 unless given), prints the consent URL through `out`, waits for `GET /?code=...`, exchanges the code, answers the browser with a plain "You can close this tab.", closes the server, and resolves the refresh token. `GET /?error=...` rejects with the error text. Nothing is written to disk.

Token endpoint: `POST https://oauth2.googleapis.com/token`, body `application/x-www-form-urlencoded`. Refresh: `client_id, client_secret, refresh_token, grant_type=refresh_token` → `{ access_token }`. Exchange: `client_id, client_secret, code, redirect_uri, grant_type=authorization_code` → `{ refresh_token, access_token }`. A non-2xx response throws `gmail token request failed: HTTP <status> <error field from the JSON body if any>`; the body is never echoed whole.
Send endpoint: `POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send`, header `Authorization: Bearer <access_token>`, JSON body `{ "raw": <base64url> }` → `{ id, threadId }`. Non-2xx throws `gmail send failed: HTTP <status> <error.message if any>`.
Consent URL: `https://accounts.google.com/o/oauth2/v2/auth` with `client_id, redirect_uri, response_type=code, scope=<space-joined>, access_type=offline, prompt=consent`.

- [ ] **Step 1: Write the failing tests**

`test/gmail.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { gmailCredentialsFromEnv, fetchAccessToken, buildRawMessage, createGmailApiMailer, GMAIL_SEND_SCOPE } from "../src/digest/gmail.js";

const env = { GMAIL_CLIENT_ID: "cid", GMAIL_CLIENT_SECRET: "csec", GMAIL_REFRESH_TOKEN: "rtok" };
const msg = { from: "jobdigest0@gmail.com", to: ["a@example.com", "b@example.com"], subject: "Sübject", text: "plain", html: "<p>plain</p>" };

function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init: init ?? {} });
    const r = handler(url, init ?? {});
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

describe("gmailCredentialsFromEnv", () => {
  it("requires all three variables, naming the first missing one", () => {
    expect(() => gmailCredentialsFromEnv({})).toThrow(/missing GMAIL_CLIENT_ID/);
    expect(() => gmailCredentialsFromEnv({ GMAIL_CLIENT_ID: "x" })).toThrow(/missing GMAIL_CLIENT_SECRET/);
    expect(() => gmailCredentialsFromEnv({ GMAIL_CLIENT_ID: "x", GMAIL_CLIENT_SECRET: "y" })).toThrow(/missing GMAIL_REFRESH_TOKEN/);
    expect(gmailCredentialsFromEnv(env)).toEqual({ clientId: "cid", clientSecret: "csec", refreshToken: "rtok" });
  });
});

describe("fetchAccessToken", () => {
  it("posts a form-encoded refresh grant and returns the access token", async () => {
    const f = fakeFetch(() => ({ status: 200, body: { access_token: "AT", expires_in: 3599 } }));
    expect(await fetchAccessToken(gmailCredentialsFromEnv(env), f.impl)).toBe("AT");
    const call = f.calls[0]!;
    expect(call.url).toBe("https://oauth2.googleapis.com/token");
    expect(call.init.method).toBe("POST");
    const body = new URLSearchParams(String(call.init.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rtok");
    expect(body.get("client_id")).toBe("cid");
  });
  it("throws a status-only error without echoing secrets", async () => {
    const f = fakeFetch(() => ({ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }));
    await expect(fetchAccessToken(gmailCredentialsFromEnv(env), f.impl)).rejects.toThrow(/gmail token request failed: HTTP 400 invalid_grant/);
    await expect(fetchAccessToken(gmailCredentialsFromEnv(env), f.impl)).rejects.not.toThrow(/rtok|csec/);
  });
});

describe("buildRawMessage", () => {
  it("produces base64url MIME with both parts and the headers", async () => {
    const raw = await buildRawMessage(msg);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toMatch(/^From: jobdigest0@gmail.com/m);
    expect(decoded).toMatch(/^To: a@example.com, b@example.com/m);
    expect(decoded).toMatch(/^Subject: =\?UTF-8\?/m); // non-ASCII subject is RFC 2047 encoded
    expect(decoded).toContain("multipart/alternative");
    expect(decoded).toContain("text/plain");
    expect(decoded).toContain("text/html");
  });
});

describe("createGmailApiMailer", () => {
  it("refreshes, then sends with a bearer token, and returns the gmail id", async () => {
    const f = fakeFetch((url) => url.includes("oauth2") ? { status: 200, body: { access_token: "AT" } } : { status: 200, body: { id: "18f1abc", threadId: "18f1abc" } });
    const res = await createGmailApiMailer(env, f.impl).send(msg);
    expect(res.messageId).toBe("gmail:18f1abc");
    const send = f.calls[1]!;
    expect(send.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect((send.init.headers as Record<string, string>).Authorization).toBe("Bearer AT");
    expect(JSON.parse(String(send.init.body)).raw).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it("throws on a send failure without the token in the message", async () => {
    const f = fakeFetch((url) => url.includes("oauth2") ? { status: 200, body: { access_token: "SECRET-AT" } } : { status: 403, body: { error: { code: 403, message: "Request had insufficient authentication scopes." } } });
    const p = createGmailApiMailer(env, f.impl).send(msg);
    await expect(p).rejects.toThrow(/gmail send failed: HTTP 403 Request had insufficient authentication scopes/);
    await expect(createGmailApiMailer(env, f.impl).send(msg)).rejects.not.toThrow(/SECRET-AT/);
  });
  it("validates env before any network call", () => {
    expect(() => createGmailApiMailer({}, fakeFetch(() => ({ status: 200, body: {} })).impl)).toThrow(/missing GMAIL_CLIENT_ID/);
  });
  it("exports the send scope", () => {
    expect(GMAIL_SEND_SCOPE).toBe("https://www.googleapis.com/auth/gmail.send");
  });
});
```

`test/gmail-auth.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { consentUrl, exchangeCode, runGmailAuth } from "../src/digest/gmail-auth.js";

function fakeFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; body: string }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

describe("consentUrl", () => {
  it("builds the offline consent URL", () => {
    const u = new URL(consentUrl("cid", "http://127.0.0.1:4321/", ["https://www.googleapis.com/auth/gmail.send"]));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:4321/");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.send");
  });
});

describe("exchangeCode", () => {
  it("posts the authorization code and returns the refresh token", async () => {
    const f = fakeFetch({ access_token: "AT", refresh_token: "RT" });
    const r = await exchangeCode({ clientId: "cid", clientSecret: "csec" }, "thecode", "http://127.0.0.1:1/", f.impl);
    expect(r.refresh_token).toBe("RT");
    const body = new URLSearchParams(f.calls[0]!.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("thecode");
    expect(body.get("redirect_uri")).toBe("http://127.0.0.1:1/");
  });
  it("fails clearly when Google returns no refresh token", async () => {
    const f = fakeFetch({ access_token: "AT" });
    await expect(exchangeCode({ clientId: "cid", clientSecret: "csec" }, "c", "http://127.0.0.1:1/", f.impl)).rejects.toThrow(/no refresh_token in response/);
  });
});

describe("runGmailAuth", () => {
  it("prints the consent URL, accepts the loopback callback, and resolves the refresh token", async () => {
    const printed: string[] = [];
    const f = fakeFetch({ access_token: "AT", refresh_token: "RT-from-flow" });
    const pending = runGmailAuth({ clientId: "cid", clientSecret: "csec", scopes: ["s1"], fetchImpl: f.impl, out: (s) => printed.push(s) });
    // wait for the server to announce its URL
    let url = "";
    for (let i = 0; i < 50 && !url; i += 1) { await new Promise((r) => setTimeout(r, 10)); url = printed.join("\n").match(/redirect_uri=([^&\s]+)/)?.[1] ?? ""; }
    const redirect = decodeURIComponent(url);
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const res = await fetch(`${redirect}?code=abc123`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("You can close this tab");
    expect(await pending).toBe("RT-from-flow");
    expect(printed.join("\n")).not.toContain("RT-from-flow"); // the token is returned, not printed by the flow itself
  });
  it("rejects when the callback carries an error", async () => {
    const printed: string[] = [];
    const pending = runGmailAuth({ clientId: "cid", clientSecret: "csec", scopes: ["s1"], fetchImpl: fakeFetch({}).impl, out: (s) => printed.push(s) });
    let url = "";
    for (let i = 0; i < 50 && !url; i += 1) { await new Promise((r) => setTimeout(r, 10)); url = printed.join("\n").match(/redirect_uri=([^&\s]+)/)?.[1] ?? ""; }
    await fetch(`${decodeURIComponent(url)}?error=access_denied`);
    await expect(pending).rejects.toThrow(/access_denied/);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/gmail.test.ts test/gmail-auth.test.ts` → module not found.

- [ ] **Step 3: Implement `src/digest/gmail.ts`**

```ts
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { MailMessage, Mailer } from "./mailer.js";

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export interface GmailCredentials { clientId: string; clientSecret: string; refreshToken: string }

export function gmailCredentialsFromEnv(env: NodeJS.ProcessEnv): GmailCredentials {
  const clientId = env.GMAIL_CLIENT_ID;
  const clientSecret = env.GMAIL_CLIENT_SECRET;
  const refreshToken = env.GMAIL_REFRESH_TOKEN;
  if (!clientId) throw new Error("missing GMAIL_CLIENT_ID");
  if (!clientSecret) throw new Error("missing GMAIL_CLIENT_SECRET");
  if (!refreshToken) throw new Error("missing GMAIL_REFRESH_TOKEN");
  return { clientId, clientSecret, refreshToken };
}

async function errorField(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string | { message?: string } };
    if (typeof j.error === "string") return j.error;
    if (j.error && typeof j.error.message === "string") return j.error.message;
  } catch { /* not JSON */ }
  return "";
}

export async function fetchAccessToken(creds: GmailCredentials, fetchImpl: typeof fetch = fetch): Promise<string> {
  const body = new URLSearchParams({
    client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: creds.refreshToken, grant_type: "refresh_token",
  });
  const res = await fetchImpl(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
  if (!res.ok) throw new Error(`gmail token request failed: HTTP ${res.status} ${await errorField(res)}`.trim());
  const j = (await res.json()) as { access_token?: string };
  if (!j.access_token) throw new Error("gmail token request failed: no access_token in response");
  return j.access_token;
}

export async function buildRawMessage(msg: MailMessage): Promise<string> {
  const mail = new MailComposer({ from: msg.from, to: msg.to.join(", "), subject: msg.subject, text: msg.text, html: msg.html });
  const buf: Buffer = await mail.compile().build();
  return buf.toString("base64url");
}

export function createGmailApiMailer(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): Mailer {
  const creds = gmailCredentialsFromEnv(env);
  return {
    async send(msg) {
      const token = await fetchAccessToken(creds, fetchImpl);
      const raw = await buildRawMessage(msg);
      const res = await fetchImpl(SEND_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ raw }),
      });
      if (!res.ok) throw new Error(`gmail send failed: HTTP ${res.status} ${await errorField(res)}`.trim());
      const j = (await res.json()) as { id?: string };
      return { messageId: `gmail:${j.id ?? "unknown"}` };
    },
  };
}
```

If `MailComposer`'s `build()` is callback-style in the installed version, wrap it: `await new Promise<Buffer>((resolve, reject) => mail.compile().build((err, b) => err ? reject(err) : resolve(b)))`. If the default import lacks types, declare a local minimal type or use `// @ts-expect-error` with a one-line justification; report which.

- [ ] **Step 4: Implement `src/digest/gmail-auth.ts`**

```ts
import { createServer } from "node:http";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export function consentUrl(clientId: string, redirectUri: string, scopes: string[]): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", scopes.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  return u.toString();
}

export async function exchangeCode(
  creds: { clientId: string; clientSecret: string }, code: string, redirectUri: string, fetchImpl: typeof fetch = fetch,
): Promise<{ refresh_token: string }> {
  const body = new URLSearchParams({
    client_id: creds.clientId, client_secret: creds.clientSecret, code, redirect_uri: redirectUri, grant_type: "authorization_code",
  });
  const res = await fetchImpl(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
  if (!res.ok) throw new Error(`gmail code exchange failed: HTTP ${res.status}`);
  const j = (await res.json()) as { refresh_token?: string };
  if (!j.refresh_token) throw new Error("gmail code exchange failed: no refresh_token in response (was prompt=consent and access_type=offline set?)");
  return { refresh_token: j.refresh_token };
}

export async function runGmailAuth(opts: {
  clientId: string; clientSecret: string; scopes: string[]; fetchImpl?: typeof fetch; out: (s: string) => void; port?: number;
}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return new Promise<string>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const err = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (err) {
        res.writeHead(400, { "content-type": "text/plain" }); res.end(`Consent failed: ${err}`);
        server.close(); reject(new Error(`gmail consent failed: ${err}`)); return;
      }
      if (!code) { res.writeHead(404); res.end(); return; }
      try {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        const { refresh_token } = await exchangeCode(opts, code, `http://127.0.0.1:${port}/`, fetchImpl);
        res.writeHead(200, { "content-type": "text/plain" }); res.end("You can close this tab.");
        server.close(); resolve(refresh_token);
      } catch (e) {
        res.writeHead(500, { "content-type": "text/plain" }); res.end("Token exchange failed; see the terminal.");
        server.close(); reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const redirect = `http://127.0.0.1:${port}/`;
      opts.out(`Open this URL in a browser signed in as the sending account:\n${consentUrl(opts.clientId, redirect, opts.scopes)}\n`);
    });
  });
}
```

- [ ] **Step 5: Run to verify pass** — both test files; then `npm test` and `npm run typecheck`.
- [ ] **Step 6: Commit** — `git add src/digest/gmail.ts src/digest/gmail-auth.ts test/gmail.test.ts test/gmail-auth.test.ts` / "Add Gmail API mailer and one-time consent flow".

### Task 17: Wire the transport choice, `gmail-auth`, docs

**Files:**
- Modify: `src/config.ts` (`transport`), `src/cli.ts` (mailer factory, `gmail-auth`, `check-env`), `config/recipients.yaml`, `.env.example`, `README.md`, `ROUTINE.md`, `SPEC.md`, `CLAUDE.md`
- Test: `test/config.test.ts`, `test/cli.test.ts`

**Changes:**
1. `RecipientsConfigSchema` gains `transport: z.enum(["gmail_api", "smtp"]).default("gmail_api")`. `config/recipients.yaml` gets `transport: gmail_api   # smtp is the local fallback; the routine sandbox blocks port 465`. Test: `expect(c.recipients.transport).toBe("gmail_api")`.
2. `src/cli.ts`: `CliIo.mailerFactory` becomes `(env: NodeJS.ProcessEnv, transport: "gmail_api" | "smtp") => Mailer`; the default is `transport === "smtp" ? createSmtpMailer(env) : createGmailApiMailer(env)`. `post` and `notify-failure` pass `config.recipients.transport`. Existing CLI tests that inject `mailerFactory` keep working (extra argument ignored).
3. `check-env`: load config; the names printed are `HEALTHCHECKS_URL`, `SOCRATA_APP_TOKEN`, and the selected transport's variables (`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` for gmail_api; `SMTP_USER`, `SMTP_APP_PASSWORD` for smtp); exit 1 if any of the transport's variables is missing. Update the existing check-env test: with `transport: gmail_api` in the copied config, `{ SMTP_USER, SMTP_APP_PASSWORD }` alone now exits 1 and the three Gmail names appear; add a case where the three Gmail variables are set and the exit is 0; keep the assertion that no value is printed.
4. New subcommand `gmail-auth`: reads `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` from env (exit 2 with a one-line message if missing), calls `runGmailAuth` with `[GMAIL_SEND_SCOPE]`, prints `GMAIL_REFRESH_TOKEN=<token>` once followed by the line `Paste that into the routine environment and your local .env; it is not saved anywhere by this tool.` Add to `USAGE`. Not covered by the CLI test (it opens a server and needs a browser); `runGmailAuth` itself is tested in Task 16.
5. Docs:
   - `.env.example`: add the three Gmail variables above the SMTP pair, with a comment that SMTP is only for `transport: smtp`.
   - `README.md` "Routine" section: environment variables list becomes `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `HEALTHCHECKS_URL`, optional `SOCRATA_APP_TOKEN`; add "Network allowlist on the environment: `data.cityofnewyork.us`, `hc-ping.com`, `oauth2.googleapis.com`, `gmail.googleapis.com`"; add a "One-time Gmail consent" subsection: `set -a; source .env; set +a; npm run propozaler -- gmail-auth`, sign in as `jobdigest0@gmail.com`, copy the printed token.
   - `ROUTINE.md`: delete the connector-fallback branch (SMTP is no longer the routine's path) and leave the rest unchanged.
   - `SPEC.md` 2.5: choice becomes "the CLI sends through the Gmail REST API over HTTPS as the dedicated account, authenticated by an OAuth refresh token; SMTP remains the local development transport"; rationale adds "the routine sandbox blocks outbound 465 and 993 (probe, 2026-09-27) while HTTPS to allowlisted Google hosts works"; rejected alternative adds the Gmail connector (agent-driven send from the personal account). 7.5: replace the SMTP bullet with the three Gmail variables plus SMTP-only-when-transport-smtp; add the four allowlist hosts. 9 risks: replace the "Outbound SMTP and IMAP from the sandbox" bullet with "Resolved 2026-09-27: both blocked; delivery moved to the Gmail REST API." 9 open questions: add "Milestone 3 alert reading needs a Gmail read scope, which Google classifies as restricted; an unverified external OAuth app may be limited to test users with 7-day refresh tokens. Options: publish and verify, forward alerts into a Sheet via a Gmail filter plus Apps Script, or a Workspace account. Decide before milestone 3."
   - `CLAUDE.md`: secrets line lists the Gmail variables; "All mail I/O is CLI code" sentence mentions the Gmail REST API over HTTPS with SMTP as the local fallback.
6. `npm test`, `npm run typecheck`, commit "Send through the Gmail API; add gmail-auth and transport config".

### Task 18 (operational, engineer): consent, variables, allowlist, first cloud run

1. In GCP project `jobs-504814`: enable the Gmail API; OAuth consent screen: add the `gmail.send` scope, and set publishing status to In production (a Testing-status app issues refresh tokens that expire after 7 days). The unverified-app warning during consent is expected and acceptable for a single internal account.
2. Locally: put `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` from the Desktop client in `.env`; run `npm run propozaler -- gmail-auth`; sign in as `jobdigest0@gmail.com`; paste the printed `GMAIL_REFRESH_TOKEN` into `.env` and into the Default environment's variables; add `oauth2.googleapis.com` and `gmail.googleapis.com` to the environment's network allowlist.
3. Local proof: `node dist/cli.js post --force-send` in a scratch copy → a real email via the API.
4. Then Task 15 steps 5 to 9 as written (create `propozaler-daily`, run now, break test, two mornings), with the push-to-`main` question answered by the first real run now that the GitHub App is installed.

### Task 19: `connector` transport (interim, 2026-09-27 late)

Google's consent screen would not publish to production because the homepage and privacy URLs must be on a domain verified to the engineer's Google account. Decision: keep the Gmail API code, disabled by config, and send through the Gmail connector attached to the routine for now. The connector path already exists in the CLI (`post --no-send` plus `sent`); this task names it as a transport so the routine does not depend on a flag, and gives `notify-failure` a matching behavior.

**Files:** modify `src/config.ts`, `src/cli.ts`, `src/run/post.ts` (only if needed), `config/recipients.yaml`, `ROUTINE.md`, `README.md`, `SPEC.md` (2.5 one paragraph, 7.2 steps), `CLAUDE.md` (one line); tests `test/config.test.ts`, `test/cli.test.ts`.

**Behavior:**
1. `RecipientsConfigSchema.transport` becomes `z.enum(["gmail_api", "smtp", "connector"]).default("gmail_api")`. `config/recipients.yaml` sets `transport: connector   # interim: the routine sends via the Gmail connector; switch to gmail_api once a verified domain lets the OAuth app publish`.
2. `post`: when `transport === "connector"`, behave exactly as `--no-send` (mailer `null`): write `work/digest.html`, `work/digest.txt`, `work/digest.meta.json` with `pending_send: true` when a send is expected, allocate the digest id, mark nothing. `--force-send` still only affects the send-day rule. No change to `runPost` itself if passing `mailer: null` already produces this; otherwise the smallest change.
3. `sent --digest-id ID --message-id M` is unchanged; it is now the routine's normal path.
4. `notify-failure`: when `transport === "connector"`, write `work/failure.json` `{ "to": [...], "subject": "...", "text": "..." }` (same subject and body it would have mailed) and print `failure notice written to work/failure.json for the routine to send`; exit 0. Other transports unchanged.
5. `check-env`: for `connector`, the transport has no variables; print `HEALTHCHECKS_URL` and `SOCRATA_APP_TOKEN`, and a line `transport: connector (no mail credentials needed by the CLI)`; exit 0 when `HEALTHCHECKS_URL` is set, 1 otherwise.
6. Tests: config default and the `connector` enum value parse; a CLI test that copies config, sets `transport: connector` in the copied `recipients.yaml`, runs `pre` then `post` (no `--no-send`) with an injected mailer factory that would throw if called, and asserts `pending_send: true` in the meta file and that the factory was never called; a CLI test for `notify-failure` under `connector` asserting `work/failure.json` exists with `to`, `subject`, `text`; a `check-env` case for `connector` with only `HEALTHCHECKS_URL` set exiting 0.
7. `ROUTINE.md`: after step 6 (`post`), add step 6b: "If `work/digest.meta.json` has `pending_send: true`: send an email through the Gmail connector to every address in its `to`, subject exactly its `subject`, HTML body from `work/digest.html`, plain-text body from `work/digest.txt`; then run `node dist/cli.js sent --digest-id <digest_id from the meta file> --message-id <id returned by the connector>` and append its output to `work/run.log`. If `pending_send` is false or absent, do nothing." Step 10 (failure): after `notify-failure`, "If `work/failure.json` exists, send it through the Gmail connector: `to`, `subject`, `text` as the plain body." Keep every other step unchanged.
8. Docs: SPEC.md 2.5 gets one paragraph under the choice: "Interim (2026-09-27): `transport: connector`. Google requires a verified domain for the OAuth app's homepage and privacy URLs before it can publish; until one exists the routine sends the rendered digest through the Gmail connector on the engineer's claude.ai account and records it with `propozaler sent`. The Gmail API path stays in the code and tests, switched by one config line." SPEC.md 7.2: add step 6b and the step 10 addition mirroring ROUTINE.md. README Routine section: connectors: Gmail (interim); variables reduce to `HEALTHCHECKS_URL` and optional `SOCRATA_APP_TOKEN` while on `connector`; keep the Gmail API subsection under a heading "When a verified domain exists". CLAUDE.md: the mail I/O sentence gains "interim: `transport: connector` hands the rendered digest to the routine's Gmail connector".
9. `npm test`, `npm run typecheck`, commit "Add connector transport as the interim sending path".
