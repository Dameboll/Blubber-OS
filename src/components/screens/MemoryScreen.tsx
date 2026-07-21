'use client';

/**
 * MemoryScreen — Blubber's persistent knowledge surface (LANE G, docs/plans/
 * idle-life-and-wiring.md). An INFO screen, NOT a work surface: it never reads
 * the work/break clock and Blubber just sits in a thinking pose.
 *
 * Real data only, three bubbles, all sourced from /api/memory:
 *   - Dame · OS Identity: ALWAYS filled from the global DAME-OS markdown his
 *     system already keeps — ~/.claude/USER.md (who he is / mission / family),
 *     ~/.claude/PERSONA.md (his top beliefs / morals) and ~/.claude/SOUL.md
 *     (the DAME-OS mantra — what the system is, what he's building). This is
 *     the OWNER'S OWN creed, not a contacts list. Independent of any project.
 *   - Session Context + Project Knowledge: HONESTLY BLANK ("Open a project in
 *     the terminal to load its context") until a project is actually open in
 *     the persistent terminal. The open terminal tabs come from useSession()'s
 *     `sessions` (their projectRoot/projectName are already derived there); the
 *     active project's docs (docs/ai-context.md, then CLAUDE.md/README) are
 *     background-loaded and dropped into these two bubbles. Missing docs render
 *     as an honest per-doc empty state, never invented copy.
 *
 * LAW 2 (one window): the screen is height:100% inside AppShell's bounded
 * content area and never grows it — the header is fixed and each bubble body
 * scrolls WITHIN its own fixed box, so the page itself never scrolls.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Database } from 'lucide-react';
import FlubberCharacter from '../FlubberCharacter';
import { Panel } from '../ui';
import { useSession } from '../../context/SessionProvider';
import './MemoryScreen.css';

// -- API response shape, mirrored locally (never imported from the route file,
// which pulls node:fs — same "duplicate, don't import" pattern SessionProvider
// uses for TabBar's tab summary). Kept in sync with src/app/api/memory/route.ts.
interface IdentityField {
  label: string;
  value: string;
}

interface OwnerIdentity {
  fields: IdentityField[];
  beliefs: string[];
  creed: string[];
}

interface MemoryProject {
  root: string;
  name: string;
  context: string | null;
  contextSource: 'ai-context' | 'claude-md' | 'readme' | null;
  knowledge: string | null;
  knowledgeSource: 'ai-context' | 'claude-md' | 'readme' | null;
}

interface MemoryResponse {
  identity: OwnerIdentity | null;
  project: MemoryProject | null;
}

type LoadState = 'loading' | 'ready' | 'error';

const SOURCE_LABELS: Record<NonNullable<MemoryProject['knowledgeSource']>, string> = {
  'ai-context': 'ai-context.md',
  'claude-md': 'CLAUDE.md',
  readme: 'README.md',
};

/** Picks the one project whose docs fill the two project bubbles: the active
 * terminal tab if it's a known Development project, otherwise the first open
 * tab that is one. Null when no open tab maps to a real project. */
function useChosenProject(): { root: string; name: string } | null {
  const { sessions, activeSessionId } = useSession();
  return useMemo(() => {
    const isProject = (root: string | null, name: string | null, exited: boolean): boolean =>
      Boolean(root) && Boolean(name) && !exited;

    const active = sessions.find((s) => s.id === activeSessionId);
    if (active && isProject(active.projectRoot, active.projectName, active.exited)) {
      return { root: active.projectRoot as string, name: active.projectName as string };
    }
    const first = sessions.find((s) => isProject(s.projectRoot, s.projectName, s.exited));
    if (first) return { root: first.projectRoot as string, name: first.projectName as string };
    return null;
  }, [sessions, activeSessionId]);
}

export default function MemoryScreen() {
  const chosen = useChosenProject();
  const projectKey = chosen ? `${chosen.root}/${chosen.name}` : '';

  const [data, setData] = useState<MemoryResponse | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  // Keep the last good identity on screen through a project-switch refetch
  // so the always-on bubble doesn't flicker back to "loading".
  const lastGoodRef = useRef<MemoryResponse | null>(null);
  // Read the chosen project through a ref so the fetch effect can key purely on
  // `projectKey` (a primitive) — that fully captures identity, so a new
  // `sessions` array reference that resolves to the same project doesn't refire.
  const chosenRef = useRef(chosen);
  chosenRef.current = chosen;

  useEffect(() => {
    const controller = new AbortController();
    const active = chosenRef.current;
    const params = active ? `?root=${encodeURIComponent(active.root)}&name=${encodeURIComponent(active.name)}` : '';

    // Only show the full loading state on the very first load; later refetches
    // (a project opening/switching) keep the last good data visible.
    if (!lastGoodRef.current) setState('loading');

    fetch(`/api/memory${params}`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`memory fetch failed: ${res.status}`);
        return res.json() as Promise<MemoryResponse>;
      })
      .then((json) => {
        lastGoodRef.current = json;
        setData(json);
        setState('ready');
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setState('error');
      });

    return () => controller.abort();
  }, [projectKey]);

  const identity = data?.identity ?? null;
  const project = data?.project ?? null;

  return (
    <div className="memory-screen">
      <header className="memory-screen__header">
        <Database size={18} aria-hidden="true" />
        <div>
          <h1>Memory</h1>
          <p>Blubber&rsquo;s persistent knowledge &mdash; the context that survives between sessions.</p>
        </div>
        <div className="memory-screen__mascot">
          <FlubberCharacter expression="thinking" size={92} mode="character" showToggle={false} />
        </div>
      </header>

      <div className="memory-screen__grid">
        <Panel accent title="Session Context" className="memory-panel">
          <ProjectBubble
            state={state}
            project={project}
            value={project?.context ?? null}
            source={project?.contextSource ?? null}
            missingDoc="ai-context.md"
          />
        </Panel>

        <Panel accent title="Project Knowledge" className="memory-panel">
          <ProjectBubble
            state={state}
            project={project}
            value={project?.knowledge ?? null}
            source={project?.knowledgeSource ?? null}
            missingDoc="CLAUDE.md or README"
          />
        </Panel>

        <Panel accent title="Dame &middot; OS Identity" className="memory-panel">
          <IdentityBubble state={state} identity={identity} />
        </Panel>
      </div>
    </div>
  );
}

interface ProjectBubbleProps {
  state: LoadState;
  project: MemoryProject | null;
  value: string | null;
  source: MemoryProject['contextSource'];
  missingDoc: string;
}

function ProjectBubble({ state, project, value, source, missingDoc }: ProjectBubbleProps) {
  if (state === 'loading') {
    return <p className="memory-panel__empty">Loading&hellip;</p>;
  }
  if (state === 'error' && !project) {
    return (
      <p className="memory-panel__empty">
        Couldn&rsquo;t load memory &mdash; is the dev server running? It&rsquo;ll retry on the next project switch.
      </p>
    );
  }
  if (!project) {
    return (
      <p className="memory-panel__empty">
        Open a project in the terminal to load its context.
      </p>
    );
  }
  if (!value) {
    return (
      <p className="memory-panel__empty">
        No {missingDoc} in <span className="memory-panel__project">{project.name}</span> yet.
      </p>
    );
  }
  return (
    <div className="memory-panel__content">
      <span className="memory-panel__project-tag">{project.name}</span>
      <p className="memory-panel__body">{value}</p>
      {source && <span className="memory-panel__source">{SOURCE_LABELS[source]}</span>}
    </div>
  );
}

interface IdentityBubbleProps {
  state: LoadState;
  identity: OwnerIdentity | null;
}

/** The owner's own creed — his USER.md identity fields, PERSONA.md beliefs and
 * the SOUL.md mantra. Every value is verbatim from those files; an absent file
 * simply drops its section. Honestly empty only when all three are missing. */
function IdentityBubble({ state, identity }: IdentityBubbleProps) {
  if (state === 'loading' && !identity) {
    return <p className="memory-panel__empty">Loading&hellip;</p>;
  }
  if (state === 'error' && !identity) {
    return <p className="memory-panel__empty">Couldn&rsquo;t load identity &mdash; check the dev server.</p>;
  }
  const fields = identity?.fields ?? [];
  const beliefs = identity?.beliefs ?? [];
  const creed = identity?.creed ?? [];
  if (fields.length === 0 && beliefs.length === 0 && creed.length === 0) {
    return <p className="memory-panel__empty">No identity recorded yet.</p>;
  }
  return (
    <div className="memory-panel__content">
      {fields.length > 0 && (
        <dl className="memory-identity">
          {fields.map((field) => (
            <div key={field.label} className="memory-identity__row">
              <dt className="memory-identity__label">{field.label}</dt>
              <dd className="memory-identity__value">{field.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {beliefs.length > 0 && (
        <div className="memory-identity__section">
          <span className="memory-identity__heading">Beliefs</span>
          <ul className="memory-beliefs">
            {beliefs.map((belief) => (
              <li key={belief} className="memory-beliefs__item">
                {belief}
              </li>
            ))}
          </ul>
        </div>
      )}
      {creed.length > 0 && (
        <div className="memory-identity__section">
          <span className="memory-identity__heading">Creed</span>
          {creed.map((line) => (
            <p key={line} className="memory-creed__line">
              {line}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
