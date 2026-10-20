import { describe, expect, it, vi } from 'vitest';
import { BuildFailed, QUIET_AFTER_S, activityOf, buildArea, buildStep, describeJob, formatElapsed, timingText } from '../index.js';

const job = (over) => ({ id: 'e1n2w300h300', status: 'building', percent: 0, stage: 'terrain', bbox: [1, 2, 301, 302], bundle: null, error: null, ...over });
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
// A fake service: POST answers `first`, then each GET answers the next of `polls`.
const service = (first, polls = []) => {
  const calls = [];
  const fetchImpl = vi.fn(async (url, opts) => { calls.push([opts?.method ?? 'GET', url]); return opts?.method === 'POST' ? first : polls.shift(); });
  fetchImpl.calls = calls; return fetchImpl;
};
const BBOX = [1, 2, 301, 302];

describe('buildArea', () => {
  it('returns at once for an area that is already built', async () => {
    const f = service(reply(job({ status: 'ready', percent: 100, bundle: '/bundles/area_x/' }), 200));
    const seen = [];
    const out = await buildArea(BBOX, { imagery: 'stylised', fetchImpl: f, onProgress: (j) => seen.push(j.status), pollMs: 0 });
    expect(out).toEqual({ id: 'e1n2w300h300', bundleUrl: '/bundles/area_x/', bbox: BBOX, cached: true });
    expect(f.calls).toEqual([['POST', '/api/builds']]); expect(seen).toEqual(['ready']);
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ bbox: BBOX, imagery: 'stylised' });
  });
  it('polls a queued build through to ready, reporting every update', async () => {
    const f = service(reply(job({ status: 'queued', queue_position: 1 }), 202), [reply(job({ percent: 30 })), reply(job({ percent: 60, stage: 'buildings' })), reply(job({ status: 'ready', percent: 100, bundle: '/b/' }))]);
    const pcts = [];
    const out = await buildArea(BBOX, { imagery: 'stylised', fetchImpl: f, onProgress: (j) => pcts.push(j.percent), pollMs: 0 });
    expect(pcts).toEqual([0, 30, 60, 100]); expect(out.bundleUrl).toBe('/b/'); expect(out.cached).toBe(false);
    expect(f.calls.slice(1).every(([m, u]) => m === 'GET' && u === '/api/builds/e1n2w300h300')).toBe(true);
  });
  it('turns a failed build and a refused request into a message', async () => {
    await expect(buildArea(BBOX, { imagery: 'stylised', fetchImpl: service(reply(job({ status: 'queued' }), 202), [reply(job({ status: 'error', error: 'LiDAR down' }))]), pollMs: 0 })).rejects.toThrow('LiDAR down');
    await expect(buildArea(BBOX, { imagery: 'stylised', fetchImpl: service(reply({ error: 'each side must be between 200 m and 2000 m' }, 400)), pollMs: 0 })).rejects.toThrow('each side must be');
    await expect(buildArea(BBOX, { imagery: 'stylised', fetchImpl: service(reply(null, 502)), pollMs: 0 })).rejects.toThrow('answered 502');
  });
  it('says so when the service is not running', async () => {
    const f = async () => { throw new TypeError('fetch failed'); };
    await expect(buildArea(BBOX, { imagery: 'stylised', fetchImpl: f, pollMs: 0 })).rejects.toThrow('could not reach the build service');
  });
  it('a dropped poll is retried, not treated as a failed build', async () => {
    let n = 0;
    const f = vi.fn(async (url, opts) => {
      if (opts?.method === 'POST') return reply(job({ status: 'queued' }), 202);
      if (++n === 1) throw new TypeError('network blip');
      return reply(job({ status: 'ready', percent: 100, bundle: '/b/' }));
    });
    expect((await buildArea(BBOX, { imagery: 'stylised', fetchImpl: f, pollMs: 0 })).bundleUrl).toBe('/b/'); expect(n).toBe(2);
  });
  it('can be aborted while waiting', async () => {
    const ctl = new AbortController();
    const f = service(reply(job({ status: 'queued' }), 202), [reply(job())]);
    const p = buildArea(BBOX, { imagery: 'stylised', fetchImpl: f, pollMs: 50, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 5);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('describeJob', () => {
  it('says what is happening', () => {
    expect(describeJob(job({ status: 'queued', queue_position: 2 }))).toContain('2 ahead');
    expect(describeJob(job({ status: 'queued' }))).toBe('Starting…');
    expect(describeJob(job({ stage: 'buildings' }))).toBe('Building: fetching buildings…');
    expect(describeJob(job({ status: 'ready' }))).toBe('Ready');
    expect(describeJob(job({ status: 'error', error: 'x' }))).toBe('x');
  });
});

describe('the choice of imagery', () => {
  it('has to be made: buildArea sends nothing without one of the two textures', async () => {
    const f = service(reply(job({ status: 'ready', percent: 100, bundle: '/b/' })));
    await expect(buildArea(BBOX, { fetchImpl: f, pollMs: 0 })).rejects.toThrow('choose the ground imagery');
    await expect(buildArea(BBOX, { imagery: 'satellite', fetchImpl: f, pollMs: 0 })).rejects.toThrow('stylised or esri');
    expect(f.calls).toEqual([]);
    await buildArea(BBOX, { imagery: 'esri', fetchImpl: f, pollMs: 0 });
    expect(JSON.parse(f.mock.calls[0][1].body).imagery).toBe('esri');
  });
  it('the build step asks first when the context does not say, then builds with the answer', async () => {
    const buttons = ['stylised', 'esri'].map((id) => ({ dataset: { imagery: id }, onclick: null }));
    const r = { className: '', innerHTML: '', q: {}, querySelectorAll: () => buttons,
      querySelector(s) { return (this.q[s] ??= { style: {}, textContent: '', onclick: null, classList: { toggle() {} } }); } };
    const f = service(reply(job({ status: 'ready', percent: 100, bundle: '/b/' })));
    const orig = globalThis.fetch; globalThis.fetch = f;
    const p = buildStep.run({ bbox: BBOX }, { root: r });
    await new Promise((res) => setTimeout(res, 5));
    expect(r.innerHTML).toContain('Choose the ground imagery'); expect(r.innerHTML).toContain('do not publish'); expect(f.calls).toEqual([]);
    buttons[1].onclick();
    const ctx = await p;
    globalThis.fetch = orig;
    expect(ctx.imagery).toBe('esri'); expect(JSON.parse(f.mock.calls[0][1].body).imagery).toBe('esri');
  });
});

describe('buildStep', () => {
  const root = () => { const el = { className: '', innerHTML: '', q: {}, querySelector(s) { return (this.q[s] ??= { style: {}, textContent: '', onclick: null, classList: { toggle(c, on) { this.last = [c, on]; } } }); } }; return el; };
  it('needs ctx.bbox', async () => {
    await expect(buildStep.run({}, { root: root() })).rejects.toThrow('ctx.bbox');
  });
  it('adds area and bundleUrl to the context and keeps everything else (so steps can be chained)', async () => {
    const f = service(reply(job({ status: 'ready', percent: 100, bundle: '/bundles/area_e1n2w300h300/' })));
    const orig = globalThis.fetch; globalThis.fetch = f;
    const ctx = await buildStep.run({ bbox: BBOX, imagery: 'stylised', overlay: { track: [1, 2] }, note: 'kept' }, { root: root() });
    globalThis.fetch = orig;
    expect(ctx).toEqual({ bbox: BBOX, imagery: 'stylised', overlay: { track: [1, 2] }, note: 'kept', area: 'e1n2w300h300', bundleUrl: '/bundles/area_e1n2w300h300/' });
  });
  it('on failure shows the reason and waits for Try again, then builds', async () => {
    const polls = [reply({ error: 'queue is full' }, 429), reply(job({ status: 'ready', percent: 100, bundle: '/b/' }))];
    const orig = globalThis.fetch; globalThis.fetch = vi.fn(async () => polls.shift());
    const r = root();
    const p = buildStep.run({ bbox: BBOX, imagery: 'stylised' }, { root: r });
    await new Promise((res) => setTimeout(res, 10));
    expect(r.innerHTML).toContain('queue is full'); expect(r.innerHTML).toContain('Try again');
    r.q['[data-retry]'].onclick();
    expect((await p).area).toBe('e1n2w300h300');
    globalThis.fetch = orig;
  });
  it('shows what the build is doing, the log, and a running time, and keeps the bar moving while it works', async () => {
    const log = ['[10:00:01] Welsh LiDAR: 2 tiles cover this area (DTM)', '[10:00:02] LiDAR tile 1 of 2 (DTM): SO1292_DTM_1m.tif', '[10:00:04] Downloading SO1292_DTM_1m.tif: 12 MB of 35 MB (34%)'];
    const polls = [reply(job({ status: 'ready', percent: 100, bundle: '/b/', log }))];
    const orig = globalThis.fetch; globalThis.fetch = vi.fn(async (url, opts) => (opts?.method === 'POST' ? reply(job({ status: 'building', percent: 8, log }), 202) : polls.shift()));
    const r = root(), p = buildStep.run({ bbox: BBOX, imagery: 'stylised' }, { root: r });
    await new Promise((res) => setTimeout(res, 30));
    expect(r.q['[data-now]'].textContent).toBe('Downloading SO1292_DTM_1m.tif: 12 MB of 35 MB (34%)');
    expect(r.q['[data-log]'].textContent.split('\n')).toHaveLength(3); expect(r.q['[data-log]'].textContent).toContain('LiDAR tile 1 of 2');
    expect(r.q['[data-time]'].textContent).toMatch(/^Running for 0:0\d · last update just now$/);
    expect(r.q['[data-bar]'].style.width).toBe('8%'); expect(r.q['[data-track]'].classList.last).toEqual(['working', true]);
    await p; globalThis.fetch = orig;
    expect(r.q['[data-track]'].classList.last).toEqual(['working', false]);                         // finished: the stripes stop
  });
  it('counts from the build\'s own start (what the service says), not from when this page began waiting', async () => {
    const polls = [reply(job({ status: 'ready', percent: 100, bundle: '/b/', elapsed_s: 140 }))];
    const orig = globalThis.fetch; globalThis.fetch = vi.fn(async (url, opts) => (opts?.method === 'POST' ? reply(job({ status: 'building', percent: 60, elapsed_s: 125.4 }), 202) : polls.shift()));
    const r = root(), p = buildStep.run({ bbox: BBOX, imagery: 'stylised' }, { root: r });
    await new Promise((res) => setTimeout(res, 30));
    expect(r.q['[data-time]'].textContent).toMatch(/^Running for 2:05 · /);                              // 125 s, though this page has only just started
    await p; globalThis.fetch = orig;
  });
  it('does not put markup from an error into the page', async () => {
    const orig = globalThis.fetch; globalThis.fetch = vi.fn(async () => reply({ error: '<img src=x onerror=alert(1)>' }, 400));
    const r = root(); buildStep.run({ bbox: BBOX, imagery: 'stylised' }, { root: r }).catch(() => {});
    await new Promise((res) => setTimeout(res, 10)); globalThis.fetch = orig;
    expect(r.innerHTML).not.toContain('<img'); expect(r.innerHTML).toContain('&lt;img');
  });
});

describe('what the build screen says it is doing', () => {
  it('shows the latest log line without its time', () => {
    expect(activityOf(job({ log: ['[14:02:11] Asking overpass-api.de for the buildings', '[14:02:12] Downloading SO1292_DTM_1m.tif: 12 MB of 35 MB (34%)'] }))).toBe('Downloading SO1292_DTM_1m.tif: 12 MB of 35 MB (34%)');
    expect(activityOf(job({ log: ['no time here', '   ', ''] }))).toBe('no time here');
    expect(activityOf(job({ log: [] }))).toBe(''); expect(activityOf(job())).toBe(''); expect(activityOf(null)).toBe('');
  });
  it('writes the time running as m:ss or h:mm:ss', () => {
    expect(formatElapsed(0)).toBe('0:00'); expect(formatElapsed(65_000)).toBe('1:05'); expect(formatElapsed(3_725_000)).toBe('1:02:05'); expect(formatElapsed(-5)).toBe('0:00');
  });
  it('says how long since the last news, and reassures when it has been quiet a while', () => {
    expect(timingText(65_000, 400)).toBe('Running for 1:05 · last update just now');
    expect(timingText(65_000, 7_400)).toBe('Running for 1:05 · last update 7 s ago');
    expect(timingText(120_000, QUIET_AFTER_S * 1000)).toMatch(/last update 15 s ago \(this step takes a while without news, it is still working\)/);
  });
  it('knows the stages the pipeline now reports', () => {
    for (const stage of ['registering', 'cars', 'land cover', 'bundle']) expect(describeJob(job({ stage }))).not.toContain(stage === 'land cover' ? '  ' : `Building: ${stage}…`);
    expect(describeJob(job({ stage: 'land cover' }))).toBe('Building: working out land cover…');
    expect(describeJob(job({ stage: 'registering' }))).toBe('Building: fitting the photo to the map…');
  });
});
