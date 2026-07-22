'use client';

import { useEffect, useState } from 'react';

/**
 * useKitInstalled — mirrors RecommendedPlugins.tsx's Starter-Kit gate: fetch
 * GET /api/kit/install once and expose whether the paid Starter Kit is present
 * on this machine. Any failure (or an unconfirmed check) resolves to `false`
 * so a paid-tier surface never leaks into the free Community build. Returns
 * `null` while the check is still in flight — callers should render the free
 * fallback until it resolves to `true`.
 */
export function useKitInstalled(): boolean | null {
  // null = still checking; false = no kit (render the free fallback); true = kit present.
  const [installed, setInstalled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/kit/install')
      .then((res) => res.json() as Promise<{ installed?: boolean }>)
      .then((data) => {
        if (!cancelled) setInstalled(Boolean(data?.installed));
      })
      .catch(() => {
        // Can't confirm kit state — stay on the free fallback rather than
        // leaking a paid-tier surface into the free build on a failed check.
        if (!cancelled) setInstalled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return installed;
}
