(() => {
  const C = globalThis.BookmarkSyncCore;
  class SyncEngine {
    constructor({ api, request, uuid = () => crypto.randomUUID() }) { this.api = api; this.request = request; this.uuid = uuid; }
    async save() { await this.api.storage.local.set({ syncState: this.state }); }
    async load() {
      this.state = (await this.api.storage.local.get('syncState')).syncState || {
        deviceId: this.uuid(), nextSeq: 1, mapping: {}, baseline: {}, pending: [], rootFolders: {}, initialized: false
      };
    }
    async capture() {
      const view = C.inspect(await this.api.bookmarks.getTree(), this.state.rootFolders);
      for (const id of Object.keys(view.native)) if (!this.state.mapping[id]) this.state.mapping[id] = this.uuid();
      const current = C.snapshot(view, this.state.mapping);
      for (const [id, fields] of Object.entries(current)) {
        const changes = C.delta(this.state.baseline[id], fields);
        if (Object.keys(changes).length) this.state.pending.push({ seq: this.state.nextSeq++, type: 'patch', id, fields: changes });
      }
      for (const id of Object.keys(this.state.baseline)) if (!current[id]) this.state.pending.push({ seq: this.state.nextSeq++, type: 'delete', id });
      this.state.baseline = current;
      for (const nativeId of Object.keys(this.state.mapping)) if (!view.native[nativeId]) delete this.state.mapping[nativeId];
      await this.save();
      return view;
    }
    async exchange(operations) {
      const response = await this.request({ protocol: 1, deviceId: this.state.deviceId, operations });
      if (this.state.serverId && this.state.serverId !== response.serverId) throw new Error('Server database has changed. Export a backup, then disconnect and reconnect to merge your local bookmarks.');
      if (typeof response.serverId !== 'string') throw new Error('Server identity is missing');
      if (!this.state.serverId) { this.state.serverId = response.serverId; await this.save(); }
      if (response.protocol !== 1 || !Array.isArray(response.records) || response.records.length > 50000 || !Number.isSafeInteger(response.acknowledged) || response.acknowledged < 0 || response.acknowledged >= this.state.nextSeq) throw new Error('Server returned an invalid sync response');
      for (const record of response.records) {
        if (typeof record.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(record.id)) throw new Error('Invalid remote bookmark ID');
        if (!record.deleted && (!['folder','bookmark'].includes(record.kind) || typeof record.title !== 'string' || record.title.length > 4096 || typeof record.parentId !== 'string' || !Number.isInteger(record.index) || record.index < 0 || (record.kind === 'bookmark' && !C.allowedURL(record.url)))) throw new Error('Invalid remote bookmark');
      }
      const byId = new Map(response.records.map(r => [r.id,r]));
      if (byId.size !== response.records.length) throw new Error('Duplicate remote bookmark IDs');
      const resolved = new Set(C.ROOT_IDS);
      for (const record of response.records) {
        if (record.deleted) continue;
        const chain = new Set(); let node = record;
        while (!resolved.has(node.id)) {
          if (chain.has(node.id)) throw new Error('Remote folder cycle');
          chain.add(node.id);
          if (C.ROOT_IDS.includes(node.parentId)) break;
          const parent = byId.get(node.parentId);
          if (!parent || parent.deleted || parent.kind !== 'folder') throw new Error('Invalid remote parent');
          node = parent;
        }
        for (const id of chain) resolved.add(id);
      }
      if (operations.length && response.acknowledged < operations.at(-1).seq) throw new Error('Server did not acknowledge all changes');
      return response;
    }
    async ensureRoots(records) {
      let view = C.inspect(await this.api.bookmarks.getTree(), this.state.rootFolders);
      if (!view.roots['root:other'] || !view.roots['root:toolbar']) throw new Error('Cannot locate browser bookmark roots');
      for (const type of ['root:menu', 'root:mobile']) {
        if (!view.roots[type] && records.some(r => !r.deleted && r.parentId === type)) {
          const title = type === 'root:menu' ? 'Synced Bookmarks Menu' : 'Synced Mobile Bookmarks';
          const node = await this.api.bookmarks.create({ parentId: view.roots['root:other'], title });
          this.state.rootFolders[type] = node.id;
          await this.save();
        }
      }
      return C.inspect(await this.api.bookmarks.getTree(), this.state.rootFolders);
    }
    async apply(records) {
      let view = await this.ensureRoots(records);
      const remote = Object.fromEntries(records.map(r => [r.id, r]));
      // Journal before mutation: an interrupted service worker resumes the same pull.
      this.state.applying = records; await this.save();
      let reverse = Object.fromEntries(Object.entries(this.state.mapping).filter(([id]) => view.native[id]).map(([id,uid]) => [uid,id]));
      if (this.state.creating) {
        const intent = this.state.creating;
        const children = await this.api.bookmarks.getChildren(intent.parentId);
        const found = children.find(n => !intent.before.includes(n.id) && !this.state.mapping[n.id] && n.title === intent.fields.title && n.url === intent.fields.url);
        if (found) { this.state.mapping[found.id] = intent.id; reverse[intent.id] = found.id; }
        delete this.state.creating; await this.save();
      }
      const waiting = records.filter(r => !r.deleted);
      let pass = 0; const processed = new Set(C.ROOT_IDS);
      while (waiting.length) {
        let progress = false;
        for (let i = 0; i < waiting.length;) {
          const r = waiting[i]; const parentId = view.roots[r.parentId] || reverse[r.parentId];
          if (!parentId || !processed.has(r.parentId)) { i++; continue; }
          const fields = { title: r.title }; if (r.kind === 'bookmark') fields.url = r.url;
          let nativeId = reverse[r.id];
          if (!nativeId) {
            const children = await this.api.bookmarks.getChildren(parentId);
            this.state.creating = { id: r.id, parentId, fields, before: children.map(n => n.id) }; await this.save();
            const created = await this.api.bookmarks.create({ ...fields, parentId });
            nativeId = created.id; this.state.mapping[nativeId] = r.id; reverse[r.id] = nativeId;
            delete this.state.creating; await this.save();
          } else {
            const [node] = await this.api.bookmarks.get(nativeId);
            if (node.title !== r.title || (r.kind === 'bookmark' && node.url !== r.url)) await this.api.bookmarks.update(nativeId, fields);
            if (node.parentId !== parentId) await this.api.bookmarks.move(nativeId, { parentId });
          }
          processed.add(r.id); waiting.splice(i, 1); progress = true;
        }
        if (!progress || ++pass > records.length + 1) throw new Error('Server returned missing parents or a folder cycle');
      }
      // Move survivors out of deleted folders before removing those folders.
      view = C.inspect(await this.api.bookmarks.getTree(), this.state.rootFolders);
      const removed = new Set(records.filter(r => r.deleted).map(r => r.id));
      for (const [nativeId, uid] of Object.entries(this.state.mapping)) {
        if (!removed.has(uid) || !view.native[nativeId]) continue;
        const parentUid = this.state.mapping[view.native[nativeId].node.parentId];
        if (removed.has(parentUid)) continue;
        const node = view.native[nativeId].node;
        if (node.url) await this.api.bookmarks.remove(nativeId); else await this.api.bookmarks.removeTree(nativeId);
      }
      // Stable ID breaks index ties from simultaneous inserts on different devices.
      const groups = {};
      for (const r of records) if (!r.deleted) (groups[r.parentId] ||= []).push(r);
      for (const [parent, children] of Object.entries(groups)) {
        children.sort((a,b) => a.index - b.index || a.id.localeCompare(b.id));
        const parentId = view.roots[parent] || reverse[parent];
        for (let index = 0; index < children.length; index++) {
          const nativeId = reverse[children[index].id]; const [node] = await this.api.bookmarks.get(nativeId);
          if (node.index !== index) await this.api.bookmarks.move(nativeId, { parentId, index });
        }
      }
      view = C.inspect(await this.api.bookmarks.getTree(), this.state.rootFolders);
      // The baseline describes actual browser indices after deterministic ordering.
      const actual = C.snapshot(view, this.state.mapping);
      this.state.baseline = {};
      for (const r of records) if (!r.deleted) {
        const fields = { kind:r.kind, title:r.title, parentId:r.parentId, index:actual[r.id]?.index ?? r.index };
        if (r.kind === 'bookmark') fields.url = r.url;
        this.state.baseline[r.id] = fields;
      }
      for (const id of Object.keys(this.state.mapping)) if (!view.native[id]) delete this.state.mapping[id];
      delete this.state.applying; await this.save();
    }
    async run() {
      await this.load();
      if (this.state.applying) await this.apply(this.state.applying);
      if (!this.state.initialized) {
        const initial = await this.exchange([]);
        const view = await this.ensureRoots(initial.records);
        C.adopt(view, this.state.mapping, initial.records);
        this.state.initialized = true; await this.save();
      }
      await this.capture();
      for (let attempt = 0; attempt < 3; attempt++) {
        const outgoing = [...this.state.pending];
        const result = await this.exchange(outgoing);
        this.state.pending = this.state.pending.filter(op => op.seq > result.acknowledged); await this.save();
        // Preserve edits made while the HTTP request was in flight.
        await this.capture();
        if (this.state.pending.length) continue;
        await this.apply(result.records);
        await this.capture();
        if (this.state.pending.length) continue;
        return { revision: result.revision, count: result.records.filter(r => !r.deleted && r.kind === 'bookmark').length };
      }
      throw new Error('Bookmarks are changing; queued changes will sync on the next run');
    }
  }
  globalThis.BookmarkSyncEngine = SyncEngine;
})();
