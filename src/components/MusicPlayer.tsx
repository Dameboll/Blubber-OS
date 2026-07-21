'use client';

/**
 * MusicPlayer — real <audio> playback (play/pause/next/prev/volume) over a
 * playlist fetched from /api/tracks, a real 3-band Web Audio EQ, PLUS live
 * frequency analysis exposed to the parent via callbacks so Core3D's orb (and
 * MusicPlayerScreen's hero visualizer) can react to the music — both a
 * continuous loudness envelope AND discrete beat hits.
 *
 * ============================================================================
 * SINGLETON ENGINE (read this before wiring in a new consumer)
 * ============================================================================
 * Playback used to live inside this component's React state, which meant
 * navigating away from the Music screen unmounted the <audio> element and
 * killed the song. It now lives in a MODULE-LEVEL singleton below (the real
 * HTMLAudioElement + AudioContext graph + queue/playback state), created
 * lazily on first use and NEVER torn down on component unmount. Every
 * MusicPlayer instance (there's normally exactly one, mounted headless by
 * MusicPlayerScreen) is a thin view over that singleton via
 * `useSyncExternalStore` — mounting/unmounting the Music screen only
 * attaches/detaches a *view*, it never stops or restarts audio.
 *
 * The rAF loop that drives `onAudioEnergy`/`onBeat` (frequency analysis for
 * visualizers) DOES stop while no component is mounted to consume it — no
 * point burning frames for a visualizer nobody is looking at — but it
 * re-attaches cleanly the moment a consumer mounts again, and playback of the
 * actual audio is completely unaffected either way.
 *
 * ============================================================================
 * QUEUE MODEL (read this before wiring in a new consumer)
 * ============================================================================
 * `tracks` is the full library (everything in music/, from
 * /api/tracks) — stable, used for Library/Liked browsing and playlist
 * "add track" pickers. `queue` is the ordered list actually being played
 * through — `currentIndex`/`currentTrack`/next/prev/shuffle all operate on
 * `queue`, never on `tracks` directly. By default the queue mirrors the full
 * library (`playFromLibrary` re-syncs it explicitly); `playQueue(trackIds)`
 * swaps it to a specific ordered subset (e.g. a playlist) so next/prev/shuffle
 * stay confined to that playlist until another selection changes it again.
 * If the library changes underneath a playlist queue (a track gets deleted),
 * the queue is filtered to drop the vanished id rather than erroring.
 *
 * ============================================================================
 * PROP / CALLBACK CONTRACT (read this before wiring into page.tsx / Core3D)
 * ============================================================================
 *   interface MusicPlayerProps {
 *     onAudioEnergy?: (value: number) => void;  // smoothed 0-1 loudness envelope
 *     onBeat?: (strength: number) => void;      // fires on each detected beat
 *     variant?: 'full' | 'headless';            // 'full' (default) renders the
 *                                                 // original built-in chrome below.
 *                                                 // 'headless' renders no DOM at
 *                                                 // all — the real <audio>
 *                                                 // element lives outside React
 *                                                 // entirely (see singleton
 *                                                 // above) so a screen can build
 *                                                 // fully custom chrome driven by
 *                                                 // onStateChange + the ref API.
 *     onStateChange?: (state: MusicEngineState) => void; // full playback state,
 *                                                 // fires whenever any of it changes.
 *   }
 *
 * - `onAudioEnergy(value)` — smoothed 0-1 float, every animation-frame WHILE a
 *   track is playing; fires once with 0 on pause/stop/track-end. Drives the
 *   orb's continuous glow + "breathing" pump. Measured AFTER the EQ chain, so
 *   it reflects what's actually audible.
 * - `onBeat(strength)` — fires on a detected bass-drum onset (see the beat
 *   detector below). `strength` (~0.5-2) scales how hard that beat hit relative
 *   to the running average. Drives the orb's per-beat squash/bounce (page.tsx
 *   routes it into Core3D's existing firePulse impulse system). Debounced so it
 *   can't fire faster than MIN_BEAT_INTERVAL_MS.
 * - Plain callback props, not a context/store. Registered with the singleton
 *   via a stable per-instance consumer object so a parent passing an inline
 *   callback won't cause a stale-loop.
 * - No external API, no key: playback + analysis both run entirely on the
 *   native browser Web Audio API (AudioContext + createMediaElementSource +
 *   AnalyserNode + BiquadFilterNode).
 * ============================================================================
 *
 * REF API (for 'headless' consumers — see MusicPlayerHandle below): play(),
 * pause(), toggle(), next(), prev(), seek(time), setVolume(v),
 * selectTrack(index, autoplay?), toggleShuffle(), toggleRepeatOne(),
 * playFromLibrary(index, autoplay?), playQueue(trackIds, startIndex?, autoplay?),
 * refreshTracks(), setEq({ low, mid, high }). This is the single source of
 * truth for playback — a headless consumer never touches an <audio> element
 * itself, it only drives the singleton through this ref.
 *
 * Audio files are NOT served from /public — they live in music/ (relative
 * to the project root) and are streamed (with HTTP Range support, required for seeking + Safari)
 * through /api/audio/[filename].
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useSyncExternalStore } from 'react';
import { Music, Pause, Play, SkipBack, SkipForward, Volume2 } from 'lucide-react';
import './MusicPlayer.css';

export interface Track {
  id: string;
  title: string;
  file: string;
}

/** Real 3-band EQ gains in dB (typically -15..+15), applied live. */
export interface EqGains {
  low: number;
  mid: number;
  high: number;
}

/** Full playback snapshot handed to onStateChange whenever it changes. */
export interface MusicEngineState {
  /** Full library — every file in music/, unaffected by the active queue. */
  tracks: Track[];
  /** The ordered list actually being played through (library by default, or a playlist). */
  queue: Track[];
  loading: boolean;
  /** Index into `queue`, not `tracks`. */
  currentIndex: number;
  currentTrack: Track | undefined;
  isPlaying: boolean;
  volume: number;
  currentTime: number;
  duration: number;
  shuffle: boolean;
  repeatOne: boolean;
}

/** Imperative transport API exposed via ref — the only way a 'headless' consumer drives playback. */
export interface MusicPlayerHandle {
  play: () => void;
  pause: () => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (time: number) => void;
  setVolume: (value: number) => void;
  /** Selects by index WITHIN THE ACTIVE QUEUE (not the full library). */
  selectTrack: (index: number, autoplay?: boolean) => void;
  toggleShuffle: () => void;
  toggleRepeatOne: () => void;
  /** Resets the queue to the full library and plays the track at `index` within it. */
  playFromLibrary: (index: number, autoplay?: boolean) => void;
  /** Swaps the queue to this ordered set of track ids (e.g. a playlist) and plays it. */
  playQueue: (trackIds: string[], startIndex?: number, autoplay?: boolean) => void;
  /** Re-fetches /api/tracks (call after an upload/delete so the library updates live). */
  refreshTracks: () => Promise<void>;
  /** Sets the 3-band EQ gains (dB). Safe to call before the audio graph exists — cached and applied on first play. */
  setEq: (gains: EqGains) => void;
}

export interface MusicPlayerProps {
  /** Smoothed 0-1 loudness envelope, every frame while playing; 0 on stop. */
  onAudioEnergy?: (value: number) => void;
  /** Fires on each detected bass-drum beat with a ~0.5-2 strength value. */
  onBeat?: (strength: number) => void;
  /** 'full' (default) renders the built-in chrome. 'headless' renders no DOM. */
  variant?: 'full' | 'headless';
  /** Fires whenever any piece of playback state changes — the feed for a custom 'headless' UI. */
  onStateChange?: (state: MusicEngineState) => void;
}

/** Exponential smoothing for the loudness envelope — attack faster than decay. */
const ENERGY_ATTACK = 0.5;
const ENERGY_DECAY = 0.1;

// ---- beat detection tuning ----
// We isolate the low-frequency bins (kick/bass) and fire a beat when their
// instantaneous energy jumps well above their own running average — a simple,
// robust onset detector. Full-spectrum averaging (the old approach) drowns
// kick transients in the rest of the mix, which is why the orb never "danced".
const BASS_BIN_COUNT = 6; // first N FFT bins ≈ sub-bass / kick region at fftSize 512
const BEAT_THRESHOLD = 1.35; // instantaneous bass must exceed running avg × this
const BEAT_MIN_ENERGY = 0.18; // ignore beats in near-silence (0-1 normalized)
const MIN_BEAT_INTERVAL_MS = 130; // debounce — no beat can fire faster than this
const BASS_AVG_SMOOTHING = 0.92; // running-average inertia for the bass baseline

// ---- EQ tuning ----
const EQ_LOW_FREQ = 320; // lowshelf corner
const EQ_MID_FREQ = 1000; // peaking center
const EQ_MID_Q = 0.8;
const EQ_HIGH_FREQ = 3200; // highshelf corner

// ============================================================================
// MODULE-LEVEL SINGLETON ENGINE — survives every mount/unmount of this file's
// component. See the file header for why this exists. Nothing below this
// point touches `document`/`window` outside of functions, so importing this
// module during SSR is still safe (functions just never get called there).
// ============================================================================

interface EngineState {
  tracks: Track[];
  queue: Track[];
  loading: boolean;
  currentIndex: number;
  isPlaying: boolean;
  volume: number;
  currentTime: number;
  duration: number;
  shuffle: boolean;
  repeatOne: boolean;
}

let engineState: EngineState = {
  tracks: [],
  queue: [],
  loading: true,
  currentIndex: 0,
  isPlaying: false,
  volume: 0.8,
  currentTime: 0,
  duration: 0,
  shuffle: false,
  repeatOne: false,
};

const stateListeners = new Set<() => void>();

function emitState(patch: Partial<EngineState>): void {
  engineState = { ...engineState, ...patch };
  stateListeners.forEach((listener) => listener());
}

function subscribeState(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

function getEngineSnapshot(): EngineState {
  return engineState;
}

// 'library' = queue mirrors the full track list (default). 'playlist' = queue
// is a specific ordered subset chosen via playQueue(), only re-synced to drop
// ids that vanish from the library entirely.
let queueSource: 'library' | 'playlist' = 'library';

let audioEl: HTMLAudioElement | null = null;
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let mediaSource: MediaElementAudioSourceNode | null = null;
let eqLow: BiquadFilterNode | null = null;
let eqMid: BiquadFilterNode | null = null;
let eqHigh: BiquadFilterNode | null = null;
let pendingEq: EqGains = { low: 0, mid: 0, high: 0 };
let freqData: Uint8Array<ArrayBuffer> | null = null;

let smoothedEnergy = 0;
let bassAvg = 0;
let lastBeatAt = 0;
let rafId: number | null = null;

let initialized = false;

interface EnergyConsumer {
  onAudioEnergy?: (value: number) => void;
  onBeat?: (strength: number) => void;
}
const energyConsumers = new Set<EnergyConsumer>();

function absoluteAudioSrc(file: string): string {
  return `/api/audio/${encodeURIComponent(file)}`;
}

function handleTrackEnded(): void {
  stopEnergyLoop();

  if (engineState.repeatOne) {
    const el = audioEl;
    if (el) {
      el.currentTime = 0;
      enginePlay();
    }
    return;
  }

  if (engineState.queue.length > 1) {
    const targetIndex = engineState.shuffle ? pickRandomIndex(engineState.currentIndex) : engineState.currentIndex + 1;
    goToIndex(targetIndex, true);
  } else {
    emitState({ isPlaying: false });
  }
}

/** Lazily creates the real, module-persistent <audio> element (detached from
 *  any React tree so it's never unmounted) and wires its event listeners. */
function getAudioEl(): HTMLAudioElement {
  if (!audioEl) {
    const el = document.createElement('audio');
    el.preload = 'metadata';
    el.style.display = 'none';
    el.volume = engineState.volume;

    el.addEventListener('ended', handleTrackEnded);
    el.addEventListener('timeupdate', () => emitState({ currentTime: el.currentTime }));
    const onMeta = () => {
      el.volume = engineState.volume;
      emitState({ duration: Number.isFinite(el.duration) ? el.duration : 0 });
    };
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('durationchange', onMeta);

    document.body.appendChild(el);
    audioEl = el;
  }
  return audioEl;
}

/** Lazily creates the AudioContext graph (source -> EQ -> analyser -> destination) on first play (needs a user gesture). */
function ensureAudioGraph(): void {
  const el = getAudioEl();

  if (!audioCtx) {
    const AudioContextCtor =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioContextCtor();
    const newAnalyser = ctx.createAnalyser();
    newAnalyser.fftSize = 512; // more bins -> finer bass resolution for beat detection
    newAnalyser.smoothingTimeConstant = 0.55;

    // Real 3-band EQ: low-shelf / mid-peak / high-shelf, gains in dB driven
    // live by a consumer's setEq() call. Chained ahead of the analyser so the
    // visualizer + beat detector react to the actual EQ'd signal.
    const newEqLow = ctx.createBiquadFilter();
    newEqLow.type = 'lowshelf';
    newEqLow.frequency.value = EQ_LOW_FREQ;
    newEqLow.gain.value = pendingEq.low;

    const newEqMid = ctx.createBiquadFilter();
    newEqMid.type = 'peaking';
    newEqMid.frequency.value = EQ_MID_FREQ;
    newEqMid.Q.value = EQ_MID_Q;
    newEqMid.gain.value = pendingEq.mid;

    const newEqHigh = ctx.createBiquadFilter();
    newEqHigh.type = 'highshelf';
    newEqHigh.frequency.value = EQ_HIGH_FREQ;
    newEqHigh.gain.value = pendingEq.high;

    // createMediaElementSource may only ever be called once per element for
    // its whole lifetime — safe here because this whole graph is built at
    // most once, ever, regardless of how many times components mount.
    const newSource = ctx.createMediaElementSource(el);
    newSource.connect(newEqLow);
    newEqLow.connect(newEqMid);
    newEqMid.connect(newEqHigh);
    newEqHigh.connect(newAnalyser);
    newAnalyser.connect(ctx.destination); // keep — otherwise playback is silenced

    audioCtx = ctx;
    analyser = newAnalyser;
    mediaSource = newSource;
    eqLow = newEqLow;
    eqMid = newEqMid;
    eqHigh = newEqHigh;
    freqData = new Uint8Array(new ArrayBuffer(newAnalyser.frequencyBinCount));
  }

  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

function notifyEnergy(value: number): void {
  energyConsumers.forEach((consumer) => consumer.onAudioEnergy?.(value));
}

function notifyBeat(strength: number): void {
  energyConsumers.forEach((consumer) => consumer.onBeat?.(strength));
}

function runEnergyLoopStep(): void {
  rafId = null;
  if (!engineState.isPlaying || energyConsumers.size === 0) return;

  if (analyser && freqData) {
    analyser.getByteFrequencyData(freqData);

    // --- continuous loudness envelope (full-spectrum mean) ---
    let sum = 0;
    for (let i = 0; i < freqData.length; i++) sum += freqData[i];
    const rawEnergy = sum / freqData.length / 255;

    const rate = rawEnergy > smoothedEnergy ? ENERGY_ATTACK : ENERGY_DECAY;
    smoothedEnergy = smoothedEnergy + (rawEnergy - smoothedEnergy) * rate;
    notifyEnergy(smoothedEnergy);

    // --- beat detection (bass band + onset vs running average) ---
    let bassSum = 0;
    for (let i = 0; i < BASS_BIN_COUNT; i++) bassSum += freqData[i];
    const bass = bassSum / BASS_BIN_COUNT / 255;

    const now = performance.now();
    if (bass > BEAT_MIN_ENERGY && bass > bassAvg * BEAT_THRESHOLD && now - lastBeatAt > MIN_BEAT_INTERVAL_MS) {
      lastBeatAt = now;
      // strength scales with how far over the baseline this hit was
      const strength = bassAvg > 0 ? Math.min(bass / bassAvg, 2.4) : 1.2;
      notifyBeat(strength);
    }
    // Update the running bass baseline (slow, so it tracks the mix level but
    // not the individual transients we're detecting against).
    bassAvg = bassAvg * BASS_AVG_SMOOTHING + bass * (1 - BASS_AVG_SMOOTHING);
  }

  rafId = requestAnimationFrame(runEnergyLoopStep);
}

function maybeStartEnergyLoop(): void {
  if (rafId !== null) return;
  if (energyConsumers.size === 0) return;
  if (!engineState.isPlaying) return;
  rafId = requestAnimationFrame(runEnergyLoopStep);
}

function stopEnergyLoop(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  smoothedEnergy = 0;
  notifyEnergy(0);
}

function registerEnergyConsumer(consumer: EnergyConsumer): void {
  energyConsumers.add(consumer);
  maybeStartEnergyLoop();
}

function unregisterEnergyConsumer(consumer: EnergyConsumer): void {
  energyConsumers.delete(consumer);
  if (energyConsumers.size === 0 && rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function enginePlay(): void {
  const el = getAudioEl();
  ensureAudioGraph();
  el.play()
    .then(() => {
      emitState({ isPlaying: true });
      maybeStartEnergyLoop();
    })
    .catch((error) => {
      console.error('[MusicPlayer] play() failed:', error);
    });
}

function enginePause(): void {
  audioEl?.pause();
  emitState({ isPlaying: false });
  stopEnergyLoop();
}

function engineToggle(): void {
  if (engineState.isPlaying) enginePause();
  else enginePlay();
}

function pickRandomIndex(excludeIndex: number): number {
  const len = engineState.queue.length;
  if (len <= 1) return excludeIndex;
  let index = Math.floor(Math.random() * len);
  while (index === excludeIndex) {
    index = Math.floor(Math.random() * len);
  }
  return index;
}

/** Selects `index` WITHIN THE ACTIVE QUEUE, swaps the audio source, and
 *  (if `autoplay`) starts playback once the new source has enough data —
 *  mirrors the old React-effect race fix, just done imperatively. */
function goToIndex(index: number, autoplay: boolean): void {
  const queue = engineState.queue;
  if (queue.length === 0) return;
  const nextIndex = ((index % queue.length) + queue.length) % queue.length;
  const track = queue[nextIndex];

  emitState({ currentIndex: nextIndex, currentTime: 0, duration: 0 });

  const el = getAudioEl();
  el.src = track ? absoluteAudioSrc(track.file) : '';

  if (autoplay) {
    if (el.readyState >= 2) {
      enginePlay();
    } else {
      const onLoaded = () => {
        el.removeEventListener('loadeddata', onLoaded);
        enginePlay();
      };
      el.addEventListener('loadeddata', onLoaded, { once: true });
      el.load();
    }
  }
}

function engineNext(): void {
  const targetIndex = engineState.shuffle ? pickRandomIndex(engineState.currentIndex) : engineState.currentIndex + 1;
  goToIndex(targetIndex, engineState.isPlaying);
}

function enginePrev(): void {
  goToIndex(engineState.currentIndex - 1, engineState.isPlaying);
}

function engineSeek(time: number): void {
  const el = audioEl;
  if (!el) return;
  const safeMax = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : time;
  const clamped = Math.max(0, Math.min(time, safeMax));
  el.currentTime = clamped;
  emitState({ currentTime: clamped });
}

function engineSetVolume(value: number): void {
  const clamped = Math.max(0, Math.min(1, value));
  emitState({ volume: clamped });
  if (audioEl) audioEl.volume = clamped;
}

function engineSelectTrack(index: number, autoplay = true): void {
  goToIndex(index, autoplay);
}

function engineToggleShuffle(): void {
  emitState({ shuffle: !engineState.shuffle });
}

function engineToggleRepeatOne(): void {
  emitState({ repeatOne: !engineState.repeatOne });
}

function enginePlayFromLibrary(index: number, autoplay = true): void {
  const tracks = engineState.tracks;
  if (tracks.length === 0) return;
  queueSource = 'library';
  emitState({ queue: tracks });
  const safeIndex = ((index % tracks.length) + tracks.length) % tracks.length;
  goToIndex(safeIndex, autoplay);
}

function enginePlayQueue(trackIds: string[], startIndex = 0, autoplay = true): void {
  const resolved = trackIds
    .map((id) => engineState.tracks.find((t) => t.id === id))
    .filter((t): t is Track => Boolean(t));
  if (resolved.length === 0) return;
  queueSource = 'playlist';
  emitState({ queue: resolved });
  const safeIndex = ((startIndex % resolved.length) + resolved.length) % resolved.length;
  goToIndex(safeIndex, autoplay);
}

function engineSetEq(gains: EqGains): void {
  pendingEq = gains;
  if (eqLow) eqLow.gain.value = gains.low;
  if (eqMid) eqMid.gain.value = gains.mid;
  if (eqHigh) eqHigh.gain.value = gains.high;
}

/** Applies a freshly-fetched library to `tracks`/`queue`, and — only the very
 *  first time, before anything has ever been loaded — primes the <audio> src
 *  so duration/scrubbing are ready without forcing playback. Never touches
 *  the src again on subsequent refreshes so an in-progress track never gets
 *  interrupted by an upload/delete elsewhere in the library. */
function syncQueueFromTracks(freshTracks: Track[]): void {
  const newQueue =
    queueSource === 'library' ? freshTracks : engineState.queue.filter((t) => freshTracks.some((lib) => lib.id === t.id));

  const el = getAudioEl();
  const hadNoSrc = !el.src;

  emitState({ tracks: freshTracks, queue: newQueue });

  if (hadNoSrc) {
    const track = newQueue[engineState.currentIndex];
    if (track) el.src = absoluteAudioSrc(track.file);
  }
}

async function fetchTracksList(): Promise<void> {
  try {
    const res = await fetch('/api/tracks');
    const data: { tracks: Track[] } = await res.json();
    syncQueueFromTracks(data.tracks ?? []);
  } catch (error) {
    console.error('[MusicPlayer] failed to load /api/tracks:', error);
    syncQueueFromTracks([]);
  } finally {
    emitState({ loading: false });
  }
}

async function engineRefreshTracks(): Promise<void> {
  await fetchTracksList();
}

/** Runs exactly once across the whole app lifetime — creates the audio
 *  element and kicks off the initial library fetch. Safe to call from every
 *  mount; only the first call does anything. */
function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  getAudioEl();
  fetchTracksList();
}

// ============================================================================
// React view layer — a thin subscription over the singleton above.
// ============================================================================

const MusicPlayer = forwardRef<MusicPlayerHandle, MusicPlayerProps>(function MusicPlayer(
  { onAudioEnergy, onBeat, variant = 'full', onStateChange },
  ref
) {
  const state = useSyncExternalStore(subscribeState, getEngineSnapshot, getEngineSnapshot);

  // Stable per-instance consumer object so the module-level energy loop can
  // always call the LATEST callbacks a parent passed, without needing this
  // effect to re-run (and re-register) on every render.
  const consumerRef = useRef<EnergyConsumer>({});
  consumerRef.current.onAudioEnergy = onAudioEnergy;
  consumerRef.current.onBeat = onBeat;

  const onStateChangeRef = useRef(onStateChange);
  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);

  // Mount: ensure the singleton exists (idempotent) and register this
  // instance as an energy/beat consumer. Unmount: unregister only — the
  // audio element and its playback state are untouched.
  useEffect(() => {
    ensureInitialized();
    const consumer = consumerRef.current;
    registerEnergyConsumer(consumer);
    return () => unregisterEnergyConsumer(consumer);
  }, []);

  const currentTrack = state.queue[state.currentIndex];

  useEffect(() => {
    onStateChangeRef.current?.({
      tracks: state.tracks,
      queue: state.queue,
      loading: state.loading,
      currentIndex: state.currentIndex,
      currentTrack,
      isPlaying: state.isPlaying,
      volume: state.volume,
      currentTime: state.currentTime,
      duration: state.duration,
      shuffle: state.shuffle,
      repeatOne: state.repeatOne,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, currentTrack]);

  useImperativeHandle(
    ref,
    () => ({
      play: enginePlay,
      pause: enginePause,
      toggle: engineToggle,
      next: engineNext,
      prev: enginePrev,
      seek: engineSeek,
      setVolume: engineSetVolume,
      selectTrack: engineSelectTrack,
      toggleShuffle: engineToggleShuffle,
      toggleRepeatOne: engineToggleRepeatOne,
      playFromLibrary: enginePlayFromLibrary,
      playQueue: enginePlayQueue,
      refreshTracks: engineRefreshTracks,
      setEq: engineSetEq,
    }),
    []
  );

  // Headless consumers (MusicPlayerScreen) build 100% custom chrome fed by
  // onStateChange + the ref API. There is nothing to render here — the real
  // <audio> element lives outside React entirely (see the singleton above),
  // so it is never mounted/unmounted with this component.
  if (variant === 'headless') {
    return null;
  }

  if (state.loading) {
    return (
      <div className="music-player music-player--empty">
        <Music size={16} aria-hidden="true" />
        <span>Loading playlist…</span>
      </div>
    );
  }

  if (state.tracks.length === 0) {
    return (
      <div className="music-player music-player--empty">
        <Music size={16} aria-hidden="true" />
        <span>Drop audio files into music/ to get started</span>
      </div>
    );
  }

  return (
    <div className={`music-player${state.isPlaying ? ' music-player--playing' : ''}`}>
      <div className="music-player__now-playing">
        <Music size={14} aria-hidden="true" className="music-player__icon" />
        <span className="music-player__title">{currentTrack?.title ?? '—'}</span>
      </div>

      <div className="music-player__controls">
        <button type="button" className="music-player__btn" onClick={enginePrev} aria-label="Previous track">
          <SkipBack size={16} />
        </button>
        <button
          type="button"
          className="music-player__btn music-player__btn--primary"
          onClick={engineToggle}
          aria-label={state.isPlaying ? 'Pause' : 'Play'}
        >
          {state.isPlaying ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button type="button" className="music-player__btn" onClick={engineNext} aria-label="Next track">
          <SkipForward size={16} />
        </button>

        <div className="music-player__volume">
          <Volume2 size={14} aria-hidden="true" />
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={state.volume}
            onChange={(e) => engineSetVolume(Number(e.target.value))}
            aria-label="Volume"
          />
        </div>
      </div>

      <ul className="music-player__playlist">
        {state.queue.map((track, index) => (
          <li key={track.id}>
            <button
              type="button"
              className={`music-player__playlist-item${index === state.currentIndex ? ' music-player__playlist-item--active' : ''}`}
              onClick={() => goToIndex(index, true)}
              title={track.title}
            >
              {track.title}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
});

export default MusicPlayer;
