"""Build service: turns a box on the OS grid into a tile bundle, one build at a time, with caching.

Pure logic with no HTTP in it (see serve.py for that), so it can be tested with a fake build runner.

  - A request names a box in British National Grid metres. It is rounded to a 25 m grid so nearby picks share a build.
  - The build id comes from that rounded box, so the same area is always the same bundle: if a bundle with the current
    PIPELINE_VERSION already exists it is returned at once and nothing is fetched. (Overpass also has a disk cache in the
    pipeline, so even a forced rebuild does not hit the public servers twice in a week.)
  - Builds run as `python3 -m pipeline.build_area` subprocesses, one at a time, in a queue. Limits: box edge 200 m to
    2 km, inside the OS grid, a few waiting builds overall and per client, 10 minute timeout per build.
"""
import json
import queue
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

SNAP_M = 25
MIN_SIZE_M, MAX_SIZE_M = 200, 2000
GB_EXTENT = (0, 0, 700000, 1300000)
MAX_QUEUED = 8
MAX_PER_CLIENT = 2
BUILD_TIMEOUT_S = 600
RETRY_AFTER_FAILURE_S = 30
KEEP_LOG_LINES = 60

# Rough progress from the pipeline's own log lines: (text it prints, percent, stage name).
STAGES = [("DTM:", 20, "terrain"), ("Filled", 30, "terrain"), ("Buildings:", 45, "buildings"), ("Buildings after cleanup", 60, "buildings"),
          ("Imagery fetched", 90, "imagery"), ("Wrote", 100, "done")]


class BuildError(ValueError):
    """The request was not acceptable (bad box, too big, queue full...). Message is safe to show the user."""


def snap(v, step=SNAP_M):
    return int(round(v / step) * step)


def normalise_box(bbox):
    """Validate a [minE, minN, maxE, maxN] box and round it to the grid. Returns a tuple of ints."""
    try:
        vals = [float(v) for v in bbox]
        if len(vals) != 4 or not all(v == v and abs(v) < 1e9 for v in vals):
            raise ValueError
    except (TypeError, ValueError):
        raise BuildError("bbox must be four numbers: minE, minN, maxE, maxN") from None
    min_e, min_n, max_e, max_n = vals
    if not (min_e < max_e and min_n < max_n):
        raise BuildError("bbox must have min smaller than max")
    w, h = snap(max_e - min_e), snap(max_n - min_n)
    if not (MIN_SIZE_M <= w <= MAX_SIZE_M and MIN_SIZE_M <= h <= MAX_SIZE_M):
        raise BuildError(f"each side must be between {MIN_SIZE_M} m and {MAX_SIZE_M} m")
    e0, n0 = snap(min_e), snap(min_n)
    box = (e0, n0, e0 + w, n0 + h)
    if box[0] < GB_EXTENT[0] or box[1] < GB_EXTENT[1] or box[2] > GB_EXTENT[2] or box[3] > GB_EXTENT[3]:
        raise BuildError("that box is outside Great Britain (the OS grid)")
    return box


def area_id(box):
    """e.g. (310450, 290880, 311450, 291880) -> 'e310450n290880w1000h1000'."""
    return f"e{box[0]}n{box[1]}w{box[2] - box[0]}h{box[3] - box[1]}"


_ID_RE = re.compile(r"^e\d+n\d+w\d+h\d+$")
valid_id = lambda s: bool(_ID_RE.match(str(s)))


class Job:
    def __init__(self, id, box, client):
        self.id, self.box, self.client = id, box, client
        self.status = "queued"           # queued | building | ready | error
        self.percent, self.stage, self.error = 0, "waiting", None
        self.log = []
        self.finished_at = None

    def public(self, queue_position=None):
        d = {"id": self.id, "status": self.status, "bbox": list(self.box), "percent": self.percent, "stage": self.stage,
             "error": self.error, "log": self.log[-8:], "bundle": f"/bundles/area_{self.id}/" if self.status == "ready" else None}
        if queue_position is not None:
            d["queue_position"] = queue_position
        return d


def subprocess_runner(root, python=sys.executable, timeout=BUILD_TIMEOUT_S):
    """Run the real pipeline. `on_line` gets each log line as it appears; raises if the build fails or times out."""
    def run(box, id, out_dir, on_line):
        cmd = [python, "-m", "pipeline.build_area", "--bbox", *[str(v) for v in box], "--id", id, "--out", str(out_dir)]
        proc = subprocess.Popen(cmd, cwd=str(root), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        timer = threading.Timer(timeout, proc.kill)
        timer.start()
        try:
            for line in proc.stdout:
                on_line(line.rstrip())
            code = proc.wait()
        finally:
            timer.cancel()
        if code != 0:
            raise RuntimeError("the build failed" if code > 0 else "the build took too long and was stopped")
    return run


class BuildService:
    def __init__(self, bundles_dir, runner, pipeline_version, clock=time.time):
        self.bundles_dir, self.runner, self.version, self.clock = Path(bundles_dir), runner, pipeline_version, clock
        self.jobs, self.lock, self.q = {}, threading.RLock(), queue.Queue()
        self.thread = None

    # -- cache -------------------------------------------------------------
    def cached(self, id):
        meta = self.bundles_dir / f"area_{id}" / "meta.json"
        try:
            return json.loads(meta.read_text()).get("pipeline_version") == self.version
        except (OSError, ValueError):
            return False

    # -- requests ----------------------------------------------------------
    def request(self, bbox, client="anon"):
        """Ask for a build. Returns the job (already 'ready' if cached). Raises BuildError if the request is refused."""
        box = normalise_box(bbox)
        id = area_id(box)
        with self.lock:
            job = self.jobs.get(id)
            if self.cached(id):
                if job is None or job.status != "ready":
                    job = self.jobs[id] = Job(id, box, client)
                    job.status, job.percent, job.stage = "ready", 100, "done"
                return job
            if job and job.status in ("queued", "building"):
                return job                                          # already on its way: share it
            if job and job.status == "error" and self.clock() - job.finished_at < RETRY_AFTER_FAILURE_S:
                return job                                          # do not hammer a failing area
            active = [j for j in self.jobs.values() if j.status in ("queued", "building")]
            if len(active) >= MAX_QUEUED:
                raise BuildError("the build queue is full, try again in a few minutes")
            if sum(j.client == client for j in active) >= MAX_PER_CLIENT:
                raise BuildError("you already have builds in progress; wait for one to finish")
            job = self.jobs[id] = Job(id, box, client)
            self.q.put(id)
            self._ensure_worker()
            return job

    def get(self, id):
        with self.lock:
            job = self.jobs.get(id)
            if job is None and valid_id(id) and self.cached(id):     # built before this server started
                m = re.match(r"e(\d+)n(\d+)w(\d+)h(\d+)", id)
                e, n, w, h = map(int, m.groups())
                job = self.jobs[id] = Job(id, (e, n, e + w, n + h), "anon")
                job.status, job.percent, job.stage = "ready", 100, "done"
            return job

    def position(self, job):
        with self.lock:
            waiting = [i for i in list(self.q.queue)]
            return waiting.index(job.id) + 1 if job.status == "queued" and job.id in waiting else None

    def list_ready(self):
        if not self.bundles_dir.exists():
            return []
        return sorted(d.name[5:] for d in self.bundles_dir.iterdir() if d.name.startswith("area_") and (d / "meta.json").exists())

    # -- worker ------------------------------------------------------------
    def _ensure_worker(self):
        if self.thread is None or not self.thread.is_alive():
            self.thread = threading.Thread(target=self._work, daemon=True)
            self.thread.start()

    def _work(self):
        while True:
            id = self.q.get()   # blocks; the worker is a daemon thread that lives as long as the server
            with self.lock:
                job = self.jobs[id]
                job.status, job.stage = "building", "starting"
            try:
                self.runner(job.box, id, self.bundles_dir, lambda line, j=job: self._on_line(j, line))
                if not self.cached(id):
                    raise RuntimeError("the build finished but wrote no bundle")
                with self.lock:
                    job.status, job.percent, job.stage = "ready", 100, "done"
            except Exception as exc:  # noqa: BLE001 - any failure becomes a job error shown to the user
                with self.lock:
                    job.status, job.error, job.stage = "error", str(exc) or type(exc).__name__, "failed"
            finally:
                with self.lock:
                    job.finished_at = self.clock()

    def _on_line(self, job, line):
        with self.lock:
            job.log = (job.log + [line])[-KEEP_LOG_LINES:]
            for text, percent, stage in STAGES:
                if text in line and percent > job.percent:
                    job.percent, job.stage = min(percent, 99), stage   # 100 is only set when the bundle exists

    def wait_idle(self, timeout=10):
        """For tests: block until nothing is queued or building."""
        end = time.time() + timeout
        while time.time() < end:
            with self.lock:
                if all(j.status not in ("queued", "building") for j in self.jobs.values()):
                    return True
            time.sleep(0.01)
        return False
