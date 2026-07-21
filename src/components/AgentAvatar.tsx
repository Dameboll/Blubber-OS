'use client';

/**
 * AgentAvatar — a live-3D mini-Blubber wearing an agent's role identity (a
 * rarity-colored ring + a role-icon badge — the BADGE APPROXIMATION of the
 * outfit costumes). Shared across the Agents screen roster/detail, the sidebar
 * Recent Agents list, and the dashboard feeds so every agent reads the same
 * role the same way.
 *
 * Role/rarity/expression are resolved from the agent's name (+ optional
 * description) via lib/agent-outfits. Pass `expressionOverride` to force a pose
 * (e.g. a sleeping idle agent), otherwise the role's default expression is used.
 */

import Flubber3D from './Flubber3D';
import type { FlubberExpression } from './FlubberCharacter';
import { agentSeed, resolveOutfit } from '../lib/agent-outfits';
import './AgentAvatar.css';

export interface AgentAvatarProps {
  /** The agent's name/label (humanized is fine — matching is word-based). */
  name: string;
  /** Optional description to sharpen role resolution. */
  description?: string;
  /** Avatar diameter in px (the inner Blubber stage). Default 44. */
  size?: number;
  /** Force a Blubber tier; defaults to micro at ≤56px, mid above. */
  tier?: 'micro' | 'mid' | 'hero';
  /** Override the role's default expression (e.g. 'sleeping' for idle). */
  expressionOverride?: FlubberExpression;
  /** Increment to trigger a one-shot squash on the inner Blubber. */
  pulseKey?: number;
  /** Larger badge treatment for detail headers. */
  large?: boolean;
  /** Render a flat rarity-ring + centered role icon with NO 3D Blubber. Used
   *  in tiny dense lists (dashboard TopAgents/Activity) where a micro 3D body
   *  reads as a green "booger" and eats WebGL budget for nothing. */
  flat?: boolean;
  className?: string;
}

export default function AgentAvatar({
  name,
  description,
  size = 44,
  tier,
  expressionOverride,
  pulseKey,
  large,
  flat,
  className,
}: AgentAvatarProps) {
  const outfit = resolveOutfit(name, description);
  const Icon = outfit.icon;
  const resolvedTier = tier ?? (size <= 56 ? 'micro' : 'mid');
  const expression = expressionOverride ?? outfit.expression;

  const classes = [
    'agent-avatar',
    `agent-avatar--${outfit.rarity}`,
    large ? 'agent-avatar--lg' : '',
    flat ? 'agent-avatar--flat' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  if (flat) {
    return (
      <span
        className={classes}
        title={`${name} · ${outfit.role}`}
        style={{ width: size, height: size }}
      >
        <Icon size={Math.round(size * 0.5)} aria-hidden="true" />
      </span>
    );
  }

  return (
    <span className={classes} title={`${name} · ${outfit.role}`}>
      <Flubber3D
        expression={expression}
        size={size}
        tier={resolvedTier}
        pulseKey={pulseKey}
        seed={agentSeed(name)}
      />
      <span className="agent-avatar__badge" aria-hidden="true">
        <Icon size={large ? 14 : 11} />
      </span>
    </span>
  );
}
