import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

// Serves the pipeline's output (../data/bundles) at /bundles/, plus /bundles/index.json listing the areas.
const bundlesDir = path.resolve(import.meta.dirname, '../data/bundles');
const modulesDir = path.resolve(import.meta.dirname, '../modules');

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

// In dev, /ws goes to the game server (`npm start` in ../server) so friends can share a room; without it the game is single player.
// Feature modules live in ../modules/<name>/ (a client/ half, and for some a server/ half). They are imported by alias
// (@map, @walker, @presence, @picker, @builder, @credits), and three.js / fast-png are resolved from this project so a module needs no copy of them.
export default defineConfig({
  plugins: [bundlesPlugin()],
  resolve: {
    alias: Object.fromEntries(['map', 'walker', 'presence', 'picker', 'builder', 'credits'].map((m) => [`@${m}`, path.join(modulesDir, m, 'client/index.js')])),
    dedupe: ['three', 'fast-png', 'maplibre-gl', 'proj4'],
  },
  // In dev, /ws goes to the presence server (`npm start` in ../modules/presence/server); without it the game is single player.
  server: { fs: { allow: ['..'] }, proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true, changeOrigin: true },
      '/api': { target: 'http://127.0.0.1:8788', changeOrigin: true }, // the build service: python3 modules/builder/server/serve.py
    } },
  test: { include: ['test/**/*.test.js', '../modules/*/client/test/**/*.test.js'] },
});
