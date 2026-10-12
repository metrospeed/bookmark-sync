export function mockBrowser(firefox = false) {
  let counter = 100;
  const tree = { id: firefox ? 'root________' : '0', title: '', children: [
    { id: firefox ? 'toolbar_____' : '1', title: 'Bookmarks bar', children: [] },
    { id: firefox ? 'unfiled_____' : '2', title: 'Other bookmarks', children: [] },
    ...(firefox ? [{ id: 'menu________', title: 'Bookmarks menu', children: [] }] : [])
  ] };
  const data = {};
  let failSave;
  const nodes = () => { const all = {}; const visit = (node, parent) => { if (parent) node.parentId = parent; all[node.id] = node; node.children?.forEach((child,index) => { child.index = index; visit(child,node.id); }); }; visit(tree); return all; };
  const node = id => { const result = nodes()[id]; if (!result) throw new Error('No bookmark ' + id); return result; };
  const remove = id => { const item = node(id); const parent = node(item.parentId); parent.children.splice(parent.children.findIndex(n => n.id === id),1); nodes(); };
  const api = { storage: { local: {
    get: async key => { if (Array.isArray(key)) return structuredClone(Object.fromEntries(key.map(k=>[k,data[k]]))); return structuredClone({[key]:data[key]}); },
    set: async values => { if (failSave?.(values)) { failSave = null; throw new Error('Simulated worker shutdown'); } Object.assign(data,structuredClone(values)); },
    remove: async keys => { for (const key of keys) delete data[key]; }
  } }, bookmarks: {
    getTree: async () => { nodes(); return structuredClone([tree]); },
    get: async id => structuredClone([node(id)]),
    getChildren: async id => structuredClone(node(id).children || []),
    create: async details => {
      const parent = node(details.parentId); if (!parent.children) throw new Error('Not a folder');
      const created = { id: String(counter++), title: details.title || '', ...(details.url ? {url:details.url} : {children:[]}) };
      parent.children.splice(details.index ?? parent.children.length,0,created); nodes(); return structuredClone(created);
    },
    update: async (id,fields) => { Object.assign(node(id),fields); return structuredClone(node(id)); },
    move: async (id,details) => {
      const item = node(id); let parent = node(details.parentId);
      let ancestor = parent; while (ancestor) { if (ancestor.id === id) throw new Error('Folder cycle'); ancestor = ancestor.parentId ? node(ancestor.parentId) : null; }
      remove(id); parent.children.splice(Math.min(details.index ?? parent.children.length,parent.children.length),0,item); nodes(); return structuredClone(item);
    },
    remove: async id => { if (node(id).children?.length) throw new Error('Folder not empty'); remove(id); },
    removeTree: async id => remove(id)
  } };
  return { api, data, tree, node, failNextSave: predicate => { failSave = predicate; }, all: nodes };
}
