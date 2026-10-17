import { connectionOf } from "../lib/api";
import { Badge } from "./ui/badge";

export function ConnectionBadge({ state }: { state: "loading" | "connected" | "unauthorized" | "unavailable" | "malformed" }) {
  if (state === "connected") return <Badge variant="ok">connected</Badge>;
  if (state === "unauthorized") return <Badge variant="warn">unauthorized</Badge>;
  if (state === "loading") return <Badge>connecting…</Badge>;
  if (state === "malformed") return <Badge variant="warn">malformed response</Badge>;
  return <Badge variant="bad">unavailable</Badge>;
}

export function useConnectionState(query: { isPending: boolean; isSuccess: boolean; error: unknown }) {
  if (query.isPending) return "loading" as const;
  if (query.isSuccess) return "connected" as const;
  return connectionOf(query.error);
}
