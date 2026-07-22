'use client';

/**
 * RetakeSoulInterview — small always-available control that re-launches the
 * Soul Interview (see src/components/soul/SoulInterview.tsx) from Settings.
 *
 * Self-gates exactly like RecommendedPlugins.tsx: checks GET /api/kit/install
 * itself and renders nothing until a Starter Kit install is confirmed on
 * this machine — Community Edition never sees this button, same as it never
 * sees the interview itself.
 *
 * Firing requestSoulInterview() (src/lib/soul.ts) dispatches the same live
 * 'blubber:start-soul' event page.tsx already listens for — the interview
 * overlay is mounted there, not here — the same live-event path KitInstaller
 * already uses to re-fire requestTour() from this same screen. A retake
 * always overwrites: SoulInterview always POSTs the full current answer set
 * to POST /api/soul, and that route always replaces both the saved record
 * and ~/.claude/blubber-profile.md wholesale.
 *
 * OWNERSHIP: this file + RetakeSoulInterview.css only.
 */

import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { requestSoulInterview } from '../../lib/soul';
import './RetakeSoulInterview.css';

export default function RetakeSoulInterview() {
  // null = still checking (render nothing, same as a confirmed "no kit" —
  // never flash a paid-tier control while the check is in flight).
  const [kitInstalled, setKitInstalled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/kit/install')
      .then((res) => res.json() as Promise<{ installed?: boolean }>)
      .then((data) => {
        if (!cancelled) setKitInstalled(Boolean(data?.installed));
      })
      .catch(() => {
        // Can't confirm kit state — stay hidden rather than leaking a
        // paid-tier surface into the free build on a failed check.
        if (!cancelled) setKitInstalled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!kitInstalled) return null;

  return (
    <button type="button" className="rsi-btn" onClick={() => requestSoulInterview()}>
      <Sparkles size={14} aria-hidden="true" />
      Retake soul interview
    </button>
  );
}
