import pytest

from pipeline import progress
from pipeline.progress import Every, download, size_text


def test_size_text():
    assert size_text(500) == "1 KB" and size_text(2048) == "2 KB" and size_text(35 * 1024 * 1024) == "35 MB" and size_text(1.5 * 1024 ** 3) == "1.5 GB"


def test_every_lets_one_through_per_interval():
    now = [0.0]
    every = Every(2.0, clock=lambda: now[0])
    assert every() is True and every() is False
    now[0] = 1.9; assert every() is False
    now[0] = 2.0; assert every() is True and every() is False


class _Response:
    def __init__(self, blocks, length=None):
        self.blocks, self.headers = blocks, ({"content-length": str(length)} if length is not None else {})
    def __enter__(self): return self
    def __exit__(self, *a): pass
    def raise_for_status(self): pass
    def iter_content(self, n): yield from self.blocks


def test_download_names_the_file_and_says_how_far_it_has_got(tmp_path):
    said = []
    dest = tmp_path / "c" / "SO1292_DTM_1m.tif"
    out = download("host/x/SO1292_DTM_1m.tif", dest, get=lambda url, **kw: _Response([b"a" * 1000, b"b" * 1000, b"c" * 1000], length=3000), say=said.append, every=lambda: True)
    assert out == dest and dest.read_bytes() == b"a" * 1000 + b"b" * 1000 + b"c" * 1000 and not list(dest.parent.glob("*.part"))
    assert said[0] == "Downloading SO1292_DTM_1m.tif"
    assert "Downloading SO1292_DTM_1m.tif: 1 KB of 3 KB (33%)" in said and "Downloading SO1292_DTM_1m.tif: 3 KB of 3 KB (100%)" in said
    assert said[-1] == "Downloaded SO1292_DTM_1m.tif (3 KB)"


def test_download_without_a_length_still_reports_and_a_saved_copy_is_used_not_fetched(tmp_path):
    said = []
    dest = tmp_path / "t.tif"
    download("https://h/t.tif", dest, "the tile", get=lambda url, **kw: _Response([b"x" * 4096]), say=said.append, every=lambda: True)
    assert "Downloading the tile: 4 KB" in said
    said.clear()
    download("https://h/t.tif", dest, "the tile", get=lambda *a, **k: pytest.fail("fetched again"), say=said.append)
    assert said == ["Using the saved copy of the tile"]


def test_a_failed_download_leaves_no_half_file(tmp_path):
    class Boom(_Response):
        def iter_content(self, n):
            yield b"abc"
            raise OSError("connection reset")
    dest = tmp_path / "t.tif"
    with pytest.raises(OSError):
        download("https://h/t.tif", dest, get=lambda *a, **k: Boom([]), say=lambda m: None)
    assert not dest.exists()


def test_say_prints_a_timed_line_at_once(capsys):
    progress.say("hello")
    out = capsys.readouterr().out
    assert out.startswith("[") and out.endswith("] hello\n") and len(out.split("]")[0]) == 9
