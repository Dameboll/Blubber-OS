/**
 * blubber-voice — "blubber-speak": Animal-Crossing-style procedural
 * squeak-gibberish, synthesized live with the WebAudio API. No TTS engine, no
 * audio assets, no API keys — every sound Blubber ever makes is a handful of
 * OscillatorNodes and a GainNode envelope, built and torn down on the fly.
 *
 * WHY THIS EXISTS: the chat bubbles (DashboardTour, SoulInterview,
 * OnboardingOverlay) already carry the actual words. This module gives
 * Blubber a *voice* to go with them — personality expressed as pitch,
 * waveform, and rhythm, never as intelligible speech. The bubble text tells
 * you what he means; the blip-blip-blip tells you how he feels saying it.
 *
 * HOW A "WORD" BECOMES SOUND: speak(text) is not a TTS call — it never reads
 * the text out loud. It only uses the text's *shape* (word count, rough
 * syllable count per word from vowel-group counting) to decide how many
 * short pitched "blips" to play and where the natural pauses between words
 * fall. Each blip is a tiny two-oscillator note (a primary waveform plus a
 * quieter secondary waveform for texture) with a random pitch "wobble" layered
 * on top of a per-style base pitch — that wobble, plus the style's waveform
 * mix, is what gives each personality its distinct timbre (bubbly's airy
 * sine chirp vs. robo's flat, barely-wobbling square/saw buzz).
 *
 * PERSISTENCE: mirrors src/server/brain-store.ts's pattern exactly on the
 * server side (src/server/voice-store.ts, GET/POST /api/voice — a small
 * atomically-written JSON file). On the client, the resolved VoiceConfig is
 * cached in this module: getVoiceConfig() returns the cached value
 * synchronously (kicking off a background GET the very first time it's
 * called) and setVoiceConfig() updates the cache immediately, then persists
 * to the server on a short debounce so a user dragging a slider doesn't fire
 * a POST per pixel.
 *
 * AUTOPLAY POLICY: browsers only let a page create/resume an AudioContext
 * from inside a user-gesture-driven call stack (a click handler, etc.) — an
 * AudioContext created any other way starts (or stays) 'suspended' and plays
 * nothing. This module never creates the shared AudioContext eagerly; it's
 * built lazily on the first speak()/playCelebration() call, and if it's
 * suspended we ask it to resume() right there. Call sites in this app
 * include step-change effects that aren't literally a click — on browsers
 * that require a real gesture first, those early calls simply produce no
 * sound until the user has interacted with the page once, which is the
 * correct, honest behavior for an autoplay-gated API. Every entry point here
 * is wrapped in try/catch specifically so a blocked or failing AudioContext
 * can never throw into a caller's render path.
 *
 * NOTE: prefers-reduced-motion / the manual reduce-effects flag are about
 * VISUAL motion (see src/lib/reduce-effects.ts) and are a completely separate
 * concern from audio — this module never reads either of them. Muting is
 * controlled only by the `muted` field and a `volume` of 0 in VoiceConfig.
 */

import type { VoiceConfig, VoiceStyle } from '../server/voice-store';

export type { VoiceConfig, VoiceStyle };

// Duplicated (not imported) from voice-store.ts on purpose: that module pulls
// in `node:fs` and must never end up in a client bundle. Only VoiceConfig's
// *type* is imported above (erased at compile time by `import type`); this is
// the one piece of runtime data this module needs to validate a voiceStyle
// value, kept in sync by hand with voice-store.ts's own VOICE_STYLES list.
const VOICE_STYLES: VoiceStyle[] = ['bubbly', 'deep', 'squeaky', 'robo'];

const DEFAULT_CONFIG: VoiceConfig = {
  voiceStyle: 'bubbly',
  pitch: 55,
  speed: 60,
  volume: 70,
  // Muted by default (matches voice-store's shipped default) — opt-in from
  // Settings' Voice rail, never a surprise on first boot.
  muted: true,
};

/** Per-style synthesis character. basePitchHz + wobbleCents is what makes
 * each style recognizably itself: bubbly/squeaky wobble a lot (playful,
 * chattery), robo barely wobbles at all (flat, mechanical), deep sits low
 * with a quiet high-octave shimmer from its secondary oscillator. */
interface StyleProfile {
  waveform: OscillatorType;
  secondaryWaveform: OscillatorType;
  /** 0-1 mix weight of the secondary oscillator against the primary. */
  secondaryMix: number;
  /** Secondary oscillator's frequency as a multiple of the primary's. */
  secondaryFreqMult: number;
  basePitchHz: number;
  /** Max random pitch wobble per blip, in cents (100 cents = 1 semitone). */
  wobbleCents: number;
  /** Blip rate before the `speed` setting nudges it, in blips/sec. */
  blipsPerSecBase: number;
}

const STYLE_PROFILES: Record<VoiceStyle, StyleProfile> = {
  bubbly: {
    waveform: 'sine',
    secondaryWaveform: 'triangle',
    secondaryMix: 0.25,
    secondaryFreqMult: 1.01,
    basePitchHz: 460,
    wobbleCents: 200,
    blipsPerSecBase: 16,
  },
  deep: {
    waveform: 'triangle',
    secondaryWaveform: 'sine',
    secondaryMix: 0.2,
    secondaryFreqMult: 2.0,
    basePitchHz: 130,
    wobbleCents: 60,
    blipsPerSecBase: 12,
  },
  squeaky: {
    waveform: 'sine',
    secondaryWaveform: 'sine',
    secondaryMix: 0.15,
    secondaryFreqMult: 1.02,
    basePitchHz: 780,
    wobbleCents: 280,
    blipsPerSecBase: 18,
  },
  robo: {
    waveform: 'square',
    secondaryWaveform: 'sawtooth',
    secondaryMix: 0.35,
    secondaryFreqMult: 0.5,
    basePitchHz: 220,
    wobbleCents: 15,
    blipsPerSecBase: 14,
  },
};

const MIN_BLIPS_PER_SEC = 12;
const MAX_BLIPS_PER_SEC = 18;
/** Hard cap on any single utterance, per the spec — long bubble text still
 * only ever chatters for this long, never droning on. */
const DEFAULT_MAX_DURATION_MS = 2500;
/** Peak linear gain at volume=100, chosen low enough that two overlapping
 * oscillators per blip (primary + secondary) never clip. */
const PEAK_GAIN = 0.28;

export interface SpeakOptions {
  /** Overrides DEFAULT_MAX_DURATION_MS for this call only. */
  maxDurationMs?: number;
}

// ---------------------------------------------------------------------------
// Config: cached in module state, loaded once from the server, persisted on
// a short debounce. Mirrors the get/update shape of brain-store.ts, just
// living client-side with a network round trip instead of direct fs access.
// ---------------------------------------------------------------------------

let cachedConfig: VoiceConfig = { ...DEFAULT_CONFIG };
let hasLoadedFromServer = false;
let loadInFlight: Promise<void> | null = null;

function clamp01to100(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, v));
}

function sanitizePartial(partial: Partial<VoiceConfig>): Partial<VoiceConfig> {
  const next: Partial<VoiceConfig> = {};
  if (partial.voiceStyle !== undefined && VOICE_STYLES.includes(partial.voiceStyle)) {
    next.voiceStyle = partial.voiceStyle;
  }
  if (partial.pitch !== undefined) next.pitch = clamp01to100(partial.pitch);
  if (partial.speed !== undefined) next.speed = clamp01to100(partial.speed);
  if (partial.volume !== undefined) next.volume = clamp01to100(partial.volume);
  if (partial.muted !== undefined) next.muted = Boolean(partial.muted);
  return next;
}

/** Kicks off a one-time background GET /api/voice the first time any caller
 * touches the config. Never awaited by getVoiceConfig() itself — callers get
 * the cached (possibly still-default) value immediately, and the real value
 * lands in the cache moments later for the *next* call. */
function ensureLoadedFromServer(): void {
  if (hasLoadedFromServer || loadInFlight || typeof window === 'undefined') return;
  loadInFlight = fetch('/api/voice')
    .then((res) => (res.ok ? (res.json() as Promise<{ config?: VoiceConfig }>) : null))
    .then((data) => {
      if (data?.config) cachedConfig = { ...cachedConfig, ...sanitizePartial(data.config) };
    })
    .catch((err) => {
      console.error('[blubber-voice] failed to load config, using defaults:', err);
    })
    .finally(() => {
      hasLoadedFromServer = true;
      loadInFlight = null;
    });
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DEBOUNCE_MS = 400;

function schedulePersist(): void {
  if (typeof window === 'undefined') return;
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const config = cachedConfig;
    fetch('/api/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    }).catch((err) => {
      console.error('[blubber-voice] failed to persist config:', err);
    });
  }, PERSIST_DEBOUNCE_MS);
}

/** Current voice config. Synchronous — always returns the cached value, and
 * transparently triggers the one-time load from the server the first time
 * it's called (see ensureLoadedFromServer). */
export function getVoiceConfig(): VoiceConfig {
  ensureLoadedFromServer();
  return { ...cachedConfig };
}

/** Merge a partial update into the cached config (clamped/validated the same
 * way the server does) and persist it, debounced. Returns the merged config
 * immediately so a caller can reflect the new value in its own UI state
 * without waiting on the network. */
export function setVoiceConfig(partial: Partial<VoiceConfig>): VoiceConfig {
  hasLoadedFromServer = true; // a local write is authoritative going forward
  cachedConfig = { ...cachedConfig, ...sanitizePartial(partial) };
  schedulePersist();
  return { ...cachedConfig };
}

// ---------------------------------------------------------------------------
// Synthesis engine
// ---------------------------------------------------------------------------

let sharedCtx: AudioContext | null = null;
let sharedMasterGain: GainNode | null = null;

interface ScheduledBlip {
  osc1: OscillatorNode;
  osc2: OscillatorNode;
  gain: GainNode;
}

let activeUtterance: { blips: ScheduledBlip[] } | null = null;

/** Lazily creates the one shared AudioContext for the whole app. Must only
 * ever be called from inside speak()/playCelebration(), which are themselves
 * only ever called from user-gesture-adjacent call sites — see file header. */
function ensureAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (sharedCtx) return sharedCtx;
  const AudioContextCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return null;
  try {
    sharedCtx = new AudioContextCtor();
  } catch (err) {
    console.error('[blubber-voice] failed to create AudioContext:', err);
    return null;
  }
  return sharedCtx;
}

function ensureMasterGain(ctx: AudioContext): GainNode {
  if (sharedMasterGain) return sharedMasterGain;
  sharedMasterGain = ctx.createGain();
  sharedMasterGain.gain.value = 0;
  sharedMasterGain.connect(ctx.destination);
  return sharedMasterGain;
}

function volumeToGain(volume: number): number {
  return (clamp01to100(volume) / 100) * PEAK_GAIN;
}

function pitchMultiplier(pitch: number): number {
  // 0-100 -> 0.6x-1.4x of the style's base pitch.
  return 0.6 + (clamp01to100(pitch) / 100) * 0.8;
}

function wobbleRatio(wobbleCents: number): number {
  const randomCents = (Math.random() * 2 - 1) * wobbleCents;
  return Math.pow(2, randomCents / 1200);
}

function computeBlipsPerSec(style: StyleProfile, speed: number): number {
  // `speed` (0-100) nudges the style's natural rate up/down a few blips/sec
  // around its base, then the whole thing is clamped to the spec's overall
  // 12-18 blips/sec band so no combination ever falls outside it.
  const offset = ((clamp01to100(speed) - 50) / 50) * 3;
  return Math.min(MAX_BLIPS_PER_SEC, Math.max(MIN_BLIPS_PER_SEC, style.blipsPerSecBase + offset));
}

/** Rough vowel-group syllable count. Not linguistically exact — it only
 * needs to feel proportionate to a word's length, since nothing here is
 * actually pronouncing the word. */
function estimateSyllables(word: string): number {
  const matches = word.toLowerCase().match(/[aeiouy]+/g);
  return matches ? matches.length : 1;
}

/** Turns text into a per-word blip count, capped so the whole utterance
 * never exceeds maxBlips. Words are trimmed evenly (fair-share, at least 1
 * blip while budget remains) rather than just chopping the tail off, so a
 * capped long sentence still "gestures at" every word instead of only its
 * first few. */
function buildWordPlan(text: string, maxBlips: number): number[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const raw = words.map((w) => estimateSyllables(w));
  const total = raw.reduce((sum, n) => sum + n, 0);
  if (total <= maxBlips) return raw;

  const scaled: number[] = [];
  let used = 0;
  for (let i = 0; i < raw.length; i++) {
    if (used >= maxBlips) {
      scaled.push(0);
      continue;
    }
    const remainingWords = raw.length - i;
    const fairShare = Math.max(1, Math.round((maxBlips - used) / remainingWords));
    const take = Math.min(raw[i], fairShare, maxBlips - used);
    scaled.push(take);
    used += take;
  }
  return scaled;
}

/** Schedules one two-oscillator "blip" at an explicit frequency/time and
 * records its nodes so a later stopSpeaking() can silence it early. */
function scheduleOneBlip(
  ctx: AudioContext,
  masterGain: GainNode,
  style: StyleProfile,
  freq: number,
  startTime: number,
  duration: number,
  attack: number,
  outBlips: ScheduledBlip[],
): void {
  const osc1 = ctx.createOscillator();
  osc1.type = style.waveform;
  osc1.frequency.setValueAtTime(freq, startTime);

  const osc2 = ctx.createOscillator();
  osc2.type = style.secondaryWaveform;
  osc2.frequency.setValueAtTime(freq * style.secondaryFreqMult, startTime);

  const gain1 = ctx.createGain();
  gain1.gain.value = 1 - style.secondaryMix;
  const gain2 = ctx.createGain();
  gain2.gain.value = style.secondaryMix;

  const blipGain = ctx.createGain();
  // Exponential ramps can't touch 0 — start/settle at a near-silent epsilon.
  blipGain.gain.setValueAtTime(0.0001, startTime);
  blipGain.gain.exponentialRampToValueAtTime(1, startTime + attack);
  blipGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  osc1.connect(gain1).connect(blipGain);
  osc2.connect(gain2).connect(blipGain);
  blipGain.connect(masterGain);

  const stopAt = startTime + duration + 0.02;
  osc1.start(startTime);
  osc1.stop(stopAt);
  osc2.start(startTime);
  osc2.stop(stopAt);

  outBlips.push({ osc1, osc2, gain: blipGain });
}

/** Immediately silences whatever utterance is currently mid-flight, if any.
 * Safe to call with nothing playing. */
function cancelActiveUtterance(): void {
  if (!activeUtterance || !sharedCtx) {
    activeUtterance = null;
    return;
  }
  const ctx = sharedCtx;
  const now = ctx.currentTime;
  for (const blip of activeUtterance.blips) {
    try {
      blip.gain.gain.cancelScheduledValues(now);
      blip.gain.gain.setValueAtTime(blip.gain.gain.value, now);
      blip.gain.gain.linearRampToValueAtTime(0.0001, now + 0.02);
      blip.osc1.stop(now + 0.03);
      blip.osc2.stop(now + 0.03);
    } catch {
      // Nodes that already finished naturally throw on a second stop() —
      // harmless, they're already silent.
    }
  }
  activeUtterance = null;
}

/**
 * Speak a line of blubber-speak. Chops `text` into syllable-ish chunks and
 * plays one short pitched blip per chunk, pausing slightly longer between
 * words. Character comes entirely from the current VoiceConfig (voiceStyle,
 * pitch, speed, volume, muted). Fire-and-forget — never throws, never
 * returns a promise a caller needs to await; failures are logged and
 * swallowed so a broken AudioContext can never break the UI it's narrating.
 */
export function speak(text: string, opts?: SpeakOptions): void {
  try {
    if (typeof window === 'undefined') return;
    const config = getVoiceConfig();
    if (config.muted || config.volume <= 0) return;

    const trimmed = (text ?? '').trim();
    if (!trimmed) return;

    const ctx = ensureAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      // Best-effort — if the browser hasn't seen a user gesture yet this
      // silently stays suspended and the utterance just makes no sound.
      ctx.resume().catch(() => {});
    }

    cancelActiveUtterance();

    const style = STYLE_PROFILES[config.voiceStyle] ?? STYLE_PROFILES.bubbly;
    const blipsPerSec = computeBlipsPerSec(style, config.speed);
    const blipInterval = 1 / blipsPerSec;
    const maxDurationMs = opts?.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    const maxBlips = Math.max(1, Math.floor((maxDurationMs / 1000) * blipsPerSec));

    const wordPlan = buildWordPlan(trimmed, maxBlips);
    if (wordPlan.every((count) => count === 0)) return;

    const masterGain = ensureMasterGain(ctx);
    masterGain.gain.setTargetAtTime(volumeToGain(config.volume), ctx.currentTime, 0.01);

    const blips: ScheduledBlip[] = [];
    const blipDuration = blipInterval * 0.62;
    const attack = Math.min(0.012, blipDuration * 0.3);
    const pitchMult = pitchMultiplier(config.pitch);
    let t = ctx.currentTime + 0.02;

    for (const count of wordPlan) {
      for (let i = 0; i < count; i++) {
        const freq = style.basePitchHz * pitchMult * wobbleRatio(style.wobbleCents);
        scheduleOneBlip(ctx, masterGain, style, freq, t, blipDuration, attack, blips);
        t += blipInterval;
      }
      if (count > 0) t += blipInterval * 0.9; // extra pause between words
    }

    const totalDurationMs = (t - ctx.currentTime) * 1000;
    activeUtterance = { blips };
    window.setTimeout(() => {
      if (activeUtterance && activeUtterance.blips === blips) activeUtterance = null;
    }, totalDurationMs + 50);
  } catch (err) {
    console.error('[blubber-voice] speak failed:', err);
  }
}

/** Cuts off whatever Blubber is currently saying, immediately. Safe to call
 * with nothing playing, and never throws. */
export function stopSpeaking(): void {
  try {
    cancelActiveUtterance();
  } catch (err) {
    console.error('[blubber-voice] stopSpeaking failed:', err);
  }
}

// Settings > Appearance > "Sound Effects" gate for the non-voice riff. Distinct
// from the voice `muted` config (which silences speech): this switch governs
// the celebratory UI sound only. Default true; set by the app-wide prefs
// applier (AppShell) from ui prefs `soundEffects`.
let sfxEnabled = true;

/** Enable/disable the celebration riff (the "Sound Effects" setting). */
export function setSoundEffectsEnabled(value: boolean): void {
  sfxEnabled = value;
}

/** A short, wordless celebratory riff (three ascending blips) — the same
 * synth engine as speak(), just with no text and a fixed happy little
 * up-shape. Used for one-liner moments (quest claim, pet feed) that deserve
 * a sound but don't have a bubble line to chop up. */
export function playCelebration(): void {
  try {
    if (typeof window === 'undefined') return;
    if (!sfxEnabled) return;
    const config = getVoiceConfig();
    if (config.muted || config.volume <= 0) return;

    const ctx = ensureAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    cancelActiveUtterance();

    const style = STYLE_PROFILES[config.voiceStyle] ?? STYLE_PROFILES.bubbly;
    const blipsPerSec = computeBlipsPerSec(style, config.speed);
    const blipInterval = 1 / blipsPerSec;
    const blipDuration = blipInterval * 0.62;
    const attack = Math.min(0.012, blipDuration * 0.3);
    const pitchMult = pitchMultiplier(config.pitch);
    const baseFreq = style.basePitchHz * pitchMult;

    const masterGain = ensureMasterGain(ctx);
    masterGain.gain.setTargetAtTime(volumeToGain(config.volume), ctx.currentTime, 0.01);

    const blips: ScheduledBlip[] = [];
    let t = ctx.currentTime + 0.02;
    const RIFF_STEPS = [1, 1.26, 1.5]; // little rising "ta-da" shape
    for (const stepMult of RIFF_STEPS) {
      const freq = baseFreq * stepMult * wobbleRatio(style.wobbleCents * 0.4);
      scheduleOneBlip(ctx, masterGain, style, freq, t, blipDuration, attack, blips);
      t += blipInterval;
    }

    const totalDurationMs = (t - ctx.currentTime) * 1000;
    activeUtterance = { blips };
    window.setTimeout(() => {
      if (activeUtterance && activeUtterance.blips === blips) activeUtterance = null;
    }, totalDurationMs + 50);
  } catch (err) {
    console.error('[blubber-voice] playCelebration failed:', err);
  }
}
