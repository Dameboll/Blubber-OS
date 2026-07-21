'use client';

import { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import './WeeklyRecap.css';

if (typeof window !== 'undefined') {
  gsap.registerPlugin(ScrollTrigger);
}

interface DailyPoint {
  date: string;
  totalTokens: number;
}

interface NamedCount {
  name: string;
  count: number;
}

interface WeeklyData {
  dailyTrend: DailyPoint[];
  topAgents: NamedCount[];
  topSkills: NamedCount[];
  totals?: {
    totalTokens: number;
    totalInvocations: number;
  };
}

type FetchState = 'loading' | 'error' | 'ready';

function sumTokens(points: DailyPoint[] = []): number {
  return points.reduce((acc, p) => acc + (p.totalTokens || 0), 0);
}

function sumInvocations(data: WeeklyData): number {
  const agents = (data.topAgents ?? []).reduce((acc, a) => acc + (a.count || 0), 0);
  const skills = (data.topSkills ?? []).reduce((acc, s) => acc + (s.count || 0), 0);
  return agents + skills;
}

function buildTrendPath(points: DailyPoint[], width: number, height: number, padding = 10) {
  if (points.length === 0) {
    return { linePath: '', areaPath: '', coords: [] as { x: number; y: number }[] };
  }
  const max = Math.max(...points.map((p) => p.totalTokens), 1);
  const usableW = width - padding * 2;
  const usableH = height - padding * 2;
  const step = points.length > 1 ? usableW / (points.length - 1) : 0;

  const coords = points.map((p, i) => {
    const x = padding + step * i;
    const ratio = p.totalTokens / max;
    const y = padding + usableH - ratio * usableH;
    return { x, y };
  });

  const linePath = coords
    .map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(2)} ${c.y.toFixed(2)}`)
    .join(' ');

  const last = coords[coords.length - 1];
  const first = coords[0];
  const floorY = height - padding;
  const areaPath = `${linePath} L ${last.x.toFixed(2)} ${floorY} L ${first.x.toFixed(2)} ${floorY} Z`;

  return { linePath, areaPath, coords };
}

function TrendChart({ points }: { points: DailyPoint[] }) {
  const width = 600;
  const height = 180;
  const { linePath, areaPath, coords } = buildTrendPath(points, width, height);
  const max = Math.max(...points.map((p) => p.totalTokens), 1);

  return (
    <svg
      className="trend-chart"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Daily token usage trend for the last 7 days"
    >
      <defs>
        <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--core-accent-bright)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--core-accent-bright)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {areaPath && <path className="trend-chart__area" d={areaPath} fill="url(#trendFill)" stroke="none" />}
      {linePath && (
        <path
          className="trend-chart__line"
          d={linePath}
          fill="none"
          stroke="var(--core-accent-bright)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      {coords.map((c, i) => (
        <circle
          key={i}
          className="trend-chart__dot"
          cx={c.x}
          cy={c.y}
          r="3.5"
          fill="var(--core-accent-bright)"
          style={{ ['--dot-delay' as string]: `${1 + i * 0.12}s` }}
        >
          <title>{points[i]?.totalTokens.toLocaleString()} tokens</title>
        </circle>
      ))}
      <text x="4" y={height - 4} className="trend-chart__label">
        {points[0]?.date}
      </text>
      <text x={width - 4} y={height - 4} textAnchor="end" className="trend-chart__label">
        {points[points.length - 1]?.date}
      </text>
      {/* Peak label sits on a solid plate behind it rather than bare over the
          plot area -- a fixed top-left position otherwise collides with
          whichever data dot happens to land near the top-left corner (e.g.
          when day 1 is also the week's peak). The plate keeps it legible
          regardless of where the line/dots fall underneath. */}
      <g className="trend-chart__peak">
        <rect x="0" y="2" width="132" height="16" rx="3" className="trend-chart__peak-bg" />
        <text x="6" y="14" className="trend-chart__label">
          {max.toLocaleString()} tok peak
        </text>
      </g>
    </svg>
  );
}

export default function WeeklyRecap() {
  const [data, setData] = useState<WeeklyData | null>(null);
  const [state, setState] = useState<FetchState>('loading');

  const sectionRef = useRef<HTMLElement>(null);
  const numberRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const listItemRefs = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/weekly')
      .then((res) => {
        if (!res.ok) throw new Error(`weekly fetch failed: ${res.status}`);
        return res.json();
      })
      .then((json: WeeklyData) => {
        if (cancelled) return;
        setData(json);
        setState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setState('error');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const hasTrend = Boolean(data?.dailyTrend?.length);
  const hasAgents = Boolean(data?.topAgents?.length);
  const hasSkills = Boolean(data?.topSkills?.length);
  const isEmpty = state === 'ready' && !hasTrend && !hasAgents && !hasSkills;

  useEffect(() => {
    if (state !== 'ready' || isEmpty || !data) return;

    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const ctx = gsap.context(() => {
      const numberEls = numberRefs.current.filter((el): el is HTMLSpanElement => Boolean(el));
      const listEls = listItemRefs.current.filter((el): el is HTMLLIElement => Boolean(el));

      if (reduceMotion) {
        numberEls.forEach((el) => {
          const target = Number(el.dataset.value || 0);
          el.textContent = Math.round(target).toLocaleString();
        });
        gsap.set(listEls, { opacity: 1, y: 0 });
        return;
      }

      // Start numbers at 0 until the reveal fires
      numberEls.forEach((el) => {
        el.textContent = '0';
      });
      gsap.set(listEls, { opacity: 0, y: 16 });

      ScrollTrigger.create({
        trigger: sectionRef.current,
        start: 'top 75%',
        once: true,
        onEnter: () => {
          numberEls.forEach((el) => {
            const target = Number(el.dataset.value || 0);
            const counter = { val: 0 };
            gsap.to(counter, {
              val: target,
              duration: 1.2,
              ease: 'power2.out',
              onUpdate: () => {
                el.textContent = Math.round(counter.val).toLocaleString();
              },
            });
          });

          gsap.to(listEls, {
            opacity: 1,
            y: 0,
            duration: 0.5,
            stagger: 0.08,
            ease: 'power2.out',
          });
        },
      });
    }, sectionRef);

    return () => ctx.revert();
  }, [state, isEmpty, data]);

  return (
    <section ref={sectionRef} className="weekly-recap" aria-labelledby="weekly-recap-heading">
      <div className="weekly-recap__header">
        <h2 id="weekly-recap-heading">This Week</h2>
        <p className="weekly-recap__sub">Token burn, top agents, top skills — last 7 days</p>
      </div>

      {state === 'loading' && (
        <div className="weekly-recap__skeleton" aria-busy="true" aria-label="Loading weekly recap">
          <div className="skeleton-block skeleton-block--chart" />
          <div className="skeleton-block skeleton-block--list" />
          <div className="skeleton-block skeleton-block--list" />
        </div>
      )}

      {state === 'error' && (
        <div className="weekly-recap__empty">
          <p>Couldn&apos;t load weekly data.</p>
          <span className="weekly-recap__hint">
            Check that the server and log indexer are running.
          </span>
        </div>
      )}

      {isEmpty && (
        <div className="weekly-recap__empty">
          <p>No usage yet this week.</p>
          <span className="weekly-recap__hint">
            Run a session and this fills in automatically.
          </span>
        </div>
      )}

      {state === 'ready' && !isEmpty && data && (
        <div className="weekly-recap__grid">
          <div className="weekly-recap__stats">
            <div className="stat">
              <span
                ref={(el) => {
                  numberRefs.current[0] = el;
                }}
                className="stat__value"
                data-value={data.totals?.totalTokens ?? sumTokens(data.dailyTrend)}
              >
                0
              </span>
              <span className="stat__label">Tokens this week</span>
            </div>
            <div className="stat">
              <span
                ref={(el) => {
                  numberRefs.current[1] = el;
                }}
                className="stat__value"
                data-value={data.totals?.totalInvocations ?? sumInvocations(data)}
              >
                0
              </span>
              <span className="stat__label">Skill / agent runs</span>
            </div>
          </div>

          {hasTrend && (
            <div className="weekly-recap__chart">
              <TrendChart points={data.dailyTrend} />
            </div>
          )}

          {(hasAgents || hasSkills) && (
            <div className="weekly-recap__lists">
              {hasAgents && (
                <div className="rank-list">
                  <h3>Top Agents</h3>
                  <ol>
                    {data.topAgents.slice(0, 5).map((a, i) => (
                      <li
                        key={a.name}
                        ref={(el) => {
                          listItemRefs.current[i] = el;
                        }}
                      >
                        <span className="rank-list__name">{a.name}</span>
                        <span className="rank-list__count">{a.count.toLocaleString()}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {hasSkills && (
                <div className="rank-list">
                  <h3>Top Skills</h3>
                  <ol>
                    {data.topSkills.slice(0, 5).map((s, i) => (
                      <li
                        key={s.name}
                        ref={(el) => {
                          listItemRefs.current[5 + i] = el;
                        }}
                      >
                        <span className="rank-list__name">{s.name}</span>
                        <span className="rank-list__count">{s.count.toLocaleString()}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
