const NY = "America/New_York";

export type Weekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

export function newYorkOffset(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: NY, timeZoneName: "longOffset" }).formatToParts(at);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-05:00";
  const m = /GMT([+-]\d{2}:\d{2})/.exec(name);
  return m?.[1] ?? "-05:00";
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/;

function offsetToMs(off: string): number {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(off);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3])) * 60 * 1000;
}

export function fromNewYorkLocal(local: string): string {
  const m = LOCAL_RE.exec(local);
  if (!m) throw new Error(`bad local datetime: ${local}`);
  const [, y, mo, d, h = "00", mi = "00", s = "00"] = m;
  const wallAsUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  // First pass: offset at the wall-clock digits read as UTC (up to 5h early). Second pass: shift
  // by that offset to land on the real instant and read the offset there. This is exact except
  // inside the nonexistent hour in March and the repeated hour in November, where it picks one.
  const first = newYorkOffset(new Date(wallAsUtc));
  const instant = wallAsUtc - offsetToMs(first);
  const off = newYorkOffset(new Date(instant));
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${off}`;
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
