'use client';

/**
 * flubber-test — STAGE 6 verification harness (docs/plans/flubber-refsheet-rebuild.md).
 * Not part of the product surface. DashboardScreen only ever drives FlubberMesh
 * with expression="waving"/"working" (see DashboardScreen.tsx's mascotExpression),
 * so Worried/Celebrate clips and the worried face-swap are never reachable through
 * normal navigation. This route mounts FlubberMesh directly with a
 * query-param-controlled expression (?expr=waving|working|celebrating|worried) and
 * a button that fires pulseKey (hop/squash), plus window.__flubberFrameCount for an
 * FPS probe -- exactly the props Stage 6's gate needs to drive every clip/feature
 * directly instead of guessing through the dashboard's own state machine.
 *
 * Safe to delete after Stage 6 verification, or keep as a standing debug route --
 * it renders nothing on the real dashboard and adds no weight to any other page.
 */

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';

const FlubberMesh = dynamic(() => import('../../components/FlubberMesh'), { ssr: false });

const EXPRESSIONS = [
  'idle', 'happy', 'waving', 'working', 'focused', 'thinking', 'confused',
  'tired', 'surprised', 'celebrating', 'sleeping', 'mischievous',
  'determined', 'overjoyed', 'plotting', 'heart-eyes', 'disappointed',
  'dj-mode', 'worried', 'excited',
] as const;

export default function FlubberTestPage() {
  const [expression, setExpression] = useState('waving');
  const [pulseKey, setPulseKey] = useState(0);
  const [debugStatic, setDebugStatic] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const expr = params.get('expr');
    if (expr) setExpression(expr);
    setDebugStatic(params.get('static') === '1');
  }, []);

  useEffect(() => {
    let count = 0;
    let raf = 0;
    const loop = () => {
      count += 1;
      (window as unknown as { __flubberFrameCount: number }).__flubberFrameCount = count;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#0a1a0a', display: 'flex', flexDirection: 'column' }}>
      {!debugStatic && (
        <div style={{ padding: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {EXPRESSIONS.map((e) => (
            <button
              key={e}
              data-testid={`expr-${e}`}
              onClick={() => setExpression(e)}
              style={{ fontWeight: expression === e ? 700 : 400 }}
            >
              {e}
            </button>
          ))}
          <button data-testid="pulse-btn" onClick={() => setPulseKey((k) => k + 1)}>
            pulse
          </button>
          <span data-testid="current-expr">{expression}</span>
        </div>
      )}
      <div
        className="flubber-test__mascot"
        data-flubber-test-stage="1"
        style={{ flex: 1, position: 'relative' }}
      >
        <FlubberMesh
          expression={expression}
          pulseKey={pulseKey}
          debugStatic={debugStatic}
          className="flubber-test__mesh"
        />
      </div>
    </div>
  );
}
