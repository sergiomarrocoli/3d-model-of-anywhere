"""HTTP face of the build service. Run from the repo root:  python3 modules/builder/server/serve.py

  POST /api/builds        {"bbox": [minE, minN, maxE, maxN], "imagery": "esri" | "stylised"}   -> 200 (cached, ready) or 202 (queued) + job
  GET  /api/builds/<id>   status, percent, stage, last log lines, bundle url when ready
  GET  /api/maps          ids of every built area
  GET  /api/health

Listens on 127.0.0.1:8788 by default (PORT / HOST to change). The game server and the dev server forward /api here.
Nothing is shelled out with user text: the pipeline is given four rounded integers and an id made from them.
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from service import BuildError, BuildService, bundles_dir_setting, allowed_imagery_setting, cars_setting, on_unless_off, subprocess_runner, valid_id  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
MAX_BODY = 2048


def make_handler(service):
    class Handler(BaseHTTPRequestHandler):
        server_version = "uk-map-3d-builder"

        def log_message(self, fmt, *args):  # quiet by default
            if os.environ.get("BUILDER_LOG"):
                super().log_message(fmt, *args)

        def _send(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _client(self):
            ip = self.client_address[0]
            fwd = self.headers.get("X-Forwarded-For")
            return fwd.split(",")[0].strip() if fwd and ip in ("127.0.0.1", "::1") else ip   # trust the header only from a local proxy

        def do_GET(self):
            path = self.path.split("?")[0].rstrip("/")
            if path == "/api/health":
                return self._send(200, {"ok": True, "pipeline_version": service.version})
            if path == "/api/maps":
                return self._send(200, service.list_ready())
            if path.startswith("/api/builds/"):
                id = path[len("/api/builds/"):]
                job = service.get(id) if valid_id(id) else None
                return self._send(200, job.public(service.position(job))) if job else self._send(404, {"error": "no such build"})
            self._send(404, {"error": "not found"})

        def do_POST(self):
            if self.path.split("?")[0].rstrip("/") != "/api/builds":
                return self._send(404, {"error": "not found"})
            try:
                n = int(self.headers.get("Content-Length", "0"))
                if not 0 < n <= MAX_BODY:
                    raise ValueError
                body = json.loads(self.rfile.read(n))
                bbox, imagery = body["bbox"], body["imagery"]       # no default: the caller chooses the photograph or the drawn ground
            except (ValueError, KeyError, TypeError):
                return self._send(400, {"error": 'send JSON like {"bbox": [minE, minN, maxE, maxN], "imagery": "esri" or "stylised"}'})
            try:
                job = service.request(bbox, self._client(), imagery)
            except BuildError as exc:
                return self._send(429 if "queue" in str(exc) or "in progress" in str(exc) else 400, {"error": str(exc)})
            self._send(200 if job.status == "ready" else 202, job.public(service.position(job)))

    return Handler


def make_server(service, host="127.0.0.1", port=8788):
    return ThreadingHTTPServer((host, port), make_handler(service))


if __name__ == "__main__":
    sys.path.insert(0, str(ROOT))
    from pipeline import PIPELINE_VERSION
    import importlib.util
    remove_cars, cars_note = cars_setting(os.environ.get("REMOVE_CARS"), importlib.util.find_spec("cardet") is not None)
    allowed = allowed_imagery_setting(os.environ.get("IMAGERY"))
    fill, register = on_unless_off(os.environ.get("FILL_FOOTPRINTS")), on_unless_off(os.environ.get("REGISTER_IMAGERY"))
    svc = BuildService(bundles_dir_setting(os.environ.get("BUNDLES_DIR"), ROOT / "data" / "bundles"), subprocess_runner(ROOT, remove_cars=remove_cars, fill_footprints=fill, register=register), PIPELINE_VERSION, allowed=allowed)
    host, port = os.environ.get("HOST", "127.0.0.1"), int(os.environ.get("PORT", "8788"))
    httpd = make_server(svc, host, port)
    print(f"build service on http://{host}:{port}  (pipeline version {PIPELINE_VERSION}, bundles in {svc.bundles_dir}, cars {cars_note}, buildings {'OSM plus Open Map Local where OSM has none' if fill else 'OSM only'}, ground: {' or '.join(allowed)}, chosen per build; photographs {'registered to the grid' if register else 'as fetched'})", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
