// Lane F — cinematic dashboard plate forge (Gemini Nano Banana Pro -> webp)
// Generates dark, green-lit sci-fi lab plates matching the existing public/bg grade.
// Usage: node scripts/gen-plates.mjs [name1 name2 ...]  (no args = all)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../public/bg");
const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error("NO GEMINI_API_KEY"); process.exit(3); }

const MODEL = "gemini-3-pro-image-preview";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;

const STYLE =
  "Cinematic wide establishing shot of a dark, near-black sci-fi laboratory environment. " +
  "Moody atmospheric lighting, deep shadows, volumetric haze, emerald and lime GREEN accent glow as the dominant light source, " +
  "subtle amber sub-accents, glossy dark surfaces with soft reflections, film grain, shallow depth of field, no text, no logos, no people, no characters. " +
  "Empty room / backdrop plate, composition leaves the center calm for UI overlay. Ultra-detailed, 8k, photographic, game-cinematic concept art.";

// logical name -> scene description
const PLATES = {
  "pet-arcade":    "a neon arcade corner with a glowing green retro cabinet, scanline CRT screens, coiled cables, dark tiled floor reflecting green light",
  "pet-questboard":"a mission board wall covered in pinned holographic quest cards and green string-lines, an ops planning nook, glowing task tiles",
  "pet-stats":     "a trophy and records hall, illuminated glass award pedestals and stat monoliths glowing green, museum-like dark gallery",
  "pet-needs":     "a cozy feeding nook / nourishment station, softly glowing green nutrient tubes and dispenser shelves, warm-cool contrast",
  "pet-level":     "a growth chamber / incubation pod room, a central glowing green cylindrical capsule, rising energy conduits, biotech lab",
  "dash-liveusage":"an energy meter wall of tall vertical glowing green power bars and gauges, a reactor readout corridor pulsing with charge",
  "dash-tokens":   "a central glowing green data core, orbiting light rings and streaming particle data conduits in a dark server sanctum",
  "dash-topagents":"a rank hall of illuminated leaderboard pillars and glowing green standings monoliths, competitive ops chamber",
  "dash-status":   "a mission control wall of dark monitoring panels and glowing green status indicators, a command bunker overview",
  "an-daily":      "a wall of tall glowing green bar-graph light columns, a data analytics gallery, rhythmic vertical light rhythm",
  "an-hours":      "a heat-map grid wall of small glowing green-to-amber cells forming a clock/heat matrix, temporal analytics lab",
  "an-burners":    "a furnace-like chamber of glowing green energy burners and consumption meters, intense reactor throughput room",
  "an-suggest":    "a softly lit advisory alcove with a glowing green idea/insight orb and gentle floating recommendation glyphs, calm think-tank nook",
  "an-projects":   "a hall of illuminated project vaults and glowing green archive shelves, an organized dark repository gallery",
  "an-recent":     "a timeline corridor of glowing green event streams and a flowing activity feed of light, recent-events data hallway",
};

const args = process.argv.slice(2);
const names = args.length ? args : Object.keys(PLATES);

async function genOne(name) {
  const scene = PLATES[name];
  if (!scene) throw new Error("unknown plate " + name);
  const prompt = `${STYLE}\nScene focus: ${scene}.`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: "3:2", imageSize: "2K" },
    },
  };
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const img = parts.find((p) => p.inlineData?.data);
  if (!img) throw new Error("no image in response: " + JSON.stringify(json).slice(0, 300));
  const buf = Buffer.from(img.inlineData.data, "base64");
  const outPath = path.join(OUT_DIR, `${name}.webp`);
  await sharp(buf)
    .resize(1536, 1024, { fit: "cover", position: "centre" })
    .webp({ quality: 82 })
    .toFile(outPath);
  const kb = Math.round(fs.statSync(outPath).size / 1024);
  console.log(`OK  ${name}.webp  ${kb}KB`);
  return true;
}

const results = {};
for (const name of names) {
  try {
    await genOne(name);
    results[name] = "ok";
  } catch (e) {
    console.error(`FAIL ${name}: ${e.message}`);
    results[name] = "fail";
  }
}
console.log("RESULTS " + JSON.stringify(results));
