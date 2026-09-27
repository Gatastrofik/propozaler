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
