'use client';

/**
 * VirtualPetScreen — the "pet" nav screen (AppShell's NAV_ITEMS id "pet").
 *
 * SEPARATE SURFACE (LANE E/F): this is Dame's PET, its own world. It IGNORES the
 * work clock entirely — no `isWorking`, no crew behaviour. It is always alive and
 * always playable, whatever a task is doing elsewhere.
 *
 * Every value on this screen is real:
 *   - Needs / mood / care streak / care level  → GET /api/pet (real-time-decaying
 *     SQLite Blubber, src/server/pet-store.ts). Meters rise ONLY on real care.
 *   - Quests / adventure level / stat board     → GET /api/quests
 *     (src/server/quest-store.ts): tiered milestones over REAL activity
 *     (care history, token burn, agent runs, projects, streak, days). A claim is
 *     server-validated and awards XP toward the adventure level (cap 55).
 *
 * The pet is a real toy: on the Care tab the hero free-roams — grab it, drag it,
 * fling it (usePetToss: gravity, wall bounce, squash, indignant face). A quick
 * press pets it (care). The Play action pops 2–4 wrestling minis that tussle and
 * wander off. Care actions pay off visually via CarePayoffs — the animation is
 * the reward.
 *
 * LAW 2 (one window): every tab fits ONE viewport with zero vertical scroll — the
 * Care tab packs the free-roam play area, care controls, needs, a live quest
 * strip, and level into one bounded grid; Quests / Play / Stats are each their
 * own single-window view.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Gamepad2,
  Heart,
  MessageCircle,
  Moon,
  PawPrint,
  Sandwich,
  ShowerHead,
  Sparkles,
  Star,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import FlubberCharacter, { type FlubberExpression } from '../FlubberCharacter';
import { Panel, ProgressBar } from '../ui';
import { useFlubberBrain, useFlubberBrainApi } from '../../hooks/useFlubberBrain';
import type { FlubberSlotHandle } from '../../lib/flubber3d/host';
import type { GestureName } from '../../lib/flubber3d/motion';
import type { QuestState } from '../../server/quest-store';
import PetHabitatScene from '../pet/PetHabitatScene';
import CarePayoffs, { type CarePayoffsHandle } from '../pet/CarePayoffs';
import QuestPanel from '../pet/QuestPanel';
import PetStats from '../pet/PetStats';
import { GamesHub } from '../games/GamesHub';
import './VirtualPetScreen.css';

type PetTab = 'care' | 'quests' | 'play' | 'stats';

const TABS: { id: PetTab; label: string }[] = [
  { id: 'care', label: 'Care' },
  { id: 'quests', label: 'Quests' },
  { id: 'play', label: 'Play' },
  { id: 'stats', label: 'Stats' },
];

type NeedField = 'hunger' | 'hygiene' | 'fun' | 'energy' | 'love';
type Needs = Record<NeedField, number>;

interface NeedDef {
  key: NeedField;
  label: string;
  icon: LucideIcon;
}

const NEED_DEFS: NeedDef[] = [
  { key: 'hunger', label: 'Hunger', icon: Sandwich },
  { key: 'hygiene', label: 'Hygiene', icon: ShowerHead },
  { key: 'fun', label: 'Fun', icon: Gamepad2 },
  { key: 'energy', label: 'Energy', icon: Zap },
  { key: 'love', label: 'Love', icon: Heart },
];

interface QuickAction {
  key: 'feed' | 'shower' | 'play' | 'sleep' | 'pet' | 'talk';
  label: string;
  icon: LucideIcon;
}

const QUICK_ACTIONS: QuickAction[] = [
  { key: 'feed', label: 'Feed', icon: Sandwich },
  { key: 'shower', label: 'Shower', icon: ShowerHead },
  { key: 'play', label: 'Play', icon: Gamepad2 },
  { key: 'sleep', label: 'Sleep', icon: Moon },
  { key: 'pet', label: 'Pet', icon: PawPrint },
  { key: 'talk', label: 'Talk', icon: MessageCircle },
];

// Optimistic bumps for instant UI feedback — the server (src/server/pet-store)
// is authoritative; its response overwrites these. Kept in sync with the
// server's NEED_BUMPS so the optimistic guess matches the real result.
const NEED_BUMPS: Record<QuickAction['key'], Partial<Needs>> = {
  feed: { hunger: 18 },
  shower: { hygiene: 18 },
  play: { fun: 18 },
  sleep: { energy: 25 },
  pet: { love: 12 },
  talk: { love: 6, fun: 4 },
};

// Each care action drives a distinct brain reaction (user priority) so the pet
// CRT (and every mood-synced Blubber) responds to real care.
const ACTION_EXPRESSION: Record<QuickAction['key'], FlubberExpression> = {
  feed: 'overjoyed',
  shower: 'surprised',
  play: 'overjoyed',
  sleep: 'sleeping',
  pet: 'heart-eyes',
  talk: 'excited',
};

// Body gestures the hero plays on the shared 3D slot for each care action.
const ACTION_GESTURE: Partial<Record<QuickAction['key'], GestureName>> = {
  feed: 'eat',
  shower: 'shower',
  play: 'celebrate',
  pet: 'petted',
};

type LoadStatus = 'loading' | 'ready' | 'error';

interface PetApiState {
  needs: Needs;
  avg: number;
  xp: number;
  level: number;
  careStreak: number;
  careToday: number;
  lastCareAt: string | null;
  lastFedAt: string | null;
  lastPlayedAt: string | null;
  createdAt: string;
}

const PET_REFRESH_MS = 60_000;
const QUEST_REFRESH_MS = 60_000;
const AMBIENT_REFRESH_MS = 300_000; // re-read the clock every 5 min
// Dashboard-hero scale (FlubberHome's HERO_MAX is 300, its dashboard-tile
// default renders ~300px at typical viewport widths) — Dame: "as big as the
// main dashboard hero." Bumped from 200; see PetHabitatScene's
// GROUND_BIAS_FRAC for the matching downward rest-position tune so the
// bigger hero's feet land on the pedestal instead of floating higher.
const HERO_SIZE = 280;
const TOSS_FACE_MS = 1300;

/** Real relative time from an ISO timestamp — "Just now", "18m ago", "2h ago". */
function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const diffMs = Date.now() - Date.parse(iso);
  if (diffMs < 45_000) return 'Just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Real age from the pet's createdAt — "3d 4h", "5h", or "new" when under 1h. */
function formatAge(iso: string): string {
  const diffMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diffMs) || diffMs < 0) return 'new';
  const totalHours = Math.floor(diffMs / 3_600_000);
  if (totalHours < 1) return 'new';
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return days < 1 ? `${hours}h` : `${days}d ${hours}h`;
}

/** Real day/night factor from the local clock: 0 at ~3am, 1 at ~3pm, smooth. */
function ambientForNow(now: Date = new Date()): number {
  const h = now.getHours() + now.getMinutes() / 60;
  const phase = (((h - 3 + 24) % 24) / 24) * Math.PI * 2;
  return 0.5 - 0.5 * Math.cos(phase);
}

interface MoodInfo {
  emoji: string;
  label: string;
}

function getMood(average: number): MoodInfo {
  if (average >= 85) return { emoji: '🤩', label: 'Ecstatic' };
  if (average >= 60) return { emoji: '😊', label: 'Happy' };
  if (average >= 35) return { emoji: '😟', label: 'Restless' };
  return { emoji: '😢', label: 'Down' };
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** Honest loading / error state shown until real pet data arrives. */
function PetStatusNotice({ status }: { status: LoadStatus }) {
  const isError = status === 'error';
  return (
    <Panel accent className="pet-panel pet-notice">
      <div className="pet-notice__body">
        <FlubberCharacter
          expression={isError ? 'confused' : 'thinking'}
          size={72}
          mode="character"
          showToggle={false}
        />
        <div className="pet-notice__copy">
          <span className="section-label">{isError ? 'Pet unavailable' : 'Waking Blubber'}</span>
          <p>
            {isError
              ? 'Could not reach the pet service. It will retry automatically.'
              : "Loading Blubber's live state…"}
          </p>
        </div>
      </div>
    </Panel>
  );
}

export interface VirtualPetScreenProps {
  className?: string;
}

export default function VirtualPetScreen({ className }: VirtualPetScreenProps) {
  const [activeTab, setActiveTab] = useState<PetTab>('care');
  const [pet, setPet] = useState<PetApiState | null>(null);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [quest, setQuest] = useState<QuestState | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [pulseKey, setPulseKey] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [ambient, setAmbient] = useState(() => ambientForNow());
  const [wrestlers, setWrestlers] = useState(0);
  const [wrestlersKey, setWrestlersKey] = useState(0);
  const [arcadeInvite, setArcadeInvite] = useState(false);
  const [tossFace, setTossFace] = useState<FlubberExpression | null>(null);

  const brain = useFlubberBrain();
  const brainApi = useFlubberBrainApi();

  const heroHandleRef = useRef<FlubberSlotHandle | null>(null);
  const payoffRef = useRef<CarePayoffsHandle | null>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const heroCharRef = useRef<HTMLDivElement>(null);
  const actionBtnRefs = useRef<Partial<Record<QuickAction['key'], HTMLButtonElement | null>>>({});
  const lastPetMoveRef = useRef(0);
  const lastHeroPlayRef = useRef(0);
  const wrestlerTimer = useRef<number | undefined>(undefined);
  const inviteTimer = useRef<number | undefined>(undefined);
  const tossFaceTimer = useRef<number | undefined>(undefined);

  const setHeroHandle = useCallback((h: FlubberSlotHandle | null) => {
    heroHandleRef.current = h;
  }, []);

  // Push fresh pet state into the brain so neglect (low needs) shows app-wide.
  const syncBrainPet = useCallback((data: PetApiState) => {
    brainApi.setPet({ ...data.needs, avg: data.avg });
  }, [brainApi]);

  // prefers-reduced-motion — gates payoffs, parallax, and the throw physics.
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduceMotion(query.matches);
    const onChange = () => setReduceMotion(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setAmbient(ambientForNow()), AMBIENT_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => () => {
    if (wrestlerTimer.current) window.clearTimeout(wrestlerTimer.current);
    if (inviteTimer.current) window.clearTimeout(inviteTimer.current);
    if (tossFaceTimer.current) window.clearTimeout(tossFaceTimer.current);
  }, []);

  // Fetch live pet state on mount + every 60s so real-time decay is visible.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/pet');
        if (cancelled) return;
        if (!res.ok) {
          setStatus((prev) => (prev === 'loading' ? 'error' : prev));
          return;
        }
        const data = (await res.json()) as PetApiState;
        if (!cancelled) {
          setPet(data);
          setStatus('ready');
          syncBrainPet(data);
        }
      } catch {
        if (!cancelled) setStatus((prev) => (prev === 'loading' ? 'error' : prev));
      }
    };
    load();
    const timer = setInterval(load, PET_REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [syncBrainPet]);

  // Fetch live quest state (real metrics + tiered chains) on mount + every 60s.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/quests');
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as QuestState;
        if (!cancelled) setQuest(data);
      } catch {
        /* keep last real quest state on a transient failure */
      }
    };
    load();
    const timer = setInterval(load, QUEST_REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  // The Play care action: pop 2–4 wrestling minis and nudge the arcade tab.
  const triggerPlay = useCallback(() => {
    setWrestlers(2 + Math.floor(Math.random() * 3));
    setWrestlersKey((k) => k + 1);
    if (wrestlerTimer.current) window.clearTimeout(wrestlerTimer.current);
    wrestlerTimer.current = window.setTimeout(() => setWrestlers(0), 4600);
    setArcadeInvite(true);
    if (inviteTimer.current) window.clearTimeout(inviteTimer.current);
    inviteTimer.current = window.setTimeout(() => setArcadeInvite(false), 2600);
  }, []);

  const runPayoff = useCallback((action: QuickAction['key']) => {
    const payoff = payoffRef.current;
    const char = heroCharRef.current;
    switch (action) {
      case 'feed':
        payoff?.feed(actionBtnRefs.current.feed ?? null, char);
        break;
      case 'shower':
        payoff?.shower(sceneRef.current);
        break;
      case 'pet':
        if (char) {
          const r = char.getBoundingClientRect();
          payoff?.hearts(r.left + r.width / 2, r.top + r.height * 0.4, 3);
        }
        break;
      case 'play':
        triggerPlay();
        break;
      default:
        break;
    }
  }, [triggerPlay]);

  const handleQuickAction = useCallback((action: QuickAction['key']) => {
    setPet((prev) => {
      if (!prev) return prev;
      const bumps = NEED_BUMPS[action];
      const nextNeeds = { ...prev.needs };
      (Object.keys(bumps) as NeedField[]).forEach((key) => {
        nextNeeds[key] = clampPercent(nextNeeds[key] + (bumps[key] ?? 0));
      });
      return { ...prev, needs: nextNeeds, careToday: Math.min(prev.careToday + 1, 10) };
    });
    setPulseKey((k) => k + 1);
    brainApi.react(ACTION_EXPRESSION[action], { priority: 4, holdMs: 2600, pulse: true });
    const gesture = ACTION_GESTURE[action];
    if (gesture) heroHandleRef.current?.playGesture(gesture);
    runPayoff(action);

    fetch('/api/pet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: PetApiState | null) => { if (data) { setPet(data); syncBrainPet(data); } })
      .catch(() => { /* keep optimistic state on failure */ });
  }, [brainApi, syncBrainPet, runPayoff]);

  // A quick press on the free-roam hero counts as a pet (full care payoff).
  const handlePetStart = useCallback(() => {
    handleQuickAction('pet');
  }, [handleQuickAction]);

  const handlePetMove = useCallback((clientX: number, clientY: number) => {
    const now = performance.now();
    if (now - lastPetMoveRef.current < 200) return;
    lastPetMoveRef.current = now;
    payoffRef.current?.hearts(clientX, clientY, 1);
  }, []);

  const handlePokeVat = useCallback((clientX: number, clientY: number) => {
    payoffRef.current?.bubbles(clientX, clientY, 8);
    heroHandleRef.current?.reactToPointer('hover');
    brainApi.react('surprised', { priority: 2, holdMs: 1200 });
  }, [brainApi]);

  // The hero and the wrestling minis messing around — throttled so a flurry of
  // bumps flashes one playful mood, not a strobe of brain events.
  const handleHeroPlay = useCallback(() => {
    const now = performance.now();
    if (now - lastHeroPlayRef.current < 1500) return;
    lastHeroPlayRef.current = now;
    brainApi.react('excited', { priority: 2, holdMs: 1200 });
  }, [brainApi]);

  // Local (pet-screen-only) face reactions to being tossed around — the pet's
  // own indignation, not an app-wide brain event.
  const flashTossFace = useCallback((face: FlubberExpression) => {
    setTossFace(face);
    if (tossFaceTimer.current) window.clearTimeout(tossFaceTimer.current);
    tossFaceTimer.current = window.setTimeout(() => setTossFace(null), TOSS_FACE_MS);
  }, []);

  const handleTossGrab = useCallback(() => flashTossFace('surprised'), [flashTossFace]);
  const handleTossLand = useCallback(() => flashTossFace('disappointed'), [flashTossFace]);

  const handleGameXp = useCallback(() => {
    brainApi.react('celebrating', { priority: 3, holdMs: 1800, pulse: true });
    fetch('/api/pet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'play' }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: PetApiState | null) => { if (data) { setPet(data); syncBrainPet(data); } })
      .catch(() => { /* score still recorded client-side in GamesHub */ });
  }, [brainApi, syncBrainPet]);

  const handleClaim = useCallback((id: string) => {
    setClaimingId(id);
    fetch('/api/quests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { state: QuestState } | null) => {
        if (data?.state) {
          setQuest(data.state);
          brainApi.react('celebrating', { priority: 3, holdMs: 1800, pulse: true });
        }
      })
      .catch(() => { /* leave state; the panel stays claimable */ })
      .finally(() => setClaimingId(null));
  }, [brainApi]);

  const heroExpression = tossFace ?? brain.expression;

  const renderLevel = (state: PetApiState) => (
    <Panel accent title="Level &amp; XP" className="pet-panel pet-level-panel">
      {quest ? (
        <>
          <div className="pet-level__top">
            <span className="pet-level__badge">Lv {quest.level}</span>
            <span className="pet-level__meta">
              <span className="pet-level__streak">
                <Sparkles size={11} aria-hidden="true" />
                {state.careStreak} day streak
              </span>
              <span className="pet-level__cap">Cap {quest.levelCap}</span>
            </span>
          </div>
          <ProgressBar
            label={`${quest.xpIntoLevel} / ${quest.xpForNextLevel} XP`}
            value={(quest.xpIntoLevel / Math.max(1, quest.xpForNextLevel)) * 100}
          />
          <div className="pet-level__care-stars" role="img" aria-label={`${state.careToday} of 10 daily care stars`}>
            {Array.from({ length: 10 }).map((_, i) => (
              <Star
                key={i}
                size={13}
                className={`pet-care__star${i < state.careToday ? ' pet-care__star--filled' : ''}`}
                aria-hidden="true"
              />
            ))}
            <span className="pet-level__care-count">{state.careToday}/10 today</span>
          </div>
        </>
      ) : (
        <p className="pet-level__loading">Loading quest progress…</p>
      )}
    </Panel>
  );

  const renderCare = (state: PetApiState) => {
    const needs = state.needs;
    const mood = getMood(state.avg);

    return (
      <div className="pet-care-view">
        <div className="pet-care-view__stage">
          <div className="pet-care-view__mood">
            <span className="pet-crt__brand">
              Blubber
              <Heart size={16} aria-hidden="true" fill="currentColor" />
            </span>
            <span className="pet-crt__mood">
              <span aria-hidden="true">{mood.emoji}</span>
              {mood.label}
            </span>
          </div>

          <div className="pet-care-view__tube">
            <PetHabitatScene
              ref={sceneRef}
              expression={heroExpression}
              pulseKey={pulseKey + brain.pulseKey}
              heroSize={HERO_SIZE}
              reduceMotion={reduceMotion}
              ambient={ambient}
              variant="crt"
              freeRoam
              wrestlers={wrestlers}
              wrestlersKey={wrestlersKey}
              characterRef={heroCharRef}
              onSlotReady={setHeroHandle}
              onPokeVat={handlePokeVat}
              onPetStart={handlePetStart}
              onPetMove={handlePetMove}
              onTossGrab={handleTossGrab}
              onTossLand={handleTossLand}
              onHeroPlay={handleHeroPlay}
            />
          </div>

          <div className="pet-care-view__actions" role="group" aria-label="Care actions">
            {QUICK_ACTIONS.map((action) => {
              const Icon = action.icon;
              return (
                <button
                  key={action.key}
                  type="button"
                  className="pet-action-btn"
                  ref={(el) => { actionBtnRefs.current[action.key] = el; }}
                  onClick={() => handleQuickAction(action.key)}
                >
                  <span className="pet-action-btn__icon" aria-hidden="true">
                    <Icon size={16} />
                  </span>
                  <span className="pet-action-btn__label">{action.label}</span>
                </button>
              );
            })}
          </div>

          <div className="pet-care-view__status">
            <span>Age {formatAge(state.createdAt)}</span>
            <span aria-hidden="true">·</span>
            <span>Last care {relativeTime(state.lastCareAt)}</span>
            <span aria-hidden="true">·</span>
            <span>Grab &amp; fling the Blubber · pet it · poke the vat</span>
          </div>
        </div>

        <aside className="pet-care-view__rail">
          <Panel title="Needs" className="pet-panel pet-needs-panel" avoidRoam>
            <div className="pet-needs__list">
              {NEED_DEFS.map((need) => {
                const Icon = need.icon;
                return (
                  <div className="pet-needs__item" key={need.key}>
                    <span className="pet-needs__icon" aria-hidden="true">
                      <Icon size={14} />
                    </span>
                    <ProgressBar label={need.label} value={needs[need.key]} />
                  </div>
                );
              })}
            </div>
          </Panel>

          <Panel
            title="Quests"
            className="pet-panel pet-quest-strip-panel"
            avoidRoam
            action={
              quest && quest.claimableCount > 0 ? (
                <span className="pet-quest-ready">{quest.claimableCount} ready</span>
              ) : undefined
            }
          >
            {quest ? (
              <QuestPanel quests={quest.quests} variant="strip" claimingId={claimingId} onClaim={handleClaim} />
            ) : (
              <p className="pet-level__loading">Loading quests…</p>
            )}
          </Panel>

          {renderLevel(state)}
        </aside>
      </div>
    );
  };

  const renderQuests = () => (
    <Panel accent title="Quest Board" className="pet-panel pet-quest-board-panel" avoidRoam>
      {quest ? (
        <QuestPanel quests={quest.quests} variant="board" claimingId={claimingId} onClaim={handleClaim} />
      ) : (
        <p className="pet-level__loading">Loading quests…</p>
      )}
    </Panel>
  );

  const renderStats = () => (
    <Panel accent title="Record" className="pet-panel pet-stats-panel" avoidRoam>
      {quest ? (
        <PetStats quest={quest} expression={heroExpression} pulseKey={pulseKey + brain.pulseKey} />
      ) : (
        <p className="pet-level__loading">Loading stats…</p>
      )}
    </Panel>
  );

  const renderArcade = () => (
    <div className="pet-arcade">
      <div className="pet-arcade__intro">
        <span className="section-label">Arcade</span>
        <p>Every finished game feeds Blubber a little fun. Pick a cabinet.</p>
      </div>
      <div className="pet-arcade__hub">
        <GamesHub onXp={handleGameXp} />
      </div>
    </div>
  );

  const renderTab = () => {
    switch (activeTab) {
      case 'care':
        return pet ? renderCare(pet) : <PetStatusNotice status={status} />;
      case 'quests':
        return renderQuests();
      case 'stats':
        return renderStats();
      case 'play':
        return renderArcade();
      default:
        return null;
    }
  };

  return (
    <div className={['pet-screen', className].filter(Boolean).join(' ')}>
      <header className="pet-screen__header">
        <div className="pet-screen__title">
          <PawPrint size={18} aria-hidden="true" />
          <span>Virtual Blubber</span>
        </div>
        <nav className="pet-screen__tabs" aria-label="Virtual pet sections">
          {TABS.map((tab) => {
            const isActive = tab.id === activeTab;
            const inviting = tab.id === 'play' && arcadeInvite && !isActive;
            return (
              <button
                key={tab.id}
                type="button"
                className={[
                  'pet-screen__tab',
                  isActive ? 'pet-screen__tab--active' : '',
                  inviting ? 'pet-screen__tab--invite' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => setActiveTab(tab.id)}
                aria-current={isActive ? 'page' : undefined}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
      </header>

      <div className="pet-screen__body">{renderTab()}</div>

      {/* Fixed, pointer-transparent overlay for care-action particle bursts. */}
      <CarePayoffs ref={payoffRef} reduceMotion={reduceMotion} />
    </div>
  );
}
