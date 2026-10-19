import os
import time

import pytest

from pipeline import buildings


class Resp:
    text = '{"elements": []}'

    def raise_for_status(self): pass
    def json(self): return {"elements": []}


@pytest.fixture
def calls(monkeypatch):
    seen = []
    monkeypatch.setattr(buildings.requests, "post", lambda url, **kw: seen.append(url) or Resp())
    monkeypatch.setattr(buildings.time, "sleep", lambda s: None)
    return seen


def test_second_identical_query_comes_from_the_cache(tmp_path, calls):
    first = buildings._overpass("q1", cache_dir=tmp_path)
    second = buildings._overpass("q1", cache_dir=tmp_path)
    assert len(calls) == 1                                      # the server was asked once
    assert first.json() == second.json() == {"elements": []}


def test_different_queries_are_cached_separately(tmp_path, calls):
    buildings._overpass("a", cache_dir=tmp_path); buildings._overpass("b", cache_dir=tmp_path)
    assert len(calls) == 2 and len(list(tmp_path.glob("*.json"))) == 2


def test_stale_cache_entries_are_refreshed(tmp_path, calls):
    buildings._overpass("q", cache_dir=tmp_path, ttl=60)
    f = next(tmp_path.glob("*.json")); old = time.time() - 3600; os.utime(f, (old, old))
    buildings._overpass("q", cache_dir=tmp_path, ttl=60)
    assert len(calls) == 2


def test_failures_are_not_cached(tmp_path, monkeypatch):
    def boom(url, **kw): raise buildings.requests.ConnectionError("down")
    monkeypatch.setattr(buildings.requests, "post", boom); monkeypatch.setattr(buildings.time, "sleep", lambda s: None)
    with pytest.raises(RuntimeError, match="All Overpass endpoints failed"):
        buildings._overpass("q", cache_dir=tmp_path)
    assert not list(tmp_path.glob("*.json"))


class _Done:
    def __init__(self, stdout="", returncode=0, stderr=""):
        self.stdout, self.returncode, self.stderr = stdout, returncode, stderr


def _ssl_fails(monkeypatch, hosts_ok=()):
    """requests cannot make a TLS connection to the main server (macOS's LibreSSL); other hosts answer or not as the test says."""
    seen = []

    def post(url, **kw):
        seen.append(url)
        if "overpass-api.de" in url:
            raise buildings.requests.exceptions.SSLError("handshake failure")
        if any(h in url for h in hosts_ok):
            return Resp()
        raise buildings.requests.exceptions.HTTPError("500")
    monkeypatch.setattr(buildings.requests, "post", post)
    monkeypatch.setattr(buildings.time, "sleep", lambda s: None)
    return seen


def test_an_ssl_failure_is_retried_through_curl_and_the_answer_is_cached(tmp_path, monkeypatch):
    posted = _ssl_fails(monkeypatch)
    runs = []

    def run(cmd, **kw):
        runs.append((cmd, kw))
        return _Done('{"elements": [{"id": 1}]}')
    monkeypatch.setattr(buildings.subprocess, "run", run)
    monkeypatch.setattr(buildings.shutil, "which", lambda name: "/usr/bin/curl")
    first = buildings._overpass("the query", cache_dir=tmp_path)
    assert first.json() == {"elements": [{"id": 1}]} and posted == [buildings.OVERPASS_URLS[0]]                # no mirror was needed
    cmd, kw = runs[0]
    assert cmd[0] == "/usr/bin/curl" and cmd[-1] == buildings.OVERPASS_URLS[0] and "--fail" in cmd and "data@-" in cmd and kw["input"] == "the query"
    again = buildings._overpass("the query", cache_dir=tmp_path)                                                  # and the next ask is the disk cache
    assert again.json() == {"elements": [{"id": 1}]} and len(runs) == 1 and len(list(tmp_path.glob("*.json"))) == 1


def test_curl_is_not_used_for_other_failures(tmp_path, monkeypatch):
    def post(url, **kw):
        raise buildings.requests.exceptions.HTTPError("503")
    monkeypatch.setattr(buildings.requests, "post", post)
    monkeypatch.setattr(buildings.time, "sleep", lambda s: None)
    monkeypatch.setattr(buildings.subprocess, "run", lambda *a, **k: pytest.fail("curl was used for a server error"))
    with pytest.raises(RuntimeError, match="All Overpass endpoints failed"):
        buildings._overpass("q", cache_dir=tmp_path)


def test_when_curl_fails_too_the_next_server_is_tried(tmp_path, monkeypatch):
    posted = _ssl_fails(monkeypatch, hosts_ok=("private.coffee",))
    monkeypatch.setattr(buildings.subprocess, "run", lambda *a, **k: _Done("", 28, "operation timed out"))
    monkeypatch.setattr(buildings.shutil, "which", lambda name: "/usr/bin/curl")
    assert buildings._overpass("q", cache_dir=tmp_path).json() == {"elements": []}
    assert posted[:2] == [buildings.OVERPASS_URLS[0], buildings.OVERPASS_URLS[1]]


def test_no_curl_installed_just_moves_on(tmp_path, monkeypatch):
    _ssl_fails(monkeypatch, hosts_ok=("kumi",))
    monkeypatch.setattr(buildings.shutil, "which", lambda name: None)
    monkeypatch.setattr(buildings.subprocess, "run", lambda *a, **k: pytest.fail("no curl to run"))
    assert buildings._overpass("q", cache_dir=tmp_path).json() == {"elements": []}


def test_a_curl_answer_that_is_not_json_is_an_error_not_cached(tmp_path, monkeypatch):
    _ssl_fails(monkeypatch)
    monkeypatch.setattr(buildings.subprocess, "run", lambda *a, **k: _Done("<html>busy</html>"))
    monkeypatch.setattr(buildings.shutil, "which", lambda name: "/usr/bin/curl")
    with pytest.raises(RuntimeError, match="All Overpass endpoints failed"):
        buildings._overpass("q", cache_dir=tmp_path)
    assert not list(tmp_path.glob("*.json"))


def _said(monkeypatch):
    said = []
    monkeypatch.setattr(buildings, "say", said.append)
    return said


def test_the_log_says_why_a_server_did_not_answer(tmp_path, monkeypatch):
    said = _said(monkeypatch)
    monkeypatch.setattr(buildings.time, "sleep", lambda s: None)

    def post(url, **kw):
        if "kumi" in url:
            return Resp()
        raise buildings.requests.exceptions.HTTPError("500 Server Error: Internal Server Error for url: " + url)
    monkeypatch.setattr(buildings.requests, "post", post)
    buildings._overpass("q", cache_dir=tmp_path)
    assert any("did not answer (HTTPError: 500 Server Error: Internal Server Error" in line for line in said)


def test_a_rate_limit_waits_and_asks_the_same_server_again_before_trying_a_mirror(tmp_path, monkeypatch):
    said, slept, runs = _said(monkeypatch), [], []
    monkeypatch.setattr(buildings.time, "sleep", slept.append)
    monkeypatch.setattr(buildings.shutil, "which", lambda name: "/usr/bin/curl")
    posted = _ssl_fails(monkeypatch)
    monkeypatch.setattr(buildings.time, "sleep", slept.append)

    def run(cmd, **kw):
        runs.append(cmd)
        return _Done("", 22, "curl: (22) The requested URL returned error: 429") if len(runs) == 1 else _Done('{"elements": []}')
    monkeypatch.setattr(buildings.subprocess, "run", run)
    assert buildings._overpass("q", cache_dir=tmp_path).json() == {"elements": []}
    assert len(runs) == 2 and posted == [buildings.OVERPASS_URLS[0]] * 2                  # the main server twice, never a mirror
    assert slept == [buildings.BUSY_WAITS_S[0]]
    assert any("is busy" in line and "429" in line for line in said) and any(line.endswith("again") for line in said)


def test_only_a_busy_answer_gets_another_go_at_the_same_server(tmp_path, monkeypatch):
    _said(monkeypatch)
    monkeypatch.setattr(buildings.time, "sleep", lambda s: None)
    asked = []

    def post(url, **kw):
        asked.append(url)
        raise buildings.requests.exceptions.HTTPError("500 Server Error: Internal Server Error")
    monkeypatch.setattr(buildings.requests, "post", post)
    with pytest.raises(RuntimeError, match="500 Server Error"):
        buildings._overpass("q", cache_dir=tmp_path)
    assert asked == buildings.OVERPASS_URLS * 3                                           # each server once per round: no waiting around for a plain error


def test_a_rate_limit_that_goes_on_still_ends_in_a_clear_error(tmp_path, monkeypatch):
    _said(monkeypatch)
    slept = []
    monkeypatch.setattr(buildings.time, "sleep", slept.append)

    def post(url, **kw):
        raise buildings.requests.exceptions.HTTPError("429 Client Error: Too Many Requests")
    monkeypatch.setattr(buildings.requests, "post", post)
    with pytest.raises(RuntimeError, match="All Overpass endpoints failed.*429"):
        buildings._overpass("q", cache_dir=tmp_path)
    mirrors = len(buildings.OVERPASS_URLS) - 1
    assert sum(slept) == 3 * (sum(buildings.BUSY_WAITS_S) + mirrors * buildings.BUSY_WAITS_S[0]) + (5 + 10 + 15)      # each round: 15 + 30 + 45 for the main server and one 15 for each mirror, plus the pauses between rounds; no more


def test_the_main_server_saying_bad_gateway_is_waited_out_before_any_mirror(tmp_path, monkeypatch):
    said, slept = _said(monkeypatch), []
    monkeypatch.setattr(buildings.shutil, "which", lambda name: "/usr/bin/curl")
    posted = _ssl_fails(monkeypatch)                                                       # Python cannot reach the main server: curl does
    monkeypatch.setattr(buildings.time, "sleep", slept.append)                             # (after _ssl_fails, which stubs sleep itself)
    answers = iter([_Done("", 56, "curl: (56) The requested URL returned error: 502"), _Done("", 56, "curl: (56) The requested URL returned error: 502"), _Done('{"elements": []}')])
    monkeypatch.setattr(buildings.subprocess, "run", lambda *a, **k: next(answers))
    assert buildings._overpass("q", cache_dir=tmp_path).json() == {"elements": []}
    assert slept == [15, 30]                                                               # two busy answers, then it let us in
    assert posted == [buildings.OVERPASS_URLS[0]] * 3                                      # the mirrors were never asked
    assert sum("is busy" in line for line in said) == 2


def test_a_mirror_saying_503_is_not_waited_for_and_gets_a_shorter_timeout(tmp_path, monkeypatch):
    _said(monkeypatch)
    slept, timeouts = [], []
    monkeypatch.setattr(buildings.time, "sleep", slept.append)

    def post(url, **kw):
        timeouts.append((url, kw["timeout"]))
        if "overpass-api.de" in url:
            raise buildings.requests.exceptions.HTTPError("500 Server Error")
        if "private.coffee" in url:
            raise buildings.requests.exceptions.HTTPError("503 Service Unavailable")
        return Resp()
    monkeypatch.setattr(buildings.requests, "post", post)
    assert buildings._overpass("q", cache_dir=tmp_path).json() == {"elements": []}
    assert slept == []                                                                     # no waiting on a mirror's 503: it is the mirrors that are unreliable
    assert dict(timeouts)[buildings.OVERPASS_URLS[0]] == 90 and dict(timeouts)[buildings.OVERPASS_URLS[1]] == buildings.MIRROR_TIMEOUT_S
