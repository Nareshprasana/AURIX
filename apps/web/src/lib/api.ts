/**
 * Read-only API client for the local AURIX dashboard backend.
 *
 * Verified routes (see services-python/aurix_ai/dashboard.py):
 *   GET  /api/health            {status, version}
 *   GET  /api/training/state    TrainingState (fields optional; IDLE-safe)
 *   GET  /api/training/events?last=N   {status, events[]}
 *
 * The dashboard's GET reads are intentionally public on loopback (per
 * approved task: any local process can already read these run artifacts
 * from disk). No credentials exist anywhere in this layer: no hardcoded
 * tokens, no login/logout calls, no storage, no URL-embedded secrets.
 *
 * Rules enforced here, not just documented:
 * - Same-origin relative URLs by default (`VITE_API_BASE` may prefix a
 *   loopback origin for explicitly configured setups only).
 * - No `localStorage`/`sessionStorage` anywhere in this layer.
 * - Every request has a timeout; failures map to typed connection states.
 */

export const API_TIMEOUT_MS = 8000;

export type ConnectionKind =
  | "loading"
  | "connected"
  | "unauthorized"
  | "unavailable"
  | "malformed";

export interface HealthResponse {
  status?: unknown;
  version?: unknown;
}

export interface PipelineStage {
  stage?: unknown;
  state?: unknown;
}

export interface TrainWorker {
  name?: unknown;
  pid?: unknown;
  state?: unknown;
  note?: unknown;
}

export interface TrainingState {
  state?: unknown;
  health?: unknown;
  experiment_id?: unknown;
  dataset_id?: unknown;
  stage?: unknown;
  epoch?: unknown;
  total_epochs?: unknown;
  loss?: unknown;
  validation_loss?: unknown;
  progress?: unknown;
  heartbeat_age_seconds?: unknown;
  checkpoint?: unknown;
  last_event?: unknown;
  worker?: TrainWorker | null;
  stdout_reference?: unknown;
  stderr_reference?: unknown;
  log_tail?: unknown;
  backtest_run?: unknown;
  started_at?: unknown;
  updated_at?: unknown;
  elapsed_seconds?: unknown;
  error?: unknown;
  recovery_state?: unknown;
  code_version?: unknown;
  pipeline?: PipelineStage[];
  last_outcome?: unknown;
}

export interface TrainEvent {
  timestamp?: unknown;
  type?: unknown;
  experiment_id?: unknown;
  [key: string]: unknown;
}

export interface EventsResponse {
  status?: unknown;
  events?: TrainEvent[];
}

export class ApiError extends Error {
  readonly kind: Exclude<ConnectionKind, "loading" | "connected">;
  readonly status?: number;

  constructor(kind: ApiError["kind"], message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
  }
}

function baseUrl(): string {
  const raw = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
  return raw.replace(/\/+$/, "");
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(baseUrl() + path, {
      credentials: "same-origin",
      signal: ctl.signal,
      ...init,
    });
    if (res.status === 401) {
      throw new ApiError("unauthorized", "unauthorized", 401);
    }
    if (!res.ok) {
      throw new ApiError("unavailable", `HTTP ${res.status}`, res.status);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ApiError("malformed", "response was not JSON");
    }
    if (body === null || typeof body !== "object") {
      throw new ApiError("malformed", "response was not an object");
    }
    return body as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError("unavailable", "request failed");
  } finally {
    clearTimeout(timer);
  }
}

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/api/health");
}

export function getTrainingState(): Promise<TrainingState> {
  return request<TrainingState>("/api/training/state");
}

export async function getEvents(last = 50): Promise<EventsResponse> {
  const n = Math.max(1, Math.min(500, Math.floor(last)));
  const body = await request<EventsResponse>(`/api/training/events?last=${n}`);
  if (Array.isArray(body) || body.events !== undefined && !Array.isArray(body.events)) {
    throw new ApiError("malformed", "events was not a list");
  }
  return body;
}

export function connectionOf(err: unknown): ConnectionKind {
  if (err instanceof ApiError) return err.kind;
  return "unavailable";
}
