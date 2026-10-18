# Builder module

A small HTTP service that turns a box on the OS grid into a tile bundle, so a browser can ask for any area instead of
someone running `build_area.py` by hand. It wraps the Python pipeline (`pipeline/`, the builder half of the map module).

```
python3 modules/builder/server/serve.py        # http://127.0.0.1:8788   (HOST / PORT to change)
```

`REMOVE_CARS=1 python3 modules/builder/server/serve.py` also paints parked cars out of the imagery of every build (see `pipeline/cars.py`; install `pipeline/requirements-cars.txt` into the Python that runs the service).

The dev server forwards `/api` to it (`client/vite.config.js`), so with both running the game page can call `/api/builds`.

## API

| | |
|---|---|
| `POST /api/builds` `{"bbox": [minE, minN, maxE, maxN]}` | **200** if that area is already built, **202** if queued; returns a job |
| `GET /api/builds/<id>` | `status` (`queued`, `building`, `ready`, `error`), `percent`, `stage`, last log lines, `queue_position`, `error`, and `bundle` (`/bundles/area_<id>/`) when ready |
| `GET /api/maps` | ids of every built area |
| `GET /api/health` | `{ok, pipeline_version}` |

```
$ curl -X POST localhost:8788/api/builds -H 'content-type: application/json' -d '{"bbox":[310700,291130,311200,291630]}'
{"id":"e310700n291125w500h500","status":"queued","bbox":[310700,291125,311200,291625],...}
$ curl localhost:8788/api/builds/e310700n291125w500h500
{"status":"building","percent":60,"stage":"buildings",...}   ->   {"status":"ready","percent":100,"bundle":"/bundles/area_e310700n291125w500h500/"}
```

## Caching and limits (the point of the service)

- **Same area, same bundle.** The box is rounded to a 25 m grid, so nearby picks share a build, and the id comes from the
  rounded box (`e310700n291125w500h500`). If a bundle with the current `PIPELINE_VERSION` exists it is returned
  immediately and nothing is fetched. Bump `PIPELINE_VERSION` in `pipeline/__init__.py` when a change should rebuild
  everything; bundles record the version they were built with in `meta.json`.
- **Overpass is asked once a week per area.** The pipeline caches each Overpass answer on disk (`data/cache/overpass`, 7
  days), so even a forced rebuild stays off the public servers. LiDAR tiles and the other sources were already cached.
- **One build at a time**, in a queue (a build is about 30 s to a minute), run as a `python3 -m pipeline.build_area`
  subprocess given four integers and an id made from them: no user text reaches a shell. 10 minute timeout.
- **Limits:** each side 200 m to 2 km, inside the OS grid, at most 8 builds waiting, 2 per client (the client is the
  address, or `X-Forwarded-For` when it comes from a local proxy). Asking for an area that is already building shares that
  job. A failed area is not retried for 30 s.

## Layout

```
modules/builder/server/   service.py   the logic: validation, ids, cache, queue, worker (no HTTP)
                          serve.py     the HTTP face (standard library only)
                          tests/       fake-runner tests, HTTP tests, and a runner test against a stub pipeline
```

Needs the pipeline's Python dependencies (`pipeline/requirements.txt`) and no others. Tests: `python3 -m pytest` from the
repo root.

## Client half

```js
import { buildArea, buildStep } from '@builder';
const { id, bundleUrl } = await buildArea([minE, minN, maxE, maxN], { onProgress: (job) => ... });  // POSTs, then polls
```

`buildArea` takes a box and gives back a bundle URL; it knows nothing about the picker or the game. A dropped poll is
retried, a refused or failed build becomes a readable error, the wait can be aborted (the build carries on and is cached).
`buildStep` is the same as a flow step (see `../README.md`): it needs `ctx.bbox`, shows a progress bar (queue position,
then terrain, buildings, imagery), and adds `ctx.area` and `ctx.bundleUrl`; on failure it shows the reason and **Try again**.

## Reaching the service

`/api` is forwarded to it by the dev server (`npm run dev`) and by the game server (`npm run share`, port 8788 by default or
`BUILDER_URL`), so friends using a shared link can build areas too, within the limits above.
