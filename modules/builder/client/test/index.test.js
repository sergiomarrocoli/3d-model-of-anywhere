import { describe, expect, it, vi } from 'vitest';
import { BuildFailed, buildArea, buildStep, describeJob } from '../index.js';

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
    const out = await buildArea(BBOX, { fetchImpl: f, onProgress: (j) => seen.push(j.status), pollMs: 0 });
    expect(out).toEqual({ id: 'e1n2w300h300', bundleUrl: '/bundles/area_x/', bbox: BBOX, cached: true });
    expect(f.calls).toEqual([['POST', '/api/builds']]); expect(seen).toEqual(['ready']);
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ bbox: BBOX });
  });
  it('polls a queued build through to ready, reporting every update', async () => {
    const f = service(reply(job({ status: 'queued', queue_position: 1 }), 202), [reply(job({ percent: 30 })), reply(job({ percent: 60, stage: 'buildings' })), reply(job({ status: 'ready', percent: 100, bundle: '/b/' }))]);
    const pcts = [];
    const out = await buildArea(BBOX, { fetchImpl: f, onProgress: (j) => pcts.push(j.percent), pollMs: 0 });
    expect(pcts).toEqual([0, 30, 60, 100]); expect(out.bundleUrl).toBe('/b/'); expect(out.cached).toBe(false);
    expect(f.calls.slice(1).every(([m, u]) => m === 'GET' && u === '/api/builds/e1n2w300h300')).toBe(true);
  });
  it('turns a failed build and a refused request into a message', async () => {
    await expect(buildArea(BBOX, { fetchImpl: service(reply(job({ status: 'queued' }), 202), [reply(job({ status: 'error', error: 'LiDAR down' }))]), pollMs: 0 })).rejects.toThrow('LiDAR down');
    await expect(buildArea(BBOX, { fetchImpl: service(reply({ error: 'each side must be between 200 m and 2000 m' }, 400)), pollMs: 0 })).rejects.toThrow('each side must be');
    await expect(buildArea(BBOX, { fetchImpl: service(reply(null, 502)), pollMs: 0 })).rejects.toThrow('answered 502');
  });
  it('says so when the service is not running', async () => {
    const f = async () => { throw new TypeError('fetch failed'); };
    await expect(buildArea(BBOX, { fetchImpl: f, pollMs: 0 })).rejects.toThrow('could not reach the build service');
  });
  it('a dropped poll is retried, not treated as a failed build', async () => {
    let n = 0;
    const f = vi.fn(async (url, opts) => {
      if (opts?.method === 'POST') return reply(job({ status: 'queued' }), 202);
      if (++n === 1) throw new TypeError('network blip');
      return reply(job({ status: 'ready', percent: 100, bundle: '/b/' }));
    });
    expect((await buildArea(BBOX, { fetchImpl: f, pollMs: 0 })).bundleUrl).toBe('/b/'); expect(n).toBe(2);
  });
  it('can be aborted while waiting', async () => {
    const ctl = new AbortController();
    const f = service(reply(job({ status: 'queued' }), 202), [reply(job())]);
    const p = buildArea(BBOX, { fetchImpl: f, pollMs: 50, signal: ctl.signal });
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

describe('buildStep', () => {
  const root = () => { const el = { className: '', innerHTML: '', q: {}, querySelector(s) { return (this.q[s] ??= { style: {}, textContent: '', onclick: null }); } }; return el; };
  it('needs ctx.bbox', async () => {
    await expect(buildStep.run({}, { root: root() })).rejects.toThrow('ctx.bbox');
  });
  it('adds area and bundleUrl to the context and keeps everything else (so steps can be chained)', async () => {
    const f = service(reply(job({ status: 'ready', percent: 100, bundle: '/bundles/area_e1n2w300h300/' })));
    const orig = globalThis.fetch; globalThis.fetch = f;
    const ctx = await buildStep.run({ bbox: BBOX, overlay: { track: [1, 2] }, note: 'kept' }, { root: root() });
    globalThis.fetch = orig;
    expect(ctx).toEqual({ bbox: BBOX, overlay: { track: [1, 2] }, note: 'kept', area: 'e1n2w300h300', bundleUrl: '/bundles/area_e1n2w300h300/' });
  });
  it('on failure shows the reason and waits for Try again, then builds', async () => {
    const polls = [reply({ error: 'queue is full' }, 429), reply(job({ status: 'ready', percent: 100, bundle: '/b/' }))];
    const orig = globalThis.fetch; globalThis.fetch = vi.fn(async () => polls.shift());
    const r = root();
    const p = buildStep.run({ bbox: BBOX }, { root: r });
    await new Promise((res) => setTimeout(res, 10));
    expect(r.innerHTML).toContain('queue is full'); expect(r.innerHTML).toContain('Try again');
    r.q['[data-retry]'].onclick();
    expect((await p).area).toBe('e1n2w300h300');
    globalThis.fetch = orig;
  });
  it('does not put markup from an error into the page', async () => {
    const orig = globalThis.fetch; globalThis.fetch = vi.fn(async () => reply({ error: '<img src=x onerror=alert(1)>' }, 400));
    const r = root(); buildStep.run({ bbox: BBOX }, { root: r }).catch(() => {});
    await new Promise((res) => setTimeout(res, 10)); globalThis.fetch = orig;
    expect(r.innerHTML).not.toContain('<img'); expect(r.innerHTML).toContain('&lt;img');
  });
});
