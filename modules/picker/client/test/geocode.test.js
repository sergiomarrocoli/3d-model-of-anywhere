import { describe, expect, it } from 'vitest';
import { POSTCODE_RE, geocode } from '../geocode.js';

const reply = (body, ok = true) => async (url) => { reply.last = url; return { ok, json: async () => body }; };

describe('geocode', () => {
  it('recognises UK postcodes with or without the space', () => {
    for (const p of ['SY16 3AN', 'sy163an', 'W1A 1AA', 'EC1A 1BB', 'M1 1AE', 'B33 8TH']) expect(POSTCODE_RE.test(p)).toBe(true);
    for (const p of ['Newtown', 'Newtown Powys', '12345', 'SY16']) expect(POSTCODE_RE.test(p)).toBe(false);
  });
  it('looks postcodes up on postcodes.io', async () => {
    const f = reply({ result: { longitude: -3.27, latitude: 52.52, postcode: 'SY16 3AN' } });
    expect(await geocode('sy16 3an', f)).toEqual({ lon: -3.27, lat: 52.52, label: 'SY16 3AN' });
    expect(reply.last).toBe('https://api.postcodes.io/postcodes/sy163an');
  });
  it('sends other text to Nominatim, limited to Britain', async () => {
    const f = reply([{ lon: '-3.31', lat: '52.51', display_name: 'Newtown, Powys, Wales, United Kingdom' }]);
    expect(await geocode('Newtown Powys', f)).toEqual({ lon: -3.31, lat: 52.51, label: 'Newtown, Powys' });
    expect(reply.last).toContain('nominatim.openstreetmap.org'); expect(reply.last).toContain('countrycodes=gb'); expect(reply.last).toContain('Newtown%20Powys');
  });
  it('returns null for blank, unknown or failed lookups', async () => {
    expect(await geocode('   ', reply({}))).toBeNull();
    expect(await geocode('SY16 3AN', reply({}, false))).toBeNull();
    expect(await geocode('SY16 3AN', reply({ result: null }))).toBeNull();
    expect(await geocode('nowhere at all', reply([]))).toBeNull();
    expect(await geocode('nowhere at all', reply([], false))).toBeNull();
  });
});
