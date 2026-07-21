'use client';

/**
 * QuestPanel — renders the Virtual Blubber's quests (LANE F). Two variants over
 * the SAME real data from /api/quests (src/server/quest-store.ts):
 *   - 'strip'  a compact right-rail list: the single active/claimable quest per
 *              chain, so the Care tab shows live quest progress in one window.
 *   - 'board'  the full tiered board for the dedicated Quests tab.
 *
 * Every progress bar is a REAL metric (care history, token burn, agent runs,
 * projects worked, care streak, days active) — nothing is fabricated. A claim
 * is only offered when the server has confirmed the target is genuinely reached;
 * the button POSTs and the parent reconciles against the authoritative state.
 */

import { Check, Lock, Sparkles } from 'lucide-react';
import type { QuestView } from '../../server/quest-store';
import './QuestPanel.css';

/** Compact metric formatter — 50000 → "50K", 5_000_000 → "5M". */
function compact(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1_000) return `${Math.round(n / 100) / 10}K`;
  return String(Math.round(n));
}

function pct(current: number, target: number): number {
  if (target <= 0) return 100;
  return Math.min(100, Math.max(0, (current / target) * 100));
}

/** Roman numerals for the tier-dots row — every chain tops out at 5 tiers
 * today; the table stretches a little further so a future longer chain
 * still renders something sane instead of falling back to a raw number. */
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
function roman(n: number): string {
  return ROMAN[n - 1] ?? String(n);
}

interface QuestRowProps {
  quest: QuestView;
  claiming: boolean;
  onClaim: (id: string) => void;
  compactRow?: boolean;
}

function QuestRow({ quest, claiming, onClaim, compactRow = false }: QuestRowProps) {
  const claimable = quest.status === 'claimable';
  const claimed = quest.status === 'claimed';
  const locked = quest.status === 'locked';
  const progress = pct(quest.current, quest.target);

  return (
    <div
      className={[
        'quest-row',
        compactRow ? 'quest-row--compact' : '',
        claimed ? 'quest-row--claimed' : '',
        claimable ? 'quest-row--claimable' : '',
        locked ? 'quest-row--locked' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="quest-row__head">
        <span className="quest-row__title">{quest.title}</span>
        <span className="quest-row__xp">
          {claimed ? <Check size={12} aria-hidden="true" /> : <Sparkles size={12} aria-hidden="true" />}
          {quest.xp} XP
        </span>
      </div>
      {!compactRow && <p className="quest-row__desc">{quest.description}</p>}
      <div className="quest-row__track" aria-hidden="true">
        <span
          className="quest-row__fill"
          style={{ transform: `scaleX(${(claimed ? 100 : progress) / 100})` }}
        />
      </div>
      <div className="quest-row__foot">
        <span className="quest-row__count">
          {locked ? (
            <>
              <Lock size={11} aria-hidden="true" /> Locked
            </>
          ) : (
            `${compact(Math.min(quest.current, quest.target))} / ${compact(quest.target)}`
          )}
        </span>
        {claimable ? (
          <button
            type="button"
            className="quest-row__claim"
            onClick={() => onClaim(quest.id)}
            disabled={claiming}
          >
            {claiming ? '…' : 'Claim'}
          </button>
        ) : claimed ? (
          <span className="quest-row__done">Done</span>
        ) : null}
      </div>
    </div>
  );
}

export interface QuestPanelProps {
  quests: QuestView[];
  variant: 'strip' | 'board';
  claimingId: string | null;
  onClaim: (id: string) => void;
  /** How many rows the strip shows before "+N more". */
  stripLimit?: number;
}

export default function QuestPanel({
  quests,
  variant,
  claimingId,
  onClaim,
  stripLimit = 3,
}: QuestPanelProps) {
  if (variant === 'strip') {
    // One live quest per chain: the first not-yet-claimed tier (claimable first).
    const perChain = new Map<string, QuestView>();
    for (const q of quests) {
      if (q.status === 'claimed') continue;
      const existing = perChain.get(q.chain);
      if (!existing) perChain.set(q.chain, q);
    }
    const active = Array.from(perChain.values()).sort((a, b) => {
      const rank = (s: QuestView['status']) => (s === 'claimable' ? 0 : s === 'active' ? 1 : 2);
      return rank(a.status) - rank(b.status);
    });
    const shown = active.slice(0, stripLimit);
    const remaining = active.length - shown.length;

    if (active.length === 0) {
      return <p className="quest-strip__empty">Every quest complete. Legendary.</p>;
    }

    return (
      <div className="quest-strip">
        {shown.map((q) => (
          <QuestRow key={q.id} quest={q} claiming={claimingId === q.id} onClaim={onClaim} compactRow />
        ))}
        {remaining > 0 && (
          <span className="quest-strip__more">+{remaining} more in the Quests tab</span>
        )}
      </div>
    );
  }

  // Board: group by chain (tiers stay in ascending order — the read order
  // from quest-store is already tier 0..N per chain). One compact card per
  // chain shows only its CURRENT tier (the first not-yet-claimed one, or the
  // final tier once the whole chain is claimed) plus a roman-numeral dots
  // row so every earlier claimed tier "rolls up" into a single filled dot
  // instead of its own row. This is what makes all 6 chains fit one window.
  const byChain = new Map<string, QuestView[]>();
  for (const q of quests) {
    const list = byChain.get(q.chain) ?? [];
    list.push(q);
    byChain.set(q.chain, list);
  }

  return (
    <div className="quest-board">
      {Array.from(byChain.entries()).map(([chain, tiers]) => {
        const label = tiers[0]?.chainLabel ?? chain;
        const activeQuest = tiers.find((t) => t.status !== 'claimed') ?? tiers[tiers.length - 1];
        const activeIndex = tiers.findIndex((t) => t.id === activeQuest.id);
        const claimedCount = tiers.filter((t) => t.status === 'claimed').length;
        return (
          <section className="quest-chain-card" key={chain}>
            <header className="quest-chain-card__head">
              <span className="quest-chain-card__label">{label}</span>
              <span className="quest-chain-card__tier">
                {roman(activeIndex + 1)} / {roman(tiers.length)}
              </span>
            </header>
            <div
              className="quest-chain-card__dots"
              role="img"
              aria-label={`${label}: tier ${activeIndex + 1} of ${tiers.length}, ${claimedCount} completed`}
            >
              {tiers.map((t, i) => {
                const state = t.status === 'claimed' ? 'claimed' : t.id === activeQuest.id ? 'active' : 'locked';
                return (
                  <span
                    key={t.id}
                    className={`quest-dot quest-dot--${state}`}
                    title={t.title}
                    aria-hidden="true"
                  >
                    {roman(i + 1)}
                  </span>
                );
              })}
            </div>
            <QuestRow quest={activeQuest} claiming={claimingId === activeQuest.id} onClaim={onClaim} compactRow />
          </section>
        );
      })}
    </div>
  );
}
