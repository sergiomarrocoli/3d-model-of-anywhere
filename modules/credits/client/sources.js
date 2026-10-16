// What we know about each data source the pipeline can credit. A bundle carries only the credit lines
// (`meta.attribution`); these turn each one into a name, a role, a licence and links. Lines that are not recognised are
// still shown, word for word, under "Other", so a new source is never hidden.

const OGL = { licence: 'Open Government Licence v3.0', licenceUrl: 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/' };

export const SOURCES = [
  { match: /Environment Agency/i, role: 'Terrain', name: 'Environment Agency LiDAR (England)', url: 'https://environment.data.gov.uk/survey', ...OGL },
  { match: /Welsh Government/i, role: 'Terrain', name: 'Welsh Government LiDAR (Wales)', url: 'https://datamap.gov.wales/', ...OGL,
    note: 'Licence wording to be confirmed with Welsh Government before any release.' },
  { match: /Natural Resources Wales/i, role: 'Terrain', name: 'Natural Resources Wales LiDAR', url: 'https://naturalresources.wales/', ...OGL },
  { match: /Contains OS data/i, role: 'Terrain and buildings', name: 'Ordnance Survey (OS Terrain 50, OS Open Map Local)', url: 'https://www.ordnancesurvey.co.uk/products/os-open-data', ...OGL },
  { match: /OpenStreetMap/i, role: 'Buildings', name: 'OpenStreetMap', url: 'https://www.openstreetmap.org/copyright', licence: 'Open Database Licence (ODbL)', licenceUrl: 'https://opendatacommons.org/licenses/odbl/' },
  { match: /Esri/i, role: 'Imagery', name: 'Esri World Imagery', url: 'https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9', licence: 'Esri terms of use', licenceUrl: 'https://www.esri.com/en-us/legal/terms/full-master-agreement',
    note: 'For development use; not licensed for a distributed game.' },
  { match: /Copernicus|Sentinel/i, role: 'Imagery', name: 'Copernicus Sentinel-2', url: 'https://sentinels.copernicus.eu/', licence: 'Copernicus open data terms', licenceUrl: 'https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice' },
];

const ORDER = ['Terrain', 'Terrain and buildings', 'Buildings', 'Imagery', 'Other'];

/** Turn credit lines into entries { line, role, name, url, licence, licenceUrl, note }, deduplicated and in a stable order. */
export function describeCredits(lines) {
  const seen = new Set(), out = [];
  for (const raw of lines ?? []) {
    const line = String(raw).trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    const known = SOURCES.find((s) => s.match.test(line));
    out.push(known ? { line, role: known.role, name: known.name, url: known.url, licence: known.licence, licenceUrl: known.licenceUrl, note: known.note ?? null }
      : { line, role: 'Other', name: line, url: null, licence: null, licenceUrl: null, note: null });
  }
  return out.sort((a, b) => ORDER.indexOf(a.role) - ORDER.indexOf(b.role));
}
