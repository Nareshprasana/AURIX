import { useQuery } from "@tanstack/react-query";
import { getHealth } from "../lib/api";
import { Card, CardTitle } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { Unavailable } from "../components/unavailable";

const opts = { retry: false, refetchOnWindowFocus: false, staleTime: Infinity } as const;

const ENDPOINTS = [
  { method: "GET", path: "/api/health", status: "verified, used" },
  { method: "GET", path: "/api/training/state", status: "verified, used" },
  { method: "GET", path: "/api/training/events?last=N", status: "verified, used" },
] as const;

export function SystemHealth() {
  const health = useQuery({ queryKey: ["health"], queryFn: getHealth, ...opts });

  return (
    <div>
      <h1 className="mb-3 text-xl font-semibold">System Health</h1>
      <Card>
        <CardTitle>Backend connectivity</CardTitle>
        {health.isPending ? (
          <Skeleton className="mt-2 h-10" />
        ) : health.isSuccess ? (
          <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
            <dt className="text-zinc-500">status</dt>
            <dd>{String(health.data.status ?? "—")}</dd>
            <dt className="text-zinc-500">version</dt>
            <dd>{String(health.data.version ?? "—")}</dd>
          </dl>
        ) : (
          <p className="mt-2 text-sm text-zinc-400">Backend unreachable or unauthorized.</p>
        )}
      </Card>
      <Card>
        <CardTitle>Verified endpoint inventory</CardTitle>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-zinc-500">
              <th className="py-1 pr-2">Method</th>
              <th className="py-1 pr-2">Path</th>
              <th className="py-1">Status</th>
            </tr>
          </thead>
          <tbody>
            {ENDPOINTS.map((e) => (
              <tr key={e.method + e.path} className="border-t border-zinc-800">
                <td className="py-1 pr-2 font-mono">{e.method}</td>
                <td className="py-1 pr-2 font-mono">{e.path}</td>
                <td className="py-1">{e.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-sm text-zinc-400">
          No other backend routes are used by this application. The dashboard
          server also exposes session login/logout for its bundled static
          page, and the training API stays fully authenticated — this app
          calls neither. Training start/stop, research, promotion, and broker
          routes are intentionally absent.
        </p>
      </Card>
    </div>
  );
}

export function Settings() {
  return (
    <Unavailable
      title="Settings"
      reason="No user-configurable settings exist in this milestone. The API base URL is configured at build time via VITE_API_BASE (same-origin default); the dev proxy target via AURIX_API_TARGET."
    />
  );
}
