export function fmtMs(v: number | null | undefined): string {
  if (v === null || v === undefined) return "–";
  if (v < 10) return v.toFixed(1);
  return String(Math.round(v));
}

export function fmtPct(v: number): string {
  if (v === 0) return "0";
  if (v < 0.1) return "<0.1";
  return v.toFixed(1);
}

export function fmtClock(utcMs: number, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone,
  }).format(new Date(utcMs));
}

export function fmtDateTime(utcMs: number, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(utcMs));
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const min = Math.floor(s / 60);
  return `${min} min ${Math.round(s - min * 60)} s`;
}

export const TARGET_COLORS = ["#1e96c8", "#c4741f", "#9556db", "#2fa14e"] as const;

export function colorForIndex(index: number): string {
  return TARGET_COLORS[index % TARGET_COLORS.length];
}
