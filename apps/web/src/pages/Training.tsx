import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getEvents, getTrainingState } from "../lib/api";
import { collectEventTypes, filterEvents, formatElapsed, progressFraction } from "../lib/format";
import { Unavailable } from "../components/unavailable";
import { Badge } from "../components/ui/badge";
import { Card, CardTitle } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";

const opts = { retry: false, refetchOnWindowFocus: false, staleTime: Infinity } as const;

function fmt(value: unknown): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function fmtTime(value: unknown): string {
  if (typeof value !== "number") return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "—";
  }
}

export function Training() {
  const state = useQuery({ queryKey: ["training-state"], queryFn: getTrainingState, ...opts });
  const events = useQuery({ queryKey: ["training-events"], queryFn: () => getEvents(200), ...opts });
  const [typeFilter, setTypeFilter] = useState("");

  const pct = progressFraction(state.data?.epoch, state.data?.total_epochs);
  const worker = state.data?.worker && typeof state.data.worker === "object" ? state.data.worker : null;
  const logTail = Array.isArray(state.data?.log_tail) ? state.data.log_tail : [];
  const allEvents = Array.isArray(events.data?.events) ? events.data.events : [];
  const types = collectEventTypes(allEvents);
  const shown = filterEvents(allEvents, typeFilter).slice().reverse().slice(0, 30);

  return (
    <div>
      <h1 className="mb-3 text-xl font-semibold">Training</h1>
      <Card>
        <CardTitle>Current status</CardTitle>
        {state.isPending ? (
          <Skeleton className="mt-2 h-20" />
        ) : state.isSuccess && state.data ? (
          <div className="mt-2">
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-zinc-500">state</dt>
              <dd>{fmt(state.data.state)}</dd>
              <dt className="text-zinc-500">health</dt>
              <dd>{fmt(state.data.health)}</dd>
              <dt className="text-zinc-500">experiment</dt>
              <dd>{fmt(state.data.experiment_id)}</dd>
              <dt className="text-zinc-500">progress</dt>
              <dd>
                {pct !== null && typeof state.data.epoch === "number" && typeof state.data.total_epochs === "number"
                  ? `${state.data.epoch} / ${state.data.total_epochs}`
                  : "—"}
              </dd>
              <dt className="text-zinc-500">elapsed</dt>
              <dd>{formatElapsed(state.data.elapsed_seconds)}</dd>
              <dt className="text-zinc-500">checkpoint</dt>
              <dd>{fmt(state.data.checkpoint)}</dd>
              <dt className="text-zinc-500">recovery</dt>
              <dd>{fmt(state.data.recovery_state)}</dd>
              <dt className="text-zinc-500">error</dt>
              <dd>{fmt(state.data.error)}</dd>
            </dl>
            {pct !== null && (
              <div className="mt-2 h-2 overflow-hidden rounded bg-zinc-800" role="progressbar" aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full bg-emerald-600" style={{ width: `${(pct * 100).toFixed(1)}%` }} />
              </div>
            )}
            {worker && (
              <div className="mt-2 text-sm">
                <h3 className="font-medium text-zinc-300">Worker</h3>
                <p className="text-zinc-400">
                  {fmt(worker.name)} · pid {fmt(worker.pid)} · {fmt(worker.state)}
                  {typeof worker.note === "string" && worker.note ? ` · ${worker.note}` : ""}
                </p>
              </div>
            )}
            {state.data.backtest_run !== undefined && state.data.backtest_run !== null && (
              <details className="mt-2 text-sm">
                <summary className="cursor-pointer text-zinc-300">Backtest run</summary>
                <pre className="mt-1 overflow-x-auto rounded bg-zinc-950 p-2 text-xs text-zinc-400">{fmt(state.data.backtest_run)}</pre>
              </details>
            )}
            <p className="mt-2 text-xs text-zinc-500">
              Log refs: {fmt(state.data.stdout_reference)} · {fmt(state.data.stderr_reference)}
            </p>
            {logTail.length > 0 && (
              <details className="mt-1 text-sm">
                <summary className="cursor-pointer text-zinc-300">Log tail ({logTail.length} lines)</summary>
                <pre className="mt-1 max-h-40 overflow-auto rounded bg-zinc-950 p-2 text-xs text-zinc-400">{logTail.map((l) => String(l)).join("\n")}</pre>
              </details>
            )}
          </div>
        ) : (
          <p className="mt-2 text-sm text-zinc-400">Training state unavailable. No job is assumed, and nothing here can start one.</p>
        )}
      </Card>
      <Card>
        <CardTitle>Recent events</CardTitle>
        {events.isPending ? (
          <Skeleton className="mt-2 h-16" />
        ) : events.isSuccess ? (
          allEvents.length > 0 ? (
            <div className="mt-2">
              <label className="text-sm text-zinc-400">
                Filter by type{" "}
                <select
                  aria-label="Filter events by type"
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100"
                >
                  <option value="">all ({allEvents.length})</option>
                  {types.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </label>
              {shown.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-400">No events of this type.</p>
              ) : (
                <ul className="mt-2 space-y-1 text-sm">
                  {shown.map((e, i) => (
                    <li key={i} className="flex gap-2">
                      <Badge>{String(e.type ?? "n/a")}</Badge>
                      <span className="text-zinc-500">{fmtTime(e.timestamp)}</span>
                      <span className="text-zinc-400">{String(e.experiment_id ?? "")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="mt-2 text-sm text-zinc-400">No events.</p>
          )
        ) : (
          <p className="mt-2 text-sm text-zinc-400">Events unavailable.</p>
        )}
      </Card>
      <p className="mt-3 text-xs text-zinc-500">
        Read-only: this page cannot start, stop, retry, or promote training. Job control stays with the supervised CLI.
      </p>
    </div>
  );
}

export function RiskGovernance() {
  return (
    <Unavailable
      title="Risk and Governance"
      reason="No verified read API exists for risk verdicts, safety-gate decisions, promotion rows, or candidate-governance records. These boundaries stay enforced server-side and are not visualized until a read API is approved."
    />
  );
}
