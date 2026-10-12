# Bookmark Sync

A browser extension that syncs native bookmarks through a server you host. Includes Chrome/Edge and Firefox builds, a dependency-free Node.js server with SQLite, and Docker Compose with optional automatic HTTPS.

## Features

- Two-way sync of bookmarks, nested folders, titles, URLs, moves, order, and deletions.
- Automatic sync after changes and once per minute while the browser is running; manual Sync now.
- Persistent offline queue, idempotent retries, and recovery after a suspended extension worker.
- Initial merge preserves each device's existing bookmarks. Identical URLs/titles under identical folder paths are adopted instead of copied again.
- A settings page, status popup, device labels, and local JSON backup export.
- Server-specific host permission, bearer-token authentication, request limits, and transactional SQLite persistence.

## Quick start

Requires **Node.js 24+**, or **Docker with Compose** for the server. No npm dependencies or install step are needed.

### 1. Start the server

Generate a private token:

~~~sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
~~~

Copy .env.example to .env and put that token in SYNC_TOKEN. Never commit .env.

~~~sh
docker compose up -d --build
~~~

The local server is available at http://localhost:8080. Health check: http://localhost:8080/health. SQLite lives in the persistent bookmark-data volume. The default port binding is accessible only from the server computer.

**Without Docker**, run from the project directory:

~~~powershell
# Windows PowerShell
$env:SYNC_TOKEN = 'paste-your-generated-token-here'
$env:HOST = '127.0.0.1'
npm start
~~~

~~~sh
# macOS/Linux
SYNC_TOKEN='paste-your-generated-token-here' HOST=127.0.0.1 npm start
~~~

Node does not read .env automatically. Set the environment variables as shown. The database defaults to data/bookmarks.sqlite; override with SYNC_DATABASE. PORT defaults to 8080.

### 2. Install the extension

Build both browser packages:

~~~sh
npm run build
~~~

- **Chrome:** open chrome://extensions, enable Developer mode, choose Load unpacked, and select dist/chrome.
- **Edge:** open edge://extensions, enable Developer mode, choose Load unpacked, and select dist/chrome.
- **Firefox 140+:** open about:debugging#/runtime/this-firefox, choose Load Temporary Add-on, and select dist/firefox/manifest.json. Temporary installs disappear on restart; ongoing use requires signing the Firefox ZIP through Mozilla's Add-on Developer Hub. The package is prepared for signing, including a fixed add-on ID and bookmark data disclosure.

The extension source folder can also be loaded directly in Chrome/Edge. Build outputs include dist/bookmark-sync-chrome.zip and dist/bookmark-sync-firefox.zip with the manifest at the archive root.

### 3. Connect each device

Open the extension, then Settings. Export a local backup before the first connection. Enter the server address, the same private token, and a device label. Click **Save & sync**, and allow access to that server when prompted.

Use http://localhost:8080 for local testing. A device's localhost address always refers to that device. To sync across computers, expose the server through HTTPS and use that same HTTPS address everywhere.

Disable your browser's built-in bookmark sync on connected profiles to avoid two competing sync systems. Initial connection merges your local bookmarks with the shared library. Changes and deletions made after connection propagate to every connected profile.

## HTTPS hosting for multiple devices

Use your own reverse proxy, or the included Caddy configuration:

1. Point your domain's DNS at your server.
2. Set BOOKMARK_DOMAIN in .env to the bare domain, such as bookmarks.example.com. Keep the generated SYNC_TOKEN in .env.
3. Allow inbound ports 80 and 443, then run:

~~~sh
docker compose -f compose.yaml -f compose.https.yaml up -d --build
~~~

Caddy provisions a certificate automatically and forwards to the bookmarks container. Connect extensions to https://bookmarks.example.com. The SQLite volume and Caddy certificate volumes persist across container replacements. If you already run a proxy, forward to the Node server's port instead; external addresses must use HTTPS. An HTTPS endpoint on a private network with a trusted certificate also works.

## Sync behavior and limits

Each native bookmark gets a stable UUID; browser-specific native IDs remain local. Uploads contain sequenced field changes. The server acknowledges them transactionally and returns the current library. A lost response can be replayed without duplicate writes.

Concurrent changes to different fields merge. For the same field, the last change **accepted by the server** wins; device clocks do not affect the result. A deletion permanently wins against stale updates to that ID. Deleting a folder deletes its descendants, except children already moved out before that deletion reached the server. Explicitly recreating a bookmark assigns a new ID.

Bookmarks bar and Other Bookmarks map to their native equivalents. Firefox menu and mobile roots map to native roots where available, or to Synced Bookmarks Menu / Synced Mobile Bookmarks folders under Other Bookmarks. Missing parents and concurrent folder-move cycles recover under Other Bookmarks. Firefox tags, separators, enterprise-managed trees, bookmarklets, data URLs, and browser-internal URLs are excluded. Supported URLs are HTTP, HTTPS, FTP, and file; a file URL may refer to different local files on different devices.

Existing bookmarks with different titles, URLs, or parent paths are preserved as distinct entries. This is a single shared library per server, suitable for your own devices or a trusted group sharing the token. A device label is local display information, not an access-control identity.

The server supports at most 50,000 record IDs (including retained deletion tombstones), 1,000 device IDs, and a 16 MiB request body. It transfers the full library on each sync, so this implementation is intended for personal bookmark collections. The extension requests unlimited local storage for its durable queue and mapping. Sync alarms are best effort; sleeping devices and closed browsers sync when they resume.

Bookmarks and tokens are not encrypted at rest. HTTPS encrypts transport; this implementation does not provide end-to-end encryption. Anyone with the token can read and change the shared library. No telemetry or third-party bookmark service is used. The optional Caddy proxy contacts its certificate provider to provision HTTPS.

## Backups and maintenance

Use **Export local backup** for a JSON snapshot of the native bookmark tree. For a browser-importable HTML backup, use the browser's bookmark manager export. The extension does not implement importing its JSON backup.

For a server backup, stop the bookmarks service before copying the entire SQLite data directory, including any WAL/SHM files:

~~~sh
docker compose stop bookmarks
docker compose cp bookmarks:/app/data ./bookmark-server-backup
docker compose start bookmarks
~~~

For Node hosting, stop the process and copy data/ (or your configured database directory). Keep a separate, protected copy of .env. Restore the entire saved directory to the configured data location with write access for the server user; Docker runs as the node user (UID 1000). Never copy just a live SQLite main file while WAL writes are active.

To rotate a token, stop the server, change SYNC_TOKEN, restart, and update each device. Before changing tokens in the extension, let queued edits sync, export a backup, and **Disconnect**. Disconnect retains local bookmarks and discards that device's queue and identity. Reconnection merges local bookmarks again. It can reintroduce bookmarks that were deleted elsewhere while the device was disconnected.

If the server database was replaced or reset, connected devices detect its changed identity and stop syncing. Export backups, then disconnect/reconnect to populate the new library. Avoid clearing extension storage or restoring an old database while clients have pending changes; operation sequences can then disagree. Keep the original database when upgrading.

## Development and verification

~~~sh
npm test
npm run build
npm run test:browser
~~~

The dependency-free test suite covers protocol validation, SQLite restarts, real HTTP authorization, origin filtering, request size and rate limits, and simulated devices with offline edits, initial merges, reorderings, deletes, retries, and creation-journal recovery.

The optional browser smoke test runs an installed Chromium browser in an isolated test profile. On Windows it defaults to the standard Chrome path; set BROWSER_PATH to another Chromium executable if needed. It loads the real Manifest V3 extension through the DevTools extension API, checks configuration, uploads a native bookmark, and pulls a server-side edit. It changes no bookmarks in your normal browser profile. The temporary test manifest grants localhost access directly; the shipped extension requests server access during setup. The smoke test requires a recent Chromium version supporting Extensions.loadUnpacked.

Validated here: 34 automated tests and the actual Chrome extension upload/pull smoke test. Settings also rendered and visually checked in Chrome. Firefox builds are generated from the same tested engine with the appropriate background-script manifest; Firefox runtime behavior and Docker execution have not been tested in this environment.

## Layout

- extension/: Manifest V3 worker, shared sync engine, popup, settings, and icons.
- server/: HTTP API and durable SQLite merge store.
- scripts/: browser manifests and dependency-free ZIP packaging.
- tests/: server, simulated browsers, and optional real Chromium smoke test.
- compose.yaml / compose.https.yaml / Caddyfile: local and HTTPS self-hosting.

API: public GET /health and authenticated POST /v1/sync. POST takes { protocol: 1, deviceId, operations }; each operation has seq, id, type (patch/delete), and fields for patches. Successful responses contain serverId, revision, acknowledged sequence, and records. The extension is the intended API client.

Browser implementation references: [Chrome bookmarks API](https://developer.chrome.com/docs/extensions/reference/api/bookmarks), [Chrome alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms), [Firefox background manifests](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background), and [Firefox data collection declarations](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings). Storage uses [Node's built-in SQLite API](https://nodejs.org/api/sqlite.html).
