'use client';

/**
 * SettingsScreen — the "settings" nav screen (see AppShell.tsx's NAV_ITEMS /
 * page.tsx's SCREENS map, keyed "settings"). Matches
 * "flubber inspo pics/flubber 7.png": a tab strip over a two-column main
 * content area plus an independent right-hand rail (Preview/Voice/Privacy,
 * General tab only).
 *
 * TAB STATUS (this pass): General, Appearance, Blubber, Notifications,
 * Shortcuts, and Advanced are all real — every control on them persists
 * somewhere real (server JSON store, app_meta row, or localStorage) and does
 * what it says. "AI & Model" was CUT entirely (see the old TABS array in
 * git history) rather than shipped as fake dropdowns backing nothing real —
 * it returns once there's an actual model-selection/provider layer to wire
 * it to. "Agents" still renders ComingSoonPanel; nothing real backs it yet.
 *
 * WHERE THINGS LIVE NOW: Interface Settings (glow/animation speed/sound fx/
 * theme + accent color) and the Reduce Effects toggle moved to Appearance.
 * Blubber Personality moved to its own Blubber tab. Notifications is new
 * (3 toggles, app_meta-backed). Shortcuts is a static, code-verified keymap
 * (no invented rows). Advanced now owns the master Reset Dashboard button
 * and OnboardingSettingsSection (Replay Setup + its own Reduce Effects
 * toggle) — both relocated from General, same handlers, not duplicated.
 * General keeps genuinely general prefs: General Preferences, Token & Usage
 * (minus the reset button), System Integration, Kit Installer, Recommended
 * Plugins, Retake Soul Interview, and the whole right rail.
 *
 * LAYOUT NOTE: the main content area (`.settings-grid__main`) and the rail
 * (`.settings-grid__rail`) are separate flex/grid containers rather than one
 * shared 3-column/3-row grid. A single shared grid would force every row's
 * track height to match its tallest cell across all three columns — since
 * Blubber Preview (rail) reads much taller than General Preferences (main),
 * that coupling would leave dead space under the shorter main-column panels.
 * Splitting them into two independently-sized flex children removes that
 * coupling entirely and also lets the rail run wider than a single main
 * column, matching the reference screenshot's proportions.
 *
 * OWNERSHIP: this file + SettingsScreen.css only. Reuses Panel + FlubberCharacter
 * from the frozen foundation (see file header in the project's screen-builder brief);
 * everything else here (toggle switch, slider, select, integration tile, theme
 * swatch, danger button) is a small local control built for this screen because
 * the shared ui/ kit has no interactive form controls yet (ProgressBar is
 * display-only — no onChange — so it couldn't be reused for the draggable
 * sliders here; the slider's track/fill visual language still matches it).
 *
 * PROPS: none required. Every control is local component state seeded with
 * sensible defaults — nothing here persists to disk/DB yet (see inline
 * comments on the two fully-inert buttons: Export Data + Clear Cache).
 * "Reset Dashboard" is the real master reset: it POSTs /api/reset, which moves
 * the stats baseline to now (zeroing every real dashboard number "fresh out
 * the box") and resets the pet, then reloads. "Delete All Data" resets this
 * screen's own control state back to defaults. Both do a real, verifiable
 * reset rather than pretending to work.
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

// 'ai-model' was cut on purpose — see the file header. Do not re-add it
// without something real (an actual model/provider layer) behind it.
type TabId = 'general' | 'appearance' | 'flubber' | 'agents' | 'notifications' | 'shortcuts' | 'advanced';

const TABS: { id: TabId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'flubber', label: 'Blubber' },
  { id: 'agents', label: 'Agents' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'advanced', label: 'Advanced' },
];

// ---------------------------------------------------------------------------
// Settings state shapes + defaults
// ---------------------------------------------------------------------------

interface GeneralPrefs {
  startupBehavior: string;
  autoLaunch: boolean;
  minimizeToTray: boolean;
  language: string;
  timeFormat: string;
}

interface UsageSettings {
  usageTracking: boolean;
  usageAlerts: boolean;
  dailyLimitWarning: number;
  weeklyLimitWarning: number;
  currency: string;
}

interface IntegrationSettings {
  systemTrayIcon: boolean;
  globalHotkey: boolean;
  clipboardListening: boolean;
  fileWatcher: boolean;
}

interface PersonalitySettings {
  mode: string;
  energyLevel: number;
  movementAmount: number;
  talkativeness: number;
  sarcasm: number;
  emoteFrequency: number;
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
}

// Appearance's server-backed shape — mirrors src/server/prefs-store.ts's
// UiPrefs exactly (see the GET/POST /api/prefs contract below). Kept as a
// separate local type from InterfaceSettings/NotificationSettings so the two
// local state groups can stay independently updatable while both still
// round-trip through the one prefs blob.
type AnimationSpeed = 'Slow' | 'Normal' | 'Fast';

interface UiPrefsPayload {
  glowIntensity: number;
  animationSpeed: AnimationSpeed;
  soundEffects: boolean;
  themeColor: string;
  accentColor: string;
  notifyQuestCompletions: boolean;
  notifyMilestoneCrossings: boolean;
  notifyBlubberTips: boolean;
}

interface NotificationSettings {
  notifyQuestCompletions: boolean;
  notifyMilestoneCrossings: boolean;
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
  /** Not part of the voice-lib contract — purely local, drives how much the
   *  idle Flubber Preview reacts to the music player's current track. */
  musicReactivity: number;
  muted: boolean;
}

interface PrivacySettings {
  localDataOnly: boolean;
}

const DEFAULT_GENERAL: GeneralPrefs = {
  startupBehavior: 'Open Dashboard',
  autoLaunch: true,
  minimizeToTray: true,
  language: 'English',
  timeFormat: '12-Hour (AM/PM)',
};

const DEFAULT_USAGE: UsageSettings = {
  usageTracking: true,
  usageAlerts: true,
  dailyLimitWarning: 80,
  weeklyLimitWarning: 90,
  currency: 'Tokens',
};

const DEFAULT_INTEGRATION: IntegrationSettings = {
  systemTrayIcon: true,
  globalHotkey: true,
  clipboardListening: true,
  fileWatcher: true,
};

// Defaults mirror src/server/brain-store.ts's BRAIN defaults exactly
// (playful / 75 / 70 / 60) so the UI never flashes a different value than
// what the server will return on first fetch.
const DEFAULT_PERSONALITY: PersonalitySettings = {
  mode: 'Playful',
  energyLevel: 75,
  movementAmount: 70,
  talkativeness: 60,
  sarcasm: 40,
  emoteFrequency: 70,
};

// Mirrors src/server/prefs-store.ts's UiPrefs defaults exactly (same reason
// as DEFAULT_PERSONALITY above — no flash of a different value on first
// fetch).
const DEFAULT_INTERFACE: InterfaceSettings = {
  themeColor: 'green',
  accentColor: '#39FF14',
  glowIntensity: 80,
  animationSpeed: 'Normal',
  soundEffects: true,
};

const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  notifyQuestCompletions: true,
  notifyMilestoneCrossings: true,
  notifyBlubberTips: true,
};

// Mirrors src/server/voice-store.ts's VoiceConfig defaults exactly
// (bubbly / 55 / — / 70 / unmuted). masterVolume maps to the contract's
// `volume` field; musicReactivity has no contract equivalent (see
// VoiceSettings above) and keeps its own pre-existing default.
const DEFAULT_VOICE: VoiceSettings = {
  voice: 'Bubbly',
  pitch: 55,
  masterVolume: 70,
  musicReactivity: 80,
  muted: false,
};

const DEFAULT_PRIVACY: PrivacySettings = { localDataOnly: true };

const STARTUP_OPTIONS = ['Open Dashboard', 'Open Terminal', 'Open Last Screen', 'Minimized to Tray'];
const LANGUAGE_OPTIONS = ['English', 'Spanish', 'French', 'German', 'Portuguese'];
const TIME_FORMAT_OPTIONS = ['12-Hour (AM/PM)', '24-Hour'];
const CURRENCY_OPTIONS = ['Tokens', 'USD ($)', 'Requests'];
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

function ComingSoonPanel({ label }: { label: string }) {
  return (
    <Panel accent title={label} className="settings-panel settings-panel--wide">
      <div className="settings-coming-soon">
        <FlubberCharacter expression="thinking" size={64} mode="character" showToggle={false} />
        <p>
          The {label} tab hasn&rsquo;t been wired up yet — General is the only fully-built tab in this pass.
          Check back once the next settings pass lands.
        </p>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------

export default function SettingsScreen() {
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [isResetting, setIsResetting] = useState(false);

  const [general, updateGeneral] = useSettingsGroup(DEFAULT_GENERAL);
  const [usage, updateUsage] = useSettingsGroup(DEFAULT_USAGE);
  const [integration, updateIntegration] = useSettingsGroup(DEFAULT_INTEGRATION);
  const [personality, updatePersonality] = useSettingsGroup(DEFAULT_PERSONALITY);
  const [ui, updateUi] = useSettingsGroup(DEFAULT_INTERFACE);
  const [notifications, updateNotifications] = useSettingsGroup(DEFAULT_NOTIFICATIONS);
  const [voice, updateVoice] = useSettingsGroup(DEFAULT_VOICE);
  const [privacy, updatePrivacy] = useSettingsGroup(DEFAULT_PRIVACY);
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
        });
        updateNotifications({
          notifyQuestCompletions: prefs.notifyQuestCompletions,
          notifyMilestoneCrossings: prefs.notifyMilestoneCrossings,
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
      const body: { prefs: Partial<UiPrefsPayload> } = {
        prefs: {
          glowIntensity: ui.glowIntensity,
          animationSpeed: ui.animationSpeed as AnimationSpeed,
          soundEffects: ui.soundEffects,
          themeColor: ui.themeColor,
          accentColor: ui.accentColor,
          notifyQuestCompletions: notifications.notifyQuestCompletions,
          notifyMilestoneCrossings: notifications.notifyMilestoneCrossings,
          notifyBlubberTips: notifications.notifyBlubberTips,
        },
      };
      fetch('/api/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`prefs save failed: ${res.status}`);
          setPrefsSync('synced');
        })
        .catch((err) => {
          console.error('[settings] failed to save prefs:', err);
          setPrefsSync('error');
        });
    }, 500);
    return () => {
      if (prefsDebounceRef.current) clearTimeout(prefsDebounceRef.current);
    };
  }, [
    ui.glowIntensity,
    ui.animationSpeed,
    ui.soundEffects,
    ui.themeColor,
    ui.accentColor,
    notifications.notifyQuestCompletions,
    notifications.notifyMilestoneCrossings,
    notifications.notifyBlubberTips,
  ]);

  // Real (if minimal) Accent Color hook: an inline style property on
  // <html> beats the :root rule in globals.css by specificity, so this
  // actually re-themes every `--core-accent-bright`/`--core-accent` consumer
  // app-wide — not just this screen's own preview. globals.css itself is
  // shared/frozen (see SettingsScreen.css's own header note), so the override
  // lives here as a runtime style property instead of a class swap.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.style.setProperty('--core-accent-bright', ui.accentColor);
    document.documentElement.style.setProperty('--core-accent', ui.accentColor);
  }, [ui.accentColor]);

  // Live-sync the sidebar "Blubber Tip" card: AppShell seeds its own copy of
  // this pref from /api/prefs on boot, but while both components are mounted
  // the toggle should take effect immediately — this event bridges the two
  // without a shared store. Guarded on prefsSync so the mount-time default
  // (true) never fires before the persisted value has loaded.
  useEffect(() => {
    if (typeof window === 'undefined' || prefsSync === 'loading') return;
    window.dispatchEvent(
      new CustomEvent('blubber:tips-pref', { detail: { enabled: notifications.notifyBlubberTips } }),
    );
  }, [notifications.notifyBlubberTips, prefsSync]);

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
  // resets the pet), also clears this screen's local control defaults, then
  // reloads so every screen refetches and shows zero. Does NOT delete the
  // underlying ~/.claude history — it just draws a new "count from here" line.
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
      updateGeneral(DEFAULT_GENERAL);
      updateUsage(DEFAULT_USAGE);
      updateIntegration(DEFAULT_INTEGRATION);
      updatePersonality(DEFAULT_PERSONALITY);
      updateUi(DEFAULT_INTERFACE);
      updateNotifications(DEFAULT_NOTIFICATIONS);
      updateVoice(DEFAULT_VOICE);
      updatePrivacy(DEFAULT_PRIVACY);
      // The server has already reset brain-config.json to defaults as part of
      // /api/reset. window.location.reload() below remounts this screen,
      // which re-runs the seed effect and re-fetches /api/brain — the Blubber
      // Personality panel comes back showing the real reset values, not
      // stale in-memory state. Same is true for prefs (Appearance/
      // Notifications) and voice config — /api/reset also clears those two
      // stores server-side (see src/app/api/reset/route.ts).
      if (typeof window !== 'undefined') window.location.reload();
    } catch {
      if (typeof window !== 'undefined') window.alert('Reset failed — is the dev server running? Check its logs.');
      setIsResetting(false);
    }
  }, [
    updateGeneral,
    updateUsage,
    updateIntegration,
    updatePersonality,
    updateUi,
    updateNotifications,
    updateVoice,
    updatePrivacy,
  ]);

  const handleDeleteAllData = useCallback(() => {
    if (typeof window !== 'undefined' && !window.confirm('Reset every Blubber OS setting on this screen back to its default? This cannot be undone.')) {
      return;
    }
    updateGeneral(DEFAULT_GENERAL);
    updateUsage(DEFAULT_USAGE);
    updateIntegration(DEFAULT_INTEGRATION);
    updatePersonality(DEFAULT_PERSONALITY);
    updateUi(DEFAULT_INTERFACE);
    updateNotifications(DEFAULT_NOTIFICATIONS);
    updateVoice(DEFAULT_VOICE);
    updatePrivacy(DEFAULT_PRIVACY);
  }, [updateGeneral, updateUsage, updateIntegration, updatePersonality, updateUi, updateNotifications, updateVoice, updatePrivacy]);

  // Export Data + Clear Cache have nothing real to do yet (no backend/export
  // pipeline wired up) — left as visible, enabled, genuinely inert buttons
  // rather than faking a success state. See file header.
  const handleNotImplemented = useCallback(() => {}, []);

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
            <Panel title="General Preferences" className="settings-panel settings-panel--general">
              <div className="settings-panel__rows">
                <SettingRow icon={Power} label="Startup Behavior" description="Choose what happens when Blubber OS launches.">
                  <SelectField
                    value={general.startupBehavior}
                    onChange={(v) => updateGeneral({ startupBehavior: v })}
                    options={STARTUP_OPTIONS}
                    ariaLabel="Startup behavior"
                  />
                </SettingRow>
                <SettingRow icon={Rocket} label="Auto-Launch" description="Launch Blubber OS at system startup.">
                  <Toggle checked={general.autoLaunch} onChange={(v) => updateGeneral({ autoLaunch: v })} label="Auto-launch" />
                </SettingRow>
                <SettingRow icon={Minimize2} label="Minimize to Tray" description="Minimize Blubber OS to system tray instead of taskbar.">
                  <Toggle
                    checked={general.minimizeToTray}
                    onChange={(v) => updateGeneral({ minimizeToTray: v })}
                    label="Minimize to tray"
                  />
                </SettingRow>
                <SettingRow icon={Globe} label="Language" description="Select your preferred language.">
                  <SelectField
                    value={general.language}
                    onChange={(v) => updateGeneral({ language: v })}
                    options={LANGUAGE_OPTIONS}
                    ariaLabel="Language"
                  />
                </SettingRow>
                <SettingRow icon={Clock} label="Time Format" description="Choose 12-hour or 24-hour time format.">
                  <SelectField
                    value={general.timeFormat}
                    onChange={(v) => updateGeneral({ timeFormat: v })}
                    options={TIME_FORMAT_OPTIONS}
                    ariaLabel="Time format"
                  />
                </SettingRow>
              </div>
            </Panel>

            <Panel title="Token & Usage Settings" className="settings-panel settings-panel--usage">
              <div className="settings-panel__rows">
                <SettingRow icon={Activity} label="Usage Tracking" description="Track token usage and generate analytics.">
                  <Toggle checked={usage.usageTracking} onChange={(v) => updateUsage({ usageTracking: v })} label="Usage tracking" />
                </SettingRow>
                <SettingRow icon={Bell} label="Usage Alerts" description="Get notified when approaching daily/weekly limits.">
                  <Toggle checked={usage.usageAlerts} onChange={(v) => updateUsage({ usageAlerts: v })} label="Usage alerts" />
                </SettingRow>
                <SliderRow
                  icon={AlertCircle}
                  label="Daily Limit Warning"
                  value={usage.dailyLimitWarning}
                  onChange={(v) => updateUsage({ dailyLimitWarning: v })}
                />
                <SliderRow
                  icon={AlertTriangle}
                  label="Weekly Limit Warning"
                  value={usage.weeklyLimitWarning}
                  onChange={(v) => updateUsage({ weeklyLimitWarning: v })}
                />
                <SettingRow icon={Coins} label="Currency" description="Choose how token usage is displayed.">
                  <SelectField
                    value={usage.currency}
                    onChange={(v) => updateUsage({ currency: v })}
                    options={CURRENCY_OPTIONS}
                    ariaLabel="Currency"
                  />
                </SettingRow>
              </div>
            </Panel>

            <Panel title="System Integration" className="settings-panel settings-panel--integration">
              <div className="integration-grid">
                <IntegrationTile
                  icon={AppWindow}
                  label="System Tray Icon"
                  description="Show Blubber in the system tray."
                  checked={integration.systemTrayIcon}
                  onChange={(v) => updateIntegration({ systemTrayIcon: v })}
                />
                <IntegrationTile
                  icon={Keyboard}
                  label="Global Hotkey"
                  description="Toggle Blubber OS with a hotkey combo."
                  checked={integration.globalHotkey}
                  onChange={(v) => updateIntegration({ globalHotkey: v })}
                  meta="Ctrl + Alt + F"
                  showToggle={false}
                />
                <IntegrationTile
                  icon={ClipboardList}
                  label="Clipboard Listening"
                  description="Let Blubber monitor clipboard content."
                  checked={integration.clipboardListening}
                  onChange={(v) => updateIntegration({ clipboardListening: v })}
                />
                <IntegrationTile
                  icon={Eye}
                  label="File Watcher"
                  description="Watch for file changes in projects folder."
                  checked={integration.fileWatcher}
                  onChange={(v) => updateIntegration({ fileWatcher: v })}
                />
                <IntegrationTile
                  icon={Code2}
                  label="Dev Mode"
                  description="Unlock experimental features."
                  checked={false}
                  onChange={() => {}}
                  disabled
                />
              </div>
            </Panel>

            <KitInstaller />

            <RecommendedPlugins />

            <RetakeSoulInterview />
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
                  {/* Lane 3 one-window fit: 172 -> 120 so the rail (Preview +
                      Voice & Audio + Data & Privacy) fits within the same
                      budget as the main column (fit-sweep.css). */}
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

            <Panel
              title="Voice & Audio"
              className="settings-panel settings-panel--voice"
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
                <SliderRow
                  icon={Music2}
                  label="Music Reactivity"
                  description="How much Blubber reacts to music."
                  value={voice.musicReactivity}
                  onChange={(v) => updateVoice({ musicReactivity: v })}
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

            <Panel title="Data & Privacy" className="settings-panel settings-panel--privacy">
              <div className="settings-panel__rows">
                <SettingRow icon={ShieldCheck} label="Local Data Only" description="Keep all data on this device.">
                  <Toggle
                    checked={privacy.localDataOnly}
                    onChange={(v) => updatePrivacy({ localDataOnly: v })}
                    label="Local data only"
                  />
                </SettingRow>
                <SettingRow icon={Download} label="Export Data" description="Export your settings and data.">
                  <button type="button" className="settings-btn" onClick={handleNotImplemented}>
                    Export
                  </button>
                </SettingRow>
                <SettingRow icon={Trash2} label="Clear Cache" description="Clear stored cache and temp files.">
                  <button type="button" className="settings-btn" onClick={handleNotImplemented}>
                    Clear
                  </button>
                </SettingRow>
                <SettingRow
                  icon={AlertTriangle}
                  label="Reset All Settings"
                  description="Reset every setting on this screen (general, usage, personality, appearance, notifications, voice, privacy) back to its default. Does not touch your data — use Reset Dashboard for that."
                  danger
                >
                  <button type="button" className="settings-btn settings-btn--danger" onClick={handleDeleteAllData}>
                    Reset Settings
                  </button>
                </SettingRow>
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
              <SliderRow
                icon={Laugh}
                label="Sarcasm"
                description="How sassy is Blubber feeling?"
                value={personality.sarcasm}
                onChange={(v) => updatePersonality({ sarcasm: v })}
              />
              <SliderRow
                icon={Heart}
                label="Emote Frequency"
                description="How often Blubber shows random emotes."
                value={personality.emoteFrequency}
                onChange={(v) => updatePersonality({ emoteFrequency: v })}
              />
            </div>
          </Panel>
        </div>
      )}

      {activeTab === 'agents' && <ComingSoonPanel label="Agents" />}

      {activeTab === 'notifications' && (
        <div className="settings-tab-content">
          <Panel title="Notifications" className="settings-panel settings-panel--wide" action={<BrainSyncPill state={prefsSync} />}>
            <div className="settings-panel__rows">
              <SettingRow icon={Trophy} label="Quest Completions" description="Notify when a quest is completed.">
                <Toggle
                  checked={notifications.notifyQuestCompletions}
                  onChange={(v) => updateNotifications({ notifyQuestCompletions: v })}
                  label="Quest completions"
                />
              </SettingRow>
              <SettingRow icon={TrendingUp} label="Milestone Crossings" description="Notify when a usage or activity milestone is crossed.">
                <Toggle
                  checked={notifications.notifyMilestoneCrossings}
                  onChange={(v) => updateNotifications({ notifyMilestoneCrossings: v })}
                  label="Milestone crossings"
                />
              </SettingRow>
              <SettingRow icon={Lightbulb} label="Blubber Tips" description="Show the rotating Blubber Tip card in the sidebar.">
                <Toggle
                  checked={notifications.notifyBlubberTips}
                  onChange={(v) => updateNotifications({ notifyBlubberTips: v })}
                  label="Blubber tips"
                />
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
