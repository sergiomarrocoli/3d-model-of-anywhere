import { describe, expect, it } from 'vitest';
import { SOURCES, creditsHtml, describeCredits, mountCredits } from '../index.js';

const EA = 'Contains Environment Agency information © Environment Agency and/or database right (OGL v3)';
const WELSH = 'Contains Welsh Government LiDAR data © Welsh Government / Llywodraeth Cymru (OGL v3)';
const OS = 'Contains OS data © Crown copyright and database right (OGL v3)';
const OSM = '© OpenStreetMap contributors (ODbL)';
const ESRI = 'Source: Esri, Maxar, Earthstar Geographics (development use only)';
const NRW = 'Contains Natural Resources Wales information © Natural Resources Wales and database right (OGL v3)';
const S2 = 'Contains modified Copernicus Sentinel data (ESA)';

describe('describeCredits', () => {
  it('recognises every credit line the pipeline writes', () => {
    const got = Object.fromEntries(describeCredits([EA, WELSH, NRW, OS, OSM, ESRI, S2]).map((e) => [e.line, e]));
    expect(got[EA].name).toMatch(/Environment Agency/); expect(got[WELSH].name).toMatch(/Welsh Government/); expect(got[NRW].name).toMatch(/Natural Resources Wales/);
    expect(got[OS].name).toMatch(/Ordnance Survey/); expect(got[OSM].licence).toMatch(/ODbL/); expect(got[ESRI].name).toBe('Esri World Imagery'); expect(got[S2].name).toMatch(/Sentinel/);
    for (const e of Object.values(got)) { expect(e.role).not.toBe('Other'); expect(e.url).toMatch(/^https:/); expect(e.licenceUrl).toMatch(/^https:/); }
  });
  it('says honestly when imagery is development only and the Welsh licence is unconfirmed', () => {
    const [esri] = describeCredits([ESRI]), [welsh] = describeCredits([WELSH]);
    expect(esri.note).toMatch(/development/i); expect(welsh.note).toMatch(/confirm/i);
  });
  it('keeps unknown lines word for word under Other, and does not drop or invent anything', () => {
    const [e] = describeCredits(['Tiles by Somebody New']);
    expect(e).toMatchObject({ role: 'Other', name: 'Tiles by Somebody New', line: 'Tiles by Somebody New', url: null, licence: null });
  });
  it('removes duplicates and blanks, and orders terrain, buildings, imagery, other', () => {
    const out = describeCredits([ESRI, OSM, 'x', EA, EA, '  ', OSM]);
    expect(out.map((e) => e.role)).toEqual(['Terrain', 'Buildings', 'Imagery', 'Other']);
    expect(describeCredits(undefined)).toEqual([]);
  });
  it('every known source has a role, name, licence and links', () => {
    for (const s of SOURCES) for (const k of ['role', 'name', 'url', 'licence', 'licenceUrl']) expect(s[k], `${s.name} ${k}`).toBeTruthy();
  });
});

describe('creditsHtml', () => {
  it('groups by role, links names and licences safely, and shows the original line and notes', () => {
    const html = creditsHtml(describeCredits([EA, OSM, ESRI]));
    expect(html.indexOf('<h3>Terrain</h3>')).toBeLessThan(html.indexOf('<h3>Buildings</h3>')); expect(html).toContain('<h3>Imagery</h3>');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"'); expect(html).toContain(OSM); expect(html).toMatch(/development use/);
  });
  it('escapes anything that is not ours, including URLs and notes', () => {
    const html = creditsHtml([{ line: '<img src=x onerror=alert(1)>', role: 'Other', name: '<img src=x onerror=alert(1)>', url: 'https://x/"><script>', licence: '<b>', licenceUrl: null, note: '<i>' }]);
    expect(html).not.toContain('<img'); expect(html).not.toContain('<script'); expect(html).not.toContain('<b>'); expect(html).not.toContain('<i>');
    expect(html).toContain('&lt;img');
  });
  it('says so when there is nothing to list', () => { expect(creditsHtml([])).toMatch(/No sources/); });
});

// A just-enough DOM: elements keep their listeners, children are found by class name.
const makeDoc = () => {
  const mk = () => { const el = { listeners: {}, hidden: false, attrs: {}, children: {}, focused: 0, removed: false,
    addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }, removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] ?? []).filter((x) => x !== f); },
    setAttribute(k, v) { this.attrs[k] = v; }, focus() { this.focused++; }, remove() { this.removed = true; },
    querySelector(sel) { return (this.children[sel] ??= mk()); }, fire(t, e = {}) { (this.listeners[t] ?? []).forEach((f) => f(e)); } }; return el; };
  const body = { appended: [], appendChild(el) { this.appended.push(el); } };
  return { createElement: mk, body, ...(() => { const d = mk(); return { addEventListener: d.addEventListener.bind(d), removeEventListener: d.removeEventListener.bind(d), fire: d.fire.bind(d), listeners: d.listeners }; })() };
};

describe('mountCredits', () => {
  it('puts the credit line and a Credits button in the footer and an overlay in the page', () => {
    const doc = makeDoc(), host = { innerHTML: '', ...makeDoc().createElement() };
    const c = mountCredits(host, [OSM, ESRI], doc);
    expect(host.innerHTML).toContain(OSM); expect(host.innerHTML).toContain('Credits</button>');
    const overlay = doc.body.appended[0];
    expect(overlay.hidden).toBe(true); expect(overlay.attrs.role).toBe('dialog'); expect(overlay.innerHTML).toContain('OpenStreetMap');
    expect(typeof c.open).toBe('function');
  });
  it('opens from the button; closes from the close button, the backdrop and Escape, but not from a click on the card', () => {
    const doc = makeDoc(), host = makeDoc().createElement(); host.innerHTML = '';
    mountCredits(host, [OSM], doc);
    const overlay = doc.body.appended[0], openBtn = host.querySelector('.credits-btn'), closeBtn = overlay.querySelector('.credits-close');
    openBtn.fire('click'); expect(overlay.hidden).toBe(false);
    overlay.fire('click', { target: {} }); expect(overlay.hidden).toBe(false);                 // inside the card
    overlay.fire('click', { target: overlay }); expect(overlay.hidden).toBe(true);              // backdrop
    openBtn.fire('click'); closeBtn.fire('click'); expect(overlay.hidden).toBe(true);
    openBtn.fire('click'); doc.fire('keydown', { key: 'Enter' }); expect(overlay.hidden).toBe(false);
    doc.fire('keydown', { key: 'Escape' }); expect(overlay.hidden).toBe(true);
  });
  it('destroy removes the overlay and the key listener', () => {
    const doc = makeDoc(), host = makeDoc().createElement(); host.innerHTML = '';
    const c = mountCredits(host, [OSM], doc); c.destroy();
    expect(doc.body.appended[0].removed).toBe(true); expect(doc.listeners.keydown ?? []).toHaveLength(0);
  });
});
