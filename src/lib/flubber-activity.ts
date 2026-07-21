/**
 * flubber-activity — the vocabulary of "what Claude is doing right now," and
 * how the home reacts to it.
 *
 * IDLE LIFE (dashboard-life lane): when nothing real is happening, the hero
 * doesn't just sit there breathing — it lives. pickIdleLifeStep() is the pure
 * scheduler brain for that: a weighted random pick among vibe/eat/shower/nap
 * (never a fixed loop, never the same beat twice in a row), each with a
 * duration and a natural pause before the next beat. Hero-tier bodies can't
 * actually roam (instance.ts hard-disables wander for the centred hero to
 * protect its circular blit mask), so "wandering" folds into `vibe` — an
 * occasional readable gesture (hop/wave/bounce) rather than literal
 * locomotion. This stays pure data; FlubberHome owns turning a step into a
 * real playGesture()/CarePayoffs() call.
 *
 * THE IDEA (the vision): Blubber is the agent with a skin on. Whatever the
 * real Claude Code session is doing — writing code, running a terminal command,
 * researching the web, planning, testing — Blubber's home visibly does the same
 * thing. Each activity resolves to a small set of holographic work-panels that
 * materialize around him, an ambient hue + energy, and a face. When the local
 * agent bridge lands (POST /api/agent-events → SSE), it just sets `activity`
 * and the whole room re-skins itself. Until then activity is derived from the
 * FlubberBrain's resolved expression (real terminal/nav/usage reactions) so the
 * room is already alive, not scripted.
 *
 * Pure data + pure mappers — no React, no DOM. FlubberHome/AgentWorkstation read
 * these to drive the visuals.
 */

import type { GestureName } from './flubber3d/motion';

/** The kinds of holographic panel a workspace can show. Each has its own
 * animated content in HoloPanel. */
export type HoloKind =
  | 'code' // scrolling code editor
  | 'terminal' // shell prompt + running lines + cursor
  | 'search' // web research — query bar + result rows
  | 'graph' // plan / mind-map — nodes + edges (thinking)
  | 'doc' // writing — document lines filling in
  | 'test' // test runner — pass/fail rows
  | 'design' // design canvas — frames + shapes
  | 'files' // file ops — create/edit rows
  | 'gears'; // processing / building — turning gears

/** What Blubber (or an agent) is doing. Coarse enough that a real tool-use
 * event maps cleanly onto one. */
export type FlubberActivity =
  | 'idle'
  | 'thinking'
  | 'planning'
  | 'coding'
  | 'building'
  | 'terminal'
  | 'researching'
  | 'writing'
  | 'testing'
  | 'designing'
  | 'debugging'
  | 'reviewing'
  | 'celebrating';

export interface ActivitySpec {
  activity: FlubberActivity;
  /** Short human label — the workspace's status line ("Writing code"). */
  label: string;
  /** First-person blurb, used for the hero caption / speech flavor. */
  blurb: string;
  /** Panels that materialize for this activity. [0] is the primary (largest). */
  panels: HoloKind[];
  /** Ambient hue for the room grade + dais (OKLCH/HSL hue degrees). */
  hue: number;
  /** 0..1 — drives bubble density, dais brightness, panel shimmer speed. */
  energy: number;
  /** Mascot expression (a FlubberExpression string). */
  expression: string;
}

// Green base hue ≈ 145. Warmer/amber (110-120) reads "stuck/debugging",
// cyan-green (160-168) reads "thinking/searching", pure bright green (132-140)
// reads "heads-down building".
export const ACTIVITIES: Record<FlubberActivity, ActivitySpec> = {
  idle: {
    activity: 'idle',
    label: 'Standing by',
    blurb: 'Standing by. What are we building?',
    panels: [],
    hue: 146,
    energy: 0.34,
    expression: 'happy',
  },
  thinking: {
    activity: 'thinking',
    label: 'Thinking it through',
    blurb: 'Thinking it through…',
    panels: ['graph'],
    hue: 162,
    energy: 0.5,
    expression: 'thinking',
  },
  planning: {
    activity: 'planning',
    label: 'Planning the approach',
    blurb: 'Mapping out the plan…',
    panels: ['graph', 'doc'],
    hue: 158,
    energy: 0.56,
    expression: 'focused',
  },
  coding: {
    activity: 'coding',
    label: 'Writing code',
    blurb: 'Writing code…',
    panels: ['code', 'files'],
    hue: 136,
    energy: 0.85,
    expression: 'working',
  },
  building: {
    activity: 'building',
    label: 'Building it',
    blurb: 'Building it out…',
    panels: ['code', 'gears'],
    hue: 132,
    energy: 0.92,
    expression: 'determined',
  },
  terminal: {
    activity: 'terminal',
    label: 'Running commands',
    blurb: 'Running commands…',
    panels: ['terminal'],
    hue: 140,
    energy: 0.78,
    expression: 'focused',
  },
  researching: {
    activity: 'researching',
    label: 'Researching',
    blurb: 'Digging through the web…',
    panels: ['search'],
    hue: 166,
    energy: 0.6,
    expression: 'thinking',
  },
  writing: {
    activity: 'writing',
    label: 'Writing it up',
    blurb: 'Writing it up…',
    panels: ['doc'],
    hue: 150,
    energy: 0.58,
    expression: 'working',
  },
  testing: {
    activity: 'testing',
    label: 'Running tests',
    blurb: 'Running the tests…',
    panels: ['test', 'terminal'],
    hue: 138,
    energy: 0.76,
    expression: 'focused',
  },
  designing: {
    activity: 'designing',
    label: 'Designing',
    blurb: 'Designing the interface…',
    panels: ['design'],
    hue: 152,
    energy: 0.72,
    expression: 'working',
  },
  debugging: {
    activity: 'debugging',
    label: 'Chasing a bug',
    blurb: 'Chasing down a bug…',
    panels: ['code', 'terminal'],
    hue: 118, // amber-green — the "stuck" tint
    energy: 0.8,
    expression: 'determined',
  },
  reviewing: {
    activity: 'reviewing',
    label: 'Reviewing',
    blurb: 'Reviewing the changes…',
    panels: ['code', 'test'],
    hue: 156,
    energy: 0.6,
    expression: 'focused',
  },
  celebrating: {
    activity: 'celebrating',
    label: 'Shipped it',
    blurb: 'Done! That one hits. 🎉',
    panels: ['test'],
    hue: 150,
    energy: 1,
    expression: 'celebrating',
  },
};

/** A single REAL, verifiable work event — the ONLY sanctioned input for
 * choosing which work-screen (holo panel set) materializes. It is either a real
 * tool invocation parsed from the ~/.claude logs (GET /api/recent: a genuine
 * skill/agent run, `toolName` + `category`) or a live terminal-watcher
 * classification (a real build pass/fail/exit). A brain expression / mood must
 * NEVER be routed through here — that is the whole point of this type existing
 * separately from activityFromExpression below. */
export interface RealWorkEvent {
  /** Real tool name from a /api/recent event (a skill or agent run), if any. */
  toolName?: string | null;
  /** 'skill' | 'agent' from the same event — the fallback read when the name
   * doesn't keyword-match a specific activity. */
  category?: 'skill' | 'agent' | null;
  /** A live terminal-watcher class, when this event came from real PTY output. */
  terminalKind?: 'success' | 'error' | 'exit-nonzero' | null;
}

/** Map a REAL work event to the activity its work-screen should show. Returns
 * 'idle' for a null/empty event so "no real event" can never fabricate a
 * working state — an expression/mood is deliberately not an accepted input.
 * This is the source panel gating must use; activityFromExpression (below) is
 * mood-derived and is NOT allowed to open a work panel. */
export function activityFromRealEvent(event: RealWorkEvent | null | undefined): FlubberActivity {
  if (!event) return 'idle';
  if (event.terminalKind) {
    // A real build result: a pass celebrates; an error / nonzero exit is a
    // genuine "chasing it down" read.
    return event.terminalKind === 'success' ? 'celebrating' : 'debugging';
  }
  const name = (event.toolName ?? '').toLowerCase().trim();
  if (!name) return 'idle';
  const has = (...keys: string[]) => keys.some((k) => name.includes(k));
  // Keyword match on the REAL skill/agent name (first hit wins).
  if (has('test', 'qa', 'e2e', 'playwright', 'vitest', 'jest')) return 'testing';
  if (has('debug', 'fix', 'bug', 'error', 'resolver', 'troubleshoot')) return 'debugging';
  if (has('research', 'search', 'scout', 'compete', 'market', 'exa')) return 'researching';
  if (has('design', 'ui', 'ux', 'frontend', 'slop', 'css', 'style')) return 'designing';
  if (has('review', 'audit', 'security', 'lint', 'inspect')) return 'reviewing';
  if (has('write', 'content', 'doc', 'article', 'blog', 'copy', 'seo', 'brand-voice')) return 'writing';
  if (has('plan', 'architect', 'scope', 'spec', 'orchestr', 'roadmap', 'system')) return 'planning';
  if (has('terminal', 'bash', 'shell', 'devops', 'deploy', 'git', 'ops')) return 'terminal';
  if (has('build', 'swarm', 'compile', 'bundle', 'forge', 'generat', 'proto')) return 'building';
  if (has('code', 'refactor', 'implement', 'pattern')) return 'coding';
  // A real event that didn't keyword-match — still honest to show a heads-down
  // work-screen: agents lean "building", skills lean "coding".
  return event.category === 'agent' ? 'building' : 'coding';
}

/** Derive an activity from the brain's resolved expression. MOOD-DERIVED and
 * therefore NOT a sanctioned source for opening a work panel (LAW: expression
 * alone must never fake work — use activityFromRealEvent for panel gating). Kept
 * for any non-panel consumer that still wants a mood-flavoured read. */
export function activityFromExpression(expr: string): FlubberActivity {
  switch (expr) {
    case 'working':
      return 'coding';
    case 'determined':
      return 'building';
    case 'focused':
      return 'terminal';
    case 'thinking':
      return 'thinking';
    case 'plotting':
      return 'planning';
    case 'confused':
      return 'debugging';
    case 'worried':
    case 'disappointed':
      return 'debugging';
    case 'celebrating':
    case 'overjoyed':
    case 'heart-eyes':
      return 'celebrating';
    case 'tired':
    case 'sleeping':
    case 'dj-mode':
      return 'idle';
    case 'excited':
      return 'building';
    default:
      return 'idle';
  }
}

/** Map an agent's resolved role (from agent-outfits) to the activity its
 * workstation should visibly be doing. Keeps each mini-flubber's little
 * workspace legible — a Designer's station shows a design canvas, a QA Tester's
 * shows a test runner, etc. */
export function activityForRole(role: string): FlubberActivity {
  switch (role) {
    case 'Coder':
      return 'coding';
    case 'Designer':
      return 'designing';
    case 'DevOps':
      return 'terminal';
    case 'Data Analyst':
      return 'researching';
    case 'QA Tester':
      return 'testing';
    case 'Editor':
      return 'reviewing';
    case 'Writer':
      return 'writing';
    case 'Architect':
      return 'planning';
    case 'Researcher':
      return 'researching';
    case 'Security':
      return 'debugging';
    case 'Innovator':
      return 'building';
    case 'Marketer':
      return 'writing';
    default:
      return 'coding';
  }
}

export function specFor(activity: FlubberActivity): ActivitySpec {
  return ACTIVITIES[activity] ?? ACTIVITIES.idle;
}

/** Ambient-only "on the clock" read (LAW 1 — the SessionProvider work latch).
 * When the work clock is on but the brain has produced NO specific activity, the
 * room holds this sustained working hue/energy/face so the hero visibly stays on
 * the clock — WITHOUT fabricating any labeled holo work-panel or scripted
 * "thinking"/"coding" work-screen. It is deliberately NOT a FlubberActivity and
 * resolves NO panels, task label, or blurb: only the ambient grade + face. Any
 * REAL activity (a genuine terminal/nav/usage-driven expression, or an explicit
 * `activity` from the agent bridge) always supersedes it and brings the real
 * panels. Source of truth: `isWorking` boolean, not a fabricated tool-use event. */
export const WORK_AMBIENT = {
  /** Heads-down green — the work-activity hue family, no task-specific tint. */
  hue: 140,
  /** Lit + busy, but short of the frantic 0.85+ of real coding/building. */
  energy: 0.62,
  /** Neutral heads-down face — never a task-specific "thinking"/"coding" claim. */
  expression: 'working',
} as const;

// ---------------------------------------------------------------------------
// Idle life — the dashboard hero's autonomous "living" scheduler
// ---------------------------------------------------------------------------

/** One beat of idle life. `vibe` covers the "wandering the home" read (the
 * hero can't literally roam — see file header) via an occasional readable
 * gesture; `eat`/`shower` pair a gesture with a CarePayoffs visual reusing the
 * Virtual Pet's feed/shower burst; `nap` is a held expression, no gesture. */
export type FlubberIdleAction = 'vibe' | 'eat' | 'shower' | 'nap';

export interface IdleLifeStep {
  action: FlubberIdleAction;
  /** Gesture to play for 'vibe' beats — null for eat/shower (FlubberHome
   * drives their own fixed gesture) and nap (no gesture, just held face). */
  gesture: GestureName | null;
  /** How long the beat's own animation/expression hold runs, in ms. */
  durationMs: number;
  /** Natural pause before the next beat is scheduled, in ms — randomized so
   * idle life never reads as a metronome. */
  pauseMs: number;
}

function randMs(min: number, max: number): number {
  return Math.round(min + Math.random() * (max - min));
}

const VIBE_GESTURES: GestureName[] = ['hop', 'wave', 'bounce'];

/** Weighted random next beat, biased away from repeating `avoid` back-to-back
 * so idle life doesn't fall into an obvious two-beat cycle. Weights: vibe is
 * the common resting state; eat/shower are occasional treats; nap is rare and
 * long, with a long recovery pause so the hero doesn't nap constantly. */
export function pickIdleLifeStep(avoid: FlubberIdleAction | null = null): IdleLifeStep {
  const table: { action: FlubberIdleAction; weight: number }[] = [
    { action: 'vibe', weight: 55 },
    { action: 'eat', weight: 16 },
    { action: 'shower', weight: 11 },
    { action: 'nap', weight: 18 },
  ];
  const pool = avoid ? table.filter((t) => t.action !== avoid) : table;
  const total = pool.reduce((sum, t) => sum + t.weight, 0);
  let roll = Math.random() * total;
  let chosen: FlubberIdleAction = pool[0].action;
  for (const t of pool) {
    roll -= t.weight;
    if (roll <= 0) {
      chosen = t.action;
      break;
    }
  }

  switch (chosen) {
    case 'eat':
      return { action: 'eat', gesture: null, durationMs: 1050, pauseMs: randMs(14_000, 26_000) };
    case 'shower':
      return { action: 'shower', gesture: null, durationMs: 1600, pauseMs: randMs(22_000, 38_000) };
    case 'nap':
      return { action: 'nap', gesture: null, durationMs: randMs(6_000, 14_000), pauseMs: randMs(26_000, 48_000) };
    case 'vibe':
    default: {
      const gesture = VIBE_GESTURES[Math.floor(Math.random() * VIBE_GESTURES.length)];
      return { action: 'vibe', gesture, durationMs: 900, pauseMs: randMs(8_000, 18_000) };
    }
  }
}
