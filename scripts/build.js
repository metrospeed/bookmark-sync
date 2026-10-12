import { zipDirectory } from './zip.js';
import { mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
export async function build(output = 'dist') {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const destination = resolve(root, output);
  if (destination !== join(root, 'dist')) throw new Error('Build output must be the project dist directory');
  await mkdir(destination, { recursive: true });
  for (const browser of ['chrome', 'firefox']) {
    const target = join(destination, browser);
    await rm(target, { recursive: true, force: true });
    await cp(join(root, 'extension'), target, { recursive: true });
    if (browser === 'firefox') {
      const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'));
      delete manifest.minimum_chrome_version;
      manifest.background = { scripts: ['core.js', 'sync.js', 'background.js'] };
      manifest.browser_specific_settings = { gecko: { id: 'bookmark-sync@selfhosted.local', strict_min_version: '140.0', data_collection_permissions: { required: ['bookmarksInfo'], optional: [] } } };
      await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    }
    await zipDirectory(target, join(destination, 'bookmark-sync-' + browser + '.zip'));
  }
  console.log('Built dist/chrome and dist/firefox');
}
if (globalThis.process?.argv[1] && resolve(globalThis.process.argv[1]) === fileURLToPath(import.meta.url)) await build();
