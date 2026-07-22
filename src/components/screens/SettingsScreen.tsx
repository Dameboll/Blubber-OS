'use client';

/**
 * SettingsScreen — the "settings" nav screen (see AppShell.tsx's NAV_ITEMS /
 * page.tsx's SCREENS map, keyed "settings"). Matches
 * "flubber inspo pics/flubber 7.png": a tab strip over a two-column main
 * content area plus an independent right-hand rail (Preview/Voice/Privacy,
 * General tab only).
 *
 * TAB STATUS (this pass): All 5 tabs (General/Appearance/Blubber/Shortcuts/
 * Advanced) are real — every control persists to a real backend (server JSON
 * store, app_meta row, or voice-store) and does what it says. Dead tabs
 * (Agents, Notifications, ComingSoonPanel) and dead panels (General Preferences
 * except Time Format, Token & Usage, System Integration, Data & Privacy except
 * Reset) have been removed entirely. Blubber Tips notification now lives in
 * General. Voice & Audio moved to Blubber tab. Music Reactivity removed.
 *
 * WIRING: Time Format added to InterfaceSettings/ui group (values: '12h'/'24h').
 * prefs dispatch now sends unified 'blubber:prefs' event with full UiPrefsPayload
 * on change + on save, replacing the old 'blubber:tips-pref' dispatch. AppShell
 * applies prefs app-wide and owns the accent color CSS (removed local useEffect).
 *
 * LAYOUT NOTE: General tab uses `.settings-grid` (main + rail separate containers)
 * for independent sizing. Other tabs use `.settings-tab-content` (simple flex column).
 *
 * OWNERSHIP: this file + SettingsScreen.css only. Reuses Panel + FlubberCharacter
 * from the frozen foundation; everything else (toggle switch, slider, select,
 * theme swatch, danger button) is local control built for this screen.
 *
 * PROPS: none required. All state is local, seeded with sensible defaults.
 * "Reset All Settings" resets screen state. "Reset Dashboard" (Advanced tab)
 * POSTs /api/reset, moving stats baseline to now and reloading.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Activity,
  AppWindow,
  Bell,
  ChevronDown,
  ClipboardList,
  Clock,
  Code2,
  Coins,
  Download,
  Eye,
  Footprints,
  FolderOpen,
  Gauge,
  Globe,
  HardDrive,
  Hash,
  Heart,
  Keyboard,
  Laugh,
  Lightbulb,
  Mic,
  MessageCircle,
  Minimize2,
  Music2,
  Palette,
  Play,
  Power,
  Rocket,
  RotateCcw,
  Settings as SettingsIcon,
  ShieldCheck,
  SlidersHorizontal,
  Smile,
  Sparkles,
  Sun,
  Tag,
  Trash2,
  Trophy,
  TrendingUp,
  Volume2,
  VolumeX,
  Zap,
} from 'lucide-react';
import { Panel } from '../ui';
import FlubberCharacter from '../FlubberCharacter';
import OnboardingSettingsSection from '../settings/OnboardingSettingsSection';
import KitInstaller from '../kit-installer/KitInstaller';
import RecommendedPlugins from '../settings/RecommendedPlugins';
import RetakeSoulInterview from '../settings/RetakeSoulInterview';
import { useReduceEffects } from '../../lib/reduce-effects';
// Voice rail contract (Lane V). This module is owned by another lane and may
// not exist on disk yet — see the file header's LANE S brief. The import +
// every call below are written against the documented contract exactly
// (speak(), getVoiceConfig(), setVoiceConfig(partial), config shape
// { voiceStyle, pitch, speed, volume, muted }); integration is verified once
// both lanes land.
import { speak, getVoiceConfig, setVoiceConfig } from '../../lib/blubber-voice';
import './SettingsScreen.css';
import '../../styles/fit-sweep.css';

// Every lucide icon component shares this exact shape — following the same
// `typeof <SomeIcon>` convention AppShell.tsx uses for its NAV_ITEMS icons,
// since lucide-react (0.462.0) doesn't export a standalone `LucideIcon` type.
type IconType = typeof SettingsIcon;

type TabId = 'general' | 'appearance' | 'flubber' | 'shortcuts' | 'advanced';

const TABS: { id: TabId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'flubber', label: 'Blubber' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'advanced', label: 'Advanced' },
];

// ---------------------------------------------------------------------------
// Settings state shapes + defaults
// ---------------------------------------------------------------------------

interface PersonalitySettings {
  mode: string;
  energyLevel: number;
  movementAmount: number;
  talkativeness: number;
}

// The real, server-backed slice of PersonalitySettings — mirrors
// src/server/brain-store.ts's BrainConfig exactly (see the GET/POST /api/brain
// contract in the file header). sarcasm + emoteFrequency below are NOT part
// of this and stay local-only until the brain store grows those fields.
type PersonalityMode = 'playful' | 'professional' | 'chill' | 'hype' | 'sarcastic';

interface BrainConfig {
  personalityMode: PersonalityMode;
  energyLevel: number;
  movementAmount: number;
  talkativeness: number;
}

function uiModeToApiMode(uiLabel: string): PersonalityMode {
  return uiLabel.toLowerCase() as PersonalityMode;
}

function apiModeToUiMode(apiMode: PersonalityMode): string {
  return apiMode.charAt(0).toUpperCase() + apiMode.slice(1);
}

interface InterfaceSettings {
  themeColor: string;
  accentColor: string;
  glowIntensity: number;
  animationSpeed: string;
  soundEffects: boolean;
  timeFormat: string;
  notifyBlubberTips: boolean;
}

// Appearance's server-backed shape — mirrors src/server/prefs-store.ts's
// UiPrefs exactly (see the GET/POST /api/prefs contract below).
type AnimationSpeed = 'Slow' | 'Normal' | 'Fast';

interface UiPrefsPayload {
  glowIntensity: number;
  animationSpeed: AnimationSpeed;
  soundEffects: boolean;
  themeColor: string;
  accentColor: string;
  timeFormat: string;
  notifyBlubberTips: boolean;
}

// The 4 real voice styles src/server/voice-store.ts's VoiceConfig accepts —
// the UI shows friendlier labels but every one maps 1:1 onto a real
// voiceStyle value, never an invented one.
type VoiceStyleValue = 'bubbly' | 'deep' | 'squeaky' | 'robo';

const VOICE_STYLE_OPTIONS: { label: string; value: VoiceStyleValue }[] = [
  { label: 'Bubbly', value: 'bubbly' },
  { label: 'Deep', value: 'deep' },
  { label: 'Squeaky', value: 'squeaky' },
  { label: 'Robotic', value: 'robo' },
];

function voiceLabelToStyle(label: string): VoiceStyleValue {
  return VOICE_STYLE_OPTIONS.find((opt) => opt.label === label)?.value ?? 'bubbly';
}

function voiceStyleToLabel(value: VoiceStyleValue): string {
  return VOICE_STYLE_OPTIONS.find((opt) => opt.value === value)?.label ?? 'Bubbly';
}

interface VoiceSettings {
  voice: string;
  pitch: number;
  masterVolume: number;
  muted: boolean;
}

// Defaults mirror src/server/brain-store.ts's BRAIN defaults exactly
// (playful / 75 / 70 / 60) so the UI never flashes a different value than
// what the server will return on first fetch.
const DEFAULT_PERSONALITY: PersonalitySettings = {
  mode: 'Playful',
  energyLevel: 75,
  movementAmount: 70,
  talkativeness: 60,
};

// Mirrors src/server/prefs-store.ts's UiPrefs defaults exactly (same reason
// as DEFAULT_PERSONALITY above — no flash of a different value on first fetch).
// timeFormat default: '12h' per spec. notifyBlubberTips: true by default.
const DEFAULT_INTERFACE: InterfaceSettings = {
  themeColor: 'green',
  accentColor: '#39FF14',
  glowIntensity: 80,
  animationSpeed: 'Normal',
  soundEffects: true,
  timeFormat: '12h',
  notifyBlubberTips: true,
};

// Mirrors src/server/voice-store.ts's VoiceConfig defaults exactly
// (bubbly / 55 / 70 / unmuted). masterVolume maps to the contract's `volume` field.
const DEFAULT_VOICE: VoiceSettings = {
  voice: 'Bubbly',
  pitch: 55,
  masterVolume: 70,
  muted: false,
};

const PERSONALITY_MODE_OPTIONS = ['Playful', 'Professional', 'Chill', 'Hype', 'Sarcastic'];
const ANIMATION_SPEED_OPTIONS: AnimationSpeed[] = ['Slow', 'Normal', 'Fast'];
const VOICE_OPTIONS = VOICE_STYLE_OPTIONS.map((opt) => opt.label);

// Advanced tab's read-only /api/meta payload shape.
interface AppMeta {
  version: string;
  dataDir: string;
  claudeProjectsDir: string;
}

// Shortcuts tab — every row here was found by grepping the codebase for real
// `keydown` handlers (see the file header's LANE S brief). Deliberately
// excludes the per-game key maps (SnakeGame/PongGame/etc. under
// components/games/) since those are scoped to one mini-game screen each,
// not app-wide shortcuts, and per-field Enter-to-submit handlers (music
// player playlist rename/create inputs) since those aren't really
// "shortcuts" either — just standard form submit-on-Enter. Nothing here is
// aspirational; every row points at a real onKeyDown in the code.
const SHORTCUT_ROWS: { keys: string; action: string; context: string }[] = [
  { keys: 'Esc / Enter', action: 'Skip', context: 'Boot-up intro cinematic' },
  { keys: 'Esc', action: 'Close tour', context: 'Dashboard walkthrough tour' },
  { keys: '→ / Enter', action: 'Next step', context: 'Dashboard walkthrough tour' },
  { keys: '←', action: 'Previous step', context: 'Dashboard walkthrough tour' },
];

// Actual selectable color values — real data, not styling, so literal hex is
// correct here (not a token substitute). Matches globals.css's own literal
// swatch strip comment ("ground truth: literal color-palette swatch...").
const THEME_SWATCHES: { id: string; hex: string; name: string }[] = [
  { id: 'green', hex: '#39FF14', name: 'Green' },
  { id: 'purple', hex: '#A855F7', name: 'Purple' },
  { id: 'blue', hex: '#3B82F6', name: 'Blue' },
  { id: 'orange', hex: '#F97316', name: 'Orange' },
  { id: 'pink', hex: '#EC4899', name: 'Pink' },
];

// Relative bar-height scale for the equalizer/waveform bars flanking the
// Blubber Preview character (reference screenshot §6). Static, not
// audio-reactive — there's no live audio source wired into this preview —
// mirrors the visual language of MusicPlayerScreen's `.mps-waveform` bars.
const EQ_BAR_SCALES = [0.35, 0.7, 1, 0.55, 0.8];

/** Generic local-state group with a merge-patch updater. Passing the group's
 *  own DEFAULT_* constant back into `update` fully resets it (every key is
 *  present), so this doubles as the reset mechanism for Reset/Delete buttons
 *  without a separate setState export. */
function useSettingsGroup<T extends object>(initial: T): [T, (patch: Partial<T>) => void] {
  const [state, setState] = useState<T>(initial);
  const update = useCallback((patch: Partial<T>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);
  return [state, update];
}

// ---------------------------------------------------------------------------
// Small local controls (no shared widget in ui/ covers these — see header)
// ---------------------------------------------------------------------------

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}

function Toggle({ checked, onChange, label, disabled }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`toggle-switch${checked ? ' toggle-switch--on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-switch__thumb" />
    </button>
  );
}

interface SelectFieldProps {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  ariaLabel: string;
}

function SelectField({ value, onChange, options, ariaLabel }: SelectFieldProps) {
  return (
    <div className="select-field">
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={ariaLabel}>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
      <ChevronDown size={13} className="select-field__chevron" aria-hidden="true" />
    </div>
  );
}

interface SettingRowProps {
  icon?: IconType;
  label: string;
  description?: string;
  children: ReactNode;
  disabled?: boolean;
  danger?: boolean;
}

function SettingRow({ icon: Icon, label, description, children, disabled, danger }: SettingRowProps) {
  const classes = ['setting-row', disabled ? 'setting-row--disabled' : '', danger ? 'setting-row--danger' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes}>
      <div className="setting-row__top">
        <span className="setting-row__id">
          {Icon && <Icon size={15} className="setting-row__icon" aria-hidden="true" />}
          <span className="setting-row__label">{label}</span>
        </span>
        <div className="setting-row__control">{children}</div>
      </div>
      {description && <p className="setting-row__description">{description}</p>}
    </div>
  );
}

interface SliderRowProps {
  icon?: IconType;
  label: string;
  description?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
}

function SliderRow({ icon: Icon, label, description, value, onChange, min = 0, max = 100 }: SliderRowProps) {
  const clamped = Math.min(max, Math.max(min, value));
  const pct = ((clamped - min) / (max - min)) * 100;
  const trackStyle = { '--slider-fill': `${pct}%` } as CSSProperties;

  return (
    <div className="slider-row">
      <div className="slider-row__header">
        <span className="setting-row__id">
          {Icon && <Icon size={15} className="setting-row__icon" aria-hidden="true" />}
          <span className="setting-row__label">{label}</span>
        </span>
        <span className="slider-row__value">{Math.round(clamped)}%</span>
      </div>
      {description && <p className="setting-row__description">{description}</p>}
      <div className="slider-row__track-wrap" style={trackStyle}>
        <input
          type="range"
          min={min}
          max={max}
          value={clamped}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={label}
          className="slider-row__input"
        />
      </div>
    </div>
  );
}

interface IntegrationTileProps {
  icon: IconType;
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  meta?: string;
  /** Reference screenshot's Global Hotkey tile has no toggle at all — its
   *  control row is just the "Ctrl + Alt + F" capture chip on its own line.
   *  Cramming a toggle next to that chip (the old default) squeezed the chip
   *  into a 3-line wrap. Every other tile keeps the toggle (default true). */
  showToggle?: boolean;
}

// Icon+label on top, description in the middle, control (toggle and/or
// optional hotkey chip) pinned to the bottom of the cell via `margin-top:
// auto` on `.integration-tile__control-row` — matches the reference
// screenshot's stacked layout instead of putting the toggle on the same row
// as the label.
function IntegrationTile({
  icon: Icon,
  label,
  description,
  checked,
  onChange,
  disabled,
  meta,
  showToggle = true,
}: IntegrationTileProps) {
  return (
    <div className={`integration-tile${disabled ? ' integration-tile--disabled' : ''}`}>
      <span className="integration-tile__label">
        <Icon size={15} aria-hidden="true" />
        <span className="integration-tile__label-text">{label}</span>
      </span>
      <p className="integration-tile__description">{description}</p>
      <div className={`integration-tile__control-row${!showToggle && meta ? ' integration-tile__control-row--meta-only' : ''}`}>
        {meta && <span className="integration-tile__meta">{meta}</span>}
        {showToggle && <Toggle checked={checked} onChange={onChange} disabled={disabled} label={label} />}
      </div>
    </div>
  );
}

function LivePill() {
  return (
    // Scoped `settings-` prefix: SettingsScreen.css and DashboardScreen.css
    // are both plain global stylesheets (no CSS Modules), and Dashboard
    // already owns an unrelated `.live-pill` class (a bordered/uppercase
    // status badge for a different context). Reusing that exact class name
    // let Dashboard's pill background, border, and uppercase transform bleed
    // into this element for every property Settings' own rule didn't set —
    // the reference here is just a plain dot + "Live" text, no badge chrome.
    <span className="settings-live-pill">
      <span className="settings-live-pill__dot" aria-hidden="true" />
      Live
    </span>
  );
}

type BrainSyncState = 'loading' | 'synced' | 'saving' | 'error';

/** Tiny status pill for the Blubber Personality panel header — honest about
 *  whether the last change actually reached the server, same spirit as
 *  LivePill above but for a save/sync state rather than a live feed. */
function BrainSyncPill({ state }: { state: BrainSyncState }) {
  const label = state === 'loading' ? 'Loading…' : state === 'saving' ? 'Saving…' : state === 'error' ? 'Save failed' : 'Synced';
  return (
    <span className={`settings-sync-pill settings-sync-pill--${state}`}>
      <span className="settings-sync-pill__dot" aria-hidden="true" />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------

export default function SettingsScreen() {
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [isResetting, setIsResetting] = useState(false);

  const [personality, updatePersonality] = useSettingsGroup(DEFAULT_PERSONALITY);
  const [ui, updateUi] = useSettingsGroup(DEFAULT_INTERFACE);
  const [voice, updateVoice] = useSettingsGroup(DEFAULT_VOICE);
  const { reduceEffects, setReduceEffects } = useReduceEffects();
  const [meta, setMeta] = useState<AppMeta | null>(null);

  // -------------------------------------------------------------------------
  // Real FlubberBrain wiring — GET /api/brain seeds mode/energy/movement/talk,
  // POST /api/brain (debounced) pushes changes back. sarcasm + emoteFrequency
  // are NOT part of the brain store yet — they stay local-only, unchanged
  // from the pre-existing behavior above.
  // -------------------------------------------------------------------------
  const [brainSync, setBrainSync] = useState<BrainSyncState>('loading');
  const skipNextPostRef = useRef(true); // true until the initial GET hydrates state, so the hydration itself never re-triggers a POST
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refetchBrainConfig = useCallback(() => {
    setBrainSync('loading');
    skipNextPostRef.current = true;
    fetch('/api/brain')
      .then((res) => {
        if (!res.ok) throw new Error(`brain fetch failed: ${res.status}`);
        return res.json() as Promise<{ config: BrainConfig }>;
      })
      .then(({ config }) => {
        updatePersonality({
          mode: apiModeToUiMode(config.personalityMode),
          energyLevel: config.energyLevel,
          movementAmount: config.movementAmount,
          talkativeness: config.talkativeness,
        });
        setBrainSync('synced');
      })
      .catch((err) => {
        console.error('[settings] failed to load brain config:', err);
        skipNextPostRef.current = false; // no seed landed — allow local changes to POST normally
        setBrainSync('error');
      });
  }, [updatePersonality]);

  // Seed once on mount.
  useEffect(() => {
    refetchBrainConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only seed; refetchBrainConfig is stable-enough (only depends on updatePersonality's stable identity)
  }, []);

  // Debounced push whenever the server-backed fields change — skips the
  // render right after hydration so a fresh GET never immediately re-POSTs
  // the exact values it just received.
  useEffect(() => {
    if (skipNextPostRef.current) {
      skipNextPostRef.current = false;
      return;
    }
    setBrainSync('saving');
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const body: { config: Partial<BrainConfig> } = {
        config: {
          personalityMode: uiModeToApiMode(personality.mode),
          energyLevel: personality.energyLevel,
          movementAmount: personality.movementAmount,
          talkativeness: personality.talkativeness,
        },
      };
      fetch('/api/brain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`brain save failed: ${res.status}`);
          setBrainSync('synced');
        })
        .catch((err) => {
          console.error('[settings] failed to save brain config:', err);
          setBrainSync('error');
        });
    }, 500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only the 4 server-backed fields; sarcasm/emoteFrequency are local-only and must not trigger a save
  }, [personality.mode, personality.energyLevel, personality.movementAmount, personality.talkativeness]);

  // -------------------------------------------------------------------------
  // Real Appearance + Notifications wiring — GET /api/prefs seeds both local
  // groups (`ui` + `notifications`), POST /api/prefs (debounced) pushes
  // whichever one just changed back as a merged blob. Same
  // load-once/skip-the-echo/debounce-save shape as the brain wiring above.
  // -------------------------------------------------------------------------
  const [prefsSync, setPrefsSync] = useState<BrainSyncState>('loading');
  const skipNextPrefsPostRef = useRef(true);
  const prefsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setPrefsSync('loading');
    skipNextPrefsPostRef.current = true;
    fetch('/api/prefs')
      .then((res) => {
        if (!res.ok) throw new Error(`prefs fetch failed: ${res.status}`);
        return res.json() as Promise<{ prefs: UiPrefsPayload }>;
      })
      .then(({ prefs }) => {
        updateUi({
          glowIntensity: prefs.glowIntensity,
          animationSpeed: prefs.animationSpeed,
          soundEffects: prefs.soundEffects,
          themeColor: prefs.themeColor,
          accentColor: prefs.accentColor,
          timeFormat: prefs.timeFormat,
          notifyBlubberTips: prefs.notifyBlubberTips,
        });
        setPrefsSync('synced');
      })
      .catch((err) => {
        console.error('[settings] failed to load prefs:', err);
        skipNextPrefsPostRef.current = false;
        setPrefsSync('error');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only seed
  }, []);

  useEffect(() => {
    if (skipNextPrefsPostRef.current) {
      skipNextPrefsPostRef.current = false;
      return;
    }
    setPrefsSync('saving');
    if (prefsDebounceRef.current) clearTimeout(prefsDebounceRef.current);
    prefsDebounceRef.current = setTimeout(() => {
      const payload: UiPrefsPayload = {
        glowIntensity: ui.glowIntensity,
        animationSpeed: ui.animationSpeed as AnimationSpeed,
        soundEffects: ui.soundEffects,
        themeColor: ui.themeColor,
        accentColor: ui.accentColor,
        timeFormat: ui.timeFormat,
        notifyBlubberTips: ui.notifyBlubberTips,
      };
      const body = { prefs: payload };
      fetch('/api/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`prefs save failed: ${res.status}`);
          setPrefsSync('synced');
          // Dispatch unified prefs event for AppShell to apply app-wide
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('blubber:prefs', { detail: { prefs: payload } }));
          }
        })
        .catch((err) => {
          console.error('[settings] failed to save prefs:', err);
          setPrefsSync('error');
        });
    }, 500);
    return () => {
      if (prefsDebounceRef.current) clearTimeout(prefsDebounceRef.current);
    };
  }, [ui.glowIntensity, ui.animationSpeed, ui.soundEffects, ui.themeColor, ui.accentColor, ui.timeFormat, ui.notifyBlubberTips]);

  // Dispatch unified prefs event on change (before save completes) for optimistic UI updates
  useEffect(() => {
    if (typeof window === 'undefined' || prefsSync === 'loading') return;
    const payload: UiPrefsPayload = {
      glowIntensity: ui.glowIntensity,
      animationSpeed: ui.animationSpeed as AnimationSpeed,
      soundEffects: ui.soundEffects,
      themeColor: ui.themeColor,
      accentColor: ui.accentColor,
      timeFormat: ui.timeFormat,
      notifyBlubberTips: ui.notifyBlubberTips,
    };
    window.dispatchEvent(new CustomEvent('blubber:prefs', { detail: { prefs: payload } }));
  }, [ui.glowIntensity, ui.animationSpeed, ui.soundEffects, ui.themeColor, ui.accentColor, ui.timeFormat, ui.notifyBlubberTips, prefsSync]);

  // -------------------------------------------------------------------------
  // Real Voice rail wiring (Lane V contract) — see the import comment at the
  // top of this file. getVoiceConfig()/setVoiceConfig() are wrapped in
  // Promise.resolve() since the contract doesn't specify sync vs async and
  // this file can't inspect the real signature until that module lands.
  // -------------------------------------------------------------------------
  const [voiceSync, setVoiceSync] = useState<BrainSyncState>('loading');
  const skipNextVoicePostRef = useRef(true);
  const voiceDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setVoiceSync('loading');
    skipNextVoicePostRef.current = true;
    Promise.resolve(getVoiceConfig())
      .then((config) => {
        updateVoice({
          voice: voiceStyleToLabel(config.voiceStyle),
          pitch: config.pitch,
          masterVolume: config.volume,
          muted: config.muted,
        });
        setVoiceSync('synced');
      })
      .catch((err) => {
        console.error('[settings] failed to load voice config:', err);
        skipNextVoicePostRef.current = false;
        setVoiceSync('error');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only seed
  }, []);

  useEffect(() => {
    if (skipNextVoicePostRef.current) {
      skipNextVoicePostRef.current = false;
      return;
    }
    setVoiceSync('saving');
    if (voiceDebounceRef.current) clearTimeout(voiceDebounceRef.current);
    voiceDebounceRef.current = setTimeout(() => {
      Promise.resolve(
        setVoiceConfig({
          voiceStyle: voiceLabelToStyle(voice.voice),
          pitch: voice.pitch,
          volume: voice.masterVolume,
          muted: voice.muted,
        }),
      )
        .then(() => setVoiceSync('synced'))
        .catch((err) => {
          console.error('[settings] failed to save voice config:', err);
          setVoiceSync('error');
        });
    }, 500);
    return () => {
      if (voiceDebounceRef.current) clearTimeout(voiceDebounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only the 4 contract fields; musicReactivity is local-only and must not trigger a save
  }, [voice.voice, voice.pitch, voice.masterVolume, voice.muted]);

  const handleVoicePreview = useCallback(() => {
    Promise.resolve(speak('Hey! This is how I sound.')).catch((err) => {
      console.error('[settings] voice preview failed:', err);
    });
  }, []);

  // Advanced tab's read-only app info — fetched once, not gated to the tab
  // being active (cheap, and avoids a loading flash every time you switch
  // back to Advanced).
  useEffect(() => {
    fetch('/api/meta')
      .then((res) => {
        if (!res.ok) throw new Error(`meta fetch failed: ${res.status}`);
        return res.json() as Promise<AppMeta>;
      })
      .then(setMeta)
      .catch((err) => console.error('[settings] failed to load app meta:', err));
  }, []);

  // Master reset — the real one. Zeros every real dashboard number back to 0
  // "fresh out the box" (POST /api/reset moves the stats baseline to now +
  // resets the pet), then reloads so every screen refetches and shows zero.
  const handleMasterReset = useCallback(async () => {
    if (
      typeof window !== 'undefined' &&
      !window.confirm(
        'Reset the entire dashboard back to zero?\n\nToken usage, agent & skill runs, activity, and the pet all start counting fresh from now. Your ~/.claude history is not deleted — this just draws a new baseline.',
      )
    ) {
      return;
    }
    setIsResetting(true);
    try {
      const res = await fetch('/api/reset', { method: 'POST' });
      if (!res.ok) throw new Error(`reset failed: ${res.status}`);
      updatePersonality(DEFAULT_PERSONALITY);
      updateUi(DEFAULT_INTERFACE);
      updateVoice(DEFAULT_VOICE);
      // The server has already reset brain-config.json, prefs, and voice config to
      // defaults as part of /api/reset. window.location.reload() below remounts
      // this screen, which re-runs the seed effects and re-fetches all configs.
      if (typeof window !== 'undefined') window.location.reload();
    } catch {
      if (typeof window !== 'undefined') window.alert('Reset failed — is the dev server running? Check its logs.');
      setIsResetting(false);
    }
  }, [updatePersonality, updateUi, updateVoice]);

  const handleDeleteAllData = useCallback(() => {
    if (typeof window !== 'undefined' && !window.confirm('Reset every Blubber OS setting on this screen back to its default? This cannot be undone.')) {
      return;
    }
    updatePersonality(DEFAULT_PERSONALITY);
    updateUi(DEFAULT_INTERFACE);
    updateVoice(DEFAULT_VOICE);
  }, [updatePersonality, updateUi, updateVoice]);

  const previewStyle = {
    '--preview-glow': ui.accentColor,
    '--preview-glow-pct': `${Math.round(10 + (ui.glowIntensity / 100) * 25)}%`,
  } as CSSProperties;

  return (
    <div className="settings-screen">
      <header className="settings-screen__header">
        <div className="settings-screen__heading">
          <SettingsIcon size={22} className="settings-screen__heading-icon" aria-hidden="true" />
          <div>
            <h1 className="settings-screen__title">Settings</h1>
            <p className="settings-screen__subtitle">Customize your Blubber experience and Claude OS preferences.</p>
          </div>
        </div>
      </header>

      <nav className="settings-tabs" aria-label="Settings sections">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`settings-tabs__item${tab.id === activeTab ? ' settings-tabs__item--active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
            aria-current={tab.id === activeTab ? 'page' : undefined}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === 'general' && (
        <div className="settings-grid">
          <div className="settings-grid__main">
            <Panel title="Preferences" className="settings-panel settings-panel--general">
              <div className="settings-panel__rows">
                <SettingRow icon={Clock} label="Time Format" description="Choose 12-hour or 24-hour time format.">
                  <SelectField
                    value={ui.timeFormat}
                    onChange={(v) => updateUi({ timeFormat: v })}
                    options={['12h', '24h']}
                    ariaLabel="Time format"
                  />
                </SettingRow>
                <SettingRow icon={Lightbulb} label="Blubber Tips" description="Show the rotating Blubber Tip card in the sidebar.">
                  <Toggle
                    checked={ui.notifyBlubberTips}
                    onChange={(v) => updateUi({ notifyBlubberTips: v })}
                    label="Blubber tips"
                  />
                </SettingRow>
              </div>
            </Panel>

            <KitInstaller />

            <RecommendedPlugins />

            <RetakeSoulInterview />

            <Panel title="Data & Privacy" className="settings-panel settings-panel--privacy">
              <div className="settings-panel__rows">
                <SettingRow
                  icon={AlertTriangle}
                  label="Reset All Settings"
                  description="Reset every setting on this screen back to its default. Does not touch your data — use Reset Dashboard (Advanced tab) for that."
                  danger
                >
                  <button type="button" className="settings-btn settings-btn--danger" onClick={handleDeleteAllData}>
                    Reset Settings
                  </button>
                </SettingRow>
              </div>
            </Panel>
          </div>

          <div className="settings-grid__rail">
            <Panel accent title="Blubber Preview" className="settings-panel settings-panel--preview" action={<LivePill />}>
              <div className="flubber-preview">
                <div className="flubber-preview__stage" style={previewStyle}>
                  <span className="flubber-preview__bubble flubber-preview__bubble--1" aria-hidden="true" />
                  <span className="flubber-preview__bubble flubber-preview__bubble--2" aria-hidden="true" />
                  <span className="flubber-preview__bubble flubber-preview__bubble--3" aria-hidden="true" />
                  <div className="flubber-preview__eq flubber-preview__eq--left" aria-hidden="true">
                    {EQ_BAR_SCALES.map((scale, i) => (
                      <span
                        key={i}
                        className="flubber-preview__eq-bar"
                        style={{ '--eq-scale': scale, animationDelay: `${i * 110}ms` } as CSSProperties}
                      />
                    ))}
                  </div>
                  <span className="flubber-preview__ring" aria-hidden="true" />
                  <FlubberCharacter expression="happy" size={120} mode="character" showToggle={false} />
                  <div className="flubber-preview__eq flubber-preview__eq--right" aria-hidden="true">
                    {EQ_BAR_SCALES.map((scale, i) => (
                      <span
                        key={i}
                        className="flubber-preview__eq-bar"
                        style={{ '--eq-scale': scale, animationDelay: `${i * 110}ms` } as CSSProperties}
                      />
                    ))}
                  </div>
                </div>
                <p className="flubber-preview__caption">Looking good! Ready to roll. 💚</p>
              </div>
            </Panel>
          </div>
        </div>
      )}

      {activeTab === 'appearance' && (
        <div className="settings-tab-content">
          <Panel title="Appearance" className="settings-panel settings-panel--interface settings-panel--wide">
            <div className="settings-panel__rows">
              <SettingRow icon={Palette} label="Theme" description="Choose your favorite color theme.">
                <div className="swatch-row">
                  {THEME_SWATCHES.map((swatch) => (
                    <button
                      key={swatch.id}
                      type="button"
                      className={`swatch-dot${ui.themeColor === swatch.id ? ' swatch-dot--active' : ''}`}
                      style={{ backgroundColor: swatch.hex }}
                      onClick={() => updateUi({ themeColor: swatch.id, accentColor: swatch.hex })}
                      aria-label={`${swatch.name} theme`}
                      aria-pressed={ui.themeColor === swatch.id}
                    />
                  ))}
                </div>
              </SettingRow>
              <SettingRow icon={Hash} label="Accent Color" description="Customize the primary accent color — applies app-wide immediately.">
                <div className="accent-input">
                  <span className="accent-input__swatch" style={{ backgroundColor: ui.accentColor }} aria-hidden="true" />
                  <input
                    type="text"
                    value={ui.accentColor}
                    onChange={(e) => updateUi({ accentColor: e.target.value })}
                    className="accent-input__text"
                    aria-label="Accent color hex value"
                    spellCheck={false}
                    maxLength={9}
                  />
                </div>
              </SettingRow>
              <SliderRow
                icon={Sun}
                label="Glow Intensity"
                description="Adjust the overall neon glow."
                value={ui.glowIntensity}
                onChange={(v) => updateUi({ glowIntensity: v })}
              />
              <SettingRow icon={Gauge} label="Animation Speed" description="Control the speed of UI animations.">
                <SelectField
                  value={ui.animationSpeed}
                  onChange={(v) => updateUi({ animationSpeed: v })}
                  options={ANIMATION_SPEED_OPTIONS}
                  ariaLabel="Animation speed"
                />
              </SettingRow>
              <SettingRow icon={Volume2} label="Sound Effects" description="Enable UI sounds and Blubber reactions.">
                <Toggle checked={ui.soundEffects} onChange={(v) => updateUi({ soundEffects: v })} label="Sound effects" />
              </SettingRow>
              <SettingRow
                icon={Sparkles}
                label="Reduce Motion & Effects"
                description="Tone down glow, blur, and background motion across the dashboard for a calmer, lighter feel."
              >
                <Toggle checked={reduceEffects} onChange={setReduceEffects} label="Reduce motion & effects" />
              </SettingRow>
            </div>
          </Panel>
        </div>
      )}

      {activeTab === 'flubber' && (
        <div className="settings-tab-content">
          <Panel
            title="Blubber Personality"
            className="settings-panel settings-panel--personality settings-panel--wide"
            action={<BrainSyncPill state={brainSync} />}
          >
            <div className="settings-panel__rows">
              <SettingRow icon={Smile} label="Personality Mode" description="Set Blubber's default personality.">
                <SelectField
                  value={personality.mode}
                  onChange={(v) => updatePersonality({ mode: v })}
                  options={PERSONALITY_MODE_OPTIONS}
                  ariaLabel="Personality mode"
                />
              </SettingRow>
              <SliderRow
                icon={Zap}
                label="Energy Level"
                description="Overall hyperactivity and bounce level."
                value={personality.energyLevel}
                onChange={(v) => updatePersonality({ energyLevel: v })}
              />
              <SliderRow
                icon={Footprints}
                label="Movement Amount"
                description="How much Blubber wanders and moves around on its own."
                value={personality.movementAmount}
                onChange={(v) => updatePersonality({ movementAmount: v })}
              />
              <SliderRow
                icon={MessageCircle}
                label="Talkativeness"
                description="How much Blubber chats and reacts."
                value={personality.talkativeness}
                onChange={(v) => updatePersonality({ talkativeness: v })}
              />
            </div>
          </Panel>

          <Panel
            title="Voice & Audio"
            className="settings-panel settings-panel--voice settings-panel--wide"
            action={<BrainSyncPill state={voiceSync} />}
          >
            <div className="settings-panel__rows">
              <SettingRow icon={Mic} label="Blubber Voice" description="Choose Blubber's voice style.">
                <SelectField
                  value={voice.voice}
                  onChange={(v) => updateVoice({ voice: v })}
                  options={VOICE_OPTIONS}
                  ariaLabel="Blubber voice"
                />
              </SettingRow>
              <SliderRow
                icon={SlidersHorizontal}
                label="Voice Pitch"
                description="Adjust Blubber's voice pitch."
                value={voice.pitch}
                onChange={(v) => updateVoice({ pitch: v })}
              />
              <SliderRow
                icon={Volume2}
                label="Master Volume"
                description="Overall volume for Blubber and UI."
                value={voice.masterVolume}
                onChange={(v) => updateVoice({ masterVolume: v })}
              />
              <SettingRow icon={VolumeX} label="Mute" description="Silence Blubber's voice entirely.">
                <Toggle checked={voice.muted} onChange={(v) => updateVoice({ muted: v })} label="Mute Blubber voice" />
              </SettingRow>
              <SettingRow icon={Play} label="Preview" description="Hear Blubber say a line with these settings.">
                <button type="button" className="settings-btn" onClick={handleVoicePreview} disabled={voice.muted}>
                  Preview
                </button>
              </SettingRow>
            </div>
          </Panel>
        </div>
      )}

      {activeTab === 'shortcuts' && (
        <div className="settings-tab-content">
          <Panel title="Keyboard Shortcuts" className="settings-panel settings-panel--wide">
            <p className="shortcuts-intro">
              Every shortcut below is real — pulled directly from this build&rsquo;s keyboard handlers, not a wishlist.
            </p>
            <div className="shortcuts-table" role="table" aria-label="Keyboard shortcuts">
              <div className="shortcuts-table__row shortcuts-table__row--head" role="row">
                <span role="columnheader">Keys</span>
                <span role="columnheader">Action</span>
                <span role="columnheader">Where</span>
              </div>
              {SHORTCUT_ROWS.map((row) => (
                <div key={row.action + row.context} className="shortcuts-table__row" role="row">
                  <span role="cell" className="shortcuts-table__keys">
                    {row.keys}
                  </span>
                  <span role="cell">{row.action}</span>
                  <span role="cell" className="shortcuts-table__context">
                    {row.context}
                  </span>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      )}

      {activeTab === 'advanced' && (
        <div className="settings-tab-content">
          <Panel title="App Info" className="settings-panel settings-panel--wide">
            <div className="settings-panel__rows">
              <SettingRow icon={Tag} label="Version" description="The installed Blubber OS build.">
                <span className="settings-meta-value">{meta ? meta.version : 'Loading…'}</span>
              </SettingRow>
              <SettingRow icon={HardDrive} label="Data Directory" description="Where local stores (usage.db, brain-config.json, voice-config.json) live.">
                <span className="settings-meta-value settings-meta-value--path">{meta ? meta.dataDir : 'Loading…'}</span>
              </SettingRow>
              <SettingRow icon={FolderOpen} label="Claude Projects Directory" description="Where session transcripts are read from.">
                <span className="settings-meta-value settings-meta-value--path">{meta ? meta.claudeProjectsDir : 'Loading…'}</span>
              </SettingRow>
            </div>
          </Panel>

          <Panel title="Danger Zone" className="settings-panel settings-panel--wide">
            <div className="settings-panel__rows">
              <SettingRow
                icon={RotateCcw}
                label="Reset Dashboard"
                description="Master reset — put every real number (tokens, agent & skill runs, activity, the pet) back to zero and start fresh from now."
                danger
              >
                <button
                  type="button"
                  className="settings-btn settings-btn--danger"
                  onClick={handleMasterReset}
                  disabled={isResetting}
                >
                  {isResetting ? 'Resetting…' : 'Reset to Zero'}
                </button>
              </SettingRow>
            </div>
          </Panel>

          <OnboardingSettingsSection />
        </div>
      )}
    </div>
  );
}
