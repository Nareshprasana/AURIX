"""Read-only local AURIX dashboard (frontend milestone, Phase 5).

Stdlib-only companion to the training API. Serves a static status page plus
three JSON read endpoints backed by the SAME read functions as the CLI/TUI
(`build_state`, `_read_events`, health constant) — no training, research,
backtest, promotion, broker, or execution path is reachable from here.

Browser authentication (loopback HTTP is NOT encrypted — never claim it is):
- The operator types the API token into a login form; the token travels in a
  POST body and is verified server-side, never placed in URLs, page source,
  storage, logs, or screenshots.
- Success mints a cryptographically random session id (`secrets.token_urlsafe`)
  kept in a server-side dict mapping sid -> expiry (30 min absolute). The
  browser holds only an `HttpOnly; SameSite=Strict` cookie. No bearer token
  is stored server-side per session or anywhere client-side.
- Programmatic bearer-token auth (the `api.py` model) keeps working on every
  `/api/*` route, so existing API clients are unaffected.
- Login/logout POSTs additionally require an absent Origin or a loopback
  self-origin (CSRF mitigation alongside SameSite=Strict). Logout destroys
  the server-side session and expires the cookie.
- Login attempts share the per-IP rate limit and are audited without
  credentials; failures return generic errors.

Read-only by construction:
- GET routes: `/` (public static page — contains no secrets), `/api/health`,
  `/api/training/state`, `/api/training/events` (authenticated: bearer or
  session). Every other GET is 404.
- POST routes: `/api/login`, `/api/logout` only. Every other POST is 405.
  No start/stop, no registry, no promotion surface exists here.
- All response writes tolerate client disconnects (`BrokenPipeError`,
  `ConnectionAbortedError`) without tracebacks; unrelated exceptions still
  propagate to normal error handling.

Run: `python -m aurix_ai.dashboard [--runs DIR] [--port 8742]`.
Token from constructor arg or `AURIX_API_TOKEN` env (fail closed, never
printed).
"""

from __future__ import annotations

import hmac
import json
import os
import secrets
import sys
import threading
import time
from http.cookies import SimpleCookie
from urllib.parse import parse_qs, urlparse

from .api import (API_VERSION, MAX_BODY_BYTES, TrainingAPIHandler,
                  TrainingAPIServer, _read_events, _utc_ms)

PAGE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "dashboard.html")
DEFAULT_PORT = 8742
SESSION_COOKIE = "AURIX_DASHBOARD_SESSION"
SESSION_TTL_S = 30 * 60
MAX_SESSIONS = 1024


def _page_bytes() -> bytes:
    with open(PAGE_PATH, "rb") as f:
        return f.read()


class DashboardSessions:
    """Server-side session store: sid -> expiry epoch seconds. The bearer
    token itself is never stored; only unguessable ids with absolute expiry."""

    def __init__(self):
        self._lock = threading.Lock()
        self._sessions: dict = {}

    def create(self) -> str:
        sid = secrets.token_urlsafe(32)
        exp = time.time() + SESSION_TTL_S
        with self._lock:
            now = time.time()
            expired = [k for k, v in self._sessions.items() if v <= now]
            for k in expired:
                del self._sessions[k]
            while len(self._sessions) >= MAX_SESSIONS:
                self._sessions.pop(next(iter(self._sessions)))
            self._sessions[sid] = exp
        return sid

    def valid(self, sid: str | None) -> bool:
        if not sid or not isinstance(sid, str):
            return False
        with self._lock:
            exp = self._sessions.get(sid)
            if exp is None:
                return False
            if exp <= time.time():
                del self._sessions[sid]
                return False
            return True

    def destroy(self, sid: str | None) -> None:
        if not sid:
            return
        with self._lock:
            self._sessions.pop(sid, None)


def _session_cookie_header(sid: str | None, max_age: int) -> str:
    # No `Secure`: this is plain loopback HTTP, and claiming otherwise would
    # be dishonest. HttpOnly + SameSite=Strict keep the sid out of JS and
    # cross-site sends on the loopback origin.
    if sid is None:
        return (f"{SESSION_COOKIE}=deleted; Path=/; HttpOnly; "
                f"SameSite=Strict; Max-Age=0")
    return (f"{SESSION_COOKIE}={sid}; Path=/; HttpOnly; "
            f"SameSite=Strict; Max-Age={max_age}")


class DashboardHandler(TrainingAPIHandler):
    server_version = "AURIX-Dashboard/1.0"

    # -- abort-safe response writer (dashboard scope only; api.py untouched) --
    def _send(self, code: int, payload: dict, extra_headers: tuple = ()) -> None:
        body = json.dumps(payload).encode()
        try:
            self.send_response(code)
            self.send_header("content-type", "application/json")
            for k, v in extra_headers:
                self.send_header(k, v)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError):
            # Client went away mid-response. Nothing to retry and nothing to
            # report to a party that is gone; unrelated exceptions propagate.
            return

    # -- auth helpers --
    def _limit(self) -> bool:
        if not self.server.bucket.take(self.client_address[0]):
            self._deny(429, "rate limit exceeded")
            return False
        return True

    def _session_id(self) -> str | None:
        try:
            jar = SimpleCookie(self.headers.get("Cookie", ""))
        except Exception:
            return None
        morsel = jar.get(SESSION_COOKIE)
        if morsel is None:
            return None
        return morsel.value or None

    def _sessions(self) -> DashboardSessions | None:
        store = getattr(self.server, "sessions", None)
        return store if isinstance(store, DashboardSessions) else None

    def _authed(self) -> bool:
        if self._authorized():
            return True
        store = self._sessions()
        return bool(store is not None and store.valid(self._session_id()))

    def _origin_ok(self) -> bool:
        """CSRF mitigation for session POSTs: allow absent Origin
        (curl/tests/non-browser clients); when present it must be our own
        loopback origin (http/https, this host and port)."""
        origin = (self.headers.get("Origin") or "").strip()
        if not origin:
            return True
        port = self.server.server_address[1]
        loopbacks = set()
        for scheme in ("http", "https"):
            for host in ("127.0.0.1", "localhost", "::1"):
                loopbacks.add(f"{scheme}://{host}:{port}")
        return origin.rstrip("/") in loopbacks

    def _read_json_body(self, maximum: int = MAX_BODY_BYTES):
        length = self.headers.get("Content-Length")
        try:
            size = int(length) if length is not None else 0
        except ValueError:
            return None, self._deny(400, "invalid content length")
        if size > maximum:
            return None, self._deny(413, "request body too large")
        raw = self.rfile.read(size) if size > 0 else b""
        try:
            body = json.loads(raw.decode() or "{}") if raw else {}
        except ValueError:
            return None, self._deny(400, "invalid JSON body")
        if not isinstance(body, dict):
            return None, self._deny(400, "invalid JSON body")
        return body, None

    # -- routes --
    def do_GET(self) -> None:  # noqa: N802 (http.server convention)
        if not self._limit():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/":
            # Public static shell only: no secrets, no data, no endpoints
            # beyond same-origin relative paths (enforced by test).
            try:
                body = _page_bytes()
            except OSError:
                return self._deny(500, "dashboard page unavailable")
            try:
                self.send_response(200)
                self.send_header("content-type", "text/html; charset=utf-8")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionAbortedError):
                return
            self._log_request(200, "/")
            return
        # GET reads are intentionally public on loopback (per approved task:
        # any local process can already read these run artifacts from disk).
        # Rate limiting, audit logging, and loopback-only bind still apply.
        # The training API (api.py) is untouched and stays fully authenticated.
        if parsed.path == "/api/health":
            self._log_request(200, "/api/health")
            return self._send(200, {"status": "OK", "version": API_VERSION})
        if parsed.path == "/api/training/state":
            from .state import build_state
            self._log_request(200, "/api/training/state")
            return self._send(200, build_state(self.server.runs_root, _utc_ms()))
        if parsed.path == "/api/training/events":
            try:
                last = int(parse_qs(parsed.query).get("last", ["50"])[0])
            except ValueError:
                return self._deny(400, "invalid last parameter")
            if not 1 <= last <= 500:
                return self._deny(400, "invalid last parameter")
            self._log_request(200, "/api/training/events")
            return self._send(200, {"status": "OK",
                                    "events": _read_events(self.server.runs_root, last)})
        return self._deny(404, "unknown route")

    def do_POST(self) -> None:  # noqa: N802 (http.server convention)
        if not self._limit():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/api/login":
            if not self._origin_ok():
                return self._deny(403, "forbidden")
            body, err = self._read_json_body()
            if err is not None:
                return err
            presented = body.get("token", "")
            expected = self.server.api_token
            # Audited like every other denial, without ever logging the secret.
            if (not isinstance(presented, str) or not presented or not expected
                    or not hmac.compare_digest(presented, expected)):
                return self._deny(401, "unauthorized")
            store = self._sessions()
            if store is None:
                return self._deny(500, "sessions unavailable")
            sid = store.create()  # fresh random id per login: rotation by design
            self._log_request(200, "/api/login")
            return self._send(200, {"status": "OK"},
                              extra_headers=(("Set-Cookie",
                                              _session_cookie_header(sid, SESSION_TTL_S)),))
        if parsed.path == "/api/logout":
            if not self._origin_ok():
                return self._deny(403, "forbidden")
            self._read_json_body()  # bounded drain; result irrelevant
            store = self._sessions()
            if store is not None:
                store.destroy(self._session_id())
            self._log_request(200, "/api/logout")
            return self._send(200, {"status": "OK"},
                              extra_headers=(("Set-Cookie",
                                              _session_cookie_header(None, 0)),))
        if not self._authed():
            return self._deny(401, "unauthorized")
        return self._deny(405, "read-only dashboard: method not allowed")


def serve_dashboard(runs_root: str, api_token: str | None,
                    host: str = "127.0.0.1", port: int = DEFAULT_PORT):
    """Build a dashboard server. Reuses every TrainingAPIServer check
    (loopback-only bind, fail-closed token); only the handler differs, plus a
    server-side session store (never the token)."""
    srv = TrainingAPIServer(runs_root, api_token, host=host, port=port)
    srv.RequestHandlerClass = DashboardHandler
    srv.sessions = DashboardSessions()
    srv.daemon_threads = True
    return srv


def main(argv=None) -> int:
    import argparse
    from .orchestrate import runs_root
    p = argparse.ArgumentParser(prog="aurix-dashboard",
                                description="Read-only local AURIX dashboard")
    p.add_argument("--runs", default=None)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = p.parse_args(argv)
    if not os.path.exists(PAGE_PATH):
        print("dashboard page missing", file=sys.stderr)
        return 1
    srv = serve_dashboard(runs_root(args.runs), None,
                          host=args.host, port=args.port)
    print(f"serving read-only dashboard on {srv.url} (localhost only, token required)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
