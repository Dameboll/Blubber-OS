'use client';

/**
 * /flubber-grid-test — Phase 1 verification page for the FlubberHost
 * (docs/plans/flubber-3d-everywhere.md). 17 simultaneous live-3D slots
 * through ONE shared WebGL context: 1 hero + 4 MID + 12 MICRO, plus 3
 * below-the-fold MICRO slots for the culling assertion. Not linked from
 * the app; blender/grid_verify.mjs drives it headlessly.
 */

import { useState } from 'react';
import Flubber3D from '../../components/Flubber3D';
import { getFlubberHost } from '../../lib/flubber3d/host';

const MID_EXPRESSIONS = ['happy', 'working', 'thinking', 'celebrating'] as const;
const MICRO_EXPRESSIONS = [
  'idle', 'happy', 'excited', 'focused', 'worried', 'surprised',
  'tired', 'mischievous', 'determined', 'overjoyed', 'dj-mode', 'sleeping',
] as const;

export default function FlubberGridTestPage() {
  const [pulseKey, setPulseKey] = useState(0);
  const [heroExpression, setHeroExpression] = useState('waving');

  return (
    <main
      data-testid="grid-root"
      style={{ background: '#0a120b', minHeight: '100vh', padding: 24, fontFamily: 'monospace', color: '#9fdfb0' }}
    >
      <h1 style={{ fontSize: 14 }}>flubber-grid-test — 1 hero + 4 mid + 12 micro (one WebGL context)</h1>
      <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
        <button type="button" data-testid="pulse-all" onClick={() => setPulseKey((k) => k + 1)}>
          pulse hero
        </button>
        <button
          type="button"
          data-testid="hero-celebrate"
          onClick={() => setHeroExpression('celebrating')}
        >
          hero celebrate
        </button>
        <button
          type="button"
          data-testid="force-context-loss"
          onClick={() => {
            const host = getFlubberHost();
            host.forceContextLoss();
            // WEBGL_lose_context never restores on its own — simulate the
            // browser's restoration the way a real transient loss behaves.
            window.setTimeout(() => host.forceContextRestore(), 600);
          }}
        >
          force context loss
        </button>
      </div>

      <section data-testid="hero-row" style={{ display: 'flex', gap: 16 }}>
        <Flubber3D expression={heroExpression} size={208} tier="hero" pulseKey={pulseKey} seed={100} />
      </section>

      <section data-testid="mid-row" style={{ display: 'flex', gap: 16, marginTop: 16 }}>
        {MID_EXPRESSIONS.map((expression, index) => (
          <Flubber3D key={expression} expression={expression} size={96} tier="mid" seed={200 + index} />
        ))}
      </section>

      <section data-testid="micro-row" style={{ display: 'flex', gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
        {MICRO_EXPRESSIONS.map((expression, index) => (
          <Flubber3D key={expression} expression={expression} size={48} tier="micro" seed={300 + index} />
        ))}
      </section>

      <div style={{ height: 1600 }} aria-hidden="true" />

      <section data-testid="offscreen-row" style={{ display: 'flex', gap: 12 }}>
        <Flubber3D expression="happy" size={48} tier="micro" seed={400} />
        <Flubber3D expression="worried" size={48} tier="micro" seed={401} />
        <Flubber3D expression="excited" size={48} tier="micro" seed={402} />
      </section>
    </main>
  );
}
