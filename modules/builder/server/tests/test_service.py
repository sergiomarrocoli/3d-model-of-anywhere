import json
import threading
import time
import urllib.request

import pytest

import service as svc
from service import BuildError, BuildService, area_id, bundles_dir_setting, cars_setting, normalise_box, on_unless_off, snap, valid_id

V = 3


def fake_runner(calls, fail=None, gate=None, lines=("[00:00:01] DTM: EA LiDAR (100% of pixels from LiDAR)", "[00:00:05] Buildings: 5 from OpenStreetMap", "[00:00:09] Imagery fetched (esri)")):
    """Writes a real-looking bundle (just meta.json), like the pipeline does."""
    def run(box, id, out_dir, on_line):
        calls.append(id)
        if gate:
            gate.wait(5)
        for line in lines:
            on_line(line)
        if fail:
            raise RuntimeError(fail)
        d = out_dir / f"area_{id}"; d.mkdir(parents=True)
        (d / "meta.json").write_text(json.dumps({"pipeline_version": V}))
    return run


@pytest.fixture
def make(tmp_path):
    def _make(**kw):
        calls = []
        return BuildService(tmp_path, fake_runner(calls, **kw), V), calls
    return _make


BOX = [310450, 290875, 311450, 291875]


class TestBox:
    def test_snaps_to_25m_and_names_the_area(self):
        assert normalise_box([310452, 290878, 311449, 291883]) == (310450, 290875, 311450, 291875)
        assert area_id((310450, 290875, 311450, 291875)) == "e310450n290875w1000h1000"
        assert snap(12) == 0 and snap(13) == 25 and snap(-13) == -25

    def test_nearby_picks_share_one_id(self):
        assert area_id(normalise_box([310451, 290881, 311452, 291879])) == area_id(normalise_box([310449, 290879, 311448, 291881]))

    @pytest.mark.parametrize("bad", [None, "x", [1, 2, 3], [1, 2, 3, "a"], [0, 0, 100, 100], [0, 0, 100000, 100000], [5, 5, 5, 500],
                                     [float("nan"), 0, 500, 500], [1000, 1000, 4000, 3000], [1000, 1000, 5100, 2000], [1000, 1000, 3100, 3000], [-500, 1000, 500, 2000], [690000, 1000, 702000, 2000], [1e12, 0, 1e12 + 500, 500], [10, 10, 5, 5]])
    def test_refuses_bad_boxes(self, bad):
        with pytest.raises(BuildError):
            normalise_box(bad)

    def test_allows_the_limits_and_rectangles(self):
        assert normalise_box([1000, 1000, 3000, 3000]) == (1000, 1000, 3000, 3000)
        assert normalise_box([1000, 1000, 1200, 1200]) == (1000, 1000, 1200, 1200)
        assert normalise_box([1000, 1000, 2500, 2000]) == (1000, 1000, 2500, 2000)

    def test_any_shape_up_to_four_square_km(self):
        assert normalise_box([1000, 1000, 3000, 3000]) == (1000, 1000, 3000, 3000)         # 2 x 2 km
        assert normalise_box([1000, 1000, 5000, 2000]) == (1000, 1000, 5000, 2000)         # 4 x 1 km: the longest side
        assert normalise_box([1000, 1000, 2000, 5000]) == (1000, 1000, 2000, 5000)         # and the other way round
        assert normalise_box([1000, 1000, 4000, 2325]) == (1000, 1000, 4000, 2325)         # 3 x 1.325 km = 3.975 km2
        with pytest.raises(BuildError, match="at most 4 km"):
            normalise_box([1000, 1000, 4000, 2350])                                        # 3 x 1.35 km = 4.05 km2: a hair too much
        with pytest.raises(BuildError, match="between 200 m and 4000 m"):
            normalise_box([1000, 1000, 5300, 1500])                                        # a strip longer than 4 km, though the area is fine

    def test_valid_id(self):
        assert valid_id("e310450n290875w1000h1000") and not valid_id("../etc") and not valid_id("bath") and not valid_id("e1n2w3h4/..")


class TestBuilds:
    def test_builds_once_then_serves_from_cache(self, make):
        s, calls = make()
        j = s.request(BOX); assert j.status in ("queued", "building")
        assert s.wait_idle() and j.status == "ready" and j.percent == 100 and j.public()["bundle"] == "/bundles/area_e310450n290875w1000h1000/"
        again = s.request(BOX)
        assert again.status == "ready" and calls == [j.id]                    # nothing was run twice

    def test_a_new_server_still_finds_old_bundles(self, make, tmp_path):
        s, _ = make(); s.request(BOX); assert s.wait_idle()
        fresh = BuildService(tmp_path, fake_runner([]), V)
        assert fresh.get("e310450n290875w1000h1000").status == "ready"
        assert fresh.get("e1n1w300h300") is None and fresh.get("../../etc") is None

    def test_a_bundle_from_an_older_pipeline_is_rebuilt(self, make, tmp_path):
        s, calls = make(); s.request(BOX); assert s.wait_idle()
        newer = BuildService(tmp_path, fake_runner(calls), V + 1)
        meta = tmp_path / "area_e310450n290875w1000h1000" / "meta.json"
        assert not newer.cached("e310450n290875w1000h1000") and meta.exists()

    def test_progress_comes_from_the_log(self, make):
        gate = threading.Event()
        s, _ = make(gate=gate)
        j = s.request(BOX); time.sleep(0.1)
        assert j.status == "building" and j.stage == "starting"
        gate.set(); assert s.wait_idle()
        assert [l for l in j.log if "Buildings" in l]

    def test_percent_never_goes_backwards_and_hits_100_only_when_the_bundle_exists(self, make):
        s, _ = make(lines=("[x] Imagery fetched", "[x] DTM: late", "[x] Wrote data/bundles/x"))
        j = s.request(BOX); assert s.wait_idle()
        assert j.percent == 100 and j.status == "ready"
        s2, _ = make(fail="boom", lines=("[x] Wrote data/bundles/x",))
        j2 = s2.request([0, 0, 500, 500]); assert s2.wait_idle()
        assert j2.status == "error" and j2.percent < 100

    def test_the_bar_follows_tile_counts_through_the_long_stages(self, tmp_path):
        seen = []
        holder = {}

        def runner(box, id, out_dir, on_line):
            for line in ["[x] Welsh LiDAR: 4 tiles cover this area (DTM)", "[x] LiDAR tile 1 of 4 (DTM): a.tif", "[x] Downloading a.tif: 3 MB of 9 MB (33%)", "[x] LiDAR tile 3 of 4 (DTM): c.tif",
                         "[x] LiDAR tile 1 of 4 (DSM): a.tif", "[x] DTM: Welsh Government LiDAR", "[x] Buildings after cleanup: 9", "[x] Imagery tiles: 100 of 400", "[x] Imagery tiles: 400 of 400", "[x] Imagery fetched"]:
                on_line(line); seen.append((holder["job"].percent, holder["job"].stage))
            d = out_dir / f"area_{id}"; d.mkdir(parents=True)
            (d / "meta.json").write_text(json.dumps({"pipeline_version": V}))
        s = BuildService(tmp_path, runner, V)
        holder["job"] = s.request(BOX); assert s.wait_idle()
        pct = [p for p, _ in seen]
        assert pct[0] == 0 and pct[1] == 3 and pct[2] == 3                               # a line with no count moves nothing; tile 1 of 4 has none done
        assert pct[3] == 3 + 16 * 2 // 4 and pct[4] == pct[3]                            # tile 3 of 4 has two done; the DSM pass starting again never takes it back
        assert pct[5] == 20 and pct[6] == 60                                             # the stage lines still set their own marks
        assert pct[7] == 60 + 29 * 100 // 400 and pct[8] == 60 + 29 and pct[9] == 90 and seen[7][1] == "imagery"
        assert pct == sorted(pct)

    def test_asking_for_the_buildings_is_the_buildings_stage(self, tmp_path):
        seen = []
        holder = {}

        def runner(box, id, out_dir, on_line):
            for line in ["[x] Filled 0.0% of the DTM from Terrain 50", "[x] Asking overpass-api.de for the buildings", "[x] Buildings: 254 from OpenStreetMap"]:
                on_line(line); seen.append((holder["job"].percent, holder["job"].stage))
            d = out_dir / f"area_{id}"; d.mkdir(parents=True)
            (d / "meta.json").write_text(json.dumps({"pipeline_version": V}))
        s = BuildService(tmp_path, runner, V)
        holder["job"] = s.request(BOX); assert s.wait_idle()
        assert seen == [(30, "terrain"), (31, "buildings"), (45, "buildings")]

    def test_the_stages_with_no_count_have_marks_too(self, tmp_path):
        seen = []
        holder = {}

        def runner(box, id, out_dir, on_line):
            for line in ["[x] Imagery fetched", "[x] Fitting the photo to the map", "[x] Working out the land cover (roads, trees, water)", "[x] Land cover: grass 30%", "[x] Writing the bundle (heightmap)"]:
                on_line(line); seen.append((holder["job"].percent, holder["job"].stage))
            d = out_dir / f"area_{id}"; d.mkdir(parents=True)
            (d / "meta.json").write_text(json.dumps({"pipeline_version": V}))
        s = BuildService(tmp_path, runner, V)
        holder["job"] = s.request(BOX); assert s.wait_idle()
        assert seen == [(90, "imagery"), (91, "registering"), (94, "land cover"), (96, "land cover"), (98, "bundle")]

    def test_failures_are_reported_and_retried_after_a_pause(self, tmp_path):
        now = [1000.0]
        calls = []
        s = BuildService(tmp_path, fake_runner(calls, fail="boom"), V, clock=lambda: now[0])
        j = s.request(BOX); assert s.wait_idle()
        assert j.status == "error" and j.error == "boom" and j.public()["bundle"] is None
        assert s.request(BOX) is j and len(calls) == 1                       # too soon: not hammered
        now[0] += svc.RETRY_AFTER_FAILURE_S + 1
        j2 = s.request(BOX); assert j2 is not j; assert s.wait_idle() and len(calls) == 2

    def test_same_area_asked_twice_shares_one_job(self, make):
        gate = threading.Event(); s, calls = make(gate=gate)
        a = s.request(BOX, "a"); b = s.request(BOX, "b")
        assert a is b; gate.set(); assert s.wait_idle() and calls == [a.id]

    def test_one_build_at_a_time_in_order_with_queue_positions(self, make):
        gate = threading.Event(); s, calls = make(gate=gate)
        boxes = [[1000 + i * 3000, 1000, 2000 + i * 3000, 2000] for i in range(3)]
        jobs = [s.request(b, f"c{i}") for i, b in enumerate(boxes)]
        time.sleep(0.1)
        assert [s.position(j) for j in jobs] == [None, 1, 2]
        gate.set(); assert s.wait_idle() and calls == [j.id for j in jobs]

    def test_limits_per_client_and_for_the_whole_queue(self, make):
        gate = threading.Event(); s, _ = make(gate=gate)
        mk = lambda i: [1000 + i * 3000, 1000, 2000 + i * 3000, 2000]
        s.request(mk(0), "me"); s.request(mk(1), "me")
        with pytest.raises(BuildError, match="in progress"):
            s.request(mk(2), "me")
        for i in range(3, 3 + svc.MAX_QUEUED - 2):
            s.request(mk(i), f"other{i}")
        with pytest.raises(BuildError, match="queue is full"):
            s.request(mk(40), "late")
        gate.set(); assert s.wait_idle(15)

    def test_a_build_that_writes_nothing_is_an_error(self, make, tmp_path):
        s = BuildService(tmp_path, lambda box, id, out, on_line: None, V)
        j = s.request(BOX); assert s.wait_idle() and j.status == "error" and "no bundle" in j.error

    def test_lists_built_maps(self, make):
        s, _ = make(); s.request(BOX); assert s.wait_idle()
        assert s.list_ready() == ["e310450n290875w1000h1000"]


class TestRunner:
    def test_a_crash_says_why(self, tmp_path):
        pkg = tmp_path / "pipeline"; pkg.mkdir(); (pkg / "__init__.py").write_text("")
        (pkg / "build_area.py").write_text("print('[1] Asking overpass-api.de for the buildings', flush=True)\nraise RuntimeError('All Overpass endpoints failed: overpass-api.de: SSLError')\n")
        seen = []
        with pytest.raises(RuntimeError) as e:
            svc.subprocess_runner(tmp_path, python="python3")((1, 2, 3, 4), "e1n2w2h2", tmp_path / "out", seen.append)
        assert str(e.value) == "the build failed: RuntimeError: All Overpass endpoints failed: overpass-api.de: SSLError"
        assert any("Traceback" in l for l in seen)                                            # the whole traceback still goes to the log

    def test_a_crash_with_no_output_is_still_just_failed(self, tmp_path):
        pkg = tmp_path / "pipeline"; pkg.mkdir(); (pkg / "__init__.py").write_text("")
        (pkg / "build_area.py").write_text("import sys\nsys.exit(3)\n")
        with pytest.raises(RuntimeError, match="^the build failed$"):
            svc.subprocess_runner(tmp_path, python="python3")((1, 2, 3, 4), "e1n2w2h2", tmp_path / "out", lambda l: None)

    def test_runs_the_pipeline_with_only_numbers_and_streams_lines(self, tmp_path):
        script = tmp_path / "fake.py"
        script.write_text("import sys\nprint('[1] DTM: x', flush=True)\nprint(' '.join(sys.argv[1:]), flush=True)\nsys.exit(int(__import__('os').environ.get('EXIT', '0')))\n")
        seen = []
        run = svc.subprocess_runner(tmp_path, python="python3")
        # The runner always calls `python -m pipeline.build_area`; point it at a stub package instead.
        pkg = tmp_path / "pipeline"; pkg.mkdir(); (pkg / "__init__.py").write_text("")
        (pkg / "build_area.py").write_text(script.read_text())
        run((1, 2, 3, 4), "e1n2w2h2", tmp_path / "out", seen.append)
        assert seen[0] == "[1] DTM: x" and seen[1] == f"--bbox 1 2 3 4 --id e1n2w2h2 --out {tmp_path / 'out'}"

    def test_a_failing_build_raises(self, tmp_path):
        pkg = tmp_path / "pipeline"; pkg.mkdir(); (pkg / "__init__.py").write_text("")
        (pkg / "build_area.py").write_text("import sys; sys.exit(3)\n")
        with pytest.raises(RuntimeError, match="failed"):
            svc.subprocess_runner(tmp_path, python="python3")((1, 2, 3, 4), "e1n2w2h2", tmp_path, lambda l: None)


class TestCarsSetting:
    def test_on_by_default_when_the_detector_is_installed(self):
        assert cars_setting(None, True) == (True, "removed")
        assert cars_setting("1", True) == (True, "removed")

    def test_off_when_asked(self):
        for word in ("0", "false", "No", "OFF"):
            assert cars_setting(word, True)[0] is False

    def test_quietly_off_by_default_without_the_detector_but_loud_when_asked_for(self):
        on, note = cars_setting(None, False)
        assert on is False and "requirements-cars.txt" in note
        with pytest.raises(RuntimeError, match="requirements-cars.txt"):
            cars_setting("1", False)
        assert cars_setting("0", False)[0] is False

    def test_the_runner_adds_the_flag(self, tmp_path):
        seen = []
        class Fake:
            def __init__(self, cmd, **kw):
                seen.append(cmd)
                self.stdout = iter([])
            def wait(self): return 0
            def kill(self): pass
        orig = svc.subprocess.Popen
        svc.subprocess.Popen = Fake
        try:
            svc.subprocess_runner(tmp_path, remove_cars=True)((1, 2, 3, 4), "e1n2w2h2", tmp_path, lambda l: None)
            svc.subprocess_runner(tmp_path)((1, 2, 3, 4), "e1n2w2h2", tmp_path, lambda l: None)
        finally:
            svc.subprocess.Popen = orig
        assert "--remove-cars" in seen[0] and "--remove-cars" not in seen[1]

    def test_the_runner_adds_the_footprint_and_registration_flags_when_asked(self, tmp_path):
        seen = []
        class Fake:
            def __init__(self, cmd, **kw):
                seen.append(cmd)
                self.stdout = iter([])
            def wait(self): return 0
            def kill(self): pass
        orig = svc.subprocess.Popen
        svc.subprocess.Popen = Fake
        try:
            svc.subprocess_runner(tmp_path, fill_footprints=True, register=True)((1, 2, 3, 4), "e1n2w2h2", tmp_path, lambda l: None)
            svc.subprocess_runner(tmp_path, fill_footprints=True)((1, 2, 3, 4), "e1n2w2h2", tmp_path, lambda l: None)
            svc.subprocess_runner(tmp_path)((1, 2, 3, 4), "e1n2w2h2", tmp_path, lambda l: None)
        finally:
            svc.subprocess.Popen = orig
        assert "--fill-footprints" in seen[0] and "--register" in seen[0]
        assert "--fill-footprints" in seen[1] and "--register" not in seen[1]
        assert "--fill-footprints" not in seen[2] and "--register" not in seen[2]               # the library default is the plain build; serve.py turns them on

    def test_the_settings_are_on_unless_turned_off(self):
        assert on_unless_off(None) and on_unless_off("") and on_unless_off("1") and on_unless_off("yes")
        for word in ("0", "false", "No", " OFF "):
            assert on_unless_off(word) is False


class TestBundlesDir:
    def test_default_when_unset(self, tmp_path):
        assert bundles_dir_setting(None, tmp_path / "data") == tmp_path / "data"
        assert bundles_dir_setting("", tmp_path / "data") == tmp_path / "data"

    def test_the_setting_wins_and_is_made_absolute(self, tmp_path, monkeypatch):
        assert bundles_dir_setting(str(tmp_path / "game" / "bundles"), tmp_path / "data") == (tmp_path / "game" / "bundles").resolve()
        monkeypatch.chdir(tmp_path)
        assert bundles_dir_setting("rel/bundles", "ignored") == (tmp_path / "rel" / "bundles").resolve()
