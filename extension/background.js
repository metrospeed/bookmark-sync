if (typeof importScripts === 'function') importScripts('core.js', 'sync.js');
const api = globalThis.browser || globalThis.chrome;
let running;
let applying = false;
async function status(values) {
  const old = (await api.storage.local.get('status')).status || {};
  await api.storage.local.set({ status: { ...old, ...values } });
}
async function schedule() {
  const { settings } = await api.storage.local.get('settings');
  if (settings?.autoSync) {
    if (!(await api.alarms.get('sync'))) await api.alarms.create('sync', { periodInMinutes: 1 });
  } else await api.alarms.clear('sync');
}
function sync() {
  if (running) return running;
  running = (async () => {
    const { settings } = await api.storage.local.get('settings');
    if (!settings?.serverUrl || !settings?.token) throw new Error('Connect a server in Settings first');
    await status({ phase: 'syncing', error: null });
    const engine = new globalThis.BookmarkSyncEngine({ api, request: async body => {
      const response = await fetch(settings.serverUrl + '/v1/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.token },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20000), redirect: 'error', credentials: 'omit', cache: 'no-store'
      });
      if (!response.ok) {
        let detail; try { detail = (await response.json()).error; } catch {}
        throw new Error(detail || 'Server returned HTTP ' + response.status);
      }
      return response.json();
    } });
    const originalApply = engine.apply.bind(engine);
    engine.apply = async records => { applying = true; try { return await originalApply(records); } finally { applying = false; } };
    try {
      const result = await engine.run();
      await status({ phase: 'connected', lastSuccess: Date.now(), error: null, ...result });
      await api.action.setBadgeText({ text: '' });
      return result;
    } catch (error) {
      const message = error.name === 'TimeoutError' ? 'Server timed out. Changes remain queued.' : error.message;
      await status({ phase: 'error', error: message });
      await api.action.setBadgeText({ text: '!' });
      await api.action.setBadgeBackgroundColor({ color: '#b45309' });
      throw new Error(message);
    }
  })().finally(() => { running = null; });
  return running;
}
function changed() {
  if (applying) return;
  // Alarms survive a suspended Manifest V3 worker; no timer is required.
  api.storage.local.get('settings').then(({settings}) => {
    if (settings?.autoSync) return api.alarms.create('changes', { when: Date.now() + 5000 });
  }).catch(() => {});
}
for (const event of ['onCreated','onRemoved','onChanged','onMoved','onChildrenReordered','onImportEnded']) api.bookmarks[event]?.addListener(changed);
api.alarms.onAlarm.addListener(alarm => { if (['sync','changes'].includes(alarm.name)) sync().catch(() => {}); });
api.runtime.onInstalled.addListener(() => { schedule().catch(() => {}); });
api.runtime.onStartup.addListener(() => { schedule().then(() => api.storage.local.get('settings')).then(({settings}) => { if (settings?.autoSync) return sync(); }).catch(() => {}); });
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== api.runtime.id) return false;
  const handle = async () => {
    if (message.type === 'sync') return sync();
    if (message.type === 'saveSettings') {
      if (running) await running.catch(() => {});
      const value = message.settings;
      let url; try { url = new URL(value.serverUrl); } catch { throw new Error('Enter a valid server URL'); }
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['https:','http:'].includes(url.protocol)) throw new Error('Use a server origin, such as https://bookmarks.example.com');
      if (url.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Use HTTPS for servers outside this computer');
      if (typeof value.token !== 'string' || value.token.length < 32) throw new Error('The server token must be at least 32 characters');
      const settings = { serverUrl: url.origin, token: value.token, deviceName: String(value.deviceName || 'This device').slice(0,80), autoSync: Boolean(value.autoSync) };
      if (!(await api.permissions.contains({ origins: [url.origin + '/*'] }))) throw new Error('Allow access to your server first');
      const old = (await api.storage.local.get('settings')).settings;
      if (old && (old.serverUrl !== settings.serverUrl || old.token !== settings.token)) throw new Error('Disconnect before switching servers or tokens. Your local bookmarks will be preserved.');
      await api.storage.local.set({ settings }); await schedule();
      await status({ phase: 'ready', error: null });
      return { saved: true };
    }
    if (message.type === 'disconnect') {
      if (running) await running.catch(() => {});
      const { settings } = await api.storage.local.get('settings');
      await api.alarms.clear('sync'); await api.alarms.clear('changes');
      await api.storage.local.remove(['settings','syncState','status']);
      if (settings?.serverUrl) await api.permissions.remove({ origins: [settings.serverUrl + '/*'] });
      await api.action.setBadgeText({ text: '' }); return { disconnected: true };
    }
    throw new Error('Unknown extension request');
  };
  handle().then(result => sendResponse({ ok: true, result }), error => sendResponse({ ok: false, error: error.message }));
  return true;
});
// Alarms may be cleared on browser restart; recreate when the worker wakes.
schedule().catch(() => {});
