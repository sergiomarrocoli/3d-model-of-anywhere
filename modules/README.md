# Modules

The viewer (`src/main.js`) is a shell that plugs modules together. Each module lives in `modules/<name>/` with a `client/`
half (and, if it needs one, a `server/` half), its own tests and a README. In the viewer they are imported by alias
(`@map`, `@picker`, `@builder`, `@credits`, `@flow`, set in `vite.config.js`); another program installs this package and
imports them as `uk-map-3d/map`, `uk-map-3d/picker` and so on (see the `exports` in `package.json`).

| Module | What it is | Needs |
|---|---|---|
| [`map`](map/README.md) | loads a built area, draws it, answers questions about it (ground height, buildings, slopes, edges, destruction) | nothing |
| [`picker`](picker/README.md) | choose an area on an open map with a draggable, resizable box (`?pick`) | nothing |
| [`builder`](builder/README.md) | HTTP service that builds a picked box into a bundle, with caching and limits (wraps `pipeline/`) | the Python pipeline |
| [`credits`](credits/README.md) | the credit line and a Credits button listing every source and licence | the credit lines |
| `flow` | the step runner that chains modules (below) | nothing |

## Chaining: the flow

Modules do not call each other. A program runs a **flow**, a list of steps, each handing a context object to the next
(`flow/client/index.js`):

```
?pick   =   ?flow=pick,build,view
              |     |     └─ view   loads ctx.area into modules/map and flies a camera round it
              |     └─ build        modules/builder: POST ctx.bbox to the build service, wait  ->  ctx.area, ctx.bundleUrl
              └─ pick               modules/picker: choose a box on the map                    ->  ctx.bbox
```

A step is `{ name, run(ctx, host) -> Promise<ctx> }`, where `host = { root, signal }` (an element to render into, and an
abort signal). It reads the context fields it needs and returns `{ ...ctx, ...itsOutput }`, keeping everything else, so it
never needs to know what is before or after it. Fields in use:

| field | meaning | set by | read by |
|---|---|---|---|
| `bbox` | `[minE, minN, maxE, maxN]`, OS grid metres | pick | build |
| `area` | id of a built area | build | view, a game |
| `bundleUrl` | where its files are | build | |
| `overlay` | anything a game draws or uses on the map (for example a track) | a game's own step | the game |

A game adds its own steps (a track drawer, a race) to the same flow.
