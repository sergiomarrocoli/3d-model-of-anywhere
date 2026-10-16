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
