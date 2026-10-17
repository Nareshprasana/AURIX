"""Read-only dashboard (Phase 5+): public page shell, session login/logout,
GET-only reads, fixture-backed state/events, no state-changing surface.
Temp roots only; stdlib HTTP client; test-only secrets; never touches real
runs or training."""

import json
import os
import threading
import urllib.request

TOKEN = "test-token-0123456789abcdef"

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _serve(root):
    from aurix_ai.dashboard import serve_dashboard
    srv = serve_dashboard(root, TOKEN)
    threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.05},
                     daemon=True).start()
    return srv


def _req(srv, path, token=TOKEN, method="GET", body=None, cookie=None,
         origin=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if cookie:
        headers["Cookie"] = cookie
    if origin:
        headers["Origin"] = origin
    if data:
        headers["content-type"] = "application/json"
    req = urllib.request.Request(srv.url + path, data=data, method=method,
                                 headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            ctype = r.headers.get("content-type", "")
            raw = r.read()
            set_cookie = r.headers.get("Set-Cookie")
            if "json" in ctype:
                return r.status, json.loads(raw.decode()), set_cookie
            return r.status, raw, set_cookie
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode()), e.headers.get("Set-Cookie")
        except ValueError:
            return e.code, {}, e.headers.get("Set-Cookie")


import urllib.error  # noqa: E402  (kept after helper for readability)


def _login(srv, token=TOKEN, origin=None):
    return _req(srv, "/api/login", token=None, method="POST",
                body={"token": token}, origin=origin)


def test_dashboard_refuses_bad_startup(tmp_path):
    import pytest
    from aurix_ai.dashboard import serve_dashboard
    old = os.environ.pop("AURIX_API_TOKEN", None)
    try:
        with pytest.raises(ValueError):
            serve_dashboard(str(tmp_path), None)
        with pytest.raises(ValueError):
            serve_dashboard(str(tmp_path), "short")
        with pytest.raises(ValueError):
            serve_dashboard(str(tmp_path), TOKEN, host="0.0.0.0")
    finally:
        if old is not None:
            os.environ["AURIX_API_TOKEN"] = old


def test_dashboard_reads_public_on_loopback(tmp_path):
    from aurix_ai.orchestrate import ExperimentRegistry, emit_event
    root = str(tmp_path)
    reg = ExperimentRegistry(root)
    ds = os.path.join(root, "ds")
    os.makedirs(ds)
    rec = reg.submit({"dataset_dir": ds, "dataset_version": "t", "model_type": "m",
                      "hyperparameters": {}, "seed": 1, "epochs": 1, "device": "cpu"})
    emit_event(os.path.join(root, rec["experiment_id"]), rec["experiment_id"],
               "EXPERIMENT_QUEUED", {})
    srv = _serve(root)
    try:
        code, raw, _ = _req(srv, "/", token=None)
        assert code == 200 and b"AURIX Local Dashboard" in raw
        code, h, _ = _req(srv, "/api/health", token=None)
        assert code == 200 and h["status"] == "OK"
        code, st, _ = _req(srv, "/api/training/state", token=None)
        assert code == 200 and st["experiment_id"] == rec["experiment_id"]
        code, ev, _ = _req(srv, "/api/training/events?last=10", token=None)
        assert code == 200 and any(e["type"] == "EXPERIMENT_QUEUED" for e in ev["events"])
        for bad in ("abc", "0", "99999"):
            code, _, _ = _req(srv, f"/api/training/events?last={bad}", token=None)
            assert code == 400, bad
        code, _, _ = _req(srv, "/no-such-route", token=None)
        assert code == 404
    finally:
        srv.shutdown()


def test_dashboard_login_logout_still_work(tmp_path):
    srv = _serve(str(tmp_path))
    try:
        code, _, bad_cookie = _login(srv, token="wrong-token-0000000000")
        assert code == 401 and not bad_cookie
        code, out, set_cookie = _login(srv)
        assert code == 200 and out["status"] == "OK"
        assert set_cookie is not None and "HttpOnly" in set_cookie
        assert "SameSite=Strict" in set_cookie
        assert "Secure" not in set_cookie  # plain loopback HTTP: honestly absent
        assert TOKEN not in set_cookie
        cookie = set_cookie.split(";", 1)[0]
        assert cookie.startswith("AURIX_DASHBOARD_SESSION=")
        code, h, _ = _req(srv, "/api/health", token=None, cookie=cookie)
        assert code == 200 and h["status"] == "OK"
        code, _, _ = _req(srv, "/api/logout", token=None, method="POST",
                          body={}, cookie=cookie)
        assert code == 200
        # Server-side invalidation is the logout guarantee (GET reads are
        # intentionally public on loopback). A re-login rotates to a new id.
        assert srv.sessions._sessions == {}
        _, _, set_cookie2 = _login(srv)
        assert set_cookie2.split(";", 1)[0] != cookie
    finally:
        srv.shutdown()


def test_dashboard_post_is_read_only(tmp_path):
    srv = _serve(str(tmp_path))
    try:
        # Unknown POSTs without auth still fail closed before method checks.
        code, _, _ = _req(srv, "/api/health", token=None, method="POST")
        assert code == 401
        for path in ("/", "/api/health", "/api/training/state",
                     "/api/training/events"):
            code, _, _ = _req(srv, path, method="POST")
            assert code == 405, (path, code)
    finally:
        srv.shutdown()


def test_session_expiry_denied(tmp_path):
    import time
    srv = _serve(str(tmp_path))
    try:
        _, _, set_cookie = _login(srv)
        cookie = set_cookie.split(";", 1)[0]
        sid = cookie.split("=", 1)[1]
        # Fresh session authorizes the (still guarded) non-login POST path.
        code, _, _ = _req(srv, "/api/health", token=None, method="POST",
                          cookie=cookie)
        assert code == 405
        srv.sessions._sessions[sid] = time.time() - 1  # force expiry
        # Expired sessions fail closed where auth still applies.
        code, _, _ = _req(srv, "/api/health", token=None, method="POST",
                          cookie=cookie)
        assert code == 401
        assert srv.sessions._sessions == {}
    finally:
        srv.shutdown()


def test_login_origin_rejected_and_failures_audited(tmp_path):
    srv = _serve(str(tmp_path))
    try:
        code, _, _ = _login(srv, origin="https://evil.test")
        assert code == 403
        code, _, _ = _login(srv, origin=srv.url)
        assert code == 200
        audit = open(os.path.join(str(tmp_path), "api-audit.jsonl")).read()
        assert TOKEN not in audit
        assert "wrong-token" not in audit
        assert "/api/login" in audit
    finally:
        srv.shutdown()


def test_login_rate_limited(tmp_path):
    srv = _serve(str(tmp_path))
    try:
        codes = set()
        for _ in range(70):
            code, _, _ = _login(srv, token="wrong-token-0000000000")
            codes.add(code)
        assert codes == {401, 429} or 429 in codes
    finally:
        srv.shutdown()


def test_dashboard_bearer_still_works(tmp_path):
    srv = _serve(str(tmp_path))
    try:
        code, h, _ = _req(srv, "/api/health", token=TOKEN)
        assert code == 200 and h["status"] == "OK"
    finally:
        srv.shutdown()


def test_dashboard_page_has_no_state_changing_surface(tmp_path):
    srv = _serve(str(tmp_path))
    try:
        code, raw, _ = _req(srv, "/")
        assert code == 200
        for pat in (b"training/start", b"training/stop", b"placeOrder",
                    b"promote(", b"localStorage", b"sessionStorage",
                    b"Bearer ", TOKEN.encode()):
            assert pat not in raw, pat
        assert b"/api/login" in raw and b"/api/logout" in raw
    finally:
        srv.shutdown()


def test_dashboard_state_and_events_from_session(tmp_path):
    from aurix_ai.orchestrate import ExperimentRegistry, emit_event
    root = str(tmp_path)
    reg = ExperimentRegistry(root)
    ds = os.path.join(root, "ds")
    os.makedirs(ds)
    rec = reg.submit({"dataset_dir": ds, "dataset_version": "t", "model_type": "m",
                      "hyperparameters": {}, "seed": 1, "epochs": 1, "device": "cpu"})
    emit_event(os.path.join(root, rec["experiment_id"]), rec["experiment_id"],
               "EXPERIMENT_QUEUED", {})
    srv = _serve(root)
    try:
        # Bearer auth keeps working alongside public reads.
        _, _, set_cookie = _login(srv)
        cookie = set_cookie.split(";", 1)[0]
        code, st, _ = _req(srv, "/api/training/state", token=None, cookie=cookie)
        assert code == 200 and st["health"] == "STARTING"
        code, ev, _ = _req(srv, "/api/training/events?last=10", token=TOKEN)
        assert code == 200 and any(e["type"] == "EXPERIMENT_QUEUED" for e in ev["events"])
    finally:
        srv.shutdown()


def test_client_abort_swallowed_but_real_errors_raise(tmp_path):
    from aurix_ai.dashboard import DashboardHandler

    class Boom:
        def __init__(self, exc):
            self.exc = exc
            self.written = []
        def write(self, b):
            raise self.exc

    def stub_handler(exc):
        h = DashboardHandler.__new__(DashboardHandler)
        h.wfile = Boom(exc)
        h.send_response = lambda *a: None
        h.send_header = lambda *a: None
        h.end_headers = lambda: None
        return h

    import pytest
    stub_handler(BrokenPipeError())._send(200, {"status": "OK"})  # must not raise
    stub_handler(ConnectionAbortedError())._send(200, {"status": "OK"})
    with pytest.raises(ValueError):
        stub_handler(ValueError("boom"))._send(200, {"status": "OK"})


def test_dashboard_module_has_no_backend_changing_surface():
    src = open(os.path.join(REPO, "services-python", "aurix_ai", "dashboard.py"),
               encoding="utf-8").read()
    for pat in ("_auto_train_impl", "_auto_stop_inner", "placeOrder", "BrokerPort",
                "promote(", "kiteconnect", "api_secret", "access_token",
                "v1/training/start", "v1/training/stop"):
        assert pat not in src, pat
