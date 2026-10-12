const api = globalThis.browser || globalThis.chrome;
const $ = selector => document.querySelector(selector);
async function message(type, extra = {}) {
  const answer = await api.runtime.sendMessage({ type, ...extra });
  if (!answer?.ok) throw new Error(answer?.error || 'Extension did not respond');
  return answer.result;
}
function notice(text, error = false) {
  const el = $('#notice'); el.textContent = text; el.classList.toggle('error', error); el.hidden = !text;
}
function relative(value) {
  if (!value) return 'No sync yet';
  const minutes = Math.floor((Date.now() - value) / 60000);
  return minutes < 1 ? 'Just now' : minutes < 60 ? minutes + ' min ago' : new Date(value).toLocaleString();
}
async function render() {
  const { settings, status = {}, syncState = {} } = await api.storage.local.get(['settings','status','syncState']);
  const phase = settings ? status.phase || 'ready' : 'setup';
  const labels = { setup:'Not connected', ready:'Ready to sync', syncing:'Syncing…', connected:'Up to date', error:'Needs attention' };
  if ($('#connection')) { $('#connection').textContent = labels[phase] || 'Ready'; $('#connection').dataset.phase = phase; }
  if ($('#endpoint')) $('#endpoint').textContent = settings ? new URL(settings.serverUrl).host : 'Connect your own server';
  if ($('#device')) $('#device').textContent = settings?.deviceName || 'This device';
  if ($('#lastSync')) $('#lastSync').textContent = relative(status.lastSuccess);
  if ($('#count')) $('#count').textContent = status.count ?? '—';
  if ($('#queue')) $('#queue').textContent = syncState.pending?.length || 0;
  if ($('#sync')) { $('#sync').disabled = !settings || phase === 'syncing'; $('#sync').textContent = phase === 'syncing' ? 'Syncing…' : 'Sync now'; }
  if ($('#serverUrl') && !$('#serverUrl').dataset.loaded) {
    $('#serverUrl').value = settings?.serverUrl || ''; $('#token').value = settings?.token || '';
    $('#deviceName').value = settings?.deviceName || ''; $('#autoSync').checked = settings?.autoSync ?? true;
    $('#serverUrl').dataset.loaded = 'true';
  }
  if ($('#disconnect')) $('#disconnect').hidden = !settings;
  if ($('#statusError')) { $('#statusError').textContent = status.error || ''; $('#statusError').hidden = !status.error; }
}
$('#settings')?.addEventListener('click', () => api.runtime.openOptionsPage());
$('#sync')?.addEventListener('click', async () => {
  notice(''); $('#sync').disabled = true;
  try { await message('sync'); notice('Bookmarks are up to date.'); } catch (error) { notice(error.message, true); }
  await render();
});
$('#configuration')?.addEventListener('submit', async event => {
  event.preventDefault(); notice('');
  let url;
  try {
    url = new URL($('#serverUrl').value.trim());
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Enter the server origin without a path, username, or query.');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error('Use HTTPS, or HTTP on localhost for development.');
    if ($('#token').value.trim().length < 32) throw new Error('Use the same server token, with at least 32 characters.');
    // Request permission directly from the submit gesture, before other async work.
    if (!(await api.permissions.request({ origins: [url.origin + '/*'] }))) throw new Error('Server access was not granted.');
    $('#save').disabled = true;
    await message('saveSettings', { settings: { serverUrl: url.origin, token: $('#token').value.trim(), deviceName: $('#deviceName').value.trim(), autoSync: $('#autoSync').checked } });
    notice('Connected. Running your first sync…'); await render();
    await message('sync'); notice('Connected. Your bookmarks are up to date.');
  } catch (error) { notice(error.message, true); }
  finally { $('#save').disabled = false; await render(); }
});
$('#showToken')?.addEventListener('click', () => { const show = $('#token').type === 'password'; $('#token').type = show ? 'text' : 'password'; $('#showToken').textContent = show ? 'Hide' : 'Show'; });
$('#disconnect')?.addEventListener('click', async () => {
  if (!confirm('Disconnect this device? Local bookmarks stay in your browser. Reconnecting will merge them again; queued changes will be discarded.')) return;
  try { await message('disconnect'); $('#serverUrl').dataset.loaded = ''; notice('Device disconnected. Local bookmarks have been kept.'); await render(); } catch (error) { notice(error.message, true); }
});
$('#backup')?.addEventListener('click', async () => {
  const bookmarks = await api.bookmarks.getTree();
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), bookmarks }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'bookmarks-' + new Date().toISOString().slice(0,10) + '.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
});
api.storage.onChanged.addListener(() => render().catch(() => {}));
render().catch(error => notice(error.message, true));
