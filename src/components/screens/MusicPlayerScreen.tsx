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
 * Matches "flubber 2.png" for the Now Playing tab: hero with FlubberCharacter
 * on a glowing platform between two speakers with a reactive equalizer
 * background, a Playlist Queue table, a sticky transport bar, and a right
 * rail (Now Playing / Playback Controls / Visualizer Mode / Playlist Queue).
 *
 * LANE 4 — LIBRARY TAB OVERHAUL: the old Library/Playlists/Liked Songs tabs
 * merged into one Apple-Music-style "Library" tab — a left rail (Library /
 * Liked Songs / Playlists + New Playlist) selects what the main area shows,
 * and the main area is a sortable track table (Title/Artist/Album/Duration,
 * click a header to sort, direction persists per column). See
 * `librarySelection` / `sortColumn` / `sortedLibraryTracks` below.
 *
 * INDEX-SPACE NOTE (read before touching play handlers): MusicPlayer keeps
 * two lists — `engine.tracks` (the full library) and `engine.queue` (whatever
 * is actually playing: the library by default, or a playlist/custom-sort once
 * one is played). `engine.currentIndex` is ALWAYS an index into `engine.queue`,
 * never into `engine.tracks`. Row highlighting is done by track id, not
 * index, so it stays correct regardless of which list is rendering:
 *   - Now Playing's "Playlist Queue" panel renders `engine.queue` and plays
 *     rows via `playQueueTrackAt(index)` (queue-space).
 *   - The Library table plays rows via `playFromSortedList(index)`, which
 *     takes the CURRENTLY DISPLAYED (possibly sorted) row order as the
 *     queue — see that function for why Library-in-natural-order is a
 *     special case that keeps the old library-auto-sync behavior.
 *
 * Data reality check (see /api/tracks/route.ts): a Track has real
 * artist/album/cover-art ONLY when the source file is an mp3 with ID3 tags
 * (server-side extraction, see id3-parser.ts + cover-art-store.ts) — every
 * other case stays honest rather than fabricated:
 *   - No ID3 title -> filename-derived title (as before).
 *   - No ID3 artist/album, or a non-mp3 file -> that column just reads "—".
 *   - No embedded/custom art -> a deterministic generated gradient tile
 *     (seeded off the track id), not a fake photo.
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
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
} from 'react';
import {
  ArrowDown,
  ArrowUp,
  AudioWaveform,
  BarChart3,
  Check,
  Disc3,
  Heart,
  ImagePlus,
  ListMusic,
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
import { Panel, Skeleton, SkeletonRow } from '../ui';
import MusicPlayer, { type MusicEngineState, type MusicPlayerHandle, type Track } from '../MusicPlayer';
import { useFlubberBrainApi } from '../../hooks/useFlubberBrain';
import './MusicPlayerScreen.css';

// LANE 4: the tab strip dropped from 4 tabs to 2 — Playlists/Library/Liked
// merged into one Apple-Music-style "Library" view (left rail nav + a
// sortable track table in the main area) instead of three separate flat
// lists. "Now Playing" (the hero visualizer) is untouched.
type ScreenTab = 'now-playing' | 'library';
type VisualizerMode = 'bars' | 'wave' | 'radial' | 'pulse';
type EqPresetName = 'Flat' | 'Bass Boost' | 'Vocal' | 'Treble' | 'Custom';

/** Which sub-view the Library rail has selected — drives what the main-area
 *  table shows. A playlist selection is stored as its id since playlists
 *  come and go. */
type LibrarySelection = { kind: 'library' } | { kind: 'liked' } | { kind: 'playlist'; id: string };

type SortColumn = 'title' | 'artist' | 'album' | 'duration';
type SortDirection = 'asc' | 'desc';

interface Playlist {
  id: string;
  name: string;
  trackIds: string[];
  createdAt: string;
  /** Computed server-side from cover-art-store.ts — whether a custom cover
   *  has been uploaded for this playlist (playlists have no embedded art of
   *  their own to auto-extract, unlike tracks). */
  hasCustomCover?: boolean;
}

const TABS: { id: ScreenTab; label: string }[] = [
  { id: 'now-playing', label: 'Now Playing' },
  { id: 'library', label: 'Library' },
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

/** Builds the /api/cover/<id> URL for a track or playlist, or undefined when
 *  the caller has nothing to fetch (no auto-extracted or custom art) — kept
 *  as a plain function rather than baking the URL into TrackArt so callers
 *  can skip the request entirely instead of letting an <img> 404. `version`
 *  is a cache-busting counter bumped after every successful cover upload so
 *  a freshly-uploaded cover shows immediately instead of waiting out the
 *  route's Cache-Control. */
function coverUrlFor(kind: 'track' | 'playlist', id: string, hasArt: boolean, version: number): string | undefined {
  if (!hasArt) return undefined;
  return `/api/cover/${encodeURIComponent(id)}?type=${kind}&v=${version}`;
}

interface TrackArtProps {
  seed: string;
  size?: number;
  /** Real cover art URL (see coverUrlFor). Omit/undefined to always show the
   *  generated placeholder — this component never guesses or probes. */
  coverUrl?: string;
  /** Gentle breathing pulse while playback is active (LAW: the Now Playing
   *  cover only — see .mps-art--pulse in MusicPlayerScreen.css). */
  pulse?: boolean;
}

function TrackArt({ seed, size = 44, coverUrl, pulse = false }: TrackArtProps) {
  // Resets whenever the art URL itself changes (new track, or a cache-busted
  // re-upload) so a previous track's broken-image state never sticks to a
  // different track that reuses this same mounted component instance.
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => setImgFailed(false), [coverUrl]);

  const hue = 132 + Math.round(hash01(seed) * 46); // stays in the brand's green family
  const showImg = Boolean(coverUrl) && !imgFailed;

  return (
    <div
      className={`mps-art${pulse ? ' mps-art--pulse' : ''}`}
      style={{
        width: size,
        height: size,
        background: `linear-gradient(155deg, oklch(32% 0.08 ${hue}) 0%, oklch(13% 0.03 ${hue}) 100%)`,
      }}
      aria-hidden="true"
    >
      {showImg ? (
        <img src={coverUrl} alt="" className="mps-art__img" onError={() => setImgFailed(true)} />
      ) : (
        <Music size={Math.round(size * 0.36)} strokeWidth={1.5} />
      )}
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
  coverUrl?: string;
  onPlay: () => void;
  onToggleLike: () => void;
  /** Library tab only — replaces the decorative "more" button with a real inline-confirm delete. */
  onDelete?: () => void;
  deletePending?: boolean;
}

/** Compact row shape used only by the Now Playing tab's "Playlist Queue"
 *  rail panel now (the Library tab's main table has its own row component,
 *  LibraryTrackRow, below — different columns, different actions). */
function TrackRow({
  track,
  index,
  isActive,
  isPlaying,
  liked,
  duration,
  energy,
  coverUrl,
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
        <TrackArt seed={track.id} size={40} coverUrl={coverUrl} />
        <span className="mps-track__meta">
          <span className="mps-track__title">{track.title}</span>
          <span className="mps-track__sub">{track.artist ?? 'local library'}</span>
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

/** Shape-matches a real TrackRow (play cell + art + title/sub lines + duration)
 *  so a loading playlist/library reads as "tracks are coming", not a bare
 *  "Loading…" line with no shape at all. */
function TrackListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <ul className="mps-track-list mps-track-list--skeleton" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="mps-track mps-track--skeleton">
          <SkeletonRow avatar avatarSize={40} lines={2} />
          <Skeleton width={36} height="0.78rem" radius={4} />
        </li>
      ))}
    </ul>
  );
}

function sortArrow(active: boolean, direction: SortDirection) {
  if (!active) return null;
  const Icon = direction === 'asc' ? ArrowUp : ArrowDown;
  return <Icon size={11} className="mps-table__sort-icon" aria-hidden="true" />;
}

interface LibraryTrackRowProps {
  track: Track;
  rowIndex: number;
  isActive: boolean;
  isPlaying: boolean;
  liked: boolean;
  duration: number | undefined;
  coverUrl?: string;
  onPlay: () => void;
  onToggleLike: () => void;
  playlists: Playlist[];
  onTogglePlaylistMembership: (playlistId: string, trackId: string) => void;
  onUploadCover: () => void;
  menuOpen: boolean;
  onToggleMenu: () => void;
  /** Library selection only — every other selection removes a track by
   *  toggling it off in the row menu instead (see onTogglePlaylistMembership). */
  onDelete?: () => void;
  deletePending?: boolean;
}

/** One row of the Library tab's main-area track table (Title/Artist/Album/
 *  Duration + like/menu/delete). Distinct from TrackRow (the compact
 *  Playlist Queue rail list in the Now Playing tab) because the columns and
 *  available actions are genuinely different — a table row, not a list item. */
function LibraryTrackRow({
  track,
  rowIndex,
  isActive,
  isPlaying,
  liked,
  duration,
  coverUrl,
  onPlay,
  onToggleLike,
  playlists,
  onTogglePlaylistMembership,
  onUploadCover,
  menuOpen,
  onToggleMenu,
  onDelete,
  deletePending,
}: LibraryTrackRowProps) {
  return (
    <li className={`mps-table__row${isActive ? ' mps-table__row--active' : ''}`} role="row">
      <button
        type="button"
        className="mps-table__cell mps-table__cell--index"
        role="cell"
        onClick={onPlay}
        aria-label={isActive && isPlaying ? `Pause ${track.title}` : `Play ${track.title}`}
      >
        <span className="mps-table__index-num">{rowIndex + 1}</span>
        <span className="mps-table__index-play">{isActive && isPlaying ? <Pause size={13} /> : <Play size={13} />}</span>
      </button>

      <button type="button" className="mps-table__cell mps-table__cell--title" role="cell" onClick={onPlay}>
        <TrackArt seed={track.id} size={36} coverUrl={coverUrl} />
        <span className="mps-table__title-text">{track.title}</span>
      </button>

      <span className="mps-table__cell mps-table__cell--artist" role="cell">
        {track.artist ?? '—'}
      </span>
      <span className="mps-table__cell mps-table__cell--album" role="cell">
        {track.album ?? '—'}
      </span>
      <span className="mps-table__cell mps-table__cell--duration" role="cell">
        {duration !== undefined ? formatTime(duration) : '--:--'}
      </span>

      <button
        type="button"
        className={`mps-track__heart${liked ? ' mps-track__heart--active' : ''}`}
        onClick={onToggleLike}
        aria-label={liked ? `Unlike ${track.title}` : `Like ${track.title}`}
        aria-pressed={liked}
      >
        <Heart size={14} fill={liked ? 'currentColor' : 'none'} />
      </button>

      <div className="mps-row-menu-wrap">
        <button type="button" className="mps-track__menu" onClick={onToggleMenu} aria-label={`More options for ${track.title}`} aria-expanded={menuOpen}>
          <MoreHorizontal size={16} />
        </button>
        {menuOpen && (
          <div className="mps-row-menu" role="menu">
            <button type="button" role="menuitem" onClick={onUploadCover}>
              <ImagePlus size={13} aria-hidden="true" />
              Upload Cover
            </button>
            <div className="mps-row-menu__divider" role="separator" />
            <span className="mps-row-menu__label">Add to Playlist</span>
            {playlists.length === 0 ? (
              <p className="mps-empty mps-row-menu__empty">No playlists yet — make one in the sidebar.</p>
            ) : (
              playlists.map((playlist) => {
                const inPlaylist = playlist.trackIds.includes(track.id);
                return (
                  <button
                    key={playlist.id}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={inPlaylist}
                    onClick={() => onTogglePlaylistMembership(playlist.id, track.id)}
                  >
                    <span className="mps-row-menu__check">{inPlaylist ? <Check size={13} /> : null}</span>
                    {playlist.name}
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

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
        <span className="mps-table__cell mps-table__cell--spacer" aria-hidden="true" />
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
  const [renamingPlaylistId, setRenamingPlaylistId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [playlistDeleteConfirmId, setPlaylistDeleteConfirmId] = useState<string | null>(null);
  const playlistDeleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- Library tab: rail selection + sortable table state ----
  const [librarySelection, setLibrarySelection] = useState<LibrarySelection>({ kind: 'library' });
  const [sortColumn, setSortColumn] = useState<SortColumn>('title');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [rowMenuOpenFor, setRowMenuOpenFor] = useState<string | null>(null);

  // ---- Cover art: upload + cache-busting ----
  // Bumped after every successful cover upload and folded into every
  // coverUrlFor() call so a freshly-uploaded cover shows immediately
  // instead of waiting out /api/cover's Cache-Control window.
  const [coverVersion, setCoverVersion] = useState(0);
  // `${kind}:${id}` set immediately on a successful upload, before the
  // subsequent refreshTracks()/fetchPlaylists() round-trip resolves — lets
  // the just-uploaded cover render this frame instead of one network
  // round-trip later.
  const [optimisticCoverIds, setOptimisticCoverIds] = useState<Set<string>>(() => new Set());
  const [coverUploadPending, setCoverUploadPending] = useState<string | null>(null); // `${kind}:${id}` mid-upload, for a small inline spinner state
  const coverUploadTargetRef = useRef<{ kind: 'track' | 'playlist'; id: string } | null>(null);
  const coverUploadInputRef = useRef<HTMLInputElement>(null);

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
        setLibrarySelection({ kind: 'library' });
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

  // A playlist the rail currently has selected can vanish out from under it
  // (deleted from another view, or by this same session's delete button) —
  // fall back to the Library view rather than rendering a selection that
  // points at nothing.
  useEffect(() => {
    if (librarySelection.kind === 'playlist' && !playlistsLoading && !playlists.some((p) => p.id === librarySelection.id)) {
      setLibrarySelection({ kind: 'library' });
    }
  }, [librarySelection, playlists, playlistsLoading]);

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

  /** Toggles one track's membership in one playlist — the row-menu's
   *  "add/remove" action is really just this: add if absent, remove if
   *  present, same as a checkbox. Replaces the old expand-and-pick-tracks
   *  playlist UI (folded into the per-row menu instead — see LibraryTrackRow). */
  const togglePlaylistMembership = useCallback(
    (playlistId: string, trackId: string) => {
      const playlist = playlists.find((p) => p.id === playlistId);
      if (!playlist) return;
      if (playlist.trackIds.includes(trackId)) removeTrackFromPlaylist(playlist, trackId);
      else addTrackToPlaylist(playlist, trackId);
    },
    [playlists, addTrackToPlaylist, removeTrackFromPlaylist]
  );

  const playPlaylist = useCallback((playlist: Playlist, startIndex = 0) => {
    if (playlist.trackIds.length === 0) return;
    playerRef.current?.playQueue(playlist.trackIds, startIndex, true);
    setActiveTab('now-playing');
  }, []);

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

  // ------------------------------------------------------------------ //
  // Library tab: rail selection -> raw tracks -> sorted tracks -> play
  // ------------------------------------------------------------------ //

  const selectedPlaylist =
    librarySelection.kind === 'playlist' ? playlists.find((p) => p.id === librarySelection.id) : undefined;

  /** Raw (unsorted) tracks for whatever the rail currently has selected. */
  const librarySelectionTracks = useMemo<Track[]>(() => {
    if (librarySelection.kind === 'library') return engine.tracks;
    if (librarySelection.kind === 'liked') return likedTracks;
    if (!selectedPlaylist) return [];
    return selectedPlaylist.trackIds
      .map((id) => engine.tracks.find((t) => t.id === id))
      .filter((t): t is Track => Boolean(t));
  }, [librarySelection, engine.tracks, likedTracks, selectedPlaylist]);

  const handleSortClick = useCallback(
    (column: SortColumn) => {
      if (column === sortColumn) {
        setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortColumn(column);
        setSortDirection('asc');
      }
    },
    [sortColumn]
  );

  // Array.prototype.sort has been spec-guaranteed stable since ES2019 (V8
  // has honored this since Node 11), so a plain sort — no manual
  // decorate-sort-undecorate — already satisfies "stable sort": rows that
  // tie on the active column keep their prior relative order.
  const sortedLibraryTracks = useMemo<Track[]>(() => {
    const dir = sortDirection === 'asc' ? 1 : -1;
    const withVal = (t: Track): string | number => {
      if (sortColumn === 'title') return t.title.toLowerCase();
      if (sortColumn === 'artist') return (t.artist ?? '').toLowerCase();
      if (sortColumn === 'album') return (t.album ?? '').toLowerCase();
      return durations.get(t.id) ?? -1; // undurationed rows sort to the front in asc, back in desc
    };
    return [...librarySelectionTracks].sort((a, b) => {
      const av = withVal(a);
      const bv = withVal(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [librarySelectionTracks, sortColumn, sortDirection, durations]);

  /** Plays a row from the Library table at its position in the CURRENTLY
   *  DISPLAYED (possibly sorted) order. Library-in-its-natural-order (title
   *  ascending, which is also the order /api/tracks itself returns) is
   *  special-cased to go through playFromLibrary instead of playQueue so the
   *  documented "queue auto-syncs to the growing library" behavior survives
   *  for the common case — any other sort, or a playlist/Liked selection,
   *  snapshots the displayed order into the queue via playQueue, matching
   *  how Apple Music treats a custom sort as its own queue. */
  const playFromSortedList = useCallback(
    (rowIndex: number) => {
      const track = sortedLibraryTracks[rowIndex];
      if (!track) return;

      const isNaturalLibraryOrder = librarySelection.kind === 'library' && sortColumn === 'title' && sortDirection === 'asc';
      if (isNaturalLibraryOrder) {
        const libraryIndex = engine.tracks.findIndex((t) => t.id === track.id);
        if (libraryIndex === -1) return;
        if (engine.currentTrack?.id === track.id) playerRef.current?.toggle();
        else playerRef.current?.playFromLibrary(libraryIndex, true);
        return;
      }

      if (engine.currentTrack?.id === track.id && librarySelection.kind !== 'liked') {
        playerRef.current?.toggle();
        return;
      }
      playerRef.current?.playQueue(
        sortedLibraryTracks.map((t) => t.id),
        rowIndex,
        true
      );
    },
    [sortedLibraryTracks, librarySelection, sortColumn, sortDirection, engine.tracks, engine.currentTrack]
  );

  // ------------------------------------------------------------------ //
  // Cover art upload
  // ------------------------------------------------------------------ //

  const openCoverPicker = useCallback((kind: 'track' | 'playlist', id: string) => {
    coverUploadTargetRef.current = { kind, id };
    coverUploadInputRef.current?.click();
  }, []);

  const handleCoverFileSelected = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const target = coverUploadTargetRef.current;
      const file = e.target.files?.[0];
      e.target.value = ''; // allow re-selecting the same file next time
      if (!target || !file) return;

      const { kind, id } = target;
      const optimisticKey = `${kind}:${id}`;
      setCoverUploadPending(optimisticKey);

      const formData = new FormData();
      formData.append('file', file);

      fetch(`/api/cover/${encodeURIComponent(id)}?type=${kind}`, { method: 'POST', body: formData })
        .then((res) => {
          if (!res.ok) throw new Error('upload failed');
          setOptimisticCoverIds((prev) => new Set(prev).add(optimisticKey));
          setCoverVersion((v) => v + 1);
          if (kind === 'track') playerRef.current?.refreshTracks();
          else fetchPlaylists();
        })
        .catch((error) => console.error('[MusicPlayerScreen] cover upload failed:', error))
        .finally(() => setCoverUploadPending((cur) => (cur === optimisticKey ? null : cur)));
    },
    [fetchPlaylists]
  );

  // hasArt OR "we just uploaded one this session" (see handleCoverFileSelected)
  // — the optimistic flag covers the gap before refreshTracks()/fetchPlaylists()
  // resolves and the server-confirmed flag arrives.
  const trackCoverUrl = useCallback(
    (track: Track) =>
      coverUrlFor('track', track.id, Boolean(track.hasArt) || optimisticCoverIds.has(`track:${track.id}`), coverVersion),
    [optimisticCoverIds, coverVersion]
  );
  const playlistCoverUrl = useCallback(
    (playlist: Playlist) =>
      coverUrlFor(
        'playlist',
        playlist.id,
        Boolean(playlist.hasCustomCover) || optimisticCoverIds.has(`playlist:${playlist.id}`),
        coverVersion
      ),
    [optimisticCoverIds, coverVersion]
  );

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

      {/* Single shared file input for cover uploads (track or playlist) —
          coverUploadTargetRef says which id/kind it's for; see
          openCoverPicker/handleCoverFileSelected. */}
      <input
        ref={coverUploadInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={handleCoverFileSelected}
      />

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
                  <TrackArt
                    seed={currentTrack?.id ?? 'idle'}
                    size={168}
                    coverUrl={currentTrack ? trackCoverUrl(currentTrack) : undefined}
                    pulse={engine.isPlaying}
                  />
                  <div className="mps-now-playing__row">
                    <span className="mps-now-playing__meta">
                      <span className="mps-now-playing__title">{currentTrack?.title ?? '—'}</span>
                      <span className="mps-now-playing__sub">{currentTrack?.artist ?? (currentTrack ? 'local library' : '—')}</span>
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
                {engine.loading && <TrackListSkeleton rows={4} />}
                {!engine.loading && !hasQueueTracks && (
                  <div className="mps-tab-empty">
                    <FlubberCharacter expression="thinking" size={56} mode="character" tier="mid" showToggle={false} />
                    <p>Nothing queued yet — add tracks from your library to get started.</p>
                    <button
                      type="button"
                      className="mps-empty-action"
                      onClick={() => {
                        setActiveTab('library');
                        setLibrarySelection({ kind: 'library' });
                      }}
                    >
                      Go to Library
                    </button>
                  </div>
                )}
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
                        coverUrl={trackCoverUrl(track)}
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
          <div className="mps-library">
            <aside className="mps-library-rail" data-flubber-avoid="true">
              <button
                type="button"
                className={`mps-library-rail__nav${librarySelection.kind === 'library' ? ' mps-library-rail__nav--active' : ''}`}
                onClick={() => setLibrarySelection({ kind: 'library' })}
              >
                <ListMusic size={15} aria-hidden="true" />
                Library
                <span className="mps-library-rail__count">{engine.tracks.length}</span>
              </button>
              <button
                type="button"
                className={`mps-library-rail__nav${librarySelection.kind === 'liked' ? ' mps-library-rail__nav--active' : ''}`}
                onClick={() => setLibrarySelection({ kind: 'liked' })}
              >
                <Heart size={15} aria-hidden="true" />
                Liked Songs
                <span className="mps-library-rail__count">{likedTracks.length}</span>
              </button>

              <div className="mps-library-rail__divider">
                <span>Playlists</span>
              </div>

              <div className="mps-playlist-create mps-playlist-create--rail">
                <input
                  type="text"
                  value={newPlaylistName}
                  onChange={(e) => setNewPlaylistName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') createPlaylist();
                  }}
                  placeholder="New playlist…"
                  className="mps-playlist-create__input"
                  aria-label="New playlist name"
                />
                <button
                  type="button"
                  className="mps-playlist-create__btn mps-playlist-create__btn--icon"
                  onClick={createPlaylist}
                  disabled={!newPlaylistName.trim()}
                  aria-label="Create playlist"
                  title="New Playlist"
                >
                  <Plus size={15} />
                </button>
              </div>

              {playlistsLoading && (
                <ul className="mps-library-rail__playlists" aria-hidden="true">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <li key={i}>
                      <Skeleton height="1.9rem" radius={6} />
                    </li>
                  ))}
                </ul>
              )}

              {!playlistsLoading && playlists.length === 0 && <p className="mps-empty mps-library-rail__empty">No playlists yet.</p>}

              {!playlistsLoading && playlists.length > 0 && (
                <ul className="mps-library-rail__playlists">
                  {playlists.map((playlist) => {
                    const renaming = renamingPlaylistId === playlist.id;
                    const deletePending = playlistDeleteConfirmId === playlist.id;
                    const isSelected = librarySelection.kind === 'playlist' && librarySelection.id === playlist.id;
                    return (
                      <li
                        key={playlist.id}
                        className={`mps-library-rail__playlist${isSelected ? ' mps-library-rail__playlist--active' : ''}`}
                      >
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
                          <button
                            type="button"
                            className="mps-library-rail__playlist-name"
                            onClick={() => setLibrarySelection({ kind: 'playlist', id: playlist.id })}
                          >
                            <span className="mps-library-rail__playlist-name-text">{playlist.name}</span>
                            <span className="mps-library-rail__count">{playlist.trackIds.length}</span>
                          </button>
                        )}
                        <div className="mps-library-rail__playlist-actions">
                          <button
                            type="button"
                            className="mps-icon-btn"
                            onClick={() => playPlaylist(playlist, 0)}
                            disabled={playlist.trackIds.length === 0}
                            aria-label={`Play ${playlist.name}`}
                            title="Play as queue"
                          >
                            <Play size={12} />
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
                            <Pencil size={12} />
                          </button>
                          <button
                            type="button"
                            className={`mps-icon-btn mps-icon-btn--danger${deletePending ? ' mps-icon-btn--confirm' : ''}`}
                            onClick={() => requestDeletePlaylist(playlist.id)}
                            aria-label={deletePending ? `Confirm delete ${playlist.name}` : `Delete ${playlist.name}`}
                            title={deletePending ? 'Click again to delete' : 'Delete'}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </aside>

            <div className="mps-library-main">
              {librarySelection.kind === 'library' && (
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
              )}

              <Panel avoidRoam className="mps-library-table-panel">
                <div className="mps-library-header">
                  <div className="mps-library-header__art">
                    {librarySelection.kind === 'playlist' && selectedPlaylist ? (
                      <>
                        <TrackArt seed={selectedPlaylist.id} size={64} coverUrl={playlistCoverUrl(selectedPlaylist)} />
                        <button
                          type="button"
                          className="mps-cover-upload-btn"
                          onClick={() => openCoverPicker('playlist', selectedPlaylist.id)}
                          aria-label="Upload playlist cover"
                          title="Upload cover"
                          disabled={coverUploadPending === `playlist:${selectedPlaylist.id}`}
                        >
                          <ImagePlus size={13} />
                        </button>
                      </>
                    ) : (
                      <div className="mps-library-header__icon" aria-hidden="true">
                        {librarySelection.kind === 'liked' ? <Heart size={24} /> : <ListMusic size={24} />}
                      </div>
                    )}
                  </div>
                  <div className="mps-library-header__meta">
                    {librarySelection.kind === 'playlist' && <span className="mps-library-header__eyebrow">Playlist</span>}
                    <h2 className="mps-library-header__title">
                      {librarySelection.kind === 'library'
                        ? 'All Tracks'
                        : librarySelection.kind === 'liked'
                          ? 'Liked Songs'
                          : (selectedPlaylist?.name ?? 'Playlist')}
                    </h2>
                    <span className="mps-library-header__count">{formatSongCount(sortedLibraryTracks.length)}</span>
                  </div>
                  {librarySelection.kind === 'playlist' && selectedPlaylist && (
                    <button
                      type="button"
                      className="mps-icon-btn mps-library-header__play"
                      onClick={() => playPlaylist(selectedPlaylist, 0)}
                      disabled={selectedPlaylist.trackIds.length === 0}
                      aria-label={`Play ${selectedPlaylist.name}`}
                      title="Play"
                    >
                      <Play size={16} />
                    </button>
                  )}
                </div>

                {engine.loading && <TrackListSkeleton rows={6} />}

                {!engine.loading && sortedLibraryTracks.length === 0 && (
                  <div className="mps-tab-empty">
                    <FlubberCharacter expression="thinking" size={56} mode="character" tier="mid" showToggle={false} />
                    {librarySelection.kind === 'library' && (
                      <>
                        <p>No tracks in your library yet — drop audio files above, or straight into music/.</p>
                        <button type="button" className="mps-empty-action" onClick={() => fileInputRef.current?.click()}>
                          Browse files
                        </button>
                      </>
                    )}
                    {librarySelection.kind === 'liked' && <p>Nothing liked yet — tap the heart on any track to save it here.</p>}
                    {librarySelection.kind === 'playlist' && <p>This playlist is empty — use a track&apos;s &quot;…&quot; menu to add songs.</p>}
                  </div>
                )}

                {!engine.loading && sortedLibraryTracks.length > 0 && (
                  <div className="mps-table" role="table" aria-label="Tracks">
                    <div className="mps-table__head" role="row">
                      <span className="mps-table__col mps-table__col--index" role="columnheader" aria-hidden="true" />
                      <button
                        type="button"
                        className={`mps-table__col mps-table__col--title${sortColumn === 'title' ? ' mps-table__col--active' : ''}`}
                        role="columnheader"
                        onClick={() => handleSortClick('title')}
                        aria-sort={sortColumn === 'title' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                      >
                        Title {sortArrow(sortColumn === 'title', sortDirection)}
                      </button>
                      <button
                        type="button"
                        className={`mps-table__col mps-table__col--artist${sortColumn === 'artist' ? ' mps-table__col--active' : ''}`}
                        role="columnheader"
                        onClick={() => handleSortClick('artist')}
                        aria-sort={sortColumn === 'artist' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                      >
                        Artist {sortArrow(sortColumn === 'artist', sortDirection)}
                      </button>
                      <button
                        type="button"
                        className={`mps-table__col mps-table__col--album${sortColumn === 'album' ? ' mps-table__col--active' : ''}`}
                        role="columnheader"
                        onClick={() => handleSortClick('album')}
                        aria-sort={sortColumn === 'album' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                      >
                        Album {sortArrow(sortColumn === 'album', sortDirection)}
                      </button>
                      <button
                        type="button"
                        className={`mps-table__col mps-table__col--duration${sortColumn === 'duration' ? ' mps-table__col--active' : ''}`}
                        role="columnheader"
                        onClick={() => handleSortClick('duration')}
                        aria-sort={sortColumn === 'duration' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                      >
                        Duration {sortArrow(sortColumn === 'duration', sortDirection)}
                      </button>
                      {/* 3 trailing spacer columns matching LibraryTrackRow's
                          heart / "..." menu / delete-or-spacer cells — see
                          the grid-template-columns comment in the CSS. */}
                      <span className="mps-table__col mps-table__col--spacer" role="columnheader" aria-hidden="true" />
                      <span className="mps-table__col mps-table__col--spacer" role="columnheader" aria-hidden="true" />
                      <span className="mps-table__col mps-table__col--spacer" role="columnheader" aria-hidden="true" />
                    </div>
                    <ul className="mps-table__body" role="rowgroup">
                      {sortedLibraryTracks.map((track, index) => (
                        <LibraryTrackRow
                          key={track.id}
                          track={track}
                          rowIndex={index}
                          isActive={currentTrack?.id === track.id}
                          isPlaying={engine.isPlaying}
                          liked={likedIds.has(track.id)}
                          duration={durations.get(track.id)}
                          coverUrl={trackCoverUrl(track)}
                          onPlay={() => playFromSortedList(index)}
                          onToggleLike={() => toggleLike(track.id)}
                          playlists={playlists}
                          onTogglePlaylistMembership={togglePlaylistMembership}
                          onUploadCover={() => {
                            setRowMenuOpenFor(null);
                            openCoverPicker('track', track.id);
                          }}
                          menuOpen={rowMenuOpenFor === track.id}
                          onToggleMenu={() => setRowMenuOpenFor((cur) => (cur === track.id ? null : track.id))}
                          onDelete={librarySelection.kind === 'library' ? () => requestDeleteTrack(track.id) : undefined}
                          deletePending={trackDeleteConfirmId === track.id}
                        />
                      ))}
                    </ul>
                  </div>
                )}
              </Panel>
            </div>
          </div>
        )}
      </div>

      {/* Two separate, column-aligned widgets (not one merged full-width bar):
          the mini player bar is confined to the main column's width; the
          volume strip is its own box sitting under the right rail, at the
          same row height. */}
      <div className="mps-bottom-bar">
        <div className="mps-transport-bar" data-flubber-avoid="true">
          <div className="mps-transport-bar__now">
            <TrackArt seed={currentTrack?.id ?? 'idle'} size={44} coverUrl={currentTrack ? trackCoverUrl(currentTrack) : undefined} />
            <div className="mps-transport-bar__meta">
              <span className="mps-transport-bar__title">{currentTrack?.title ?? '—'}</span>
              <span className="mps-transport-bar__sub">
                {currentTrack?.artist ?? (currentTrack ? 'local library' : hasQueueTracks ? 'Select a track' : 'No tracks loaded')}
              </span>
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
