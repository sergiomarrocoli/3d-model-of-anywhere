// Presence: tell the server where we are and learn where everyone else in the room is. No authority, friends only.

export const SEND_INTERVAL_MS = 100;       // 10 Hz position updates
export const HEARTBEAT_MS = 1000;          // resend even when standing still so late joiners and drops recover
export const MAX_RETRIES = 3;

export function wsUrl(loc, room, name) {
  const q = new URLSearchParams({ room, name });
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/ws?${q}`;
}

/** Fold one server message into the peer map: Map(id -> { id, name, colour, x, z, h }). Returns what changed. */
export function applyMessage(peers, msg) {
  switch (msg.t) {
    case 'hello': peers.clear(); for (const p of msg.peers) peers.set(p.id, { ...p }); return 'peers';
    case 'join': peers.set(msg.id, { id: msg.id, name: msg.name, colour: msg.colour, x: NaN, z: NaN, h: 0 }); return 'peers';
    case 'pos': { const p = peers.get(msg.id); if (p) { p.x = msg.x; p.z = msg.z; p.h = msg.h; } return 'pos'; }
    case 'bye': peers.delete(msg.id); return 'peers';
    default: return null;
  }
}

/** Ease a displayed value toward its target (frame-rate independent). */
export const smoothTo = (cur, target, dt, rate = 12) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

/** Shortest-way angle easing. */
export function smoothAngle(cur, target, dt, rate = 12) {
  const diff = Math.atan2(Math.sin(target - cur), Math.cos(target - cur));
  return cur + diff * (1 - Math.exp(-rate * dt));
}

/**
 * Connect to the room. Quietly gives up (single player) if there is no server: a few retries, then silence.
 * `onChange(kind)` fires with 'status', 'peers' or 'pos'.
 */
export function connectPresence({ room, name, location: loc = globalThis.location, WebSocketImpl = globalThis.WebSocket, onChange = () => {} }) {
  const peers = new Map();
  const state = { status: 'connecting', id: null, colour: null, room, peers };
  let ws = null, closed = false, retries = 0, lastSent = -Infinity, lastKey = '';

  const set = (status) => { state.status = status; onChange('status'); };
  const open = () => {
    ws = new WebSocketImpl(wsUrl(loc, room, name));
    ws.onopen = () => { retries = 0; };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'hello') { state.id = msg.id; state.colour = msg.colour; set('online'); }
      if (msg.t === 'full') { closed = true; set('full'); return; }
      const kind = applyMessage(peers, msg);
      if (kind) onChange(kind);
    };
    ws.onclose = () => {
      peers.clear(); onChange('peers');
      if (closed) return;
      if (retries++ >= MAX_RETRIES && state.status !== 'online') { closed = true; set('offline'); return; }
      set(state.status === 'online' ? 'reconnecting' : 'connecting');
      setTimeout(open, 1500 * retries);
    };
    ws.onerror = () => {};
  };
  open();

  return {
    state,
    /** Call every frame with the player's position; sends at most every SEND_INTERVAL_MS, and on a heartbeat. */
    update(now, x, z, h) {
      if (!ws || ws.readyState !== 1) return;
      const key = `${x.toFixed(2)},${z.toFixed(2)},${h.toFixed(2)}`;
      const due = now - lastSent >= (key === lastKey ? HEARTBEAT_MS : SEND_INTERVAL_MS);
      if (!due) return;
      lastSent = now; lastKey = key;
      ws.send(JSON.stringify({ t: 'pos', x: +x.toFixed(2), z: +z.toFixed(2), h: +h.toFixed(3) }));
    },
    close() { closed = true; ws?.close(); },
  };
}
