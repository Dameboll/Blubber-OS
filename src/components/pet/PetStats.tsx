'use client';

/**
 * PetStats — the Virtual Blubber's real "record" board (Stats tab).
 *
 * "Reading his stats": Blubber stands on a small pedestal (dais ring + core
 * glow — the same visual language as FlubberHome's dais, simplified and
 * statically toned to the pet screen's green palette) on the LEFT; a clean
 * list of REAL stat rows fills the RIGHT. Every row has a live source:
 *   Age            → quest.metrics.daysActive (whole days since the
 *                     app_meta stats baseline — the "fresh out the box" reset)
 *   Projects       → quest.metrics.projects (distinct real Development
 *                     projects with indexed activity since baseline)
 *   Tokens Today   → GET /api/insights .daily (today's real token burn)
 *   Tokens (7d)    → GET /api/insights .daily (trailing 7-day real sum)
 *   Quests         → quest.quests claimed / total (real server-validated claims)
 *   Level          → quest.level / quest.levelCap
 *   XP             → quest.xpIntoLevel / quest.xpForNextLevel
 * A "sessions opened" stat was considered (per the build plan) but has no
 * persisted real source — pty-manager only tracks a live in-memory PTY count
 * with no API exposing it — so it is omitted rather than fabricated.
 */

import { useEffect, useState } from 'react';
import FlubberCharacter, { type FlubberExpression } from '../FlubberCharacter';
import type { QuestState } from '../../server/quest-store';
import './PetStats.css';

interface DailyPoint {
  date: string;
  tokens: number;
  runs: number;
}

interface InsightsPayload {
  daily?: DailyPoint[];
}

type TokenLoad = 'loading' | 'ready' | 'error';

/** Compact formatter — 50000 → "50K", 5_000_000 → "5M". */
function fmt(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 10_000) return `${Math.round(n / 100) / 10}K`;
  return n.toLocaleString();
}

export interface PetStatsProps {
  /** Full live quest state — metrics + claim status power every row. */
  quest: QuestState;
  /** Live brain expression, for continuity with the rest of the pet screen.
   * Defaults to a calm idle when the caller doesn't have one handy. */
  expression?: FlubberExpression;
  pulseKey?: number;
}

export default function PetStats({ quest, expression = 'happy', pulseKey = 0 }: PetStatsProps) {
  const [daily, setDaily] = useState<DailyPoint[] | null>(null);
  const [tokenStatus, setTokenStatus] = useState<TokenLoad>('loading');

  // Self-fetch real daily token burn once on mount (the Stats tab only
  // mounts this component while active) — quest/pet state is already piped
  // in from the parent, but per-day token burn lives in the usage-analytics
  // rollup, not the quest store.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/insights')
      .then((res) => (res.ok ? (res.json() as Promise<InsightsPayload>) : Promise.reject(res)))
      .then((data) => {
        if (cancelled) return;
        setDaily(Array.isArray(data.daily) ? data.daily : []);
        setTokenStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setTokenStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const { metrics } = quest;
  const questsClaimed = quest.quests.filter((q) => q.status === 'claimed').length;
  const questsTotal = quest.quests.length;

  // getDailyTokensAndRuns returns oldest-first, zero-filled through today —
  // the last entry is today; the trailing 7 (including today) is the week.
  const tokensToday = daily && daily.length > 0 ? daily[daily.length - 1].tokens : null;
  const tokensWeek = daily && daily.length > 0 ? daily.slice(-7).reduce((sum, d) => sum + d.tokens, 0) : null;

  const tokenCell = (value: number | null): string => {
    if (tokenStatus === 'error') return '—';
    if (tokenStatus === 'loading' || value === null) return '…';
    return fmt(value);
  };

  const rows: { label: string; value: string; sub?: string }[] = [
    {
      label: 'Age',
      value: `${metrics.daysActive}`,
      sub: metrics.daysActive === 1 ? 'day since baseline' : 'days since baseline',
    },
    { label: 'Projects', value: `${metrics.projects}`, sub: 'worked on' },
    { label: 'Tokens Today', value: tokenCell(tokensToday) },
    { label: 'Tokens (7d)', value: tokenCell(tokensWeek), sub: 'trailing week' },
    { label: 'Quests', value: `${questsClaimed} / ${questsTotal}`, sub: 'completed' },
    { label: 'Level', value: `${quest.level}`, sub: `cap ${quest.levelCap}` },
    { label: 'XP', value: `${quest.xpIntoLevel} / ${quest.xpForNextLevel}`, sub: 'into next level' },
  ];

  return (
    <div className="pet-stats">
      <div className="pet-stats__pedestal">
        <div className="pet-stats__hero">
          <FlubberCharacter expression={expression} size={112} tier="mid" pulseKey={pulseKey} />
        </div>
        <div className="pet-stats__dais" aria-hidden="true">
          <span className="pet-stats__dais-core" />
          <span className="pet-stats__dais-ring" />
        </div>
        <span className="pet-stats__pedestal-label">Blubber</span>
      </div>

      <div className="pet-stats__list">
        {rows.map((row) => (
          <div className="pet-stats__row" key={row.label}>
            <span className="pet-stats__row-label">{row.label}</span>
            <span className="pet-stats__row-values">
              <span className="pet-stats__row-value">{row.value}</span>
              {row.sub && <span className="pet-stats__row-sub">{row.sub}</span>}
            </span>
          </div>
        ))}
        <p className="pet-stats__note">
          Every number here is real — care history, live token burn, quest claims, and projects worked.
          Nothing is simulated.
        </p>
      </div>
    </div>
  );
}
