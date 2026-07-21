// Lane 1 — Pill Worlds image pipeline.
// Converts source inspo pics ("flubber inspo pics/") into optimized webp room plates
// in public/bg/, per the mapping table in docs/plans/pill-worlds-mini-dash.md.
//
// Usage: node scripts/convert-inspo.mjs
import sharp from "sharp";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT, "flubber inspo pics");
const OUT_DIR = path.join(ROOT, "public", "bg");

// [source filename, output filename, size] — size: "big" = max 1600w, "mini" = max 900w
const JOBS = [
  ["1.png", "pool.webp", "big"],
  ["2.png", "syslog.webp", "big"],
  ["3.png", "memory2.webp", "big"],
  ["4.png", "vault.webp", "big"],
  ["5.png", "telemetry.webp", "big"],
  ["6.png", "studio2.webp", "big"],
  ["7.png", "habitat.webp", "big"],
  ["8.png", "reactor.webp", "big"],
  // photoreal mini set
  ["mini 1.png", "role-coder2.webp", "mini"],
  ["mini 2.png", "role-qa2.webp", "mini"],
  ["mini 3.png", "role-security2.webp", "mini"],
  ["mini 4.png", "role-data2.webp", "mini"],
  ["mini 5.png", "role-devops2.webp", "mini"],
  ["mini 6.png", "role-designer2.webp", "mini"],
  // painterly mini set
  ["mini_flubber_architect.png", "role-architect2.webp", "mini"],
  ["mini_flubber_editor.png", "role-editor2.webp", "mini"],
  ["mini_flubber_innovator.png", "role-innovator2.webp", "mini"],
  ["mini_flubber_marketer.png", "role-marketer2.webp", "mini"],
  ["mini_flubber_researcher.png", "role-researcher2.webp", "mini"],
  ["mini_flubber_writer.png", "role-writer2.webp", "mini"],
];

const WIDTHS = { big: 1600, mini: 900 };

async function run() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  let ok = 0;
  let failed = 0;

  for (const [srcName, outName, size] of JOBS) {
    const srcPath = path.join(SRC_DIR, srcName);
    const outPath = path.join(OUT_DIR, outName);

    if (!fs.existsSync(srcPath)) {
      console.error(`[MISSING SOURCE] ${srcName} — skipping ${outName}`);
      failed++;
      continue;
    }

    try {
      await sharp(srcPath)
        .resize({ width: WIDTHS[size], withoutEnlargement: true })
        .webp({ quality: 72 })
        .toFile(outPath);

      const stat = fs.statSync(outPath);
      const kb = (stat.size / 1024).toFixed(1);
      const flag = stat.size > 300 * 1024 ? " ⚠ OVER 300KB" : "";
      console.log(`[OK] ${srcName} -> bg/${outName} (${kb}KB)${flag}`);
      ok++;
    } catch (err) {
      console.error(`[FAIL] ${srcName} -> ${outName}:`, err.message);
      failed++;
    }
  }

  console.log(`\nDone. ${ok} converted, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

run();
