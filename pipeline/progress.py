"""What the pipeline says while it works, so the build screen can show it is not frozen.

One line per thing, with a time, flushed at once (the build service reads them as they appear):
    [14:02:11] Downloading SO1292_DTM_1m.tif: 12 of 35 MB (34%)
    [14:02:40] Imagery tiles: 240 of 702
The build service also reads a few of these to move its progress bar (`Imagery tiles: N of M`, `LiDAR tile N of M`), so keep those words.
"""
import time
from pathlib import Path

import requests


def say(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def size_text(n):
    """12345678 -> '12 MB'; small sizes in KB."""
    n = float(n)
    if n >= 1 << 30:
        return f"{n / (1 << 30):.1f} GB"
    if n >= 1 << 20:
        return f"{n / (1 << 20):.0f} MB"
    return f"{max(n / 1024, 1):.0f} KB"


class Every:
    """True at most once per `seconds`: `if every(): say(...)` keeps a busy loop from flooding the log."""

    def __init__(self, seconds=2.0, clock=time.monotonic):
        self.seconds, self.clock, self.last = seconds, clock, None

    def __call__(self):
        now = self.clock()
        if self.last is None or now - self.last >= self.seconds:
            self.last = now
            return True
        return False


def download(url, dest, what=None, get=None, chunk=1 << 20, timeout=120, say=say, every=None):
    """Stream `url` to `dest` (through dest.part, so a half download is never taken for a whole one), saying the file's name and
    how far it has got every couple of seconds. Returns `dest`; an existing file is used as it is."""
    dest = Path(dest)
    what = what or dest.name
    if dest.exists():
        say(f"Using the saved copy of {what}")
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    every = every or Every(2.0)
    say(f"Downloading {what}")
    get = get or requests.get                                   # looked up now, so a test can swap requests.get
    with get(url if url.startswith("http") else f"https://{url}", stream=True, timeout=timeout) as r:
        r.raise_for_status()
        total, done = int((getattr(r, "headers", None) or {}).get("content-length") or 0), 0
        with open(part, "wb") as f:
            for block in r.iter_content(chunk):
                f.write(block)
                done += len(block)
                if every():
                    say(f"Downloading {what}: {size_text(done)} of {size_text(total)} ({done * 100 // total}%)" if total else f"Downloading {what}: {size_text(done)}")
    part.rename(dest)
    say(f"Downloaded {what} ({size_text(done)})")
    return dest
