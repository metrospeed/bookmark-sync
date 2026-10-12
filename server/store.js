import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const ROOTS = new Set(['root:toolbar', 'root:other', 'root:menu', 'root:mobile']);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS = new Set(['kind', 'title', 'url', 'parentId', 'index']);
export class ProtocolError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function assert(ok, message) { if (!ok) throw new ProtocolError(message); }
export function validateRequest(body) {
  assert(body && typeof body === 'object' && body.protocol === 1, 'Unsupported sync protocol');
  assert(ID.test(body.deviceId), 'Invalid device ID');
  assert(Array.isArray(body.operations) && body.operations.length <= 50000, 'Too many operations');
  for (const op of body.operations) {
    assert(op && ID.test(op.id), 'Invalid bookmark ID');
    assert(Number.isSafeInteger(op.seq) && op.seq > 0, 'Invalid operation sequence');
    assert(op.type === 'patch' || op.type === 'delete', 'Invalid operation type');
    if (op.type === 'delete') continue;
    assert(op.fields && typeof op.fields === 'object' && !Array.isArray(op.fields), 'Invalid fields');
    for (const [key, value] of Object.entries(op.fields)) {
      assert(FIELDS.has(key), 'Unknown bookmark field');
      if (key === 'kind') assert(value === 'folder' || value === 'bookmark', 'Invalid kind');
      if (key === 'title') assert(typeof value === 'string' && value.length <= 4096, 'Title too long');
      if (key === 'parentId') assert(ROOTS.has(value) || ID.test(value), 'Invalid parent ID');
      if (key === 'index') assert(Number.isInteger(value) && value >= 0 && value <= 1000000, 'Invalid index');
      if (key === 'url') {
        assert(typeof value === 'string' && value.length <= 16384, 'Invalid URL');
        let url; try { url = new URL(value); } catch { throw new ProtocolError('Invalid URL'); }
        assert(['http:', 'https:', 'ftp:', 'file:'].includes(url.protocol), 'Unsupported bookmark URL scheme');
      }
    }
  }
}
export class Store {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id=1), json TEXT NOT NULL);');
    this.db.prepare('INSERT OR IGNORE INTO state VALUES (1, ?)').run(JSON.stringify({ serverId: randomUUID(), revision: 0, records: {}, devices: {} }));
  }
  sync(body) {
    validateRequest(body);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = JSON.parse(this.db.prepare('SELECT json FROM state WHERE id=1').get().json);
      let last = state.devices[body.deviceId] || 0;
      let changed = false;
      for (const op of body.operations) {
        if (op.seq <= last) continue; // A lost HTTP response can be retried safely.
        if (op.seq !== last + 1) throw new ProtocolError('Operation sequence gap; restore this device\'s local sync state', 409);
        const previous = state.records[op.id];
        if (op.type === 'delete') {
          state.records[op.id] = { id: op.id, deleted: true };
        } else if (!previous?.deleted) {
          const next = { ...previous, ...op.fields, id: op.id, deleted: false };
          assert(next.kind === 'folder' || next.kind === 'bookmark', 'A new record needs a kind');
          assert(typeof next.title === 'string' && typeof next.parentId === 'string' && Number.isInteger(next.index), 'Incomplete new record');
          assert(!previous || next.kind === previous.kind, 'Bookmark kind cannot change');
          assert(next.kind !== 'bookmark' || typeof next.url === 'string', 'A bookmark needs a URL');
          assert(next.kind !== 'folder' || next.url === undefined, 'A folder cannot have a URL');
          state.records[op.id] = next;
        }
        last = op.seq;
        changed = true;
      }
      // A folder deletion dominates offline edits and newly uploaded descendants.
      // Missing parents and concurrent move cycles are recovered in Other Bookmarks.
      const done = new Set();
      const resolve = (start) => {
        const chain = []; const visiting = new Set(); let current = start;
        while (current && !current.deleted && !ROOTS.has(current.parentId) && !done.has(current.id)) {
          if (visiting.has(current.id)) { current.parentId = 'root:other'; break; }
          visiting.add(current.id); chain.push(current);
          const parent = state.records[current.parentId];
          if (!parent) { current.parentId = 'root:other'; break; }
          if (parent.deleted) { current.deleted = true; break; }
          assert(parent.kind === 'folder', 'A bookmark cannot contain children');
          current = parent;
        }
        for (const item of chain.reverse()) {
          if (state.records[item.parentId]?.deleted) state.records[item.id] = { id: item.id, deleted: true };
          done.add(item.id);
        }
      };
      for (const record of Object.values(state.records)) resolve(record);
      assert(Object.keys(state.records).length <= 50000, 'Server bookmark limit reached');
      assert(Object.keys(state.devices).length < 1000 || body.deviceId in state.devices, 'Server device limit reached');
      if (changed) {
        state.devices[body.deviceId] = last;
        state.revision++;
        this.db.prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify(state));
      }
      this.db.exec('COMMIT');
      return { protocol: 1, serverId: state.serverId, revision: state.revision, acknowledged: last, records: Object.values(state.records) };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
