import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

// Serves the pipeline's output (../data/bundles) at /bundles/, plus /bundles/index.json listing the areas.
const bundlesDir = path.resolve(import.meta.dirname, '../data/bundles');

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

export default defineConfig({ plugins: [bundlesPlugin()], test: { include: ['test/**/*.test.js'] } });
