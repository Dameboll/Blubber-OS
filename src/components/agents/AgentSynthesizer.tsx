'use client';

/**
 * AgentSynthesizer — the Starter-Kit-only surface that replaces the Activity
 * Feed in the Agents screen's right rail (see AgentsScreen.tsx's kit gate).
 * Describe an agent or skill and Blubber opens a REAL `claude` authoring
 * session, cd'd into ~/.claude (src/lib/claude-dir.ts), with a crafted scaffold
 * prompt typed in for you — the same PTY plumbing New Terminal / Launch Agent
 * already use (SessionProvider.openTabWith -> TabBar.openTab -> TerminalPane ->
 * wsClient.spawn, initialPrompt typed + submitted ~1.5s after the REPL boots).
 * No new backend: the running Claude writes the file into ~/.claude/{agents,
 * skills}, and the Agents roster (GET /api/agents) picks it up on its next
 * refetch.
 *
 * Wraps Panel with className="acc-log-panel" so it inherits the exact same
 * /bg/syslog.webp "green-beam UFO" plate the Activity Feed sits on — the free
 * build keeps that panel unchanged; the kit build swaps only the contents.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Puzzle, Wand2 } from 'lucide-react';
import { Panel } from '../ui';
import { useSession } from '../../context/SessionProvider';
import { CLAUDE_DIR } from '../../lib/claude-dir';
import { narrate } from '../../lib/flubber3d/narration';
import './AgentSynthesizer.css';

type SynthKind = 'agent' | 'skill';

// How long the "on its way" confirmation line stays up after a submit.
const SENT_NOTICE_MS = 6000;

/** Builds the one-line scaffold prompt typed into the fresh `claude` session.
 *  Kept to a SINGLE line (the PTY submits on the first \r) — the caller
 *  collapses the user's description whitespace so a pasted multi-line brief
 *  can't submit early. Claude picks the kebab-case name and writes the file in
 *  the correct Claude Code format. */
function buildScaffoldPrompt(kind: SynthKind, description: string): string {
  const desc = description.replace(/\s+/g, ' ').trim();
  if (kind === 'agent') {
    return (
      `Create a new Claude Code subagent based on this description: "${desc}". ` +
      `Pick a short, clear kebab-case name for it. Write it as a single markdown ` +
      `file with YAML frontmatter (name, description, and an appropriate tools list) ` +
      `to ~/.claude/agents/<name>.md, following the standard Claude Code subagent ` +
      `format. Make the system prompt focused, specific, and production-ready. ` +
      `When you're done, tell me the exact file path you created.`
    );
  }
  return (
    `Create a new Claude Code skill based on this description: "${desc}". ` +
    `Pick a short, clear kebab-case name for it. Create the folder ` +
    `~/.claude/skills/<name>/ and write SKILL.md inside it with YAML frontmatter ` +
    `(name, description) and clear step-by-step instructions, following the ` +
    `standard Claude Code skill format. Make it focused and production-ready. ` +
    `When you're done, tell me the exact file path you created.`
  );
}

export interface AgentSynthesizerProps {
  className?: string;
  /** Forwarded to Panel — set when this panel sits where a roaming Blubber
   *  companion must not park (the Agents rail). */
  avoidRoam?: boolean;
}

export default function AgentSynthesizer({ className, avoidRoam }: AgentSynthesizerProps) {
  const { openTabWith } = useSession();
  const [kind, setKind] = useState<SynthKind>('agent');
  const [description, setDescription] = useState('');
  const [sentNotice, setSentNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  const handleSynthesize = useCallback(() => {
    const trimmed = description.trim();
    if (!trimmed) return;

    const title = kind === 'agent' ? 'New agent' : 'New skill';
    openTabWith({
      title,
      cwd: CLAUDE_DIR,
      initialPrompt: buildScaffoldPrompt(kind, trimmed),
    });
    narrate(kind === 'agent' ? 'Cooking up your agent…' : 'Cooking up your skill…', { mood: 'focused' });

    setSentNotice(`Opening a Claude session to build your ${kind}. Watch it work in the Terminal.`);
    setDescription('');
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setSentNotice(null), SENT_NOTICE_MS);
  }, [description, kind, openTabWith]);

  const canSynthesize = description.trim().length > 0;

  return (
    <Panel
      accent
      title="Agent Synthesizer"
      className={['synth-panel', className ?? ''].filter(Boolean).join(' ')}
      avoidRoam={avoidRoam}
    >
      <p className="synth__lead">Describe an agent or skill and Blubber will build it for you.</p>

      <div className="synth__toggle" role="group" aria-label="Create an agent or a skill">
        <button
          type="button"
          className={`synth__toggle-btn${kind === 'agent' ? ' synth__toggle-btn--on' : ''}`}
          aria-pressed={kind === 'agent'}
          onClick={() => setKind('agent')}
        >
          <Bot size={14} aria-hidden="true" />
          Agent
        </button>
        <button
          type="button"
          className={`synth__toggle-btn${kind === 'skill' ? ' synth__toggle-btn--on' : ''}`}
          aria-pressed={kind === 'skill'}
          onClick={() => setKind('skill')}
        >
          <Puzzle size={14} aria-hidden="true" />
          Skill
        </button>
      </div>

      <textarea
        className="synth__input"
        placeholder={
          kind === 'agent'
            ? 'e.g. a code reviewer that flags security issues in my API routes'
            : 'e.g. a skill that turns rough notes into a clean changelog'
        }
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={3}
      />

      <div className="synth__actions">
        <button type="button" className="synth__btn" onClick={handleSynthesize} disabled={!canSynthesize}>
          <Wand2 size={16} aria-hidden="true" />
          Synthesize {kind}
        </button>
      </div>

      {sentNotice && <p className="synth__notice">{sentNotice}</p>}
    </Panel>
  );
}
