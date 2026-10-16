import { describe, expect, it, vi } from 'vitest';
import { applyMessage, connectPresence, smoothAngle, smoothTo, wsUrl, MAX_RETRIES, SEND_INTERVAL_MS, HEARTBEAT_MS } from '../src/multiplayer.js';

describe('wsUrl', () => {
  it('uses ws/wss to match the page and encodes room and name', () => {
    expect(wsUrl({ protocol: 'http:', host: 'localhost:5173' }, 'bath 1', 'A&B')).toBe('ws://localhost:5173/ws?room=bath+1&name=A%26B');
    expect(wsUrl({ protocol: 'https:', host: 'x.trycloudflare.com' }, 'r', 'n')).toBe('wss://x.trycloudflare.com/ws?room=r&name=n');
  });
});

describe('applyMessage', () => {
  it('tracks hello, join, pos and bye', () => {
    const peers = new Map();
    applyMessage(peers, { t: 'hello', id: '1', peers: [{ id: '2', name: 'Ann', colour: '#f00', x: 1, z: 2, h: 0 }] });
    expect([...peers.keys()]).toEqual(['2']);
    applyMessage(peers, { t: 'join', id: '3', name: 'Bob', colour: '#0f0' });
    expect(Number.isNaN(peers.get('3').x)).toBe(true);        // no position yet: not drawn
    expect(applyMessage(peers, { t: 'pos', id: '3', x: 5, z: 6, h: 1 })).toBe('pos');
    expect(peers.get('3')).toMatchObject({ x: 5, z: 6, h: 1, name: 'Bob' });
    applyMessage(peers, { t: 'bye', id: '2' });
    expect([...peers.keys()]).toEqual(['3']);
    expect(applyMessage(peers, { t: 'pos', id: 'ghost', x: 1, z: 1, h: 0 })).toBe('pos'); expect(peers.has('ghost')).toBe(false);
    expect(applyMessage(peers, { t: '???' })).toBeNull();
  });
});

describe('smoothing', () => {
  it('eases toward the target without overshooting, and takes the short way round for angles', () => {
    expect(smoothTo(0, 10, 0.016)).toBeGreaterThan(0); expect(smoothTo(0, 10, 0.016)).toBeLessThan(10);
    expect(smoothTo(0, 10, 100)).toBeCloseTo(10, 6);
    const a = smoothAngle(3.0, -3.0, 0.05);                   // 3.0 -> -3.0 is a short hop across pi, not a long way round
    expect(a).toBeGreaterThan(3.0);
  });
});

class FakeWS {
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWS.instances.push(this); }
  send(m) { this.sent.push(JSON.parse(m)); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  say(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}
const loc = { protocol: 'http:', host: 'h' };

describe('connectPresence', () => {
  it('goes online on hello, throttles position sends, and heartbeats when still', () => {
    FakeWS.instances = [];
    const events = [];
    const p = connectPresence({ room: 'r', name: 'n', location: loc, WebSocketImpl: FakeWS, onChange: (k) => events.push(k) });
    const ws = FakeWS.instances[0]; ws.open();
    p.update(0, 1, 2, 0); expect(ws.sent).toHaveLength(1);
    p.update(SEND_INTERVAL_MS / 2, 1.5, 2, 0); expect(ws.sent).toHaveLength(1);             // too soon
    p.update(SEND_INTERVAL_MS + 1, 1.5, 2, 0); expect(ws.sent).toHaveLength(2);             // moved, due
    p.update(SEND_INTERVAL_MS * 3, 1.5, 2, 0); expect(ws.sent).toHaveLength(2);             // standing still: wait for heartbeat
    p.update(SEND_INTERVAL_MS + 1 + HEARTBEAT_MS, 1.5, 2, 0); expect(ws.sent).toHaveLength(3);
    ws.say({ t: 'hello', id: '7', colour: '#abc', peers: [] });
    expect(p.state).toMatchObject({ status: 'online', id: '7', colour: '#abc' });
    expect(events).toContain('status');
  });
  it('does not send before the socket is open', () => {
    FakeWS.instances = [];
    const p = connectPresence({ room: 'r', name: 'n', location: loc, WebSocketImpl: FakeWS });
    p.update(0, 1, 2, 0); expect(FakeWS.instances[0].sent).toHaveLength(0);
  });
  it('gives up quietly (single player) after a few failed connections, with no server', () => {
    vi.useFakeTimers(); FakeWS.instances = [];
    const p = connectPresence({ room: 'r', name: 'n', location: loc, WebSocketImpl: FakeWS });
    for (let i = 0; i < MAX_RETRIES + 2; i++) { FakeWS.instances.at(-1).close(); vi.runOnlyPendingTimers(); }
    expect(p.state.status).toBe('offline');
    const n = FakeWS.instances.length; vi.runOnlyPendingTimers(); expect(FakeWS.instances.length).toBe(n);   // stops retrying
    vi.useRealTimers();
  });
  it('reports a full room and does not retry', () => {
    vi.useFakeTimers(); FakeWS.instances = [];
    const p = connectPresence({ room: 'r', name: 'n', location: loc, WebSocketImpl: FakeWS });
    FakeWS.instances[0].open(); FakeWS.instances[0].say({ t: 'full' });
    expect(p.state.status).toBe('full'); FakeWS.instances[0].close(); vi.runOnlyPendingTimers();
    expect(FakeWS.instances).toHaveLength(1); vi.useRealTimers();
  });
});
