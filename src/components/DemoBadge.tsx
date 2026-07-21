'use client';

/**
 * DemoBadge — small fixed-corner "Demo Mode" pill, rendered only while Demo
 * Mode is active (see src/lib/demo-mode.ts). Purely presentational: reads
 * the flag once on mount via isDemoModeActive() (which also handles the
 * `?demo=1`/`?demo=0` activation side effect) and renders nothing otherwise.
 *
 * Not mounted anywhere yet — see this lane's INTEGRATION REPORT for exactly
 * where to drop it (AppShell, once).
 */

import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { isDemoModeActive } from '../lib/demo-mode';
import './DemoBadge.css';

export default function DemoBadge() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    setActive(isDemoModeActive());
  }, []);

  if (!active) return null;

  return (
    <div className="demo-badge" aria-label="Demo mode is active — showing sample data">
      <Sparkles size={13} aria-hidden="true" />
      <span>Demo Mode</span>
    </div>
  );
}
