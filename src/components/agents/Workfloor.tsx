'use client';

/**
 * Workfloor — the dynamic strip of live agent "workrooms" under the hero
 * Blubber (last-hard-push Phase 2). The ask: whenever Claude fires a real
 * agent/skill run, it gets its own little command room the moment it starts,
 * and stays there until it's done — visible, one by one, never all at once.
 *
 * A bay here represents a REAL running run (GET /api/agents-live's `running`)
 * that has NO matching manually-spawned standby card already showing it in
 * the Active Agents grid — see AgentsScreen's materialize effect for the
 * claim check and the CORE LAW (a bay only ever exists for a genuinely
 * running run, never speculative). `working` is always true here for exactly
 * that reason.
 *
 * Zero footprint when idle: the parent only mounts this component once at
 * least one bay exists, so the pool below reclaims 100% of the main column's
 * height automatically (plain conditional render, not a CSS trick).
 */

import AgentWorkstation from '../AgentWorkstation';
import type { FlubberSlotHandle } from '../../lib/flubber3d/host';
import './Workfloor.css';

export interface WorkfloorBayView {
  runId: string;
  role: string;
  seed: number;
  name: string;
  category: 'skill' | 'agent';
  /** Real live "Tool → target" read off this run's own transcript, or null
   *  when nothing's landed yet — never a fabricated placeholder. */
  activity: string | null;
}

export interface WorkfloorProps {
  bays: WorkfloorBayView[];
  /** Real count of running-and-unclaimed runs beyond the visible cap — an
   *  honest "+N working" chip, never a fabricated 7th+ bay. */
  overflowCount: number;
  registerCell: (id: string) => (el: HTMLElement | null) => void;
  registerSlot: (id: string) => (h: FlubberSlotHandle | null) => void;
}

export default function Workfloor({ bays, overflowCount, registerCell, registerSlot }: WorkfloorProps) {
  if (bays.length === 0 && overflowCount === 0) return null;

  return (
    <div className="acc-workfloor" aria-label="Live agent workroom">
      {bays.map((bay) => (
        <div key={bay.runId} className="wf-bay" ref={registerCell(`wf-${bay.runId}`)}>
          <div className="wf-bay__stage">
            <AgentWorkstation
              role={bay.role}
              seed={bay.seed}
              working
              activityLabel={bay.activity}
              size={54}
              onSlotReady={registerSlot(`wf-${bay.runId}`)}
            />
          </div>
          <div className="wf-bay__head">
            <span className="wf-bay__name" title={bay.name}>
              {bay.name}
            </span>
            <span className={`wf-bay__tag wf-bay__tag--${bay.category}`}>{bay.category}</span>
          </div>
        </div>
      ))}
      {overflowCount > 0 && (
        <div
          className="wf-overflow"
          title={`${overflowCount} more agent${overflowCount === 1 ? '' : 's'} working right now`}
        >
          +{overflowCount} working
        </div>
      )}
    </div>
  );
}
