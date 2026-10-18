// Bundle inspector (?debug): summary, imagery with building outlines, and the heightmap in greyscale.
import { loadBundle } from './bundle.js';

const $ = (id) => document.getElementById(id);

export async function debugMain() {
  const area = new URLSearchParams(location.search).get('area') ?? (await (await fetch('/bundles/index.json')).json())[0];

  $('summary').hidden = false; $('dbgrow').hidden = false;
  const t0 = performance.now();
  const { meta, heightmap, imagery, buildings } = await loadBundle(`/bundles/area_${area}`);
  const ms = Math.round(performance.now() - t0);

  let zmin = Infinity, zmax = -Infinity;
  for (const v of heightmap.data) { if (v < zmin) zmin = v; if (v > zmax) zmax = v; }
  const heights = buildings.features.map((f) => f.properties.height);
  $('summary').textContent = [
    `area:       ${meta.id}  (${meta.size_m[0]} x ${meta.size_m[1]} m, ${meta.crs})`,
    `origin:     E ${meta.origin[0]}, N ${meta.origin[1]}`,
    `heightmap:  ${heightmap.width} x ${heightmap.height} @ ${heightmap.resolution} m, ${zmin.toFixed(1)}..${zmax.toFixed(1)} m`,
    `imagery:    ${imagery.width} x ${imagery.height}`,
    `buildings:  ${buildings.features.length}, heights ${Math.min(...heights).toFixed(1)}..${Math.max(...heights).toFixed(1)} m`,
    `loaded in ${ms} ms`,
    '', 'credits:', ...meta.attribution.map((a) => `  ${a}`),
  ].join('\n');

  // Debug previews: imagery with building outlines, and heightmap as greyscale.
  const S = 480;
  const c1 = $('imagery'); c1.width = c1.height = S;
  const g1 = c1.getContext('2d');
  g1.drawImage(imagery, 0, 0, S, S);
  g1.strokeStyle = 'red'; g1.lineWidth = 1;
  const k = S / meta.size_m[0];
  for (const f of buildings.features) {
    g1.beginPath();
    f.geometry.coordinates[0].forEach(([x, y], i) => (i ? g1.lineTo(x * k, S - y * k) : g1.moveTo(x * k, S - y * k)));
    g1.stroke();
  }
  const c2 = $('height'); c2.width = heightmap.width; c2.height = heightmap.height;
  const g2 = c2.getContext('2d');
  const px = g2.createImageData(heightmap.width, heightmap.height);
  heightmap.data.forEach((v, i) => { const g = ((v - zmin) / (zmax - zmin || 1)) * 255; px.data.set([g, g, g, 255], i * 4); });
  g2.putImageData(px, 0, 0);
  document.title = `uk-map-3d: ${meta.id}`;
  window.__bundle = { meta, heightmap, buildings }; // for console poking
}
