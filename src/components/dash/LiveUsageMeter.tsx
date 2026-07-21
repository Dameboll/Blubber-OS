'use client';

/**
 * LiveUsageMeter — the in-depth "live burn" pill (Lane B), now the single
 * consolidated usage pill (merges what used to be three separate dashboard
 * panels: Token Usage, Usage Overview, and this Live Usage pill).
 *
 * Live half (always shown): real 5-hour session + weekly plan-limit meters
 * (from GET /api/usage-limits, the same OAuth usage data the terminal
 * statusline shows), a live tokens/min sparkline fed by the /api/live SSE
 * stream, today's In / Out / Cache token split (GET /api/usage-window), and
 * the current top token burner (GET /api/insights).
 *
 * Weekly half (opt-in via `showWeekly`): the 7-day token bar chart (peak day
 * highlighted, floating callout) that used to be the "Token Usage" panel, plus
 * one compact total/in-out-cache line that used to be the "Usage Overview"
 * panel's donut + legend (the donut is dropped — it duplicated the CACHE chip
 * already in the live half above). The bar data comes from GET /api/weekly,
 * which only DashboardScreen polls — passed down as `weeklyBarData` etc. so
 * this component never opens a second poll of that endpoint. The in/out/cache
 * split reuses this component's OWN already-fetched GET /api/usage-window
 * `breakdown.weekly` (no new fetch needed for that half either).
 *
 * Self-contained: fetches its own live-half data, so a parent just mounts
 * <LiveUsageMeter/> (or <LiveUsageMeter showWeekly .../> for the full pill).
 *
 * Honesty rules: every number is real. When the limits endpoint can't reach a
 * signed-in session it shows the last-known percentages with a dim "sync" dot —
 * never a blank pill, never a fabricated figure. The live half and the weekly
 * half degrade (loading/error/empty) independently — they're different data
 * sources with different fetch lifecycles, not one blended state.
 */

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Activity } from 'lucide-react';
import { useLiveUsage } from '../../hooks/useLiveUsage';
import { BarChart } from '../ui';
import type { BarChartDatum } from '../ui';
import './LiveUsageMeter.css';

// dash-liveusage plate (docs/plans/plate-manifest.json → /bg/telemetry.webp).
const PLATE_URL = '/bg/telemetry.webp';

const POLL_MS = 60_000;
const SPARK_BUCKETS = 48;
const BUCKET_MS = 1500;
const SPARK_WINDOW_SEC = (SPARK_BUCKETS * BUCKET_MS) / 1000;

interface LimitsPayload {
  session_pct: number | null;
  weekly_pct: number | null;
  session_resets: string | null;
  stale: boolean;
}

interface WindowSplit {
  totalTokens: number;
  tokensIn: number;
  tokensOut: number;
  tokensCache: number;
}

interface WindowPayload {
  fiveHour: number;
  weekly: number;
  today: number;
  breakdown?: { fiveHour: WindowSplit; weekly: WindowSplit; today: WindowSplit };
}

interface Burner {
  name: string;
  sharePct: number;
}

interface InsightsPayload {
  burners: Burner[];
}

type LoadState = 'loading' | 'ready' | 'error';

interface LiveUsageMeterProps {
  compact?: boolean;
  /** Renders the weekly-recap half beneath the live half — see the file
   *  header for what merged into this component and why. */
  showWeekly?: boolean;
  /** The 7 daily {label, value} bars from GET /api/weekly (dailyTrend),
   *  already mapped by the caller (see DashboardScreen's `barData`). */
  weeklyBarData?: BarChartDatum[];
  /** Index of the peak day in `weeklyBarData`, for the bright highlighted bar
   *  + floating callout. */
  weeklyBarHighlightIndex?: number;
  /** Total weekly tokens for the "N tokens" total line (mirrors
   *  DashboardScreen's own totals-with-fallback math, computed once there). */
  weeklyTotal?: number;
  /** Loading/error/ready state of the GET /api/weekly fetch that produced
   *  `weeklyBarData` — independent of this component's own live-half state. */
  weeklyState?: 'loading' | 'error' | 'ready';
}

/** Mirrors BarChart.tsx's internal geometry constants (VIEW_WIDTH / LABEL_AREA
 *  aren't exported from that shared component) so the weekly half can position
 *  a floating tooltip callout over the highlighted bar without modifying the
 *  shared ui/BarChart.tsx component. Keep in sync if that geometry changes. */
const WEEKLY_CHART_VIEW_WIDTH = 240;
const WEEKLY_CHART_LABEL_AREA = 20;
const WEEKLY_CHART_HEIGHT = 96;

interface BarCalloutPosition {
  leftPct: number;
  topPct: number;
}

/** Replicates BarChart.tsx's internal bar-geometry math (that component owns
 *  layout, not a position API) to place a floating callout above the
 *  highlighted weekly bar from outside it. */
function computeWeeklyBarCallout(
  data: BarChartDatum[],
  highlightIndex: number | undefined,
): BarCalloutPosition | null {
  if (highlightIndex === undefined || data.length === 0) return null;
  const plotHeight = WEEKLY_CHART_HEIGHT - WEEKLY_CHART_LABEL_AREA;
  const max = Math.max(...data.map((d) => d.value), 1);
  const slotWidth = WEEKLY_CHART_VIEW_WIDTH / Math.max(data.length, 1);
  const barWidth = Math.min(slotWidth * 0.5, 18);
  const barHeight = max > 0 ? (data[highlightIndex].value / max) * plotHeight : 0;
  const x = highlightIndex * slotWidth + (slotWidth - barWidth) / 2;
  const y = plotHeight - barHeight;
  return {
    leftPct: ((x + barWidth / 2) / WEEKLY_CHART_VIEW_WIDTH) * 100,
    topPct: (y / WEEKLY_CHART_HEIGHT) * 100,
  };
}

// ---- helpers ---------------------------------------------------------------

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(n));
}

function formatCountdown(resetsAt: string | null): string | null {
  if (!resetsAt) return null;
  const ms = Date.parse(resetsAt) - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return null;
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor((ms % 60_000) / 1000)}s`;
}

/** Semantic green→amber→red ramp for a usage-limit meter. The Blubber world is
 * green-first, but a limit gauge earns a real warning escalation — color here
 * carries meaning (how close to the cap), not decoration. */
function rampColor(pct: number | null): string {
  if (pct == null) return 'var(--text-secondary)';
  if (pct < 50) return 'var(--core-accent)';
  if (pct < 75) return 'oklch(88% 0.22 118)';
  if (pct < 90) return 'oklch(80% 0.20 75)';
  return 'var(--accent-danger)';
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return reduced;
}

/** Animate a number toward `target` on change (count-up), reduced-motion safe. */
function useCountUp(target: number, ms = 650): number {
  const [display, setDisplay] = useState(target);
  const displayRef = useRef(target);
  const rafRef = useRef<number | null>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (reduced || !Number.isFinite(target)) {
      displayRef.current = target;
      setDisplay(target);
      return;
    }
    const from = displayRef.current;
    if (from === target) return;
    const start = performance.now();
    const step = (t: number) => {
      const p = Math.min((t - start) / ms, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      const val = from + (target - from) * eased;
      displayRef.current = val;
      setDisplay(val);
      if (p < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, ms, reduced]);

  return display;
}

// ---- sub-components ---------------------------------------------------------

function LimitBar({
  label,
  pct,
  sub,
}: {
  label: string;
  pct: number | null;
  sub?: string | null;
}) {
  const animated = useCountUp(pct ?? 0);
  const color = rampColor(pct);
  const width = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  return (
    <div className="lum-bar">
      <div className="lum-bar__head">
        <span className="lum-bar__label">{label}</span>
        <span className="lum-bar__pct" style={{ color }}>
          {pct == null ? '—' : `${Math.round(animated)}%`}
        </span>
      </div>
      <div className="lum-bar__track" role="progressbar" aria-valuenow={pct ?? 0} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="lum-bar__fill" style={{ transform: `scaleX(${width / 100})`, background: color }} />
      </div>
      {sub && <div className="lum-bar__sub">{sub}</div>}
    </div>
  );
}

function Sparkline({ buckets }: { buckets: number[] }) {
  const max = Math.max(1, ...buckets);
  const w = 100;
  const h = 28;
  const n = buckets.length;
  const points = buckets.map((v, i) => {
    const x = n <= 1 ? 0 : (i / (n - 1)) * w;
    const y = h - (v / max) * h;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const linePts = points.join(' ');
  const areaPts = `0,${h} ${linePts} ${w},${h}`;
  return (
    <svg className="lum-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon className="lum-spark__area" points={areaPts} />
      <polyline className="lum-spark__line" points={linePts} />
    </svg>
  );
}

function SplitChip({ label, value }: { label: string; value: number }) {
  return (
    <div className="lum-split">
      <span className="lum-split__label">{label}</span>
      <span className="lum-split__val">{formatCompact(value)}</span>
    </div>
  );
}

// ---- main -------------------------------------------------------------------

export function LiveUsageMeter({
  compact = false,
  showWeekly = false,
  weeklyBarData,
  weeklyBarHighlightIndex,
  weeklyTotal = 0,
  weeklyState,
}: LiveUsageMeterProps) {
  const live = useLiveUsage();

  const [limits, setLimits] = useState<LimitsPayload | null>(null);
  const [windowData, setWindowData] = useState<WindowPayload | null>(null);
  const [topBurner, setTopBurner] = useState<Burner | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');

  // Poll the three real endpoints together every 60s. SSE keeps the burn line
  // live between polls.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      Promise.allSettled([
        fetch('/api/usage-limits').then((r) => (r.ok ? (r.json() as Promise<LimitsPayload>) : Promise.reject())),
        fetch('/api/usage-window').then((r) => (r.ok ? (r.json() as Promise<WindowPayload>) : Promise.reject())),
        fetch('/api/insights').then((r) => (r.ok ? (r.json() as Promise<InsightsPayload>) : Promise.reject())),
      ]).then(([limitsRes, windowRes, insightsRes]) => {
        if (cancelled) return;
        if (limitsRes.status === 'fulfilled') setLimits(limitsRes.value);
        if (windowRes.status === 'fulfilled') setWindowData(windowRes.value);
        if (insightsRes.status === 'fulfilled') setTopBurner(insightsRes.value.burners?.[0] ?? null);
        const anyOk =
          limitsRes.status === 'fulfilled' ||
          windowRes.status === 'fulfilled' ||
          insightsRes.status === 'fulfilled';
        setLoadState(anyOk ? 'ready' : 'error');
      });
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Live tokens/min sparkline: accumulate real SSE token increments into a
  // rolling bucket ring that advances on a fixed tick.
  const bucketsRef = useRef<number[]>(new Array(SPARK_BUCKETS).fill(0));
  const lastTotalRef = useRef<number | null>(null);
  const [, force] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    const t = live.totalToday;
    if (lastTotalRef.current == null) {
      lastTotalRef.current = t;
      return;
    }
    const inc = t - lastTotalRef.current;
    lastTotalRef.current = t;
    if (inc > 0) {
      const b = bucketsRef.current;
      b[b.length - 1] += inc;
      force();
    }
  }, [live.totalToday]);

  useEffect(() => {
    const id = setInterval(() => {
      const b = bucketsRef.current;
      b.push(0);
      b.shift();
      force();
    }, BUCKET_MS);
    return () => clearInterval(id);
  }, []);

  const buckets = bucketsRef.current;
  const windowSum = buckets.reduce((s, v) => s + v, 0);
  const tokensPerMin = Math.round((windowSum / SPARK_WINDOW_SEC) * 60);
  const tpmAnimated = Math.round(useCountUp(tokensPerMin));

  const todaySplit = windowData?.breakdown?.today;
  const totalToday = live.totalToday || windowData?.today || 0;
  const todayAnimated = Math.round(useCountUp(totalToday));

  // Weekly half (opt-in): the in/out/cache split reuses THIS component's own
  // already-fetched /api/usage-window response — no second fetch needed. The
  // bars themselves are the caller's GET /api/weekly data, passed as props.
  const weekBreakdown = windowData?.breakdown?.weekly ?? null;
  const weeklyBars = weeklyBarData ?? [];
  const hasWeeklyUsage = weeklyBars.some((d) => d.value > 0);
  const weeklyCallout = useMemo(
    () => computeWeeklyBarCallout(weeklyBars, weeklyBarHighlightIndex),
    [weeklyBars, weeklyBarHighlightIndex],
  );

  const sessionPct = limits?.session_pct ?? null;
  const weeklyPct = limits?.weekly_pct ?? null;
  const stale = limits?.stale ?? false;
  const countdown = formatCountdown(limits?.session_resets ?? null);

  const dotClass = stale
    ? 'lum-dot lum-dot--sync'
    : live.connected
      ? 'lum-dot lum-dot--live'
      : 'lum-dot';
  const dotLabel = stale ? 'Syncing — showing last known' : live.connected ? 'Live' : 'Idle';

  const showSkeleton = loadState === 'loading' && !limits && !windowData;
  const noLimitsData = sessionPct == null && weeklyPct == null;

  return (
    <div className={`pill-room lum${compact ? ' lum--compact' : ''}`}>
      <div className="pill-room__plate" style={{ backgroundImage: `url('${PLATE_URL}')` }} aria-hidden="true" />
      <div className="pill-room__scrim" aria-hidden="true" />

      <div className="lum__content">
        <div className="lum__head">
          <Activity size={13} aria-hidden="true" />
          <span className="lum__title">Live Usage</span>
          <span className={dotClass} title={dotLabel} aria-label={dotLabel} />
        </div>

        {showSkeleton ? (
          <div className="lum__skeleton" aria-hidden="true">
            <div className="lum-skel lum-skel--bar" />
            <div className="lum-skel lum-skel--bar" />
            <div className="lum-skel lum-skel--wide" />
          </div>
        ) : (
          <div className="lum__body">
            <LimitBar
              label="5H SESSION"
              pct={sessionPct}
              sub={countdown ? `resets in ${countdown}` : stale ? 'last known' : null}
            />
            <LimitBar label="WEEK" pct={weeklyPct} sub={stale ? 'last known' : null} />

            {noLimitsData && (
              <p className="lum__note">Live plan limits need a signed-in Claude session.</p>
            )}

            {!compact && (
              <div className="lum__burn">
                <div className="lum__burn-head">
                  <span className="lum__burn-rate">
                    <span className="lum__burn-num">{formatCompact(tpmAnimated)}</span>
                    <span className="lum__burn-unit">tok/min</span>
                  </span>
                  {windowSum === 0 && <span className="lum__burn-idle">idle</span>}
                </div>
                <Sparkline buckets={buckets} />
              </div>
            )}

            <div className="lum__today">
              <div className="lum__today-total">
                <span className="lum__today-num">{formatCompact(todayAnimated)}</span>
                <span className="lum__today-label">tokens today</span>
              </div>
              {todaySplit && (
                <div className="lum__splits">
                  <SplitChip label="IN" value={todaySplit.tokensIn} />
                  <SplitChip label="OUT" value={todaySplit.tokensOut} />
                  <SplitChip label="CACHE" value={todaySplit.tokensCache} />
                </div>
              )}
            </div>

            {!compact && topBurner && (
              <div className="lum__burner">
                <span className="lum__burner-label">Top burner</span>
                <span className="lum__burner-name">{topBurner.name}</span>
                <span className="lum__burner-pct">{topBurner.sharePct}%</span>
              </div>
            )}

            {showWeekly && (
              <>
                {/* Seam between "right now" (live half above) and "the week"
                    (recap half below) — reads as one continuous pill, not two
                    panels glued together. */}
                <div className="lum-divider">
                  <span className="lum-divider__line" aria-hidden="true" />
                  <span className="lum-divider__label">This Week</span>
                  <span className="lum-divider__line" aria-hidden="true" />
                </div>

                <div className="lum-weekly">
                  {weeklyState === 'loading' && <p className="lum__note">Loading token usage…</p>}
                  {weeklyState === 'error' && <p className="lum__note">Couldn&rsquo;t load token usage.</p>}
                  {weeklyState === 'ready' && !hasWeeklyUsage && (
                    <p className="lum__note">No token usage recorded this week yet.</p>
                  )}
                  {weeklyState === 'ready' && hasWeeklyUsage && (
                    <>
                      <div className="lum-weekly__chart">
                        <BarChart data={weeklyBars} highlightIndex={weeklyBarHighlightIndex} height={WEEKLY_CHART_HEIGHT} />
                        {weeklyCallout && weeklyBarHighlightIndex !== undefined && (
                          <div
                            className="lum-weekly__callout"
                            style={{ left: `${weeklyCallout.leftPct}%`, top: `${weeklyCallout.topPct}%` }}
                          >
                            {formatCompact(weeklyBars[weeklyBarHighlightIndex].value)} tokens
                          </div>
                        )}
                      </div>
                      <p className="lum-weekly__total">
                        <span className="lum-weekly__total-num">{formatCompact(weeklyTotal)}</span> tokens
                        {weekBreakdown && weekBreakdown.totalTokens > 0 && (
                          <span className="lum-weekly__total-split">
                            {' '}
                            · {formatCompact(weekBreakdown.tokensIn)} in / {formatCompact(weekBreakdown.tokensOut)} out /{' '}
                            {formatCompact(weekBreakdown.tokensCache)} cache
                          </span>
                        )}
                      </p>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default LiveUsageMeter;
