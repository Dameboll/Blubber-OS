'use client';

/**
 * AgentWorkstation — a single mini agent's little workspace, made legible.
 *
 * The old version put a 120px procedural 3D desk behind each mini flubber; at
 * that size it read as mush. The ask was for the crew's stations to be "more
 * visually clear and established," each visibly doing its job. So a station now composes:
 *   - a framed bay with corner brackets (the "established" tech read),
 *   - the agent's activity as a compact HoloPanel monitor (a Designer shows a
 *     design canvas, a QA Tester a test runner — same visual language as the
 *     hero Blubber's workspace),
 *   - the mini flubber on its own glowing dais in front of the monitor,
 *   - a status LED.
 *
 * `onSlotReady` still forwards the hero mini-flubber's slot handle so the Agents
 * spawn choreography can pop each station in.
 *
 * REAL-WORK GATING (CORE LAW: panels only during real work). `working` is a
 * per-agent signal the PARENT resolves from real evidence (a matching recent
 * tool event, or the session's honest isWorking latch) — never a blanket flag.
 * The activity monitor (a HoloPanel themed by the role's activity) and its
 * liveness shimmer render ONLY while `working` is truly true. An idle bay is
 * just ambient light: its cinematic nook plate, a resting mini on its dais, and
 * a dim status LED — no panel, no shimmer, no fabricated activity. The
 * role→activity map is kept purely for VISUAL theming of that monitor, and only
 * ever surfaces during real work.
 */

import Flubber3D from './Flubber3D';
import HoloPanel from './HoloPanel';
import type { FlubberSlotHandle } from '../lib/flubber3d/host';
import { activityForRole, specFor, type FlubberActivity } from '../lib/flubber-activity';
import './AgentWorkstation.css';

/**
 * Each role gets a tiny cinematic "nook" plate (public/bg/role-*.webp) behind
 * its bay — a Designer sits in a swatch studio, a Security agent in a shield
 * vault, a Coder at a code terminal. Maps the resolved role label to its plate
 * slug; an unknown role falls back to the coder nook.
 */
const ROLE_ROOM: Record<string, string> = {
  'QA Tester': 'qa',
  Security: 'security',
  'Data Analyst': 'data',
  DevOps: 'devops',
  Designer: 'designer',
  Writer: 'writer',
  Editor: 'editor',
  Coder: 'coder',
  Architect: 'architect',
  Researcher: 'researcher',
  Innovator: 'innovator',
  Marketer: 'marketer',
};

function roomSlug(role: string): string {
  return ROLE_ROOM[role] ?? 'coder';
}

export interface AgentWorkstationProps {
  role: string;
  activity?: FlubberActivity;
  /** A REAL live "what's happening right now" line (e.g. "Edit → file.ts"),
   *  straight off a live run's own transcript read (GET /api/agents-live's
   *  per-run `activity`). When set, it overrides the role-derived generic
   *  label in the monitor header — a genuine per-agent status, not a themed
   *  placeholder. Never fabricated by this component; the caller only ever
   *  passes a real value or omits the prop. */
  activityLabel?: string | null;
  expression?: string;
  seed?: number;
  size?: number;
  working?: boolean;
  onSlotReady?: (handle: FlubberSlotHandle | null) => void;
  className?: string;
}

export default function AgentWorkstation({
  role,
  activity,
  activityLabel,
  expression,
  seed,
  size = 66,
  working = false,
  onSlotReady,
  className,
}: AgentWorkstationProps) {
  // spec drives the ambient hue/energy tint always; the monitor it themes only
  // materializes while the agent is really working.
  const resolved = activity ?? activityForRole(role);
  const spec = specFor(resolved);
  const primary = spec.panels[0] ?? 'code';
  // A resting mini wears a calm face, not a fabricated "working" one.
  const face = expression ?? (working ? 'working' : 'happy');
  const classes = ['aws', className ?? ''].filter(Boolean).join(' ');

  return (
    <div
      className={classes}
      data-activity={resolved}
      data-working={working ? 'true' : 'false'}
      style={{ ['--fh-hue' as string]: spec.hue, ['--fh-energy' as string]: spec.energy }}
    >
      <span className={`aws__room aws__room--${roomSlug(role)}`} aria-hidden="true" />
      <span className="aws__bracket aws__bracket--tl" aria-hidden="true" />
      <span className="aws__bracket aws__bracket--tr" aria-hidden="true" />
      <span className="aws__bracket aws__bracket--bl" aria-hidden="true" />
      <span className="aws__bracket aws__bracket--br" aria-hidden="true" />

      {/* Activity monitor = REAL-WORK ONLY. It renders solely while the agent is
          genuinely working (per-agent signal from the parent). An idle bay skips
          it entirely — ambient light with no fabricated work-screen. */}
      {working && (
        <div className="aws__monitor is-working">
          {/* CORE LAW: never show a role-guessed label in the same slot real
              transcript-read activity occupies — a viewer can't tell a guess
              apart from real data. Neutral "Working" (mirrors FlubberHome's
              forcedWork fallback) until a real activity string lands; never
              spec.label as a stand-in for it. */}
          <HoloPanel kind={primary} label={activityLabel ?? 'Working'} compact seed={seed ?? 0} />
          {/* Honest liveness signal: a neutral shimmer sweep, NOT a fabricated
              percentage. There's no real per-agent progress feed, so the sweep
              only says "active", it never claims a completion number. */}
          <span className="aws__working" aria-hidden="true" />
        </div>
      )}

      <div className="aws__desk">
        <span className="aws__dais" aria-hidden="true" />
        <Flubber3D
          expression={face}
          size={size}
          tier="mid"
          seed={seed}
          onSlotReady={onSlotReady}
          className="aws__flubber"
        />
      </div>

      <span className={`aws__led${working ? ' is-working' : ''}`} aria-hidden="true" />
    </div>
  );
}
