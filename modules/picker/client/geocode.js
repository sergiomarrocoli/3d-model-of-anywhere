// Find a place to centre the map on. UK postcodes go to postcodes.io (free, no key); anything else to OpenStreetMap
// Nominatim (free, light use only, one request per search). Both return { lon, lat, label } or null.

export const POSTCODE_RE = /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}$/;

export async function geocode(query, fetchImpl = globalThis.fetch) {
  const q = query.trim();
  if (!q) return null;
  if (POSTCODE_RE.test(q)) {
    const r = await fetchImpl(`https://api.postcodes.io/postcodes/${encodeURIComponent(q.replace(/\s+/g, ''))}`);
    if (!r.ok) return null;
    const { result } = await r.json();
    return result ? { lon: result.longitude, lat: result.latitude, label: result.postcode } : null;
  }
  const r = await fetchImpl(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=gb&q=${encodeURIComponent(q)}`);
  if (!r.ok) return null;
  const [hit] = await r.json();
  return hit ? { lon: Number(hit.lon), lat: Number(hit.lat), label: hit.display_name.split(',').slice(0, 2).join(',') } : null;
}
