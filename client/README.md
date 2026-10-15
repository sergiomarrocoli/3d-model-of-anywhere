# Client

three.js game client (Vite). It loads tile bundles written by `build_area.py`.

```
cd client && npm install
npm run dev     # http://localhost:5173/?area=<id>; serves ../data/bundles at /bundles/
npm test
```

`src/bundle.js` is the loader (`loadBundle(url)` -> `{ meta, heightmap, imagery, buildings }`); the bundle format is documented in `pipeline/bundle.py`.
