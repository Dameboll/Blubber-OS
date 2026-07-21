'use client';

/**
 * MiniAnalytics — Dashboard "Analytics" tab (PILL WORLDS + MINI DASH, Lane 2).
 *
 * Item 4 rebuild: this is now a true MINI of the real Analytics screen, not a
 * stretched SVG chart. The old version fed a 240×58 <BarChart> with
 * preserveAspectRatio="none" across a ~700px tile, which warped the bars and
 * smeared the 7px labels. This mirrors AnalyticsScreen's hero row instead —
 * CSS-flex daily-token bars (like .analytics-daily), a live-pulse readout (like
 * .analytics-pulse: tokens today · runs · streak), and one top-burner row (like
 * .analytics-agents__row). Same /api/insights payload it already loaded — no
 * new endpoint, no fabricated numbers, honest empty state.
 */

import { useEffect, useState } from 'react';
import { Activity, BarChart3, CalendarDays, Flame, Zap } from 'lucide-react';
import { humanizeSlug } from '../../lib/humanize';
import './MiniAnalytics.css';

interface DailyPoint {
  date: string;
  tokens: number;
  runs: number;
}

interface Burner {
  name: string;
  category: 'skill' | 'agent';
  tokens: number;
  runs: number;
  sharePct: number;
}

interface InsightsPayload {
  sinceBaseline: { totalTokens: number; totalRuns: number; days: number };
  burners: Burner[];
  daily: DailyPoint[];
}

type LoadState = 'loading' | 'ready' | 'error';

const RECENT_DAYS = 10;
const MAX_BURNERS = 3;

function weekdayLabel(dateStr: string): string {
  const parsed = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return dateStr.slice(5);
  return parsed.toLocaleDateString('en-US', { weekday: 'short' }).charAt(0);
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(n));
}

export default function MiniAnalytics() {
  const [data, setData] = useState<InsightsPayload | null>(null);
  const [state, setState] = useState<LoadState>('loading');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/insights')
      .then((res) => {
        if (!res.ok) throw new Error(`insights fetch failed: ${res.status}`);
        return res.json() as Promise<InsightsPayload>;
      })
      .then((json) => {
        if (cancelled) return;
        setData(json);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const allDaily = data?.daily ?? [];
  const daily = allDaily.slice(-RECENT_DAYS);
  const dailyMax = Math.max(...daily.map((d) => d.tokens), 1);
  const burners = (data?.burners ?? []).slice(0, MAX_BURNERS);
  const hasUsage = (data?.sinceBaseline.totalRuns ?? 0) > 0;

  // Live pulse — from the real ASC daily series (today = last entry).
  const todayEntry = allDaily.length > 0 ? allDaily[allDaily.length - 1] : null;
  const todayTokens = todayEntry?.tokens ?? 0;
  const todayRuns = todayEntry?.runs ?? 0;
  let streak = 0;
  for (let i = allDaily.length - 1; i >= 0; i--) {
    if (allDaily[i].tokens > 0) streak++;
    else break;
  }

  return (
    <div className="pill-room mini-analytics">
      {/* Lane 1's shared pill-room recipe (src/styles/pill-room.css) —
          telemetry.webp is the analytics-panel plate. */}
      <div className="pill-room__plate" style={{ backgroundImage: "url('/bg/telemetry.webp')" }} aria-hidden="true" />
      <div className="pill-room__scrim" aria-hidden="true" />
      <div className="mini-analytics__content">
        <div className="mini-analytics__head">
          <BarChart3 size={13} aria-hidden="true" />
          <span>Analytics</span>
          {data && (
            <span className="mini-analytics__total">{formatCompact(data.sinceBaseline.totalTokens)} tokens</span>
          )}
        </div>

        <div className="mini-analytics__body">
          {state === 'loading' && <p className="mini-analytics__empty">Loading…</p>}
          {state === 'error' && <p className="mini-analytics__empty">Couldn&rsquo;t load analytics.</p>}
          {state === 'ready' && !hasUsage && <p className="mini-analytics__empty">No usage recorded yet.</p>}

          {state === 'ready' && hasUsage && (
            <div className="mini-analytics__grid">
              {/* PULSE — tokens today + runs + streak (mirror .analytics-pulse). */}
              <div className="mini-analytics__pulse">
                <span className="mini-analytics__pulse-value">{formatCompact(todayTokens)}</span>
                <span className="mini-analytics__pulse-label">
                  <Zap size={10} aria-hidden="true" /> tokens today
                </span>
                <div className="mini-analytics__pulse-row">
                  <span title="runs today">
                    <Activity size={10} aria-hidden="true" /> {todayRuns}
                  </span>
                  <span title="day streak">
                    <CalendarDays size={10} aria-hidden="true" /> {streak}d
                  </span>
                </div>
              </div>

              {/* DAILY BARS — CSS flex, no stretched SVG (mirror .analytics-daily). */}
              <div className="mini-analytics__daily" role="img" aria-label="Daily token usage">
                {daily.map((d) => {
                  const pct = Math.max(4, (d.tokens / dailyMax) * 100);
                  return (
                    <div
                      key={d.date}
                      className="mini-analytics__daily-col"
                      title={`${d.date}: ${d.tokens.toLocaleString()} tokens · ${d.runs} runs`}
                    >
                      <span className="mini-analytics__daily-bar" style={{ height: `${pct}%` }} />
                      <span className="mini-analytics__daily-label">{weekdayLabel(d.date)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TOP BURNERS — one row each (mirror .analytics-agents__row). */}
          {state === 'ready' && hasUsage && burners.length > 0 && (
            <ul className="mini-analytics__burners">
              {burners.map((b) => (
                <li key={`${b.category}-${b.name}`}>
                  <Flame size={10} aria-hidden="true" className="mini-analytics__burner-icon" />
                  <span className="mini-analytics__burner-name">{humanizeSlug(b.name)}</span>
                  <span className="mini-analytics__burner-bar" aria-hidden="true">
                    <span className="mini-analytics__burner-fill" style={{ width: `${b.sharePct}%` }} />
                  </span>
                  <span className="mini-analytics__burner-pct">{b.sharePct}%</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
