import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

// Serves the pipeline's output (./data/bundles) at /bundles/, plus /bundles/index.json listing the areas.
const bundlesDir = path.resolve(import.meta.dirname, 'data/bundles');
const modulesDir = path.resolve(import.meta.dirname, 'modules');

function bundlesPlugin() {
  const handler = (req, res, next) => {
    if (!req.url.startsWith('/bundles/')) return next();
    const rel = decodeURIComponent(req.url.slice('/bundles/'.length).split('?')[0]);
    if (rel === 'index.json') {
      const areas = fs.existsSync(bundlesDir)
        ? fs.readdirSync(bundlesDir).filter((d) => d.startsWith('area_') && fs.existsSync(path.join(bundlesDir, d, 'meta.json')))
        : [];
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(areas.map((d) => d.slice('area_'.length))));
    }
    const file = path.resolve(bundlesDir, rel);
    if (!file.startsWith(bundlesDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.statusCode = 404;
      return res.end('not found');
    }
    res.setHeader('Content-Type', { '.json': 'application/json', '.geojson': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.txt': 'text/plain' }[path.extname(file)] ?? 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  };
  return { name: 'serve-bundles', configureServer(s) { s.middlewares.use(handler); }, configurePreviewServer(s) { s.middlewares.use(handler); } };
}

// The viewer imports the modules by alias (@map, @picker, @builder, @credits, @flow); a game that uses this package sets the
// same aliases to node_modules/uk-map-3d/modules/<name>/client/index.js. three.js and friends are resolved from the app.
export default defineConfig({
  plugins: [bundlesPlugin()],
  resolve: {
    alias: Object.fromEntries(['map', 'picker', 'builder', 'credits', 'flow'].map((m) => [`@${m}`, path.join(modulesDir, m, 'client/index.js')])),
    dedupe: ['three', 'fast-png', 'maplibre-gl', 'proj4'],
  },
  server: { fs: { allow: ['.'] }, proxy: {
      '/api': { target: 'http://127.0.0.1:8788', changeOrigin: true }, // the build service: python3 modules/builder/server/serve.py
    } },
  test: { include: ['modules/*/client/test/**/*.test.js'] },
});
