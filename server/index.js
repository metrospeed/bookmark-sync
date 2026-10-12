import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Store, ProtocolError } from './store.js';
const MAX_BODY = 16 * 1024 * 1024;
export function createSyncServer({ token, database = './data/bookmarks.sqlite', store = new Store(database) }) {
  if (typeof token !== 'string' || token.length < 32) { store.close(); throw new Error('SYNC_TOKEN must be at least 32 characters'); }
  const expected = createHash('sha256').update(token).digest();
  const clients = new Map();
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, value) => { res.writeHead(status); res.end(JSON.stringify(value)); };
    if (req.url === '/health' && req.method === 'GET') return send(200, { ok: true });
    const origin = req.headers.origin;
    if (origin && !/^(chrome|moz)-extension:\/\/[a-zA-Z0-9-]+$/.test(origin)) return send(403, { error: 'Browser website origins are not allowed' });
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    }
    if (req.url === '/v1/sync' && req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const now = Date.now(); const key = req.socket.remoteAddress;
    if (clients.size > 10000) for (const [address, value] of clients) if (now - value.start > 60000) clients.delete(address);
    const rate = clients.get(key);
    if (!rate || now - rate.start > 60000) clients.set(key, { start: now, count: 1 });
    else if (++rate.count > 120) { res.setHeader('Retry-After', '60'); return send(429, { error: 'Too many requests; retry in a minute' }); }
    const authorization = req.headers.authorization || '';
    const actual = createHash('sha256').update(authorization.startsWith('Bearer ') ? authorization.slice(7) : '').digest();
    if (!timingSafeEqual(actual, expected)) return send(401, { error: 'Invalid sync token' });
    if (req.url !== '/v1/sync') return send(404, { error: 'Not found' });
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(405, { error: 'Use POST' }); }
    if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'Use application/json' });
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) { send(413, { error: 'Request exceeds 16 MiB' }); req.resume(); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ProtocolError('Invalid JSON'); }
      send(200, store.sync(body));
    } catch (error) {
      if (!res.headersSent) send(error.status || 500, { error: error.status ? error.message : 'Server error' });
      if (!error.status) console.error('Sync request failed:', error.message);
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.on('close', () => store.close());
  return server;
}
if (globalThis.process?.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 8080);
  const server = createSyncServer({ token: process.env.SYNC_TOKEN, database: process.env.SYNC_DATABASE || './data/bookmarks.sqlite' });
  server.listen(port, process.env.HOST || '0.0.0.0', () => console.log('Bookmark Sync listening on port ' + port));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
