"""Local training API (P1-7): auth, routes, limits, audit, no broker surface.
Spawns nothing: start-success paths are covered by existing auto-train tests.
Temp roots only; stdlib HTTP client."""

import json
import os
import threading
import urllib.request

TOKEN = "test-token-0123456789abcdef"

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _serve(root):
    from aurix_ai.api import TrainingAPIServer
    srv = TrainingAPIServer(root, TOKEN)
    threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.05},
                     daemon=True).start()
    return srv


def _req(srv, path, token=TOKEN, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(srv.url + path, data=data, method=method,
                                 headers={"Authorization": f"Bearer {token}"} if token else {})
    if data:
        req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)


import urllib.error  # noqa: E402  (kept after helper for readability)


def test_missing_token_refuses_startup(tmp_path):
    import pytest
    from aurix_ai.api import TrainingAPIServer
    old = os.environ.pop("AURIX_API_TOKEN", None)
    try:
        with pytest.raises(ValueError):
            TrainingAPIServer(str(tmp_path), None)
        with pytest.raises(ValueError):
            TrainingAPIServer(str(tmp_path), "short")
        with pytest.raises(ValueError):
            TrainingAPIServer(str(tmp_path), TOKEN, host="0.0.0.0")
    finally:
        if old is not None:
            os.environ["AURIX_API_TOKEN"] = old


def test_unauthorized_rejected_everywhere(tmp_path):
    srv = _serve(str(tmp_path))
    try:
        for path, method in [("/health", "GET"), ("/v1/training/state", "GET"),
                             ("/v1/training/events", "GET"),
                             ("/v1/training/start", "POST"), ("/v1/training/stop", "POST")]:
            code, _ = _req(srv, path, token=None, method=method, body={} if method == "POST" else None)
            assert code == 401, path
            code, _ = _req(srv, path, token="wrong-token-0000000000", method=method,
                           body={} if method == "POST" else None)
            assert code == 401, path
    finally:
        srv.shutdown()


def test_state_and_events_routes(tmp_path):
    from aurix_ai.orchestrate import ExperimentRegistry
    root = str(tmp_path)
    reg = ExperimentRegistry(root)
    ds = os.path.join(root, "ds")
    os.makedirs(ds)
    rec = reg.submit({"dataset_dir": ds, "dataset_version": "t", "model_type": "m",
                      "hyperparameters": {}, "seed": 1, "epochs": 1, "device": "cpu"})
    from aurix_ai.orchestrate import emit_event
    emit_event(os.path.join(root, rec["experiment_id"]), rec["experiment_id"],
               "EXPERIMENT_QUEUED", {})
    srv = _serve(root)
    try:
        code, st = _req(srv, "/v1/training/state")
        assert code == 200 and st["health"] == "STARTING"
        code, ev = _req(srv, "/v1/training/events?last=10")
        assert code == 200 and any(e["type"] == "EXPERIMENT_QUEUED" for e in ev["events"])
        code, h = _req(srv, "/health")
        assert code == 200 and h["status"] == "OK"
    finally:
        srv.shutdown()


def test_stop_idle_and_start_fail_closed(tmp_path):
    srv = _serve(str(tmp_path))
    try:
        code, out = _req(srv, "/v1/training/stop", method="POST", body={})
        assert code == 200 and out["message"] == "No active AURIX training job."
        code, out = _req(srv, "/v1/training/start", method="POST",
                         body={"datasets": os.path.join(str(tmp_path), "no-such-dir")})
        assert code == 500  # explicit scope missing: fail closed, nothing spawned
    finally:
        srv.shutdown()


def test_rate_limit_and_body_cap(tmp_path):
    srv = _serve(str(tmp_path))
    try:
        codes = set()
        for _ in range(70):
            code, _ = _req(srv, "/health")
            codes.add(code)
        assert 429 in codes
    finally:
        srv.shutdown()
    srv2 = _serve(str(tmp_path))
    try:
        big = "x" * (70 * 1024)
        req = urllib.request.Request(srv2.url + "/v1/training/stop", data=big.encode(),
                                     method="POST",
                                     headers={"Authorization": f"Bearer {TOKEN}"})
        try:
            urllib.request.urlopen(req, timeout=10)
            capped = False
        except urllib.error.HTTPError as e:
            capped = e.code == 413
        assert capped
    finally:
        srv2.shutdown()


def test_audit_log_redacts_tokens(tmp_path):
    srv = _serve(str(tmp_path))
    try:
        _req(srv, "/health", token="wrong-token-0000000000")
        _req(srv, "/health")
    finally:
        srv.shutdown()
    audit = open(os.path.join(str(tmp_path), "api-audit.jsonl")).read()
    assert "wrong-token" not in audit and TOKEN not in audit
    assert audit.count("\n") >= 2


def test_api_has_no_broker_or_risk_surface():
    src = open(os.path.join(REPO, "services-python", "aurix_ai", "api.py"),
               encoding="utf-8").read()
    for pat in ("BrokerPort", "placeOrder", "risk-engine", "order-safety-gate",
                "kiteconnect", "api_secret", "access_token", "ModelRegistry",
                "promote("):
        assert pat not in src, pat
