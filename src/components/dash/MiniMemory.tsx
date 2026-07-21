'use client';

/**
 * MiniMemory — Dashboard "Memory" tab (PILL WORLDS + MINI DASH, Lane 2). A
 * compact, self-fetching version of MemoryScreen's real three bubbles
 * (Session Context / Project Knowledge / Operator · OS Identity), all sourced from
 * the same real /api/memory route MemoryScreen uses — same honest-empty
 * states, condensed for a dashboard tile. See MemoryScreen.tsx for the full
 * per-field breakdown of what each bubble reads.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Brain } from 'lucide-react';
import { useSession } from '../../context/SessionProvider';
import './MiniMemory.css';

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
  knowledge: string | null;
}

interface MemoryResponse {
  identity: OwnerIdentity | null;
  project: MemoryProject | null;
}

type LoadState = 'loading' | 'ready' | 'error';

const TRUNCATE_LENGTH = 150;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max - 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Same "which open terminal tab counts as the active project" resolution as
 * MemoryScreen's useChosenProject — duplicated (not imported) so this mini
 * has zero compile-time coupling to a full screen file. */
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
    return first ? { root: first.projectRoot as string, name: first.projectName as string } : null;
  }, [sessions, activeSessionId]);
}

export default function MiniMemory() {
  const chosen = useChosenProject();
  const projectKey = chosen ? `${chosen.root}/${chosen.name}` : '';

  const [data, setData] = useState<MemoryResponse | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const chosenRef = useRef(chosen);
  chosenRef.current = chosen;

  useEffect(() => {
    const controller = new AbortController();
    const active = chosenRef.current;
    const params = active ? `?root=${encodeURIComponent(active.root)}&name=${encodeURIComponent(active.name)}` : '';
    fetch(`/api/memory${params}`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`memory fetch failed: ${res.status}`);
        return res.json() as Promise<MemoryResponse>;
      })
      .then((json) => {
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
  const identityLine = identity?.creed[0] ?? identity?.beliefs[0] ?? identity?.fields[0]?.value ?? null;

  return (
    <div className="mini-memory">
      <div className="mini-memory__head">
        <Brain size={13} aria-hidden="true" />
        <span>Memory</span>
      </div>
      <div className="mini-memory__body">
        {state === 'loading' && <p className="mini-memory__empty">Loading…</p>}
        {state === 'error' && <p className="mini-memory__empty">Couldn&rsquo;t load memory.</p>}
        {state === 'ready' && (
          <>
            <div className="mini-memory__bubble">
              <span className="mini-memory__bubble-title">Session Context</span>
              <p className="mini-memory__bubble-text">
                {project?.context
                  ? truncate(project.context, TRUNCATE_LENGTH)
                  : project
                    ? 'No ai-context.md in this project yet.'
                    : 'Open a project in the terminal to load its context.'}
              </p>
            </div>
            <div className="mini-memory__bubble">
              <span className="mini-memory__bubble-title">Project Knowledge</span>
              <p className="mini-memory__bubble-text">
                {project?.knowledge
                  ? truncate(project.knowledge, TRUNCATE_LENGTH)
                  : project
                    ? 'No CLAUDE.md or README in this project yet.'
                    : 'Open a project in the terminal to load its context.'}
              </p>
            </div>
            <div className="mini-memory__bubble">
              <span className="mini-memory__bubble-title">Operator &middot; OS Identity</span>
              <p className="mini-memory__bubble-text">
                {identityLine ? truncate(identityLine, TRUNCATE_LENGTH) : 'No identity recorded yet.'}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
