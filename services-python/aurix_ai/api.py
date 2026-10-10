"""Minimal localhost training API (P1-7): bearer-token authed reads and
start/stop over the SAME functions as the CLI/TUI. No new framework
(stdlib http.server only). No broker, risk, execution, or secret surface.

- Binds 127.0.0.1 only (constructor refuses anything else).
- Token from constructor arg or AURIX_API_TOKEN env; missing token refuses
  to start (fail closed). Tokens never logged, never in errors.
- Rate limiting (token bucket per client IP), 64 KiB request cap, audit log
  with redacted credentials, generic error bodies.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

API_VERSION = "v1"
MAX_BODY_BYTES = 64 * 1024
RATE_PER_MINUTE = 60


def _utc_ms() -> int:
    return int(time.time() * 1000)


class _Bucket:
    def __init__(self):
        self.lock = threading.Lock()
        self.tokens: dict = {}

    def take(self, key: str, rate_per_min: int = RATE_PER_MINUTE) -> bool:
        now = time.time()
        with self.lock:
            tokens, updated = self.tokens.get(key, (float(rate_per_min), now))
            tokens = min(float(rate_per_min), tokens + (now - updated) * rate_per_min / 60.0)
            if tokens < 1.0:
                self.tokens[key] = (tokens, now)
                return False
            self.tokens[key] = (tokens - 1.0, now)
            return True


def _audit_log(runs_root: str, entry: dict) -> None:
    entry = {"at": _utc_ms(), **entry}
    entry.pop("token", None)
    entry.pop("authorization", None)
    try:
        with open(os.path.join(runs_root, "api-audit.jsonl"), "a") as f:
            f.write(json.dumps(entry, sort_keys=True) + "\n")
    except OSError:
        pass


def _read_events(runs_root: str, last: int = 50) -> list:
    import glob as _glob
    rows = []
    for path in sorted(_glob.glob(os.path.join(runs_root, "*", "events.jsonl"))):
        eid = os.path.basename(os.path.dirname(path))
        try:
            with open(path) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        ev = json.loads(line)
                    except ValueError:
                        continue
                    ev["experiment_id"] = ev.get("experiment_id", eid)
                    rows.append(ev)
        except OSError:
            continue
    rows.sort(key=lambda e: e.get("timestamp", 0))
    return rows[-max(1, last):]


class TrainingAPIHandler(BaseHTTPRequestHandler):
    server_version = "AURIX-TrainingAPI/1.0"

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _deny(self, code: int, message: str) -> None:
        _audit_log(self.server.runs_root,
                   {"route": self.path.split("?")[0], "client": self.client_address[0],
                    "status": code, "note": message})
        self._send(code, {"status": "error", "error": message})

    def _authorized(self) -> bool:
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return False
        presented = auth[len("Bearer "):].strip()
        expected = self.server.api_token
        return bool(expected) and hmac.compare_digest(presented, expected)

    def _guard(self) -> bool:
        if not self.server.bucket.take(self.client_address[0]):
            self._deny(429, "rate limit exceeded")
            return False
        length = self.headers.get("Content-Length")
        if length is not None:
            try:
                if int(length) > MAX_BODY_BYTES:
                    self._deny(413, "request body too large")
                    return False
            except ValueError:
                self._deny(400, "invalid content length")
                return False
        if not self._authorized():
            self._deny(401, "unauthorized")
            return False
        return True

    def _log_request(self, code: int, route: str) -> None:
        _audit_log(self.server.runs_root,
                   {"route": route, "client": self.client_address[0], "status": code})

    def do_GET(self) -> None:  # noqa: N802 (http.server convention)
        parsed = urlparse(self.path)
        if not self._guard():
            return
        if parsed.path == "/health":
            self._log_request(200, "/health")
            return self._send(200, {"status": "OK", "version": API_VERSION})
        if parsed.path == "/v1/training/state":
            from .state import build_state
            self._log_request(200, "/v1/training/state")
            return self._send(200, build_state(self.server.runs_root, _utc_ms()))
        if parsed.path == "/v1/training/events":
            try:
                last = int(parse_qs(parsed.query).get("last", ["50"])[0])
            except ValueError:
                return self._deny(400, "invalid last parameter")
            self._log_request(200, "/v1/training/events")
            return self._send(200, {"status": "OK",
                                    "events": _read_events(self.server.runs_root, last)})
        return self._deny(404, "unknown route")

    def do_POST(self) -> None:  # noqa: N802 (http.server convention)
        parsed = urlparse(self.path)
        if not self._guard():
            return
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            body = json.loads(raw.decode() or "{}") if raw else {}
            if not isinstance(body, dict):
                raise ValueError("body must be an object")
        except ValueError:
            return self._deny(400, "invalid JSON body")
        if parsed.path == "/v1/training/start":
            from .cli import _auto_train_impl
            try:
                out = _auto_train_impl(runs=self.server.runs_root,
                                       datasets=body.get("datasets"),
                                       interval=int(body.get("interval", 30)),
                                       once=False)
            except Exception as e:
                self._log_request(500, "/v1/training/start")
                return self._send(500, {"status": "error", "error": "start failed"})
            self._log_request(200, "/v1/training/start")
            return self._send(200, {"status": "OK", **out})
        if parsed.path == "/v1/training/stop":
            from .cli import _auto_stop_inner
            try:
                timeout = int(body.get("timeout", 300))
            except ValueError:
                return self._deny(400, "invalid timeout")
            summary = _auto_stop_inner(self.server.runs_root, timeout)
            self._log_request(200, "/v1/training/stop")
            return self._send(200, {"status": "OK", **summary})
        return self._deny(404, "unknown route")

    def log_message(self, *args) -> None:  # silence default stderr logging
        return


class TrainingAPIServer(HTTPServer):
    daemon_threads = True

    def __init__(self, runs_root: str, api_token: str | None, host: str = "127.0.0.1",
                 port: int = 0):
        if host not in ("127.0.0.1", "::1", "localhost"):
            raise ValueError(f"refusing non-loopback bind: {host}")
        token = api_token or os.environ.get("AURIX_API_TOKEN", "")
        if not token:
            raise ValueError("refusing to start without AURIX_API_TOKEN (fail closed)")
        if len(token) < 16:
            raise ValueError("refusing weak API token (<16 chars)")
        self.runs_root = runs_root
        self.api_token = token
        self.bucket = _Bucket()
        os.makedirs(runs_root, exist_ok=True)
        super().__init__((host, port), TrainingAPIHandler)

    @property
    def url(self) -> str:
        host, port = self.server_address[:2]
        return f"http://{host}:{port}"


def token_fingerprint(token: str) -> str:
    """Log-safe token identifier (sha256 prefix, never the token)."""
    return hashlib.sha256(token.encode()).hexdigest()[:12]
