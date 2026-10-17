import { describe, expect, it } from 'vitest';
import { MATERIALS, MIN_WINDOWED_HEIGHT_M, WINDOWS, facadeLook, hashSeed, materialOf, parseColour } from '../facade.js';

describe('parseColour', () => {
  it('reads names, long and short hex, and refuses the rest', () => {
    expect(parseColour('red')).toEqual([0.62, 0.22, 0.18]); expect(parseColour(' Cream ')).not.toBeNull();
    expect(parseColour('#ff8000')).toEqual([1, 128 / 255, 0]); expect(parseColour('#f80')[0]).toBe(1);
    expect(parseColour('chartreuse-ish')).toBeNull(); expect(parseColour(null)).toBeNull(); expect(parseColour('#12')).toBeNull();
  });
});

describe('materialOf', () => {
  it('maps the common building:material values, and leaves the rest to the shader', () => {
    expect(materialOf('brick')).toBe(MATERIALS.brick); expect(materialOf('red_brick')).toBe(MATERIALS.brick); expect(materialOf('sandstone')).toBe(MATERIALS.stone);
    expect(materialOf('plaster')).toBe(MATERIALS.render); expect(materialOf('concrete')).toBe(MATERIALS.render); expect(materialOf('glass')).toBe(MATERIALS.cladding);
    expect(materialOf(undefined)).toBe(MATERIALS.auto); expect(materialOf('unobtainium')).toBe(MATERIALS.auto);
  });
});

describe('hashSeed', () => {
  it('is stable, in [0, 1), and different for different buildings', () => {
    expect(hashSeed('way/123')).toBe(hashSeed('way/123')); expect(hashSeed('way/123')).not.toBe(hashSeed('way/124'));
    for (const id of ['a', 'way/1', 'relation/99999999', '']) { const s = hashSeed(id); expect(s).toBeGreaterThanOrEqual(0); expect(s).toBeLessThan(1); }
  });
});

describe('facadeLook', () => {
  it('a plain house has house windows, floors 2.8 m apart, no shopfront', () => {
    const l = facadeLook({ building: 'house', osm_id: 'way/1' }, 7);
    expect(l.windows).toBe(WINDOWS.domestic); expect(l.floorHeight).toBeCloseTo(2.8); expect(l.shopfront).toBe(0); expect(l.material).toBe(MATERIALS.auto); expect(l.tint[3]).toBe(0);
  });
  it('takes the number of floors from building:levels (kept within sensible limits), else from the type', () => {
    expect(facadeLook({ building: 'yes', 'building:levels': '3' }, 9).floorHeight).toBeCloseTo(3);
    expect(facadeLook({ building: 'yes', 'building:levels': '1' }, 12).floorHeight).toBe(4.5); expect(facadeLook({ building: 'yes', 'building:levels': '9' }, 12).floorHeight).toBe(2.4);
  });
  it('shops and pubs get a shopfront, shop or not as a building tag', () => {
    expect(facadeLook({ building: 'yes', shop: 'bakery' }, 8).shopfront).toBe(1); expect(facadeLook({ building: 'yes', amenity: 'pub' }, 8).shopfront).toBe(1);
    expect(facadeLook({ building: 'retail' }, 8).shopfront).toBe(1); expect(facadeLook({ building: 'yes', shop: 'no' }, 8).shopfront).toBe(0); expect(facadeLook({ building: 'yes', amenity: 'school' }, 8).shopfront).toBe(0);
  });
  it('flats and offices get large windows; churches tall narrow ones; sheds, garages and warehouses none', () => {
    expect(facadeLook({ building: 'apartments' }, 12).windows).toBe(WINDOWS.large); expect(facadeLook({ building: 'church' }, 14).windows).toBe(WINDOWS.tall);
    for (const t of ['industrial', 'warehouse', 'garage', 'shed', 'barn']) expect(facadeLook({ building: t }, 8).windows).toBe(WINDOWS.none);
    expect(facadeLook({ building: 'yes' }, 20).windows).toBe(WINDOWS.large);                       // a tall plain building is a block
  });
  it('a low building has no windows, and no shopfront without windows', () => {
    expect(facadeLook({ building: 'house' }, MIN_WINDOWED_HEIGHT_M - 0.1).windows).toBe(WINDOWS.none); expect(facadeLook({ building: 'house', shop: 'yes' }, 2).shopfront).toBe(0);
  });
  it('carries the tagged material and colour, and a stable seed from the OSM id', () => {
    const l = facadeLook({ building: 'house', 'building:material': 'brick', 'building:colour': 'red', osm_id: 'way/42' }, 7);
    expect(l.material).toBe(MATERIALS.brick); expect(l.tint).toEqual([0.62, 0.22, 0.18, 1]); expect(l.seed).toBe(hashSeed('way/42'));
  });
  it('copes with nothing at all', () => { const l = facadeLook(undefined); expect(l.windows).toBe(WINDOWS.domestic); expect(Number.isFinite(l.seed)).toBe(true); });
});
