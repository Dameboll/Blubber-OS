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
const homeDir = path.join(runtimeRoot, 'home');

for (const dir of [dataDir, musicDir, homeDir]) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.blubber-e2e-profile'), 'disposable test profile\n');
}

process.env.BLUBBER_DATA_DIR = dataDir;
process.env.BLUBBER_MUSIC_DIR = musicDir;
process.env.BLUBBER_PICKER_TOKEN = 'blubber-e2e-picker';
// Keep default project roots and ~/.claude transcript indexing inside the
// disposable profile too. Without this, the isolated test DB still walks the
// developer's real home directory, making the suite slow and privacy-unsafe.
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;

await import('../server.js');
