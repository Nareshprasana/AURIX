import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { connectionOf, getEvents, getHealth, getTrainingState } from "../lib/api";
import { ConnectionBadge } from "../components/connection";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardTitle } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";

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

export function Overview() {
  const qc = useQueryClient();
  const [lastOk, setLastOk] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const opts = { retry: false, refetchOnWindowFocus: false, staleTime: Infinity } as const;

  const health = useQuery({ queryKey: ["health"], queryFn: getHealth, ...opts });
  const state = useQuery({ queryKey: ["training-state"], queryFn: getTrainingState, ...opts });
  const events = useQuery({ queryKey: ["training-events"], queryFn: () => getEvents(50), ...opts });

  const firstError = [health.error, state.error, events.error].find((e) => e !== null && e !== undefined);
  const conn = state.isPending && health.isPending && events.isPending
    ? "loading"
    : state.isSuccess && health.isSuccess && events.isSuccess
      ? "connected"
      : connectionOf(firstError);

  async function refresh() {
    const res = await Promise.allSettled([
      qc.fetchQuery({ queryKey: ["health"], queryFn: getHealth, ...opts }),
      qc.fetchQuery({ queryKey: ["training-state"], queryFn: getTrainingState, ...opts }),
      qc.fetchQuery({ queryKey: ["training-events"], queryFn: () => getEvents(50), ...opts }),
    ]);
    if (res.every((r) => r.status === "fulfilled")) {
      setLastOk(new Date().toLocaleString());
      setStale(false);
    } else {
      setStale(lastOk !== null);
    }
  }

  const pct = typeof state.data?.epoch === "number" && typeof state.data?.total_epochs === "number" && state.data.total_epochs > 0
    ? Math.max(0, Math.min(100, (100 * state.data.epoch) / state.data.total_epochs))
    : null;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Overview</h1>
        <div className="flex items-center gap-2">
          <ConnectionBadge state={conn} />
          <Button variant="secondary" size="sm" onClick={refresh}>Refresh</Button>
        </div>
      </div>
      <p className="mb-3 text-sm text-zinc-500">
        Last successful refresh: {lastOk ?? "never"}{" "}
        {stale && <Badge variant="warn">stale data shown</Badge>}
      </p>

      <Card>
        <CardTitle>System health</CardTitle>
        {health.isPending ? (
          <Skeleton className="mt-2 h-10" />
        ) : health.isSuccess ? (
          <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
            <dt className="text-zinc-500">status</dt>
            <dd>{fmt(health.data.status)}</dd>
            <dt className="text-zinc-500">version</dt>
            <dd>{fmt(health.data.version)}</dd>
          </dl>
        ) : (
          <p className="mt-2 text-sm text-zinc-400">Health unavailable ({conn}).</p>
        )}
      </Card>

      <Card>
        <CardTitle>Training status</CardTitle>
        {state.isPending ? (
          <Skeleton className="mt-2 h-24" />
        ) : state.isSuccess && state.data ? (
          <div className="mt-2">
            <dl className="grid grid-cols-2 gap-2 text-sm">
              {(["state", "health", "experiment_id", "dataset_id", "stage", "epoch", "total_epochs", "loss", "validation_loss", "heartbeat_age_seconds", "checkpoint", "error", "recovery_state"] as const).map((k) => (
                <div key={k} className="contents">
                  <dt className="text-zinc-500">{k}</dt>
                  <dd>{fmt(state.data?.[k])}</dd>
                </div>
              ))}
            </dl>
            {pct !== null && (
              <div className="mt-2 h-2 overflow-hidden rounded bg-zinc-800" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full bg-emerald-600" style={{ width: `${pct.toFixed(1)}%` }} />
              </div>
            )}
            {Array.isArray(state.data.pipeline) && state.data.pipeline.length > 0 && (
              <table className="mt-2 w-full text-sm">
                <tbody>
                  {state.data.pipeline.map((s, i) => (
                    <tr key={i} className="border-t border-zinc-800">
                      <td className="py-1 pr-2">{fmt(s.stage)}</td>
                      <td className="py-1">{fmt(s.state)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : (
          <p className="mt-2 text-sm text-zinc-400">Training state unavailable ({conn}). No job is assumed.</p>
        )}
      </Card>

      <Card>
        <CardTitle>Event history</CardTitle>
        {events.isPending ? (
          <Skeleton className="mt-2 h-16" />
        ) : events.isSuccess && Array.isArray(events.data.events) && events.data.events.length > 0 ? (
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-500">
                <th className="py-1 pr-2">Time</th>
                <th className="py-1 pr-2">Type</th>
                <th className="py-1 pr-2">Experiment</th>
              </tr>
            </thead>
            <tbody>
              {events.data.events.slice().reverse().map((e, i) => (
                <tr key={i} className="border-t border-zinc-800">
                  <td className="py-1 pr-2">{fmtTime(e.timestamp)}</td>
                  <td className="py-1 pr-2">{fmt(e.type)}</td>
                  <td className="py-1">{fmt(e.experiment_id)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : events.isSuccess ? (
          <p className="mt-2 text-sm text-zinc-400">No events.</p>
        ) : (
          <p className="mt-2 text-sm text-zinc-400">Events unavailable ({conn}).</p>
        )}
      </Card>

      <Card>
        <CardTitle>Data integrity</CardTitle>
        <p className="mt-1 text-sm text-zinc-400">
          Experiments, datasets, governance records, portfolio, and risk views are unavailable:
          no verified read API exists for them. Nothing is fabricated here.
        </p>
      </Card>
    </div>
  );
}
