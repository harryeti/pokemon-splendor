/* Node LAN server (server/index.js + server/room-manager.js) over real sockets:
 *  - static files: the game is served, everything outside the allowlist is not;
 *  - rooms: join / start / redaction / snapshot survives a restart;
 *  - bot turns: the scheduler plays bots, pauses them when no human is connected,
 *    resumes on reconnect, and persists lobby edits (addAI) across a restart;
 *  - a full 2 humans + 1 bot game, with a restart in the middle, reaches game over;
 *  - an idle room is evicted from memory and reloads from disk.
 * Originally from honey634546-dev/pokemon-splendor; extended here.
 * run: node test/server.test.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { createServer, resolveStatic } = require('../server/index.js');
const E = require('../js/engine.js');
const AI = require('../js/ai.js');

const AI_DELAY = 10;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what, timeout = 10000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeout) throw new Error('timed out: ' + what);
    await wait(5);
  }
}

function client(url) {
  const queue = [];
  const waiters = [];
  const ws = new WebSocket(url);
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (err) { return; }
    const waiter = waiters.findIndex((w) => !w.predicate || w.predicate(msg));
    if (waiter >= 0) {
      const w = waiters.splice(waiter, 1)[0];
      clearTimeout(w.timer);
      w.resolve(msg);
    } else queue.push(msg);
  });
  return {
    ws,
    open: new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }),
    send(msg) { ws.send(JSON.stringify(msg)); },
    next(predicate, timeout = 3000) {
      const index = queue.findIndex((msg) => !predicate || predicate(msg));
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = waiters.findIndex((w) => w.timer === timer);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error('timed out waiting for WebSocket message'));
        }, timeout);
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
    close() {
      return new Promise((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once('close', resolve);
        ws.close();
      });
    },
  };
}

async function startApp(dataDir) {
  const app = createServer({ host: '127.0.0.1', port: 0, dataDir, aiDelayMs: AI_DELAY });
  app.start();
  await new Promise((resolve) => app.server.once('listening', resolve));
  app.port = app.server.address().port;
  app.url = (code) => `ws://127.0.0.1:${app.port}/room/${code}/ws`;
  return app;
}
const stopApp = (app) => new Promise((resolve) => app.stop(resolve));

async function join(app, code, name, token) {
  const c = client(app.url(code));
  await c.open;
  c.send({ t: 'join', name, token });
  c.seat = (await c.next((m) => m.t === 'welcome')).seat;
  return c;
}

function get(port, urlPath) {
  return new Promise((resolve) => {
    // raw path: http.get would normalise '..' away before it reaches the server
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
      let body = ''; res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    });
    req.on('error', (err) => resolve({ status: 0, body: err.message }));
    req.end();
  });
}

// The active HUMAN seat plays one whole turn over the protocol (plan from the AI on a clone).
function humanTurn(app, code, clients) {
  const G = app.roomManager.rooms.get(code).authority.G;
  const c = clients.find((x) => x.seat === G.turn);
  assert.ok(c, 'a human client owns the active seat ' + G.turn);
  const plan = AI.chooseTurn(E.clone(G), { difficulty: 'easy' });
  c.send({ t: 'action', action: plan.action || { type: 'pass' } });
  for (const color of plan.discards || []) c.send({ t: 'action', action: { type: 'discard', color } });
  if (plan.megaEvolution) c.send({ t: 'action', action: { type: 'megaEvolve', ...plan.megaEvolution } });
  else if (plan.evolution) c.send({ t: 'action', action: { type: 'evolve', ...plan.evolution } });
  c.send({ t: 'action', action: { type: 'endTurn' } });
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('static allowlist: game files served, everything else 404', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-rooms-'));
  const app = await startApp(dataDir);
  try {
    const index = await get(app.port, '/');
    assert.strictEqual(index.status, 200);
    assert.ok(/text\/html/.test(index.type) && index.body.includes('<html'), 'index.html at /');
    assert.strictEqual((await get(app.port, '/?room=ABC12')).status, 200, 'invite link loads the page');
    assert.strictEqual((await get(app.port, '/js/room.js')).status, 200);
    assert.strictEqual((await get(app.port, '/css/style.css')).status, 200);
    assert.strictEqual((await get(app.port, '/sw.js')).status, 200);
    assert.strictEqual((await get(app.port, '/data/cards.json')).status, 200);
    for (const bad of ['/server/index.js', '/package.json', '/test/server.test.js', '/train/engine.py',
      '/.git/config', '/js/../server/index.js', '/js/%2e%2e/server/index.js', '/%2e%2e/package.json',
      '/js/..%2fserver%2findex.js', '/.runtime/rooms/X.json', '/node_modules/ws/package.json',
      '/wrangler.jsonc', '/README.md', '/js/nope.js', '/js/', '/assets/%00.png']) {
      assert.strictEqual((await get(app.port, bad)).status, 404, bad + ' must not be served');
    }
    assert.strictEqual(resolveStatic('/js/..\\server\\index.js'), null, 'backslash paths rejected');
    const health = JSON.parse((await get(app.port, '/healthz')).body);
    assert.strictEqual(health.ok, true);
  } finally {
    await stopApp(app);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('two humans: redacted state per seat, snapshot survives restart', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-rooms-'));
  const app = await startApp(dataDir);
  const a = await join(app, 'TEST1', 'Alice', 'tA'), b = await join(app, 'TEST1', 'Bob', 'tB');
  assert.strictEqual(a.seat, 0);
  assert.strictEqual(b.seat, 1);
  a.send({ t: 'start', opts: {} });
  const stateA = await a.next((m) => m.t === 'state');
  const stateB = await b.next((m) => m.t === 'state');
  assert.strictEqual(stateA.state.viewerId, 0);
  assert.strictEqual(stateB.state.viewerId, 1);
  assert.ok(stateA.state.decks.stage1.every((id) => id === null), 'deck order is redacted');
  await Promise.all([a.close(), b.close()]);
  await stopApp(app);
  assert.ok(fs.existsSync(path.join(dataDir, 'TEST1.json')), 'room snapshot was written');

  const restored = await startApp(dataDir);
  const c = await join(restored, 'TEST1', 'Alice', 'tA');
  assert.strictEqual(c.seat, 0);
  assert.strictEqual((await c.next((m) => m.t === 'state')).state.viewerId, 0);
  await c.close();
  await stopApp(restored);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('lobby bot survives a restart; bots move, pause without humans, resume on reconnect', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-rooms-'));
  let app = await startApp(dataDir);
  let h = await join(app, 'BOT1', 'Host', 'tH');
  h.send({ t: 'addAI', level: 'easy' });
  await h.next((m) => m.t === 'roster' && m.players.length === 2);
  await h.close();
  await stopApp(app);

  app = await startApp(dataDir);
  h = await join(app, 'BOT1', 'Host', 'tH');
  const room = () => app.roomManager.rooms.get('BOT1');
  assert.strictEqual(room().authority.seats.length, 2, 'addAI was persisted');
  assert.strictEqual(room().authority.seats[1].ai, 'easy');
  h.send({ t: 'start', opts: {} });
  await h.next((m) => m.t === 'state');
  const a = room().authority;

  // whoever is first, play until the bot has moved at least once
  let botMoves = 0;
  const stepAI = a.stepAI.bind(a);
  a.stepAI = (n) => { const ok = stepAI(n); if (ok) botMoves++; return ok; };
  if (!a.aiPending()) humanTurn(app, 'BOT1', [h]);
  await until(() => botMoves >= 1 && !a.aiPending(), 'bot plays its turn');
  assert.strictEqual(room().authority.G.turn, h.seat, 'back to the human after the bot');

  // human moves, then leaves before the bot's timer fires → the bot must pause
  humanTurn(app, 'BOT1', [h]);
  await until(() => room().authority.aiPending(), 'bot to move');
  const pausedSeq = room().authority.seq;
  await h.close();
  await wait(AI_DELAY * 10);
  assert.strictEqual(app.roomManager.rooms.size, 0, 'idle room evicted from memory');
  const snap = JSON.parse(fs.readFileSync(path.join(dataDir, 'BOT1.json'), 'utf8'));
  assert.strictEqual(snap.seq, pausedSeq, 'no bot move while no human is connected');

  // reconnect → the room reloads from disk and the bot resumes
  h = await join(app, 'BOT1', 'Host', 'tH');
  await until(() => room() && !room().authority.aiPending(), 'bot resumes after reconnect');
  assert.ok(room().authority.seq > pausedSeq);
  await h.close();
  await stopApp(app);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('2 humans + 1 bot play a full game, with a refresh and a server restart mid-game', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-rooms-'));
  let app = await startApp(dataDir);
  let a = await join(app, 'FULL1', 'Alice', 'tA'), b = await join(app, 'FULL1', 'Bob', 'tB');
  a.send({ t: 'addAI', level: 'easy' });
  await a.next((m) => m.t === 'roster' && m.players.length === 3);
  a.send({ t: 'start', opts: {} });
  await a.next((m) => m.t === 'state');
  const room = () => app.roomManager.rooms.get('FULL1');

  // Play while the humans' turns come up; the bot is driven by the server's timer.
  async function play(maxHumanTurns) {
    for (let n = 0; n < maxHumanTurns; n++) {
      await until(() => !room().authority.aiPending() || room().authority.G.phase !== 'play', 'bot finishes');
      const G = room().authority.G;
      if (G.phase !== 'play') return;
      const turn = G.turn;
      humanTurn(app, 'FULL1', [a, b]);
      await until(() => room().authority.G.turn !== turn || room().authority.G.phase !== 'play', 'human turn ends');
    }
  }

  await play(6);
  // refresh: Bob reconnects with the same token and gets his seat back
  const bobSeat = b.seat;
  await b.close();
  b = await join(app, 'FULL1', 'Bob', 'tB');
  assert.strictEqual(b.seat, bobSeat);

  await play(6);
  await until(() => !room().authority.aiPending(), 'bot finishes before restart');
  const before = JSON.stringify(room().authority.snapshot());
  await Promise.all([a.close(), b.close()]);
  await stopApp(app);

  app = await startApp(dataDir);
  a = await join(app, 'FULL1', 'Alice', 'tA');
  b = await join(app, 'FULL1', 'Bob', 'tB');
  assert.strictEqual(JSON.stringify(room().authority.snapshot()), before, 'restart restores the exact room');

  await play(400);
  const G = room().authority.G;
  assert.strictEqual(G.phase, 'gameover', 'game reaches game over');
  assert.ok(G.winner != null, 'there is a winner');
  await a.next((m) => m.t === 'over');
  await Promise.all([a.close(), b.close()]);
  await stopApp(app);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('  ✓ ' + t.name); }
    catch (err) { failed++; console.log('  ✗ ' + t.name + '\n    ' + (err.stack || err)); }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
