/* =====================================================================
 * Node server for LAN play — serves the static game AND /room/:code/ws on ONE port.
 * Originally from honey634546-dev/pokemon-splendor (ECS server); adapted here.
 * ---------------------------------------------------------------------
 *   npm start                     → http://<this machine's LAN IP>:8787
 *   PORT=9000 HOST=127.0.0.1 npm start
 *   ROOM_DATA_DIR=/some/private/dir npm start   (default .runtime/rooms/)
 * Scope: a trusted LAN, one process — no accounts, no multi-process locking.
 * js/net.js builds the socket URL from location.host, so a page loaded from this
 * server talks to this server — no configuration on the clients.
 * Same rules as the Cloudflare Worker (worker/index.js): both wrap js/room.js.
 * ===================================================================== */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { RoomManager } = require('./room-manager.js');

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '0.0.0.0';        // LAN: reachable from other devices
const MAX_CONNECTIONS_PER_ROOM = 16;
const MAX_MESSAGE_BYTES = 8192;

// ------------------------------ static files ------------------------------
// Allowlist, not a denylist: only what the browser needs is reachable. server/,
// test/, train/, node_modules/, .runtime/ (room snapshots) and dotfiles never are.
const ROOT = path.resolve(__dirname, '..');
const STATIC_FILES = new Set(['index.html', 'manifest.json', 'sw.js',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']);
const STATIC_DIRS = new Set(['css', 'js', 'data', 'assets']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
// html/css/js/json can change between versions (sw.js is network-first for them too).
const SHELL_EXT = new Set(['.html', '.js', '.css', '.json']);

function plain(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

// Map a URL path to a file inside ROOT, or null if it is not allowed.
function resolveStatic(urlPath) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(urlPath, 'http://localhost').pathname); } catch (err) { return null; }
  if (pathname.includes('\0') || pathname.includes('\\')) return null;
  if (pathname === '/') pathname = '/index.html';
  const parts = pathname.split('/').filter(Boolean);
  if (!parts.length || parts.some((p) => p.startsWith('.'))) return null;   // also rejects '..'
  const allowed = parts.length === 1 ? STATIC_FILES.has(parts[0]) : STATIC_DIRS.has(parts[0]);
  if (!allowed) return null;
  const file = path.join(ROOT, ...parts);
  return file.startsWith(ROOT + path.sep) ? file : null;
}

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'Method not allowed\n');
  const file = resolveStatic(req.url);
  if (!file) return plain(res, 404, 'Not found\n');
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return plain(res, 404, 'Not found\n');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': SHELL_EXT.has(ext) ? 'no-cache' : 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

// IPv4 addresses other devices on the LAN can use to reach this machine.
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

// ------------------------------ WebSocket ------------------------------
function rejectUpgrade(socket, status, message) {
  const body = `${message}\n`;
  socket.write(
    `HTTP/1.1 ${status} Error\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  );
  socket.destroy();
}

function createServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? DEFAULT_PORT);
  const host = options.host || process.env.HOST || DEFAULT_HOST;
  const maxConnections = Number(options.maxConnections ?? process.env.MAX_CONNECTIONS_PER_ROOM ?? MAX_CONNECTIONS_PER_ROOM);
  const maxMessageBytes = Number(options.maxMessageBytes ?? process.env.MAX_MESSAGE_BYTES ?? MAX_MESSAGE_BYTES);
  const roomManager = options.roomManager || new RoomManager({
    dataDir: options.dataDir || process.env.ROOM_DATA_DIR,
    aiDelayMs: options.aiDelayMs,
    maxSeats: 4,
    send: (entry, connId, msg) => {
      const ws = entry.connections.get(connId);
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
    },
    // 1011 = server error; js/net.js treats any close as a dropped link and reconnects
    close: (entry, reason) => {
      for (const ws of entry.connections.values()) ws.close(1011, reason);
    },
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxMessageBytes });
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      const body = JSON.stringify({ ok: true, rooms: roomManager.rooms.size });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    serveStatic(req, res);
  });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    } catch (err) {
      rejectUpgrade(socket, 400, 'Bad request');
      return;
    }
    const match = pathname.match(/^\/room\/([A-Za-z0-9_-]{1,32})\/ws$/);
    if (!match) {
      rejectUpgrade(socket, 404, 'WebSocket endpoint not found');
      return;
    }

    const code = match[1].toUpperCase();
    if (roomManager.get(code).connections.size >= maxConnections) {
      rejectUpgrade(socket, 503, 'Room is full');
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      // Look the room up again: it may have been evicted (last socket closed) while
      // this upgrade was in flight, and attaching to a stale entry would split the room.
      const entry = roomManager.get(code);
      const connId = crypto.randomUUID();
      let detached = false;
      roomManager.connect(entry, connId, ws);

      const detach = () => {
        if (detached) return;
        detached = true;
        try { roomManager.disconnect(entry, connId); } catch (err) { console.error(`[rooms] disconnect ${code}:`, err); }
      };

      ws.on('message', (data) => {
        const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        if (raw.length > maxMessageBytes) return;
        let msg;
        try { msg = JSON.parse(raw.toString('utf8')); } catch (err) { return; }
        if (!msg || typeof msg.t !== 'string') return;
        if (msg.t === 'ping') {
          if (ws.readyState === 1) ws.send('{"t":"pong"}');
          return;
        }
        // handle() never throws for room logic (it fails the room instead); this
        // only guards the transport itself.
        try {
          roomManager.handle(entry, connId, msg);
        } catch (err) {
          console.error(`[rooms] message ${code}:`, err);
        }
      });
      ws.on('close', detach);
      ws.on('error', detach);
    });
  });

  return {
    server,
    wss,
    roomManager,
    start(callback) { server.listen(port, host, callback); },
    stop(callback) {
      roomManager.shutdown();
      for (const ws of wss.clients) ws.close(1001, 'server shutdown');
      wss.close(() => server.close(callback));
    },
  };
}

if (require.main === module) {
  let app;
  try {
    app = createServer();
  } catch (err) {
    console.error(`[server] ${err.message}`);
    process.exit(1);
  }
  app.start(() => {
    const { address, port } = app.server.address();
    const hosts = address === '0.0.0.0' || address === '::' ? ['localhost', ...lanAddresses()] : [address];
    console.log('[server] 宝可梦璀璨宝石 已启动，在同一局域网的设备上打开：');
    for (const h of hosts) console.log(`  http://${h}:${port}/`);
    console.log(`[server] room snapshots: ${app.roomManager.store.dir}`);
  });
  const shutdown = (signal) => {
    console.log(`[server] ${signal}, saving rooms and shutting down`);
    app.stop(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { createServer, resolveStatic, lanAddresses };
