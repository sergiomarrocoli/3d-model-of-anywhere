import json
import threading
import urllib.error
import urllib.request

import pytest

import serve
from service import BuildService
from test_service import V, fake_runner

BOX = [310450, 290875, 311450, 291875]
ID = "e310450n290875w1000h1000"


@pytest.fixture
def api(tmp_path):
    calls = []
    gate = threading.Event()
    gate.set()
    svc = BuildService(tmp_path, fake_runner(calls, gate=gate), V)
    httpd = serve.make_server(svc, "127.0.0.1", 0)
    t = threading.Thread(target=httpd.serve_forever, daemon=True); t.start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"

    def call(method, path, body=None, headers=None, raw=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(base + path, data=data, method=method, headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())
    call.svc, call.calls, call.gate = svc, calls, gate
    yield call
    httpd.shutdown()


def test_health_and_unknown_routes(api):
    assert api("GET", "/api/health") == (200, {"ok": True, "pipeline_version": V})
    assert api("GET", "/api/nope")[0] == 404 and api("POST", "/api/nope", {})[0] == 404


def test_build_then_poll_then_cached(api):
    code, job = api("POST", "/api/builds", {"bbox": BOX})
    assert code == 202 and job["id"] == ID and job["status"] in ("queued", "building") and job["bbox"] == BOX
    assert api.svc.wait_idle()
    code, done = api("GET", f"/api/builds/{ID}")
    assert code == 200 and done["status"] == "ready" and done["percent"] == 100 and done["bundle"] == f"/bundles/area_{ID}/"
    code, again = api("POST", "/api/builds", {"bbox": BOX})
    assert code == 200 and again["status"] == "ready" and api.calls == [ID]       # 200 not 202, and nothing rebuilt
    assert api("GET", "/api/maps") == (200, [ID])


def test_unknown_and_malformed_ids_are_404(api):
    assert api("GET", "/api/builds/e1n1w300h300")[0] == 404
    assert api("GET", "/api/builds/..%2f..%2fetc")[0] == 404
    assert api("GET", "/api/builds/bath")[0] == 404


@pytest.mark.parametrize("raw", [b"not json", b"[]", b'{"nope": 1}', b'{"bbox": "x"}', b"", b"x" * 5000])
def test_bad_bodies_are_400(api, raw):
    assert api("POST", "/api/builds", raw=raw)[0] == 400


def test_bad_boxes_are_400_with_a_reason(api):
    code, body = api("POST", "/api/builds", {"bbox": [0, 0, 50000, 50000]})
    assert code == 400 and "between 200 m and 2000 m" in body["error"]
    code, body = api("POST", "/api/builds", {"bbox": [-5000, 0, -4000, 1000]})
    assert code == 400 and "outside Great Britain" in body["error"]


def test_too_many_builds_from_one_client_is_429(api):
    api.gate.clear()
    mk = lambda i: [1000 + i * 3000, 1000, 2000 + i * 3000, 2000]
    assert api("POST", "/api/builds", {"bbox": mk(0)})[0] == 202 and api("POST", "/api/builds", {"bbox": mk(1)})[0] == 202
    code, body = api("POST", "/api/builds", {"bbox": mk(2)})
    assert code == 429 and "in progress" in body["error"]
    # a different client (via a local proxy's X-Forwarded-For) is counted separately
    assert api("POST", "/api/builds", {"bbox": mk(3)}, headers={"X-Forwarded-For": "203.0.113.9"})[0] == 202
    api.gate.set(); assert api.svc.wait_idle(15)
