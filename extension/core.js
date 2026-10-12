(() => {
  const ROOT_IDS = ['root:toolbar', 'root:other', 'root:menu', 'root:mobile'];
  const fields = ['kind', 'title', 'url', 'parentId', 'index'];
  function allowedURL(value) {
    try { return ['http:', 'https:', 'ftp:', 'file:'].includes(new URL(value).protocol); } catch { return false; }
  }
  function delta(previous, next) {
    const result = {};
    for (const key of fields) if (next[key] !== undefined && previous?.[key] !== next[key]) result[key] = next[key];
    return result;
  }
  function rootType(node) {
    if (node.id === 'toolbar_____') return 'root:toolbar';
    if (node.id === 'unfiled_____') return 'root:other';
    if (node.id === 'menu________') return 'root:menu';
    if (node.id === 'mobile______') return 'root:mobile';
    const types = { 'bookmarks-bar': 'root:toolbar', other: 'root:other', mobile: 'root:mobile' };
    return types[node.folderType] || ({ '1': 'root:toolbar', '2': 'root:other', '3': 'root:mobile' })[node.id];
  }
  function inspect(tree, rootFolders = {}) {
    const roots = {}; const native = {};
    for (const node of tree[0].children || []) {
      if (node.unmodifiable) continue;
      const type = rootType(node);
      if (type && (!roots[type] || node.syncing === false)) roots[type] = node.id;
    }
    const exists = new Set(); const visit = node => { exists.add(node.id); for (const child of node.children || []) visit(child); }; visit(tree[0]);
    for (const [type, id] of Object.entries(rootFolders)) if (!roots[type] && exists.has(id)) roots[type] = id;
    const rootByNative = Object.fromEntries(Object.entries(roots).map(([a,b]) => [b,a]));
    const scan = (node, parent) => {
      if (node.unmodifiable || node.type === 'separator') return;
      const type = rootByNative[node.id];
      if (type) { for (const child of node.children || []) scan(child, type); return; }
      if (!parent || (node.url && !allowedURL(node.url))) return;
      native[node.id] = { node, parent };
      for (const child of node.children || []) scan(child, node.id);
    };
    // Scan only supported roots; tags and enterprise-managed trees are excluded.
    const find = (node) => { if (rootByNative[node.id]) scan(node, null); else for (const child of node.children || []) find(child); };
    find(tree[0]);
    return { roots, native };
  }
  function snapshot(view, mapping) {
    const records = {};
    for (const [id, { node, parent }] of Object.entries(view.native)) {
      const uid = mapping[id]; const parentId = ROOT_IDS.includes(parent) ? parent : mapping[parent];
      if (!uid || !parentId) continue;
      records[uid] = { kind: node.url ? 'bookmark' : 'folder', title: node.title || '', parentId, index: node.index || 0 };
      if (node.url) records[uid].url = node.url;
    }
    return records;
  }
  function adopt(view, mapping, remote) {
    const claimed = new Set(Object.values(mapping));
    const queue = ROOT_IDS.map(id => [id,id]);
    while (queue.length) {
      const [nativeParent, remoteParent] = queue.shift();
      const local = Object.entries(view.native).filter(([, item]) => item.parent === nativeParent);
      for (const [id, {node}] of local) {
        const match = remote.find(r => !r.deleted && !claimed.has(r.id) && r.parentId === remoteParent && r.kind === (node.url ? 'bookmark' : 'folder') && r.title === (node.title || '') && r.url === node.url);
        if (match) { mapping[id] = match.id; claimed.add(match.id); if (!node.url) queue.push([id,match.id]); }
      }
    }
  }
  globalThis.BookmarkSyncCore = { ROOT_IDS, allowedURL, delta, inspect, snapshot, adopt };
})();
