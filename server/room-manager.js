/* =====================================================================
 * Node room manager — the Node twin of worker/index.js's Durable Object.
 * Originally from honey634546-dev/pokemon-splendor (ECS server); adapted here.
 * Scope: a trusted LAN, one process.
 * ---------------------------------------------------------------------
 * One RoomAuthority (js/room.js, the pure unit-tested rules) per room code, plus
 * what the transport must add:
 *   - snapshots on disk (a room survives a server restart; clients reconnect
 *     with their token),
 *   - the pacing of bot turns (one setTimeout per bot turn, like one DO alarm),
 *   - eviction of a room from memory once its last socket is gone.
 *
 * Persist before send: everything js/room.js sends while handling a mutating
 * message (or a bot turn) is held back until the snapshot is on disk. If the
 * write fails, nothing is sent; the room is dropped from memory and every socket
 * is closed, so clients reconnect (js/net.js does this automatically) to the last
 * snapshot that was saved. Memory and disk never diverge, and no client ever sees
 * a position that a restart would take back.
 * ===================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Room: RoomAuthority } = require('../js/room.js');
const AI = require('../js/ai.js');
const DB = require('../data/cards.json');
const MEGA_DB = require('../data/megas.json');
const POKEMART_DB = require('../data/pokemart.json');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DATA_DIR = path.join(ROOT, '.runtime', 'rooms');
// Same pacing as worker/index.js: brisk, yet slow enough to follow each bot move.
const AI_TURN_DELAY_MS = 1200;
// Same list as worker/index.js MUTATING: every message that changes room state is persisted.
const MUTATING = new Set(['join', 'start', 'action', 'name', 'rematch', 'takeover',
  'addAI', 'removeAI', 'aiLevel', 'shuffle']);
const PERSIST_FAILED = '服务器保存失败，本步未生效，正在重新连接…';
const PROCESS_FAILED = '服务器处理失败，本步未生效，正在重新连接…';

const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

// Snapshots hold the full game (deck order, every reserve) and every player's token,
// so they must never sit where the static server could hand them out. Inside the
// project only .runtime/ is allowed; anywhere outside the project is fine.
function assertPrivateDataDir(dir, root = ROOT) {
  const check = (d, r) => {
    if (inside(d, r) && !inside(d, path.join(r, '.runtime'))) {
      throw new Error(`ROOM_DATA_DIR must be outside the project or under .runtime/ (got ${dir}); `
        + 'room snapshots contain hidden cards and player tokens');
    }
  };
  check(path.resolve(dir), path.resolve(root));
  // again after symlinks are resolved (only possible once the directory exists)
  if (fs.existsSync(dir)) check(fs.realpathSync(dir), fs.realpathSync(root));
}

class SnapshotStore {
  constructor(dir) {
    this.dir = path.resolve(dir || DEFAULT_DATA_DIR);
    assertPrivateDataDir(this.dir);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    assertPrivateDataDir(this.dir);
  }

  // Room codes are validated by the caller ([A-Z0-9_-]{1,32}), so this cannot escape dir.
  fileFor(code) {
    return path.join(this.dir, `${code}.json`);
  }

  load(code) {
    const file = this.fileFor(code);
    if (!fs.existsSync(file)) return null;
    try {
      const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
      return snap && typeof snap === 'object' ? snap : null;
    } catch (err) {
      console.error(`[rooms] ignoring unreadable snapshot ${file}: ${err.message}`);
      return null;
    }
  }

  // write-then-rename, so a failed write never replaces the last good snapshot
  save(code, snapshot) {
    const file = this.fileFor(code);
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, file);
    } catch (err) {
      try { fs.unlinkSync(temp); } catch (e) { /* never created */ }
      throw err;
    }
  }
}

class RoomManager {
  // send(entry, connId, msg) delivers to a socket; close(entry, reason) closes every socket of a room.
  constructor({ dataDir, send, close, maxSeats = 4, ai = AI, aiDelayMs = AI_TURN_DELAY_MS } = {}) {
    this.store = new SnapshotStore(dataDir);
    this.send = send || (() => {});
    this.close = close || (() => {});
    this.maxSeats = maxSeats;
    this.ai = ai;
    this.aiDelayMs = aiDelayMs;
    this.rooms = new Map();
    this.closed = false;          // set by shutdown(): no new bot turns after this
  }

  get(code) {
    let entry = this.rooms.get(code);
    if (entry) return entry;

    entry = {
      code,
      connections: new Map(),     // connId -> WebSocket
      authority: null,
      outbox: null,               // messages held back until the snapshot is saved
      aiTimer: null,              // at most one pending bot turn per room
      aiAttempt: { seq: -1, n: 0 },
      evicted: false,
    };
    entry.authority = new RoomAuthority({
      cardDB: DB,
      megaDB: MEGA_DB,
      pokemartDB: POKEMART_DB,
      ai: this.ai,
      maxSeats: this.maxSeats,
      send: (connId, msg) => {
        if (entry.outbox) entry.outbox.push([connId, msg]);
        else this.send(entry, connId, msg);
      },
    });

    const snapshot = this.store.load(code);
    if (snapshot) entry.authority.restore(snapshot);
    this.rooms.set(code, entry);
    return entry;
  }

  // true when the snapshot is on disk
  persist(entry) {
    try {
      this.store.save(entry.code, entry.authority.snapshot());
      return true;
    } catch (err) {
      console.error(`[rooms] failed to persist ${entry.code}: ${err.stack || err.message}`);
      return false;
    }
  }

  // Server shutdown: stop all bot timers (and never arm new ones while sockets close), save.
  shutdown() {
    this.closed = true;
    for (const entry of this.rooms.values()) {
      this._clearAI(entry);
      this.persist(entry);
    }
  }

  connect(entry, connId, ws) {
    entry.connections.set(connId, ws);
  }

  handle(entry, connId, msg) {
    if (entry.evicted) return;          // room failed or emptied; this socket is being closed
    const a = entry.authority;
    a.now = Date.now();                 // server clock for idle-timeout / takeover
    if (!MUTATING.has(msg.t)) {
      a.onMessage(connId, msg);         // read-only (sync): reply straight away
    } else if (!this._commit(entry, () => a.onMessage(connId, msg), connId)) {
      return;
    }
    // Every message re-checks the bot driver, so a client's `sync` (or a join after a
    // restart) revives a bot turn that was paused or lost.
    this.armAI(entry);
  }

  // Run fn with outgoing messages held back; save; then deliver — or fail the room.
  _commit(entry, fn, connId) {
    entry.outbox = [];
    let out, threw = null;
    try { fn(); } catch (err) { threw = err; } finally { out = entry.outbox; entry.outbox = null; }
    if (threw) {
      // half-applied in memory, so it is just as diverged from disk as a failed save
      console.error(`[rooms] message ${entry.code}:`, threw);
      this._fail(entry, connId, PROCESS_FAILED);
      return false;
    }
    if (!this.persist(entry)) {
      this._fail(entry, connId, PERSIST_FAILED);
      return false;
    }
    for (const [cid, m] of out) this.send(entry, cid, m);
    return true;
  }

  // The in-memory room is ahead of its last snapshot (or half-applied): discard it. The sender is told
  // why; every socket is closed and reconnects to the snapshot on disk.
  _fail(entry, connId, reason) {
    if (connId != null) this.send(entry, connId, { t: 'reject', reason });
    this.evict(entry);
    this.close(entry, 'room reloaded from snapshot');
  }

  disconnect(entry, connId) {
    entry.connections.delete(connId);
    if (entry.evicted) return;          // stale entry: never touch the snapshot from here
    entry.authority.now = Date.now();
    // leave() only marks the seat offline (and snapshots always store seats offline),
    // so there is nothing new to persist; the roster update can go out directly.
    entry.authority.leave(connId);
    if (entry.connections.size === 0) this.evict(entry);
    else this.armAI(entry);             // the last human leaving pauses the bots
  }

  // Drop a room from memory; its snapshot on disk is the source of truth.
  evict(entry) {
    this._clearAI(entry);
    entry.evicted = true;
    if (this.rooms.get(entry.code) === entry) this.rooms.delete(entry.code);
  }

  // ------------------------------ bot turns ------------------------------
  // Mirrors worker/index.js _armAI/alarm: bots only move while some human is
  // connected; each timer plays exactly one bot turn, persists, then chains.
  armAI(entry) {
    const a = entry.authority;
    if (this.closed || entry.evicted || !a.aiPending() || !a.humansConnected()) {
      this._clearAI(entry);
      return;
    }
    if (entry.aiTimer) return;
    entry.aiTimer = setTimeout(() => this._runAI(entry), this.aiDelayMs);
  }

  _clearAI(entry) {
    if (entry.aiTimer) clearTimeout(entry.aiTimer);
    entry.aiTimer = null;
  }

  _runAI(entry) {
    entry.aiTimer = null;
    const a = entry.authority;
    if (this.closed || entry.evicted || !a.aiPending() || !a.humansConnected()) return;
    // Count attempts per bot TURN (seq): if a think throws, the retry thinks more
    // cheaply (see aiThinkOpts in js/room.js), so one bad turn can never wedge a room.
    const rec = entry.aiAttempt;
    const attempt = rec.seq === a.seq ? rec.n + 1 : 0;
    entry.aiAttempt = { seq: a.seq, n: attempt };
    a.now = Date.now();
    const ok = this._commit(entry, () => {
      try { a.stepAI(attempt); } catch (err) { console.error(`[rooms] bot turn ${entry.code}:`, err); }
    }, null);
    if (ok) this.armAI(entry);          // next bot in a row, if any
  }
}

module.exports = { RoomManager, SnapshotStore, assertPrivateDataDir, AI_TURN_DELAY_MS, MUTATING, PERSIST_FAILED, PROCESS_FAILED };
