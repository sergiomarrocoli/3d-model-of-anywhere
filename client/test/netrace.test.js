import { describe, expect, it, vi } from 'vitest';
import { CAR_SEND_HZ, attachRace, joinRoom, sendTrack, waitForTrack } from '../src/netrace.js';

// A fake connection: lets a test say what the server says, and records what we send.
function fakeRoom(state = {}) {
  const listeners = new Set(), sent = [];
  const room = {
    state: { id: '2', colour: '#2f7de1', host: null, track: null, peers: new Map(), ...state },
    conn: { send: (m) => (sent.push(m), true), close: vi.fn() },
    on: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
  };
  return { room, sent, say: (m) => listeners.forEach((f) => f(m)) };
}
const fakeRacer = () => {
  const calls = [], field = [];
  const racer = {
    field, isHost: true, canSend: true, snapshot: () => ({ x: 1.234, z: -5.678, h: 0.12345, vx: 3, vz: 4, s: 0.01 }),
    setColour: (c) => calls.push(['colour', c]), setHost(v) { racer.isHost = v; calls.push(['host', v]); },
    addRemote: (id, o) => { calls.push(['add', id, o.name]); if (!field.some((f) => f.id === id)) field.push({ id }); }, removeRemote: (id) => calls.push(['remove', id]),
    setRemote: (id, s) => calls.push(['set', id, s.x]), applyEvent: (k, d) => calls.push(['event', k, d]), hostRestart: () => calls.push(['restart']),
  };
  return { racer, calls };
};

describe('joinRoom', () => {
  it('resolves when the server says hello, and null when there is no server', async () => {
    const ok = await joinRoom({ room: 'r', name: 'n', connect: ({ onChange }) => { const c = { state: { status: 'connecting' }, close() {} }; setTimeout(() => { c.state.status = 'online'; onChange('status'); }, 0); return c; } });
    expect(ok.state.status).toBe('online');
    const none = await joinRoom({ room: 'r', name: 'n', connect: ({ onChange }) => { const c = { state: { status: 'connecting' }, close: vi.fn() }; setTimeout(() => { c.state.status = 'offline'; onChange('status'); }, 0); return c; } });
    expect(none).toBeNull();
    const slow = await joinRoom({ room: 'r', name: 'n', timeoutMs: 20, connect: () => ({ state: { status: 'connecting' }, close() {} }) });
    expect(slow).toBeNull();
  });
});

describe('tracks', () => {
  it('a guest gets the track straight away if the room has one, or when it arrives', async () => {
    const have = fakeRoom({ track: { points: [[0, 0]], lengthM: 1, width: 8 } });
    expect((await waitForTrack(have.room)).lengthM).toBe(1);
    const later = fakeRoom(); const p = waitForTrack(later.room);
    later.room.state.track = { points: [[1, 1]], lengthM: 7, width: 8 }; later.say({ t: 'track' });
    expect((await p).lengthM).toBe(7);
  });
  it('the host sends the track and counts itself as the host', () => {
    const { room, sent } = fakeRoom();
    sendTrack(room, { points: [[0, 0], [1, 1], [2, 0]], lengthM: 9, width: 8, area: 'x', mode: 'grandprix' });
    expect(sent[0]).toEqual({ t: 'track', points: [[0, 0], [1, 1], [2, 0]], lengthM: 9, width: 8, mode: 'grandprix' }); expect(room.state.host).toBe('2');
  });
});

describe('attachRace', () => {
  it('the first player is the host: adds who is here, announces itself and starts a round', () => {
    const { room, sent } = fakeRoom({ host: '2', peers: new Map([['5', { id: '5', name: 'Ann', colour: '#f00' }]]) });
    const { racer, calls } = fakeRacer(); attachRace(room, racer);
    expect(calls).toEqual([['colour', '#2f7de1'], ['host', true], ['add', '5', 'Ann'], ['restart']]);
    expect(sent).toEqual([{ t: 'ready' }]);
  });
  it('a guest waits: it is not the host and starts nothing', () => {
    const { room } = fakeRoom({ host: '1' }); const { racer, calls } = fakeRacer(); attachRace(room, racer);
    expect(calls).toEqual([['colour', '#2f7de1'], ['host', false]]);
  });
  it('forwards the racer\'s events to the room, and the room\'s to the racer', () => {
    const { room, sent, say } = fakeRoom({ host: '2' }); const { racer, calls } = fakeRacer(); attachRace(room, racer); calls.length = 0; sent.length = 0;
    racer.onEvent({ k: 'out', d: { id: '5' } }); expect(sent).toEqual([{ t: 'ctl', k: 'out', d: { id: '5' } }]);
    say({ t: 'ctl', k: 'round', d: { winner: '2' } }); expect(calls).toEqual([['event', 'round', { winner: '2' }]]);
  });
  it('the host starts a round when somebody is ready or leaves; a guest does not', () => {
    const host = fakeRoom({ host: '2', peers: new Map([['5', { id: '5', name: 'Ann' }]]) }), h = fakeRacer(); attachRace(host.room, h.racer); h.calls.length = 0;
    host.say({ t: 'ready', id: '5' }); host.say({ t: 'bye', id: '5' });
    expect(h.calls).toEqual([['add', '5', 'Ann'], ['restart'], ['remove', '5'], ['restart']]);
    const guest = fakeRoom({ host: '1' }), g = fakeRacer(); attachRace(guest.room, g.racer); g.calls.length = 0;
    guest.say({ t: 'ready', id: '5' }); guest.say({ t: 'bye', id: '5' });
    expect(g.calls.map((c) => c[0])).toEqual(['add', 'remove']);
  });
  it('takes over as host when the host leaves, and starts a round', () => {
    const { room, say } = fakeRoom({ host: '1' }); const { racer, calls } = fakeRacer(); attachRace(room, racer); calls.length = 0;
    room.state.host = '2'; say({ t: 'host', id: '2' });
    expect(calls).toEqual([['host', true], ['restart']]);
    calls.length = 0; room.state.host = '2'; say({ t: 'host', id: '2' }); expect(calls).toEqual([['host', true]]);   // told again: nothing more to do
  });
  it('shows other cars, adding one it has not heard of', () => {
    const { room, say } = fakeRoom({ host: '1' }); const { racer, calls } = fakeRacer(); attachRace(room, racer);
    room.state.peers.set('9', { id: '9', name: 'Bob' }); calls.length = 0; say({ t: 'car', id: '9', x: 4 }); expect(calls).toEqual([['add', '9', 'Bob'], ['set', '9', 4]]);
  });
  it('sends our car at the right rate, rounded, only while racing', () => {
    const { room, sent } = fakeRoom({ host: '1' }); const { racer } = fakeRacer(); const net = attachRace(room, racer); sent.length = 0;
    net.tick(1 / CAR_SEND_HZ / 2); expect(sent).toEqual([]);
    net.tick(1 / CAR_SEND_HZ / 2); expect(sent).toEqual([{ t: 'car', x: 1.23, z: -5.68, h: 0.123, vx: 3, vz: 4, s: 0.01 }]);
    racer.canSend = false; net.tick(1); expect(sent.length).toBe(1);
    net.dispose(); expect(room.conn.close).toHaveBeenCalled();
  });
});
