// Online racing glue: joins the room, and wires a racer (modules/racer, in `online` mode) to it. The racer knows nothing about the network
// and presence knows nothing about racing; this is the only place that knows both.
//   joinRoom({ room, name })       connect and wait for the server; null if there is none (then the race is single player)
//   waitForTrack(room)             a guest: resolves with the host's track when it arrives
//   sendTrack(room, overlay)       the host: share the drawn track (this also makes you the host)
//   attachRace(room, racer, ...)   forward cars and the host's decisions both ways; returns { tick(dt), dispose() }
import { connectPresence } from '@presence';

export const CAR_SEND_HZ = 20;
const r2 = (v) => +v.toFixed(2);

/** Connect to the server and say who we are. Resolves { conn, state } once the server has said hello, or null if it did not within `timeoutMs`. */
export function joinRoom({ room, name, timeoutMs = 3000, connect = connectPresence }) {
  return new Promise((resolve) => {
    const listeners = new Set();
    let conn = null, done = false;
    const finish = (ok) => { if (done) return; done = true; clearTimeout(timer); if (!ok) conn?.close(); resolve(ok ? { conn, state: conn.state, on: (fn) => (listeners.add(fn), () => listeners.delete(fn)) } : null); };
    const timer = setTimeout(() => finish(conn?.state.status === 'online'), timeoutMs);
    conn = connect({ room, name, onChange: (k) => { if (k === 'status') { if (conn.state.status === 'online') finish(true); else if (conn.state.status === 'offline' || conn.state.status === 'full') finish(false); } }, onMessage: (m) => listeners.forEach((f) => f(m)) });
  });
}

/** A guest: the track the host drew, as soon as the room has one. */
export function waitForTrack(room, signal) {
  return new Promise((resolve, reject) => {
    if (room.state.track) return resolve(room.state.track);
    const off = room.on((m) => { if (m.t === 'track') { off(); resolve(room.state.track); } });
    signal?.addEventListener('abort', () => { off(); reject(new Error('cancelled')); });
  });
}

/** The host: tell the room the track. */
export function sendTrack(room, overlay) {
  room.state.host = room.state.id;                      // the server confirms in a moment; we do not wait for it
  return room.conn.send({ t: 'track', points: overlay.points, lengthM: overlay.lengthM, width: overlay.width, mode: overlay.mode, damage: overlay.damage === true });
}

/**
 * Wire a racer to a room. Cars go out at CAR_SEND_HZ while we are racing; other players' cars, the host's decisions (who is out, who won, the next
 * round), joins, leaves and host changes come in. The host starts a round whenever someone becomes ready or leaves, so everyone is on the grid.
 */
export function attachRace(room, racer) {
  const { conn, state } = room;
  const peer = (id) => state.peers.get(id) ?? {};
  const isHost = () => state.host === state.id;
  const sync = () => racer.setHost(isHost());
  let sendT = 0;

  racer.setColour(state.colour ?? '#e03030');
  sync();
  racer.onEvent = ({ k, d }) => conn.send({ t: 'ctl', k, d });
  racer.onBoom = () => conn.send({ t: 'boom' });
  racer.onBuildingHit = ({ id, amount }) => conn.send({ t: 'bld', b: id, a: +amount.toFixed(1) });
  for (const p of state.peers.values()) racer.addRemote(p.id, { name: p.name, colour: p.colour });       // everyone already here (they may still be loading: the host sorts that out)

  const off = room.on((m) => {
    if (m.t === 'ready') { racer.addRemote(m.id, { name: peer(m.id).name, colour: peer(m.id).colour }); if (isHost()) racer.hostRestart(); }
    else if (m.t === 'car') { if (!racer.field.some((f) => f.id === m.id)) racer.addRemote(m.id, { name: peer(m.id).name, colour: peer(m.id).colour }); racer.setRemote(m.id, m); }
    else if (m.t === 'ctl') racer.applyEvent(m.k, m.d ?? {});
    else if (m.t === 'boom') racer.applyBoom(m.id);
    else if (m.t === 'bld') racer.applyBuildingHit(m.b, m.a);
    else if (m.t === 'bye') { racer.removeRemote(m.id); if (isHost()) racer.hostRestart(); }
    else if (m.t === 'host') { const was = racer.isHost; sync(); if (isHost() && !was) racer.hostRestart(); }      // the host left and it is our turn
  });
  conn.send({ t: 'ready' });
  if (isHost()) racer.hostRestart();                                                                      // the first player: start straight away

  return {
    tick(dt) {
      sendT += dt;
      if (sendT < 1 / CAR_SEND_HZ || !racer.canSend) return;
      sendT = 0;
      const s = racer.snapshot();
      conn.send({ t: 'car', x: r2(s.x), z: r2(s.z), h: +s.h.toFixed(3), vx: r2(s.vx), vz: r2(s.vz), s: +s.s.toFixed(3), d: +s.d.toFixed(2) });
    },
    dispose() { off(); conn.close(); },
  };
}
