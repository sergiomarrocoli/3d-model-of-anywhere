import { describe, expect, it } from 'vitest';
import { DEFAULT_FLOW, FlowError, PICK_FLOW, parseFlow, runFlow, urlAfterBuild } from '../src/flow.js';

const known = ['pick', 'build', 'track', 'play'];
const q = (s) => new URLSearchParams(s);

describe('parseFlow', () => {
  it('defaults to just playing, ?pick gives pick,build,play, ?flow= is explicit', () => {
    expect(parseFlow(q(''), known)).toEqual(DEFAULT_FLOW); expect(DEFAULT_FLOW).toEqual(['play']);
    expect(parseFlow(q('?pick'), known)).toEqual(PICK_FLOW); expect(PICK_FLOW).toEqual(['pick', 'build', 'play']);
    expect(parseFlow(q('?flow=pick,track,build,play'), known)).toEqual(['pick', 'track', 'build', 'play']);
    expect(parseFlow(q('?flow= pick , play '), known)).toEqual(['pick', 'play']);
  });
  it('an explicit flow wins over ?pick', () => { expect(parseFlow(q('?pick&flow=play'), known)).toEqual(['play']); });
  it('refuses unknown steps by name and lists what exists', () => {
    expect(() => parseFlow(q('?flow=pick,warp,play'), known)).toThrow(/unknown step "warp" \(available: pick, build, track, play\)/);
  });
});

describe('runFlow', () => {
  const step = (name, fn) => ({ name, run: async (ctx, host) => fn(ctx, host) });
  it('runs steps in order, handing each the context the previous one returned', async () => {
    const seen = [];
    const reg = {
      pick: step('pick', (ctx) => { seen.push('pick'); return { ...ctx, bbox: [1, 2, 3, 4] }; }),
      build: step('build', (ctx) => { seen.push(`build:${ctx.bbox}`); return { ...ctx, area: 'a1', bundleUrl: '/b/' }; }),
      play: step('play', (ctx) => { seen.push(`play:${ctx.area}`); return ctx; }),
    };
    const out = await runFlow(['pick', 'build', 'play'], reg, {});
    expect(seen).toEqual(['pick', 'build:1,2,3,4', 'play:a1']);
    expect(out).toEqual({ bbox: [1, 2, 3, 4], area: 'a1', bundleUrl: '/b/' });
  });
  it('another module can be slotted between two without either knowing: it reads and adds to the context', async () => {
    const reg = {
      pick: step('pick', (ctx) => ({ ...ctx, bbox: [0, 0, 500, 500] })),
      track: step('track', (ctx) => ({ ...ctx, overlay: { type: 'track', polyline: [[1, 1], [2, 2]], over: ctx.bbox } })),   // a track drawer
      build: step('build', (ctx) => ({ ...ctx, area: 'a1' })),
      play: step('play', (ctx) => ctx),
    };
    const without = await runFlow(['pick', 'build', 'play'], reg);
    const withTrack = await runFlow(['pick', 'track', 'build', 'play'], reg);
    expect(without.overlay).toBeUndefined();
    expect(withTrack.overlay.over).toEqual([0, 0, 500, 500]);   // saw the picker output
    expect(withTrack.area).toBe('a1');                           // and the builder still ran after it
  });
  it('gives each step its own host', async () => {
    const hosts = [];
    const reg = { a: step('a', (c, h) => { hosts.push(h.name); return c; }), b: step('b', (c, h) => { hosts.push(h.name); return c; }) };
    await runFlow(['a', 'b'], reg, {}, (name) => ({ name }));
    expect(hosts).toEqual(['a', 'b']);
  });
  it('stops with the step error, and later steps do not run', async () => {
    let ranAfter = false;
    const reg = { a: step('a', () => { throw new Error('boom'); }), b: step('b', (c) => { ranAfter = true; return c; }) };
    await expect(runFlow(['a', 'b'], reg)).rejects.toThrow('boom'); expect(ranAfter).toBe(false);
  });
  it('rejects a step that does not return a context', async () => {
    for (const bad of [undefined, null, 'x', [1]]) await expect(runFlow(['a'], { a: step('a', () => bad) })).rejects.toThrow(/must return the context object/);
  });
  it('rejects a step that is not registered', async () => {
    await expect(runFlow(['nope'], {})).rejects.toBeInstanceOf(FlowError);
  });
});

describe('urlAfterBuild', () => {
  it('points at the built area and drops the flow, keeping every other param', () => {
    const u = new URL(urlAfterBuild('http://x/?pick&fly&room=friends&name=Ann', 'e1n2w300h300'));
    expect(u.searchParams.get('area')).toBe('e1n2w300h300');
    expect(u.searchParams.has('pick')).toBe(false); expect(u.searchParams.has('flow')).toBe(false);
    expect(u.searchParams.has('fly')).toBe(true); expect(u.searchParams.get('room')).toBe('friends'); expect(u.searchParams.get('name')).toBe('Ann');
  });
  it('replaces an existing area and handles ?flow=', () => {
    const u = new URL(urlAfterBuild('http://x/?area=old&flow=pick,build,play', 'new'));
    expect(u.search).toBe('?area=new');
  });
});
