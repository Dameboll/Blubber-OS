'use client';

import './AgentCard.css';

/**
 * AgentCard — one card per entry from /api/agents (which reads
 * ~/.claude/agents/*.md and returns the roster as JSON).
 *
 * Clicking a card asks the parent (TabBar) to launch this agent: open a new
 * tab in a sensible default cwd and have the PTY type + submit the agent's
 * invocation prompt automatically, exactly as if a user had typed it. The
 * card itself does not touch the WebSocket — TabBar owns tab creation and
 * TerminalPane owns the spawn/initialPrompt wire call, so there is a single
 * source of truth for how a session comes to life (see TerminalPane.tsx).
 */

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  /**
   * Assumed shape from /api/agents — if the route instead returns a raw
   * frontmatter blob, map it to this shape at the API boundary rather than
   * threading a different type through the component tree.
   */
  invocationPrompt?: string;
  /** Optional per-agent accent, e.g. from frontmatter `color:`. Rendered as a small dot, not a border wash. */
  color?: string;
}

interface AgentCardProps {
  agent: AgentInfo;
  onLaunch: (agent: AgentInfo) => void;
}

export default function AgentCard({ agent, onLaunch }: AgentCardProps) {
  return (
    <button
      type="button"
      className="agent-card"
      onClick={() => onLaunch(agent)}
      title={agent.description}
    >
      <span className="agent-card-header">
        {agent.color && (
          <span className="agent-card-dot" style={{ backgroundColor: agent.color }} aria-hidden="true" />
        )}
        <span className="agent-card-name">{agent.name}</span>
      </span>
      <span className="agent-card-description">{agent.description}</span>
    </button>
  );
}
