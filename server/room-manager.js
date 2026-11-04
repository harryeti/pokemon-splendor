/* =====================================================================
 * Node room manager — the Node twin of worker/index.js's Durable Object.
 * Originally from honey634546-dev/pokemon-splendor (ECS server); adapted here.
 * ---------------------------------------------------------------------
 * One RoomAuthority (js/room.js, the pure unit-tested rules) per room code, plus
 * what the transport must add:
 *   - snapshots on disk (a room survives a server restart; clients reconnect
 *     with their token),
 *   - the pacing of bot turns (one setTimeout per bot turn, like one DO alarm),
 *   - eviction of a room from memory once its last socket is gone.
 * ===================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Room: RoomAuthority } = require('../js/room.js');
const AI = require('../js/ai.js');
const DB = require('../data/cards.json');
const MEGA_DB = require('../data/megas.json');
const POKEMART_DB = require('../data/pokemart.json');

// Same pacing as worker/index.js: brisk, yet slow enough to follow each bot move.
const AI_TURN_DELAY_MS = 1200;
// Same list as worker/index.js MUTATING: every message that changes room state is persisted.
const MUTATING = new Set(['join', 'start', 'action', 'name', 'rematch', 'takeover',
  'addAI', 'removeAI', 'aiLevel', 'shuffle']);

class SnapshotStore {
  constructor(dir) {
    this.dir = path.resolve(dir || path.join(process.cwd(), '.runtime', 'rooms'));
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
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

  // write-then-rename, so a crash mid-write never leaves a truncated snapshot
  save(code, snapshot) {
    const file = this.fileFor(code);
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  }
}

class RoomManager {
  constructor({ dataDir, send, maxSeats = 4, ai = AI, aiDelayMs = AI_TURN_DELAY_MS } = {}) {
    this.store = new SnapshotStore(dataDir);
    this.send = send || (() => {});
    this.maxSeats = maxSeats;
    this.ai = ai;
    this.aiDelayMs = aiDelayMs;
    this.rooms = new Map();
    this.closed = false;          // set by shutdown(): no new bot turns after this
  }

  // Server shutdown: stop all bot timers (and never arm new ones while sockets close), save.
  shutdown() {
    this.closed = true;
    for (const entry of this.rooms.values()) this._clearAI(entry);
    this.persistAll();
  }

  get(code) {
    let entry = this.rooms.get(code);
    if (entry) return entry;

    entry = {
      code,
      connections: new Map(),     // connId -> WebSocket
      authority: null,
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
      send: (connId, msg) => this.send(entry, connId, msg),
    });

    const snapshot = this.store.load(code);
    if (snapshot) entry.authority.restore(snapshot);
    this.rooms.set(code, entry);
    return entry;
  }

  persist(entry) {
    try {
      this.store.save(entry.code, entry.authority.snapshot());
    } catch (err) {
      console.error(`[rooms] failed to persist ${entry.code}: ${err.stack || err.message}`);
    }
  }

  persistAll() {
    for (const entry of this.rooms.values()) this.persist(entry);
  }

  connect(entry, connId, ws) {
    entry.connections.set(connId, ws);
  }

  handle(entry, connId, msg) {
    entry.authority.now = Date.now();   // server clock for idle-timeout / takeover
    entry.authority.onMessage(connId, msg);
    if (MUTATING.has(msg.t)) this.persist(entry);
    // Every message re-checks the bot driver, so a client's `sync` (or a join after a
    // restart) revives a bot turn that was paused or lost.
    this.armAI(entry);
  }

  disconnect(entry, connId) {
    entry.authority.now = Date.now();
    entry.authority.leave(connId);      // seat keeps its token → reclaimable
    entry.connections.delete(connId);
    this.persist(entry);
    if (entry.connections.size === 0) this.evict(entry);
    else this.armAI(entry);             // the last human leaving pauses the bots
  }

  // Drop an idle room from memory; its snapshot on disk is the source of truth.
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
    try { a.stepAI(attempt); } catch (err) { console.error(`[rooms] bot turn ${entry.code}:`, err); }
    this.persist(entry);
    this.armAI(entry);                  // next bot in a row, if any
  }
}

module.exports = { RoomManager, SnapshotStore, AI_TURN_DELAY_MS, MUTATING };
