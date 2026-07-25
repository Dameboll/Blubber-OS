/**
 * Start the real Blubber server against an isolated, disposable E2E profile.
 *
 * The Settings master-reset test intentionally changes every local store.
 * Running it against the normal repo-local ./data directory would change a
 * developer's Blubber state. The sentinel files make data migration treat
 * these test directories as already initialized, so no personal dev data is
 * copied into the disposable profile at startup.
 */
import fs from 'node:fs';
import path from 'node:path';

const runtimeRoot = path.join(process.cwd(), 'test-results', 'runtime-profile');
const dataDir = path.join(runtimeRoot, 'data');
const musicDir = path.join(runtimeRoot, 'music');

for (const dir of [dataDir, musicDir]) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.blubber-e2e-profile'), 'disposable test profile\n');
}

process.env.BLUBBER_DATA_DIR = dataDir;
process.env.BLUBBER_MUSIC_DIR = musicDir;

await import('../server.js');
