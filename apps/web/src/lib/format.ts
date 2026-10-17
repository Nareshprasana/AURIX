import type { TrainEvent } from "./api";

/** Distinct event types present in a list, in first-seen order. */
export function collectEventTypes(events: TrainEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    const t = typeof e.type === "string" ? e.type : "n/a";
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

export function filterEvents(events: TrainEvent[], type: string): TrainEvent[] {
  if (!type) return events;
  return events.filter((e) => (typeof e.type === "string" ? e.type : "n/a") === type);
}

/** Human duration from seconds; unknown/invalid input renders as em-dash. */
export function formatElapsed(seconds: unknown): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Progress fraction 0..1 from epoch/total, or null when not computable. */
export function progressFraction(epoch: unknown, total: unknown): number | null {
  if (typeof epoch !== "number" || typeof total !== "number" || total <= 0) return null;
  return Math.max(0, Math.min(1, epoch / total));
}
