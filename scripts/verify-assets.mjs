/**
 * verify-assets — guards the shipped asset surface.
 *
 * Why this exists: public/ ships whole, so anything dropped in there lands in
 * the deploy whether code loads it or not. Before 2026-07-19 that meant ~19.5MB
 * of dead weight — three superseded Flubber GLBs (one a byte-identical
 * duplicate of the live model), four unreferenced experimental GLBs, and the
 * retired PNG sprite pipeline. All invisible, all shipped.
 *
 * Every Flubber in the app is the ONE live V3.8 GLB rendered through the shared
 * FlubberHost (src/lib/flubber3d). Tiers (hero/mid/micro) are render paths over
 * that same mesh, NOT separate models — so a second .glb showing up here is
 * always either a mistake or a deliberate, reviewed addition.
 *
 * Run: node scripts/verify-assets.mjs   (or: npm run verify:assets)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The complete set of files allowed to live in public/models. */
const ALLOWED_MODELS = new Set(['flubber.glb', 'flubber-matcap.png', 'flubber-matcap-eye.png']);

/** Directories retired on 2026-07-19 that must never come back. */
const RETIRED_DIRS = ['public/flubber'];

const failures = [];

const modelsDir = path.join(root, 'public', 'models');
const found = fs.existsSync(modelsDir) ? fs.readdirSync(modelsDir).sort() : [];

for (const name of found) {
  if (!ALLOWED_MODELS.has(name)) {
    failures.push(
      `public/models/${name} is not in the allowed set. Every Flubber renders the ` +
        `one live flubber.glb — tiers are render paths, not extra models. If this ` +
        `asset is genuinely needed, add it to ALLOWED_MODELS with a reason.`
    );
  }
}

for (const name of ALLOWED_MODELS) {
  if (!found.includes(name)) failures.push(`public/models/${name} is MISSING — the app cannot render without it.`);
}

for (const dir of RETIRED_DIRS) {
  if (fs.existsSync(path.join(root, dir))) {
    failures.push(`${dir}/ is retired (PNG sprite pipeline, removed 2026-07-19) and must not exist.`);
  }
}

if (failures.length) {
  console.error('verify-assets FAILED:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}

console.log(`verify-assets OK — public/models holds exactly ${found.length} live files, no retired dirs.`);
