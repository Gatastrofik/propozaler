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
