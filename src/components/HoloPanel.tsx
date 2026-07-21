'use client';

/**
 * HoloPanel — one holographic "work surface" that visualizes a single kind of
 * activity (code, terminal, web search, plan graph, doc, tests, design, files,
 * gears). These float around the hero Blubber (and inside each mini agent
 * workstation) so you can SEE what the agent is doing, not just read a status.
 *
 * Real-data bodies (LANE G / LAW 1): the terminal, code, and files work-screens
 * render REAL signals — the terminal tails the shared ws-client's actual PTY
 * output ring, and code/files show the real last few tool invocations from
 * /api/recent (a shared, refcounted poll). They start empty and fill in from
 * live data; they NEVER show fabricated command text or fake file rows. The
 * remaining bodies (search/graph/doc/test/design/gears) are abstract, wordless
 * CSS-animated ambiance — no fabricated claims — and these panels only ever
 * mount while the real work clock is running (FlubberHome gates on isWorking).
 * The morph in/out between activities is driven by the parent (FlubberHome).
 *
 * `compact` shrinks a panel to fit inside a mini agent workstation card.
 */

import { memo, useEffect, useState, type ReactElement } from 'react';
import { Braces, FlaskConical, Folder, Globe, PenLine, Settings2, Share2, SquarePen, TerminalSquare } from 'lucide-react';
import type { HoloKind } from '../lib/flubber-activity';
import { wsClient } from '../lib/ws-client';
import { humanizeSlug } from '../lib/humanize';
import './HoloPanel.css';

interface HoloPanelProps {
  kind: HoloKind;
  /** Status label shown in the panel header (e.g. "Writing code"). */
  label?: string;
  /** Shrinks type/padding to fit a mini workstation card. */
  compact?: boolean;
  /** Desyncs animation phase across many panels. */
  seed?: number;
  className?: string;
}

const KIND_META: Record<HoloKind, { title: string; Icon: typeof Braces }> = {
  code: { title: 'editor', Icon: Braces },
  terminal: { title: 'shell', Icon: TerminalSquare },
  search: { title: 'research', Icon: Globe },
  graph: { title: 'plan', Icon: Share2 },
  doc: { title: 'draft', Icon: PenLine },
  test: { title: 'tests', Icon: FlaskConical },
  design: { title: 'canvas', Icon: SquarePen },
  files: { title: 'files', Icon: Folder },
  gears: { title: 'engine', Icon: Settings2 },
};

// ── real recent-events store (shared across panels) ─────────────────────────
// One refcounted poll of /api/recent for every work-screen that needs it (the
// code + files bodies), so N simultaneous panels don't each hit the route.

interface RecentToolEvent {
  toolName: string | null;
  category: 'skill' | 'agent' | null;
  project: string | null;
  ts: string;
}

const RECENT_POLL_MS = 6000;
const RECENT_LIMIT = 6;
let recentCache: RecentToolEvent[] = [];
const recentSubscribers = new Set<() => void>();
let recentTimer: ReturnType<typeof setInterval> | null = null;

async function fetchRecentEvents(): Promise<void> {
  try {
    const res = await fetch(`/api/recent?limit=${RECENT_LIMIT}`);
    if (!res.ok) return;
    const data = (await res.json()) as { events?: RecentToolEvent[] };
    recentCache = Array.isArray(data.events) ? data.events : [];
    recentSubscribers.forEach((cb) => cb());
  } catch {
    /* keep the last real snapshot on a transient failure */
  }
}

function subscribeRecentEvents(cb: () => void): () => void {
  recentSubscribers.add(cb);
  if (recentSubscribers.size === 1) {
    fetchRecentEvents();
    recentTimer = setInterval(fetchRecentEvents, RECENT_POLL_MS);
  } else {
    cb(); // hand the newcomer the cached snapshot immediately
  }
  return () => {
    recentSubscribers.delete(cb);
    if (recentSubscribers.size === 0 && recentTimer) {
      clearInterval(recentTimer);
      recentTimer = null;
    }
  };
}

function useRecentEvents(): RecentToolEvent[] {
  const [, force] = useState(0);
  useEffect(() => subscribeRecentEvents(() => force((n) => n + 1)), []);
  return recentCache;
}

// ── per-kind bodies ─────────────────────────────────────────────────────────

/** Real "what the agent just did" rows — the last few genuine tool invocations
 * (skill/agent runs) from /api/recent, newest first. Backs the code + files
 * work-screens so they show REAL activity instead of fabricated file/edit rows.
 * A dim scan placeholder (no fake text) holds until a real event is indexed. */
function RecentEventsBody() {
  const events = useRecentEvents();
  if (events.length === 0) {
    return (
      <div className="holo-evt holo-evt--empty" aria-hidden="true">
        <span className="holo-evt__scan" />
      </div>
    );
  }
  return (
    <div className="holo-evt">
      {events.slice(0, 5).map((evt, i) => (
        <div key={`${evt.ts}-${i}`} className="holo-evt__row" style={{ animationDelay: `${i * 0.4}s` }}>
          <span className={`holo-evt__verb holo-evt__verb--${evt.category ?? 'skill'}`}>
            {evt.category === 'agent' ? 'AGENT' : 'SKILL'}
          </span>
          <span className="holo-evt__name">{humanizeSlug(evt.toolName ?? 'task')}</span>
          {evt.project && <span className="holo-evt__proj">{evt.project}</span>}
        </div>
      ))}
    </div>
  );
}

const TERM_TAIL_LINES = 5;

/** Real terminal work-screen: the last few ACTUAL PTY output lines from the
 * shared ws-client output ring — never fabricated command text. A lone blinking
 * cursor is the honest "waiting on output" placeholder when nothing has
 * streamed yet. Re-syncs on every new real output frame. */
function TerminalBody() {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    const sync = () => setLines(wsClient.getRecentOutput(TERM_TAIL_LINES));
    sync();
    const unsubscribe = wsClient.subscribeAll((message) => {
      if (message.type === 'output') sync();
    });
    return unsubscribe;
  }, []);

  return (
    <div className="holo-term">
      {lines.map((line, i) => (
        <span key={`${i}-${line}`} className="holo-term__line">
          <span className="holo-term__prompt">$</span>
          <span className="holo-term__text">{line}</span>
        </span>
      ))}
      <span className="holo-term__line holo-term__line--live">
        <span className="holo-term__prompt">$</span>
        <span className="holo-term__cursor" />
      </span>
    </div>
  );
}

function SearchBody() {
  return (
    <div className="holo-search">
      <div className="holo-search__bar">
        <Globe size={11} aria-hidden="true" />
        <span className="holo-search__q" />
        <span className="holo-caret holo-caret--inline" />
      </div>
      <div className="holo-search__results">
        {[74, 88, 60].map((w, i) => (
          <div key={i} className="holo-search__row" style={{ animationDelay: `${i * 0.4}s` }}>
            <span className="holo-search__dot" />
            <span className="holo-search__lines">
              <span className="holo-search__title" style={{ width: `${w}%` }} />
              <span className="holo-search__url" style={{ width: `${w - 22}%` }} />
            </span>
          </div>
        ))}
      </div>
      <span className="holo-search__scan" aria-hidden="true" />
    </div>
  );
}

// Plan graph — a root node with children, edges pulse in sequence.
const GRAPH_NODES = [
  { x: 50, y: 22, r: 7 },
  { x: 24, y: 58, r: 5.5 },
  { x: 50, y: 74, r: 5.5 },
  { x: 78, y: 56, r: 5.5 },
];
const GRAPH_EDGES: Array<[number, number]> = [
  [0, 1],
  [0, 2],
  [0, 3],
];

function GraphBody() {
  return (
    <svg className="holo-graph" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {GRAPH_EDGES.map(([a, b], i) => (
        <line
          key={i}
          className="holo-graph__edge"
          x1={GRAPH_NODES[a].x}
          y1={GRAPH_NODES[a].y}
          x2={GRAPH_NODES[b].x}
          y2={GRAPH_NODES[b].y}
          style={{ animationDelay: `${0.3 + i * 0.35}s` }}
        />
      ))}
      {GRAPH_NODES.map((n, i) => (
        <circle
          key={i}
          className={`holo-graph__node${i === 0 ? ' is-root' : ''}`}
          cx={n.x}
          cy={n.y}
          r={n.r}
          style={{ animationDelay: `${i * 0.35}s` }}
        />
      ))}
    </svg>
  );
}

function DocBody() {
  const widths = [40, 92, 80, 96, 68, 88, 54];
  return (
    <div className="holo-doc">
      <span className="holo-doc__title" />
      {widths.map((w, i) => (
        <span
          key={i}
          className="holo-doc__line"
          style={{ ['--w' as string]: `${w}%`, animationDelay: `${i * 0.32}s` }}
        />
      ))}
    </div>
  );
}

const TEST_ROWS: Array<{ w: number; state: 'pass' | 'run' | 'fail' }> = [
  { w: 66, state: 'pass' },
  { w: 80, state: 'pass' },
  { w: 54, state: 'run' },
  { w: 72, state: 'pass' },
];

function TestBody() {
  return (
    <div className="holo-test">
      {TEST_ROWS.map((row, i) => (
        <div key={i} className="holo-test__row" style={{ animationDelay: `${i * 0.45}s` }}>
          <span className={`holo-test__mark holo-test__mark--${row.state}`} />
          <span className="holo-test__label" style={{ width: `${row.w}%` }} />
        </div>
      ))}
      <span className="holo-test__count">passing</span>
    </div>
  );
}

function DesignBody() {
  return (
    <div className="holo-design">
      <span className="holo-design__frame holo-design__frame--a" />
      <span className="holo-design__frame holo-design__frame--b" />
      <span className="holo-design__frame holo-design__frame--c" />
      <span className="holo-design__marquee" aria-hidden="true" />
    </div>
  );
}

function GearsBody() {
  return (
    <div className="holo-gears" aria-hidden="true">
      <Settings2 className="holo-gears__g holo-gears__g--1" />
      <Settings2 className="holo-gears__g holo-gears__g--2" />
      <Settings2 className="holo-gears__g holo-gears__g--3" />
    </div>
  );
}

const BODIES: Record<HoloKind, () => ReactElement> = {
  code: RecentEventsBody,
  terminal: TerminalBody,
  search: SearchBody,
  graph: GraphBody,
  doc: DocBody,
  test: TestBody,
  design: DesignBody,
  files: RecentEventsBody,
  gears: GearsBody,
};

function HoloPanelImpl({ kind, label, compact, seed = 0, className }: HoloPanelProps) {
  const meta = KIND_META[kind];
  const Body = BODIES[kind];
  const classes = ['holo-panel', compact ? 'holo-panel--compact' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes} data-kind={kind} style={{ ['--holo-seed' as string]: seed }}>
      <div className="holo-panel__bar">
        <meta.Icon size={compact ? 10 : 12} className="holo-panel__icon" aria-hidden="true" />
        <span className="holo-panel__title">{label ?? meta.title}</span>
        <span className="holo-panel__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className="holo-panel__body">
        <Body />
      </div>
      <span className="holo-panel__sheen" aria-hidden="true" />
    </div>
  );
}

const HoloPanel = memo(HoloPanelImpl);
export default HoloPanel;
