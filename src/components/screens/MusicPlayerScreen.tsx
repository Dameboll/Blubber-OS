'use client';

/**
 * MusicPlayerScreen — the "music" nav screen (see AppShell.tsx NAV_ITEMS).
 * Chrome-only: all real playback + Web Audio energy analysis lives in
 * MusicPlayer.tsx (mounted here in `variant="headless"`, i.e. it renders
 * nothing but an <audio> element). This screen drives it entirely through
 * MusicPlayer's ref API (play/pause/next/prev/seek/setVolume/selectTrack/
 * toggleShuffle/toggleRepeatOne/playFromLibrary/playQueue/refreshTracks/setEq)
 * and reads real state back via its `onStateChange` callback, plus
 * `onAudioEnergy`/`onBeat` for the visuals.
 *
 * Matches "flubber 2.png": tab strip, hero with FlubberCharacter on a
 * glowing platform between two speakers with a reactive equalizer
 * background, a Playlist Queue table, a sticky transport bar, and a right
 * rail (Now Playing / Playback Controls / Visualizer Mode / Equalizer).
 *
 * INDEX-SPACE NOTE (read before touching play handlers): MusicPlayer keeps
 * two lists — `engine.tracks` (the full library) and `engine.queue` (whatever
 * is actually playing: the library by default, or a playlist once one is
 * played). `engine.currentIndex` is ALWAYS an index into `engine.queue`, never
 * into `engine.tracks`. Row highlighting is done by track id, not index, so
 * it stays correct regardless of which list a given tab is rendering:
 *   - Now Playing's "Playlist Queue" panel renders `engine.queue` and plays
 *     rows via `playQueueTrackAt(index)` (queue-space).
 *   - Library / Liked tabs render `engine.tracks` and play rows via
 *     `playLibraryTrackAt(index)` (library-space — resets the queue to the
 *     full library first).
 *
 * Data reality check (see /api/tracks/route.ts): a Track is only
 * { id, title, file, sizeBytes } — no artist/producer, no duration, no art.
 * This screen never fabricates that missing metadata:
 *   - "prod. by" subtext -> replaced with an honest "local library" tag.
 *   - Album art -> a deterministic generated gradient tile (seeded off the
 *     track id), not a fake photo.
 *   - Duration -> read for REAL via a lightweight metadata-only probe
 *     (see useTrackDurations below), not guessed.
 *   - "Liked" state -> real, but session-local only (no backend for it yet).
 *
 * REAL EQ: the three sliders in EQUALIZER drive an actual 3-band Web Audio
 * chain (low-shelf / mid-peak / high-shelf BiquadFilters) inside MusicPlayer
 * via its `setEq()` ref method — not decorative bars. Slider values are 0-100
 * mapped to +/-EQ_MAX_GAIN_DB, 50 = 0dB (flat).
 *
 * LANE C VISUALIZER: the hero visualizer IS the Flubbers now — the old CSS
 * bar/radial/pulse strip is gone, replaced by MusicVisualizerFlubbers (a swarm
 * of shiny MID mini Flubbers that dance to the REAL analyser energy/beat, with
 * the hero DJ's stage lifting to the same signal). This is a SEPARATE surface:
 * it reacts only to whether music is PLAYING, never to the work/break clock
 * (LAW 1) — nothing here imports or reads isWorking. The "Visualizer Mode"
 * selector now picks the swarm's dance formation. Energy still feeds the small
 * per-track waveforms (rows + Now Playing rail), which stay as-is.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from 'react';
import {
  AudioWaveform,
  BarChart3,
  ChevronDown,
  Disc3,
  FolderPlus,
  GripVertical,
  Heart,
  MoreHorizontal,
  Music,
  Pause,
  Pencil,
  Play,
  Plus,
  Repeat,
  Repeat1,
  RotateCw,
  Shuffle,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import FlubberCharacter from '../FlubberCharacter';
import MusicVisualizerFlubbers from '../music/MusicVisualizerFlubbers';
import { Panel } from '../ui';
import MusicPlayer, { type MusicEngineState, type MusicPlayerHandle, type Track } from '../MusicPlayer';
import { useFlubberBrainApi } from '../../hooks/useFlubberBrain';
import './MusicPlayerScreen.css';

type ScreenTab = 'now-playing' | 'playlists' | 'library' | 'liked';
type VisualizerMode = 'bars' | 'wave' | 'radial' | 'pulse';
type EqPresetName = 'Flat' | 'Bass Boost' | 'Vocal' | 'Treble' | 'Custom';

interface Playlist {
  id: string;
  name: string;
  trackIds: string[];
  createdAt: string;
}

const TABS: { id: ScreenTab; label: string }[] = [
  { id: 'now-playing', label: 'Now Playing' },
  { id: 'playlists', label: 'Playlists' },
  { id: 'library', label: 'Library' },
  { id: 'liked', label: 'Liked Songs' },
];

// Order + default match the reference (flubber 2.png / fidelity-specs/music.md
// §3): waveform icon active by default, then radial, bar-chart, refresh/sync.
const VISUALIZER_MODES: { id: VisualizerMode; icon: typeof BarChart3; label: string }[] = [
  { id: 'wave', icon: AudioWaveform, label: 'Waveform' },
  { id: 'radial', icon: Disc3, label: 'Radial' },
  { id: 'bars', icon: BarChart3, label: 'Bars' },
  { id: 'pulse', icon: RotateCw, label: 'Pulse rings' },
];

// Real 3-band EQ (see MusicPlayer's setEq()). Slider values are 0-100;
// eqValueToDb() maps them to +/-EQ_MAX_GAIN_DB with 50 = flat (0dB).
const EQ_BANDS = ['Low', 'Mid', 'High'];
const EQ_MAX_GAIN_DB = 15;
const EQ_PRESET_NAMES: EqPresetName[] = ['Flat', 'Bass Boost', 'Vocal', 'Treble'];
const EQ_PRESETS: Record<EqPresetName, number[]> = {
  Flat: [50, 50, 50],
  'Bass Boost': [80, 56, 42],
  Vocal: [40, 66, 52],
  Treble: [40, 45, 78],
  Custom: [50, 50, 50], // placeholder label only reached via manual slider drags, never picked directly
};

function eqValueToDb(value: number): number {
  return ((value - 50) / 50) * EQ_MAX_GAIN_DB;
}

const ALLOWED_UPLOAD_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.ogg'];
const DELETE_CONFIRM_WINDOW_MS = 3000;

const EMPTY_ENGINE_STATE: MusicEngineState = {
  tracks: [],
  queue: [],
  loading: true,
  currentIndex: 0,
  currentTrack: undefined,
  isPlaying: false,
  volume: 0.8,
  currentTime: 0,
  duration: 0,
  shuffle: false,
  repeatOne: false,
};

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** "1 Song" / "5 Songs" — avoids the unconditional-plural "1 Songs" bug. */
function formatSongCount(count: number): string {
  return `${count} Song${count === 1 ? '' : 's'}`;
}

/** Deterministic 0..1 hash so per-track visuals (art hue, waveform shape) stay stable without real randomness. */
function hash01(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return (Math.abs(h) % 1000) / 1000;
}

/**
 * Lightweight, metadata-only duration probe per track file — separate
 * throwaway Audio() instances (never attached to the DOM, never the thing
 * that actually plays), so this never competes with MusicPlayer's real
 * playback element. Real durations, not fabricated ones.
 */
function useTrackDurations(tracks: Track[]): Map<string, number> {
  const [durations, setDurations] = useState<Map<string, number>>(() => new Map());
  const loadedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    tracks.forEach((track) => {
      if (loadedRef.current.has(track.id)) return;
      loadedRef.current.add(track.id);

      const probe = new Audio();
      probe.preload = 'metadata';
      probe.src = `/api/audio/${encodeURIComponent(track.file)}`;

      const handleLoaded = () => {
        if (cancelled || !Number.isFinite(probe.duration)) return;
        setDurations((prev) => {
          const next = new Map(prev);
          next.set(track.id, probe.duration);
          return next;
        });
      };
      probe.addEventListener('loadedmetadata', handleLoaded, { once: true });
      probe.addEventListener('error', () => {}, { once: true });
    });
    return () => {
      cancelled = true;
    };
  }, [tracks]);

  return durations;
}

interface TrackArtProps {
  seed: string;
  size?: number;
}

function TrackArt({ seed, size = 44 }: TrackArtProps) {
  const hue = 132 + Math.round(hash01(seed) * 46); // stays in the brand's green family
  return (
    <div
      className="mps-art"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(155deg, oklch(32% 0.08 ${hue}) 0%, oklch(13% 0.03 ${hue}) 100%)`,
      }}
      aria-hidden="true"
    >
      <Music size={Math.round(size * 0.36)} strokeWidth={1.5} />
    </div>
  );
}

interface WaveformProps {
  seed: string;
  count?: number;
  active: boolean;
  energy: number;
  height?: number;
}

function Waveform({ seed, count = 26, active, energy, height = 20 }: WaveformProps) {
  const bars = useMemo(() => Array.from({ length: count }, (_, i) => 0.22 + hash01(`${seed}-${i}`) * 0.78), [seed, count]);

  return (
    <div className={`mps-waveform${active ? ' mps-waveform--active' : ''}`} style={{ height }} aria-hidden="true">
      {bars.map((b, i) => {
        const scale = active ? Math.max(0.14, Math.min(1, b * (0.45 + energy * 1.2))) : b * 0.38;
        return (
          <span
            key={i}
            className="mps-waveform__bar"
            style={{ transform: `scaleY(${scale.toFixed(3)})`, animationDelay: `${(i % 8) * 60}ms` }}
          />
        );
      })}
    </div>
  );
}

interface TrackRowProps {
  track: Track;
  index: number;
  isActive: boolean;
  isPlaying: boolean;
  liked: boolean;
  duration: number | undefined;
  energy: number;
  onPlay: () => void;
  onToggleLike: () => void;
  /** Library tab only — replaces the decorative "more" button with a real inline-confirm delete. */
  onDelete?: () => void;
  deletePending?: boolean;
}

function TrackRow({
  track,
  index,
  isActive,
  isPlaying,
  liked,
  duration,
  energy,
  onPlay,
  onToggleLike,
  onDelete,
  deletePending,
}: TrackRowProps) {
  return (
    <li className={`mps-track${isActive ? ' mps-track--active' : ''}`}>
      <button
        type="button"
        className="mps-track__playcell"
        onClick={onPlay}
        aria-label={isActive && isPlaying ? `Pause ${track.title}` : `Play ${track.title}`}
      >
        <span className="mps-track__index">{index + 1}</span>
        <span className="mps-track__playicon">
          {isActive && isPlaying ? <Pause size={13} /> : <Play size={13} />}
        </span>
      </button>

      <button type="button" className="mps-track__main" onClick={onPlay}>
        <TrackArt seed={track.id} size={40} />
        <span className="mps-track__meta">
          <span className="mps-track__title">{track.title}</span>
          <span className="mps-track__sub">local library</span>
        </span>
      </button>

      <span className="mps-track__waveform">
        {isActive && <Waveform seed={track.id} count={20} active={isPlaying} energy={energy} height={18} />}
      </span>

      <span className="mps-track__duration">{duration !== undefined ? formatTime(duration) : '--:--'}</span>

      <button
        type="button"
        className={`mps-track__heart${liked ? ' mps-track__heart--active' : ''}`}
        onClick={onToggleLike}
        aria-label={liked ? `Unlike ${track.title}` : `Like ${track.title}`}
        aria-pressed={liked}
      >
        <Heart size={15} fill={liked ? 'currentColor' : 'none'} />
      </button>

      {onDelete ? (
        <button
          type="button"
          className={`mps-track__delete${deletePending ? ' mps-track__delete--confirm' : ''}`}
          onClick={onDelete}
          aria-label={deletePending ? `Confirm delete ${track.title}` : `Delete ${track.title}`}
          title={deletePending ? 'Click again to delete' : 'Delete track'}
        >
          <Trash2 size={14} />
        </button>
      ) : (
        <button type="button" className="mps-track__menu" aria-label={`More options for ${track.title}`}>
          <MoreHorizontal size={16} />
        </button>
      )}
    </li>
  );
}

/** A chunky studio monitor cabinet (dark box + glowing green woofer + tweeter),
 *  drawn in CSS so the oklch brand greens render reliably. Flanks the hero. */
function HeroSpeaker({ side, playing }: { side: 'left' | 'right'; playing: boolean }) {
  return (
    <div className={`mps-speaker mps-speaker--${side}${playing ? ' mps-speaker--live' : ''}`} aria-hidden="true">
      <span className="mps-speaker__tweeter" />
      <span className="mps-speaker__woofer" />
    </div>
  );
}

interface UploadState {
  name: string;
  progress: number;
  error?: string;
}

/** POSTs one file with real upload progress via XHR (fetch has no upload-progress event). */
function uploadTrackWithProgress(file: File, onProgress: (pct: number) => void): Promise<{ error?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/tracks');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText) as { error?: string };
        if (xhr.status >= 200 && xhr.status < 300) resolve({});
        else resolve({ error: data.error ?? `upload failed (HTTP ${xhr.status})` });
      } catch {
        resolve({ error: 'upload failed — unreadable server response' });
      }
    };
    xhr.onerror = () => resolve({ error: 'network error during upload' });
    const formData = new FormData();
    formData.append('file', file);
    xhr.send(formData);
  });
}

export default function MusicPlayerScreen() {
  const playerRef = useRef<MusicPlayerHandle>(null);
  const heroStageRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<MusicEngineState>(EMPTY_ENGINE_STATE);
  const [energy, setEnergy] = useState(0);
  // Stable live mirror of the loudness envelope — lets MusicVisualizerFlubbers
  // animate its swarm off real energy every frame WITHOUT re-rendering it each
  // frame (it's memoized; energy arrives via this ref, not a per-frame prop).
  const energyRef = useRef(0);
  const [beatPulseKey, setBeatPulseKey] = useState(0);
  const [beatStrength, setBeatStrength] = useState(1);
  const [activeTab, setActiveTab] = useState<ScreenTab>('now-playing');
  const [likedIds, setLikedIds] = useState<Set<string>>(() => new Set());
  const [visualizerMode, setVisualizerMode] = useState<VisualizerMode>('wave');
  const [eqPresetLabel, setEqPresetLabel] = useState<EqPresetName>('Flat');
  const [eqValues, setEqValues] = useState<number[]>(EQ_PRESETS.Flat);
  const [eqMenuOpen, setEqMenuOpen] = useState(false);
  // Ties the hero visualizer + FlubberCharacter's beat pulse to real audio
  // analysis (on by default, matching the reference). Off freezes the
  // mascot/visualizer at rest even while a track plays — a real toggle, not
  // decorative chrome.
  const [flubberSync, setFlubberSync] = useState(true);
  const lastVolumeRef = useRef(0.8);

  // ---- Library: upload + delete state ----
  const [uploads, setUploads] = useState<Map<string, UploadState>>(() => new Map());
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [trackDeleteConfirmId, setTrackDeleteConfirmId] = useState<string | null>(null);
  const trackDeleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- Playlists state ----
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [playlistsLoading, setPlaylistsLoading] = useState(true);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [expandedPlaylistId, setExpandedPlaylistId] = useState<string | null>(null);
  const [addTrackOpenFor, setAddTrackOpenFor] = useState<string | null>(null);
  const [renamingPlaylistId, setRenamingPlaylistId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [playlistDeleteConfirmId, setPlaylistDeleteConfirmId] = useState<string | null>(null);
  const playlistDeleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragTrackIndexRef = useRef<number | null>(null);

  const durations = useTrackDurations(engine.tracks);
  const brainApi = useFlubberBrainApi();
  const lastBrainPulseRef = useRef(0);

  const handleStateChange = useCallback((state: MusicEngineState) => setEngine(state), []);
  const handleAudioEnergy = useCallback((value: number) => {
    energyRef.current = value;
    setEnergy(value);
  }, []);
  const handleBeat = useCallback(
    (strength: number) => {
      if (!flubberSync) return;
      setBeatPulseKey((k) => k + 1);
      setBeatStrength(strength);
      // Brain-driven Flubbers pulse with the beat too, but throttled to ≥900ms
      // so a fast track doesn't storm re-renders across every mood-synced slot.
      const now = performance.now();
      if (now - lastBrainPulseRef.current >= 900) {
        lastBrainPulseRef.current = now;
        brainApi.pulse();
      }
    },
    [flubberSync, brainApi]
  );

  // Playing state feeds the brain so every mood-synced Blubber (hero, roamer)
  // shifts into dj-mode while a track plays, app-wide.
  useEffect(() => {
    brainApi.setMusic(engine.isPlaying && flubberSync);
    return () => brainApi.setMusic(false);
  }, [engine.isPlaying, flubberSync, brainApi]);

  // Push the real EQ gains into MusicPlayer's Web Audio chain whenever the
  // slider values change (mount + preset pick + manual drag).
  useEffect(() => {
    playerRef.current?.setEq({
      low: eqValueToDb(eqValues[0]),
      mid: eqValueToDb(eqValues[1]),
      high: eqValueToDb(eqValues[2]),
    });
  }, [eqValues]);

  // Clean up any pending inline-confirm timers on unmount.
  useEffect(() => {
    return () => {
      if (trackDeleteTimerRef.current) clearTimeout(trackDeleteTimerRef.current);
      if (playlistDeleteTimerRef.current) clearTimeout(playlistDeleteTimerRef.current);
    };
  }, []);

  const toggleLike = useCallback((id: string) => {
    setLikedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Plays a row from the "Playlist Queue" panel — index is IN THE ACTIVE QUEUE.
  const playQueueTrackAt = useCallback(
    (index: number) => {
      if (index === engine.currentIndex) {
        playerRef.current?.toggle();
      } else {
        playerRef.current?.selectTrack(index, true);
      }
    },
    [engine.currentIndex]
  );

  // Plays a row from Library/Liked — index is IN THE FULL LIBRARY, resets the
  // active queue to the library. Toggles instead of restarting if it's already
  // the current track (e.g. clicked from Liked while queued from a playlist).
  const playLibraryTrackAt = useCallback(
    (index: number) => {
      const track = engine.tracks[index];
      if (track && engine.currentTrack?.id === track.id) {
        playerRef.current?.toggle();
      } else {
        playerRef.current?.playFromLibrary(index, true);
      }
    },
    [engine.tracks, engine.currentTrack]
  );

  const handleScrub = useCallback(
    (value: number) => {
      playerRef.current?.seek((value / 100) * engine.duration);
    },
    [engine.duration]
  );

  const handleVolumeChange = useCallback((value: number) => {
    lastVolumeRef.current = value > 0 ? value : lastVolumeRef.current;
    playerRef.current?.setVolume(value);
  }, []);

  const toggleMute = useCallback(() => {
    if (engine.volume > 0) {
      lastVolumeRef.current = engine.volume;
      playerRef.current?.setVolume(0);
    } else {
      playerRef.current?.setVolume(lastVolumeRef.current || 0.8);
    }
  }, [engine.volume]);

  const applyEqPreset = useCallback((name: EqPresetName) => {
    setEqValues(EQ_PRESETS[name]);
    setEqPresetLabel(name);
    setEqMenuOpen(false);
  }, []);

  const updateEqBand = useCallback((bandIndex: number, value: number) => {
    setEqValues((prev) => prev.map((v, i) => (i === bandIndex ? value : v)));
    setEqPresetLabel('Custom');
  }, []);

  // ------------------------------------------------------------------ //
  // Library: upload + delete
  // ------------------------------------------------------------------ //

  const dismissUpload = useCallback((id: string) => {
    setUploads((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const handleFiles = useCallback((fileList: FileList | File[]) => {
    Array.from(fileList).forEach((file) => {
      const id = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const dot = file.name.lastIndexOf('.');
      const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';

      if (!ALLOWED_UPLOAD_EXTENSIONS.includes(ext)) {
        setUploads((prev) =>
          new Map(prev).set(id, {
            name: file.name,
            progress: 0,
            error: `unsupported file type — allowed: ${ALLOWED_UPLOAD_EXTENSIONS.join(', ')}`,
          })
        );
        return;
      }

      setUploads((prev) => new Map(prev).set(id, { name: file.name, progress: 0 }));

      uploadTrackWithProgress(file, (pct) => {
        setUploads((prev) => {
          const existing = prev.get(id);
          if (!existing) return prev;
          return new Map(prev).set(id, { ...existing, progress: pct });
        });
      }).then(({ error }) => {
        if (error) {
          setUploads((prev) => {
            const existing = prev.get(id);
            if (!existing) return prev;
            return new Map(prev).set(id, { ...existing, error });
          });
          return;
        }
        setUploads((prev) => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
        playerRef.current?.refreshTracks();
      });
    });
  }, []);

  const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragCounterRef.current += 1;
    setIsDraggingFile(true);
  }, []);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setIsDraggingFile(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDraggingFile(false);
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        setActiveTab('library');
        handleFiles(e.dataTransfer.files);
      }
    },
    [handleFiles]
  );

  const fetchPlaylists = useCallback(() => {
    fetch('/api/playlists')
      .then((res) => res.json())
      .then((data: { playlists: Playlist[] }) => setPlaylists(data.playlists ?? []))
      .catch(() => setPlaylists([]))
      .finally(() => setPlaylistsLoading(false));
  }, []);

  useEffect(() => {
    fetchPlaylists();
  }, [fetchPlaylists]);

  const requestDeleteTrack = useCallback(
    (id: string) => {
      if (trackDeleteConfirmId === id) {
        if (trackDeleteTimerRef.current) clearTimeout(trackDeleteTimerRef.current);
        setTrackDeleteConfirmId(null);
        fetch(`/api/tracks?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
          .catch(() => {})
          .finally(() => {
            playerRef.current?.refreshTracks();
            fetchPlaylists(); // the track may have been scrubbed out of playlists server-side
          });
        return;
      }
      setTrackDeleteConfirmId(id);
      if (trackDeleteTimerRef.current) clearTimeout(trackDeleteTimerRef.current);
      trackDeleteTimerRef.current = setTimeout(
        () => setTrackDeleteConfirmId((cur) => (cur === id ? null : cur)),
        DELETE_CONFIRM_WINDOW_MS
      );
    },
    [trackDeleteConfirmId, fetchPlaylists]
  );

  // ------------------------------------------------------------------ //
  // Playlists CRUD
  // ------------------------------------------------------------------ //

  const createPlaylist = useCallback(() => {
    const name = newPlaylistName.trim();
    if (!name) return;
    fetch('/api/playlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
      .catch(() => {})
      .finally(() => {
        setNewPlaylistName('');
        fetchPlaylists();
      });
  }, [newPlaylistName, fetchPlaylists]);

  const commitRenamePlaylist = useCallback(
    (id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) {
        setRenamingPlaylistId(null);
        return;
      }
      fetch('/api/playlists', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name: trimmed }),
      })
        .catch(() => {})
        .finally(() => {
          setRenamingPlaylistId(null);
          fetchPlaylists();
        });
    },
    [fetchPlaylists]
  );

  const requestDeletePlaylist = useCallback(
    (id: string) => {
      if (playlistDeleteConfirmId === id) {
        if (playlistDeleteTimerRef.current) clearTimeout(playlistDeleteTimerRef.current);
        setPlaylistDeleteConfirmId(null);
        fetch(`/api/playlists?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
          .catch(() => {})
          .finally(fetchPlaylists);
        return;
      }
      setPlaylistDeleteConfirmId(id);
      if (playlistDeleteTimerRef.current) clearTimeout(playlistDeleteTimerRef.current);
      playlistDeleteTimerRef.current = setTimeout(
        () => setPlaylistDeleteConfirmId((cur) => (cur === id ? null : cur)),
        DELETE_CONFIRM_WINDOW_MS
      );
    },
    [playlistDeleteConfirmId, fetchPlaylists]
  );

  const updatePlaylistTrackIds = useCallback(
    (id: string, trackIds: string[]) => {
      fetch('/api/playlists', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, trackIds }),
      })
        .catch(() => {})
        .finally(fetchPlaylists);
    },
    [fetchPlaylists]
  );

  const addTrackToPlaylist = useCallback(
    (playlist: Playlist, trackId: string) => {
      if (playlist.trackIds.includes(trackId)) return;
      updatePlaylistTrackIds(playlist.id, [...playlist.trackIds, trackId]);
    },
    [updatePlaylistTrackIds]
  );

  const removeTrackFromPlaylist = useCallback(
    (playlist: Playlist, trackId: string) => {
      updatePlaylistTrackIds(
        playlist.id,
        playlist.trackIds.filter((id) => id !== trackId)
      );
    },
    [updatePlaylistTrackIds]
  );

  const reorderPlaylistTrack = useCallback(
    (playlist: Playlist, fromIndex: number, toIndex: number) => {
      if (fromIndex === toIndex) return;
      const next = [...playlist.trackIds];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      updatePlaylistTrackIds(playlist.id, next);
    },
    [updatePlaylistTrackIds]
  );

  const playPlaylist = useCallback((playlist: Playlist, startIndex = 0) => {
    if (playlist.trackIds.length === 0) return;
    playerRef.current?.playQueue(playlist.trackIds, startIndex, true);
    setActiveTab('now-playing');
  }, []);

  const hasLibraryTracks = engine.tracks.length > 0;
  const hasQueueTracks = engine.queue.length > 0;
  const currentTrack = engine.currentTrack;
  const currentLiked = currentTrack ? likedIds.has(currentTrack.id) : false;
  const progressPct = engine.duration > 0 ? Math.min(100, (engine.currentTime / engine.duration) * 100) : 0;

  const totalQueueDuration = useMemo(() => {
    if (engine.queue.length === 0) return null;
    let sum = 0;
    for (const t of engine.queue) {
      const d = durations.get(t.id);
      if (d === undefined) return null;
      sum += d;
    }
    return sum;
  }, [engine.queue, durations]);

  const likedTracks = useMemo(() => engine.tracks.filter((t) => likedIds.has(t.id)), [engine.tracks, likedIds]);

  return (
    <div
      className="mps-root"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDraggingFile && (
        <div className="mps-drop-overlay" aria-hidden="true">
          <Upload size={40} />
          <p>Drop to add to your library</p>
        </div>
      )}

      <MusicPlayer ref={playerRef} variant="headless" onStateChange={handleStateChange} onAudioEnergy={handleAudioEnergy} onBeat={handleBeat} />

      <div className="mps-scroll">
        <div className="mps-header">
          <div className="mps-header__title">
            <Music size={15} aria-hidden="true" />
            <span className="section-label">Music Player</span>
          </div>

          <div className="mps-tabs" role="tablist" aria-label="Music Player views">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                className={`mps-tab${activeTab === tab.id ? ' mps-tab--active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {activeTab === 'now-playing' && (
          <div className="mps-layout">
            <div className="mps-main">
              <section className={`mps-hero${engine.isPlaying ? ' mps-hero--playing' : ''}`} aria-label="Now playing visualizer">
                <div className="mps-hero__backdrop" aria-hidden="true" />
                <div className={`mps-hero__platform${engine.isPlaying ? ' mps-hero__platform--active' : ''}`} aria-hidden="true" />
                <HeroSpeaker side="left" playing={engine.isPlaying} />
                <HeroSpeaker side="right" playing={engine.isPlaying} />
                <MusicVisualizerFlubbers
                  energyRef={energyRef}
                  beatKey={beatPulseKey}
                  beatStrength={beatStrength}
                  playing={engine.isPlaying}
                  enabled={flubberSync}
                  formation={visualizerMode}
                  heroStageRef={heroStageRef}
                />
                <div className="mps-hero__stage" ref={heroStageRef}>
                  <FlubberCharacter
                    expression="dj-mode"
                    size={300}
                    mode="character"
                    showToggle={false}
                    pulseKey={beatPulseKey}
                    accessory="dj-headphones"
                  />
                </div>
              </section>

            </div>

            <aside className="mps-rail">
              <Panel title="NOW PLAYING">
                <div className="mps-now-playing">
                  <TrackArt seed={currentTrack?.id ?? 'idle'} size={168} />
                  <div className="mps-now-playing__row">
                    <span className="mps-now-playing__meta">
                      <span className="mps-now-playing__title">{currentTrack?.title ?? '—'}</span>
                      <span className="mps-now-playing__sub">{currentTrack ? 'local library' : '—'}</span>
                    </span>
                    <button
                      type="button"
                      className={`mps-track__heart${currentLiked ? ' mps-track__heart--active' : ''}`}
                      onClick={() => currentTrack && toggleLike(currentTrack.id)}
                      disabled={!currentTrack}
                      aria-label={currentLiked ? 'Unlike current track' : 'Like current track'}
                      aria-pressed={currentLiked}
                    >
                      <Heart size={16} fill={currentLiked ? 'currentColor' : 'none'} />
                    </button>
                  </div>
                  <Waveform seed={currentTrack?.id ?? 'idle'} count={34} active={engine.isPlaying} energy={energy} height={28} />
                  <div className="mps-now-playing__time">
                    <span>{formatTime(engine.currentTime)}</span>
                    <span>{formatTime(engine.duration)}</span>
                  </div>
                </div>
              </Panel>

              <Panel title="PLAYBACK CONTROLS">
                <div className="mps-controls mps-controls--lg">
                  <button
                    type="button"
                    className={`mps-transport-btn${engine.shuffle ? ' mps-transport-btn--active' : ''}`}
                    onClick={() => playerRef.current?.toggleShuffle()}
                    disabled={!hasQueueTracks}
                    aria-pressed={engine.shuffle}
                    aria-label="Toggle shuffle"
                  >
                    <Shuffle size={17} />
                  </button>
                  <button type="button" className="mps-transport-btn" onClick={() => playerRef.current?.prev()} disabled={!hasQueueTracks} aria-label="Previous track">
                    <SkipBack size={19} />
                  </button>
                  <button
                    type="button"
                    className="mps-transport-btn mps-transport-btn--play"
                    onClick={() => playerRef.current?.toggle()}
                    disabled={!hasQueueTracks}
                    aria-label={engine.isPlaying ? 'Pause' : 'Play'}
                  >
                    {engine.isPlaying ? <Pause size={22} /> : <Play size={22} />}
                  </button>
                  <button type="button" className="mps-transport-btn" onClick={() => playerRef.current?.next()} disabled={!hasQueueTracks} aria-label="Next track">
                    <SkipForward size={19} />
                  </button>
                  <button
                    type="button"
                    className={`mps-transport-btn${engine.repeatOne ? ' mps-transport-btn--active' : ''}`}
                    onClick={() => playerRef.current?.toggleRepeatOne()}
                    disabled={!hasQueueTracks}
                    aria-pressed={engine.repeatOne}
                    aria-label="Toggle repeat"
                  >
                    {engine.repeatOne ? <Repeat1 size={17} /> : <Repeat size={17} />}
                  </button>
                </div>
              </Panel>

              <Panel title="VISUALIZER MODE">
                <div className="mps-viz-modes">
                  {VISUALIZER_MODES.map((mode) => {
                    const Icon = mode.icon;
                    const active = visualizerMode === mode.id;
                    return (
                      <button
                        key={mode.id}
                        type="button"
                        className={`mps-viz-btn${active ? ' mps-viz-btn--active' : ''}`}
                        onClick={() => setVisualizerMode(mode.id)}
                        aria-pressed={active}
                        title={mode.label}
                        aria-label={mode.label}
                      >
                        <Icon size={17} />
                      </button>
                    );
                  })}
                </div>

                <div className="mps-viz-sync">
                  <span className="mps-viz-sync__label">Blubber Sync</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={flubberSync}
                    aria-label="Toggle Blubber Sync — ties the hero visualizer and mascot to the beat"
                    title="Ties the hero visualizer and mascot pulse to real audio analysis"
                    className={`mps-viz-sync__toggle${flubberSync ? ' mps-viz-sync__toggle--on' : ''}`}
                    onClick={() => setFlubberSync((v) => !v)}
                  >
                    <span className="mps-viz-sync__thumb" />
                  </button>
                </div>
              </Panel>

              <Panel
                title="PLAYLIST QUEUE"
                action={
                  <span className="mps-queue-meta">
                    {hasQueueTracks && <span>{formatSongCount(engine.queue.length)}</span>}
                    {totalQueueDuration !== null && <span>{formatTime(totalQueueDuration)}</span>}
                  </span>
                }
              >
                {engine.loading && <p className="mps-empty">Loading playlist…</p>}
                {!engine.loading && !hasQueueTracks && <p className="mps-empty">Drop audio files into music/ (or use the Library tab) to get started</p>}
                {!engine.loading && hasQueueTracks && (
                  <ul className="mps-track-list mps-rail-queue">
                    {engine.queue.map((track, index) => (
                      <TrackRow
                        key={track.id}
                        track={track}
                        index={index}
                        isActive={currentTrack?.id === track.id}
                        isPlaying={engine.isPlaying}
                        liked={likedIds.has(track.id)}
                        duration={durations.get(track.id)}
                        energy={energy}
                        onPlay={() => playQueueTrackAt(index)}
                        onToggleLike={() => toggleLike(track.id)}
                      />
                    ))}
                  </ul>
                )}
              </Panel>
            </aside>
          </div>
        )}

        {activeTab === 'library' && (
          <>
            <Panel avoidRoam title="UPLOAD MUSIC">
              <div
                className={`mps-dropzone${isDraggingFile ? ' mps-dropzone--active' : ''}`}
                onClick={() => fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
                }}
              >
                <Upload size={22} aria-hidden="true" />
                <p>Drag audio files here, or click to browse</p>
                <span className="mps-dropzone__hint">.mp3, .wav, .m4a, .ogg — up to 60MB each</span>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".mp3,.wav,.m4a,.ogg,audio/*"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) handleFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              {uploads.size > 0 && (
                <ul className="mps-uploads">
                  {Array.from(uploads.entries()).map(([id, u]) => (
                    <li key={id} className={`mps-upload${u.error ? ' mps-upload--error' : ''}`}>
                      <span className="mps-upload__name">{u.name}</span>
                      {u.error ? (
                        <span className="mps-upload__error">{u.error}</span>
                      ) : (
                        <div className="mps-upload__bar" role="progressbar" aria-valuenow={u.progress} aria-valuemin={0} aria-valuemax={100}>
                          <span style={{ transform: `scaleX(${u.progress / 100})` }} />
                        </div>
                      )}
                      <button type="button" className="mps-upload__dismiss" onClick={() => dismissUpload(id)} aria-label={`Dismiss ${u.name}`}>
                        <X size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="LIBRARY" avoidRoam action={hasLibraryTracks ? <span className="mps-queue-meta">{formatSongCount(engine.tracks.length)}</span> : undefined}>
              {engine.loading && <p className="mps-empty">Loading playlist…</p>}
              {!engine.loading && !hasLibraryTracks && (
                <p className="mps-empty">Drop audio files above, or straight into music/, to get started</p>
              )}
              {!engine.loading && hasLibraryTracks && (
                <ul className="mps-track-list">
                  {engine.tracks.map((track, index) => (
                    <TrackRow
                      key={track.id}
                      track={track}
                      index={index}
                      isActive={currentTrack?.id === track.id}
                      isPlaying={engine.isPlaying}
                      liked={likedIds.has(track.id)}
                      duration={durations.get(track.id)}
                      energy={energy}
                      onPlay={() => playLibraryTrackAt(index)}
                      onToggleLike={() => toggleLike(track.id)}
                      onDelete={() => requestDeleteTrack(track.id)}
                      deletePending={trackDeleteConfirmId === track.id}
                    />
                  ))}
                </ul>
              )}
            </Panel>
          </>
        )}

        {activeTab === 'liked' && (
          <Panel title="LIKED SONGS" action={likedTracks.length > 0 ? <span className="mps-queue-meta">{formatSongCount(likedTracks.length)}</span> : undefined}>
            {likedTracks.length === 0 ? (
              <div className="mps-tab-empty">
                <FlubberCharacter expression="thinking" size={64} mode="character" showToggle={false} />
                <p>Nothing liked yet — tap the heart on any track to save it here.</p>
              </div>
            ) : (
              <ul className="mps-track-list">
                {likedTracks.map((track) => {
                  const index = engine.tracks.findIndex((t) => t.id === track.id);
                  return (
                    <TrackRow
                      key={track.id}
                      track={track}
                      index={index}
                      isActive={currentTrack?.id === track.id}
                      isPlaying={engine.isPlaying}
                      liked
                      duration={durations.get(track.id)}
                      energy={energy}
                      onPlay={() => playLibraryTrackAt(index)}
                      onToggleLike={() => toggleLike(track.id)}
                    />
                  );
                })}
              </ul>
            )}
          </Panel>
        )}

        {activeTab === 'playlists' && (
          <Panel
            title="PLAYLISTS"
            action={playlists.length > 0 ? <span className="mps-queue-meta">{playlists.length === 1 ? '1 Playlist' : `${playlists.length} Playlists`}</span> : undefined}
          >
            <div className="mps-playlist-create">
              <input
                type="text"
                value={newPlaylistName}
                onChange={(e) => setNewPlaylistName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createPlaylist();
                }}
                placeholder="New playlist name…"
                className="mps-playlist-create__input"
                aria-label="New playlist name"
              />
              <button
                type="button"
                className="mps-playlist-create__btn"
                onClick={createPlaylist}
                disabled={!newPlaylistName.trim()}
              >
                <Plus size={15} />
                Create
              </button>
            </div>

            {playlistsLoading && <p className="mps-empty">Loading playlists…</p>}

            {!playlistsLoading && playlists.length === 0 && (
              <div className="mps-tab-empty">
                <FlubberCharacter expression="worried" size={64} mode="character" showToggle={false} />
                <p>No playlists yet — name one above to start collecting tracks.</p>
              </div>
            )}

            {!playlistsLoading && playlists.length > 0 && (
              <ul className="mps-playlist-list">
                {playlists.map((playlist) => {
                  const expanded = expandedPlaylistId === playlist.id;
                  const renaming = renamingPlaylistId === playlist.id;
                  const playlistTracks = playlist.trackIds
                    .map((id) => engine.tracks.find((t) => t.id === id))
                    .filter((t): t is Track => Boolean(t));
                  const availableToAdd = engine.tracks.filter((t) => !playlist.trackIds.includes(t.id));
                  const deletePending = playlistDeleteConfirmId === playlist.id;

                  return (
                    <li key={playlist.id} className="mps-playlist">
                      <div className="mps-playlist__row">
                        <button
                          type="button"
                          className="mps-playlist__expand"
                          onClick={() => setExpandedPlaylistId(expanded ? null : playlist.id)}
                          aria-expanded={expanded}
                          aria-label={expanded ? `Collapse ${playlist.name}` : `Expand ${playlist.name}`}
                        >
                          <ChevronDown size={14} style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
                        </button>

                        {renaming ? (
                          <input
                            type="text"
                            className="mps-playlist__rename-input"
                            value={renameDraft}
                            autoFocus
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitRenamePlaylist(playlist.id, renameDraft);
                              if (e.key === 'Escape') setRenamingPlaylistId(null);
                            }}
                            onBlur={() => commitRenamePlaylist(playlist.id, renameDraft)}
                            aria-label={`Rename ${playlist.name}`}
                          />
                        ) : (
                          <button type="button" className="mps-playlist__name" onClick={() => setExpandedPlaylistId(expanded ? null : playlist.id)}>
                            {playlist.name}
                          </button>
                        )}

                        <span className="mps-playlist__count">{formatSongCount(playlist.trackIds.length)}</span>

                        <button
                          type="button"
                          className="mps-icon-btn"
                          onClick={() => playPlaylist(playlist, 0)}
                          disabled={playlist.trackIds.length === 0}
                          aria-label={`Play ${playlist.name} as queue`}
                          title="Play as queue"
                        >
                          <Play size={14} />
                        </button>

                        <button
                          type="button"
                          className="mps-icon-btn"
                          onClick={() => {
                            setRenamingPlaylistId(playlist.id);
                            setRenameDraft(playlist.name);
                          }}
                          aria-label={`Rename ${playlist.name}`}
                          title="Rename"
                        >
                          <Pencil size={13} />
                        </button>

                        <button
                          type="button"
                          className={`mps-icon-btn mps-icon-btn--danger${deletePending ? ' mps-icon-btn--confirm' : ''}`}
                          onClick={() => requestDeletePlaylist(playlist.id)}
                          aria-label={deletePending ? `Confirm delete ${playlist.name}` : `Delete ${playlist.name}`}
                          title={deletePending ? 'Click again to delete' : 'Delete playlist'}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>

                      {expanded && (
                        <div className="mps-playlist__body">
                          {playlistTracks.length === 0 ? (
                            <p className="mps-empty">No tracks yet — add some from your library below.</p>
                          ) : (
                            <ul className="mps-playlist__tracks">
                              {playlistTracks.map((track, idx) => (
                                <li
                                  key={track.id}
                                  className="mps-playlist__track"
                                  draggable
                                  onDragStart={() => {
                                    dragTrackIndexRef.current = idx;
                                  }}
                                  onDragOver={(e) => e.preventDefault()}
                                  onDrop={(e) => {
                                    e.preventDefault();
                                    const from = dragTrackIndexRef.current;
                                    dragTrackIndexRef.current = null;
                                    if (from === null) return;
                                    reorderPlaylistTrack(playlist, from, idx);
                                  }}
                                >
                                  <GripVertical size={14} className="mps-playlist__grip" aria-hidden="true" />
                                  <span className="mps-playlist__track-title">{track.title}</span>
                                  <button
                                    type="button"
                                    className="mps-icon-btn"
                                    onClick={() => removeTrackFromPlaylist(playlist, track.id)}
                                    aria-label={`Remove ${track.title} from ${playlist.name}`}
                                  >
                                    <X size={13} />
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}

                          <div className="mps-playlist__add">
                            <button
                              type="button"
                              className="mps-playlist__add-toggle"
                              onClick={() => setAddTrackOpenFor(addTrackOpenFor === playlist.id ? null : playlist.id)}
                            >
                              <FolderPlus size={14} />
                              Add tracks
                            </button>
                            {addTrackOpenFor === playlist.id && (
                              <ul className="mps-playlist__add-list">
                                {availableToAdd.length === 0 ? (
                                  <li className="mps-empty">Every library track is already in this playlist.</li>
                                ) : (
                                  availableToAdd.map((track) => (
                                    <li key={track.id}>
                                      <button type="button" onClick={() => addTrackToPlaylist(playlist, track.id)}>
                                        <Plus size={12} />
                                        {track.title}
                                      </button>
                                    </li>
                                  ))
                                )}
                              </ul>
                            )}
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        )}
      </div>

      {/* Two separate, column-aligned widgets (not one merged full-width bar):
          the mini player bar is confined to the main column's width; the
          volume strip is its own box sitting under the right rail, at the
          same row height. */}
      <div className="mps-bottom-bar">
        <div className="mps-transport-bar" data-flubber-avoid="true">
          <div className="mps-transport-bar__now">
            <TrackArt seed={currentTrack?.id ?? 'idle'} size={44} />
            <div className="mps-transport-bar__meta">
              <span className="mps-transport-bar__title">{currentTrack?.title ?? '—'}</span>
              <span className="mps-transport-bar__sub">{currentTrack ? 'local library' : hasQueueTracks ? 'Select a track' : 'No tracks loaded'}</span>
            </div>
            <button
              type="button"
              className={`mps-track__heart${currentLiked ? ' mps-track__heart--active' : ''}`}
              onClick={() => currentTrack && toggleLike(currentTrack.id)}
              disabled={!currentTrack}
              aria-label={currentLiked ? 'Unlike current track' : 'Like current track'}
              aria-pressed={currentLiked}
            >
              <Heart size={14} fill={currentLiked ? 'currentColor' : 'none'} />
            </button>
          </div>

          <div className="mps-transport-bar__center">
            <div className="mps-controls">
              <button
                type="button"
                className={`mps-transport-btn mps-transport-btn--sm${engine.shuffle ? ' mps-transport-btn--active' : ''}`}
                onClick={() => playerRef.current?.toggleShuffle()}
                disabled={!hasQueueTracks}
                aria-pressed={engine.shuffle}
                aria-label="Toggle shuffle"
              >
                <Shuffle size={15} />
              </button>
              <button type="button" className="mps-transport-btn mps-transport-btn--sm" onClick={() => playerRef.current?.prev()} disabled={!hasQueueTracks} aria-label="Previous track">
                <SkipBack size={16} />
              </button>
              <button
                type="button"
                className="mps-transport-btn mps-transport-btn--sm mps-transport-btn--play"
                onClick={() => playerRef.current?.toggle()}
                disabled={!hasQueueTracks}
                aria-label={engine.isPlaying ? 'Pause' : 'Play'}
              >
                {engine.isPlaying ? <Pause size={17} /> : <Play size={17} />}
              </button>
              <button type="button" className="mps-transport-btn mps-transport-btn--sm" onClick={() => playerRef.current?.next()} disabled={!hasQueueTracks} aria-label="Next track">
                <SkipForward size={16} />
              </button>
              <button
                type="button"
                className={`mps-transport-btn mps-transport-btn--sm${engine.repeatOne ? ' mps-transport-btn--active' : ''}`}
                onClick={() => playerRef.current?.toggleRepeatOne()}
                disabled={!hasQueueTracks}
                aria-pressed={engine.repeatOne}
                aria-label="Toggle repeat"
              >
                {engine.repeatOne ? <Repeat1 size={15} /> : <Repeat size={15} />}
              </button>
            </div>

            <div className="mps-scrub">
              <span className="mps-scrub__time">{formatTime(engine.currentTime)}</span>
              <input
                type="range"
                min={0}
                max={100}
                step={0.1}
                value={progressPct}
                onChange={(e) => handleScrub(Number(e.target.value))}
                disabled={!hasQueueTracks}
                className="mps-scrub__input"
                aria-label="Seek"
                style={{ '--mps-scrub-pct': `${progressPct}%` } as CSSProperties}
              />
              <span className="mps-scrub__time">{formatTime(engine.duration)}</span>
            </div>
          </div>
        </div>

        <div className="mps-volume-strip">
          <button type="button" className="mps-icon-btn" onClick={toggleMute} disabled={!hasQueueTracks} aria-label={engine.volume > 0 ? 'Mute' : 'Unmute'}>
            {engine.volume > 0 ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={engine.volume}
            onChange={(e) => handleVolumeChange(Number(e.target.value))}
            disabled={!hasQueueTracks}
            className="mps-volume__input"
            aria-label="Volume"
            style={{ '--mps-scrub-pct': `${engine.volume * 100}%` } as CSSProperties}
          />
          <SlidersHorizontal className="mps-volume-strip__icon" size={15} aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}
