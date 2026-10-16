# Client

three.js game client (Vite). It loads tile bundles written by `build_area.py`.

```
cd client && npm install
npm run dev     # http://localhost:5173/?area=<id>; serves ../data/bundles at /bundles/
npm test
```

`src/bundle.js` is the loader (`loadBundle(url)` -> `{ meta, heightmap, imagery, buildings }`); the bundle format is documented in `pipeline/bundle.py`.

## Playing with friends

See `../server/README.md`: a small server serves the built client and bundles and relays player positions so friends can share a map (`npm run share` builds the client and starts it).
