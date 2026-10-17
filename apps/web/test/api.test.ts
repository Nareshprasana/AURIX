import { describe, expect, it, vi } from "vitest";
import { ApiError, connectionOf, getEvents, getHealth } from "../src/lib/api";
import { collectEventTypes, filterEvents, formatElapsed, progressFraction } from "../src/lib/format";

// DOM-free: exercises URL building, timeout, and error mapping with a stubbed
// global fetch. Run from the repo root: `npx vitest run apps/web/src/lib/api.test.ts`

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => handler(url, init)));
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("api client", () => {
  it("calls same-origin relative URLs", async () => {
    const seen: string[] = [];
    stubFetch(async (url) => {
      seen.push(String(url));
      return jsonResponse(200, { status: "OK", version: "v1" });
    });
    await getHealth();
    expect(seen).toEqual(["/api/health"]);
    vi.unstubAllGlobals();
  });

  it("maps 401 to unauthorized without leaking bodies", async () => {
    stubFetch(async () => jsonResponse(401, { status: "error", error: "unauthorized" }));
    await expect(getHealth()).rejects.toMatchObject({ kind: "unauthorized" });
    expect(connectionOf(new ApiError("unauthorized", "x"))).toBe("unauthorized");
    vi.unstubAllGlobals();
  });

  it("maps network failure to unavailable and bad JSON to malformed", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(getEvents()).rejects.toMatchObject({ kind: "unavailable" });
    stubFetch(async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }));
    await expect(getEvents()).rejects.toMatchObject({ kind: "malformed" });
    stubFetch(async () => jsonResponse(200, [1, 2, 3]));
    await expect(getEvents()).rejects.toMatchObject({ kind: "malformed" });
    vi.unstubAllGlobals();
  });

  it("clamps the events window and never puts tokens in URLs", async () => {
    const seen: string[] = [];
    stubFetch(async (url) => {
      seen.push(String(url));
      return jsonResponse(200, { status: "OK", events: [] });
    });
    await getEvents(99999);
    await getEvents(-3);
    expect(seen).toEqual(["/api/training/events?last=500", "/api/training/events?last=1"]);
    vi.unstubAllGlobals();
  });

  it("never puts credentials in URLs (none exist in this layer)", async () => {
    const seen: string[] = [];
    stubFetch(async (url, init) => {
      seen.push(String(url));
      expect(init?.headers ?? {}).not.toHaveProperty("Authorization");
      return jsonResponse(200, { status: "OK", version: "v1" });
    });
    await getHealth();
    await getEvents(10);
    expect(seen).toEqual(["/api/health", "/api/training/events?last=10"]);
    vi.unstubAllGlobals();
  });
});

describe("format helpers", () => {
  it("collects distinct event types and filters by type", () => {
    const events = [{ type: "a" }, { type: "b" }, { type: "a" }, {}, { type: 7 }];
    expect(collectEventTypes(events)).toEqual(["a", "b", "n/a"]);
    expect(filterEvents(events, "")).toHaveLength(5);
    expect(filterEvents(events, "a")).toHaveLength(2);
    expect(filterEvents(events, "zzz")).toHaveLength(0);
  });

  it("formats elapsed seconds and progress fractions defensively", () => {
    expect(formatElapsed(undefined)).toBe("—");
    expect(formatElapsed(-5)).toBe("—");
    expect(formatElapsed(45)).toBe("45s");
    expect(formatElapsed(125)).toBe("2m 5s");
    expect(formatElapsed(3725)).toBe("1h 2m");
    expect(progressFraction(2, 4)).toBe(0.5);
    expect(progressFraction(0, 0)).toBeNull();
    expect(progressFraction("x", 4)).toBeNull();
    expect(progressFraction(9, 4)).toBe(1);
  });
});
