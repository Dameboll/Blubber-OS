'use client';

/**
 * PersistentTerminalHost — mounts the real terminal (TerminalScreen → TabBar →
 * TerminalPanes → xterm) ONCE and keeps it alive across nav switches (LANE P,
 * docs/plans/idle-life-and-wiring.md), AND generalizes to an anchor-portal so
 * the SAME live instance can also render inside the Dashboard's "Terminal" tab
 * tile (PILL WORLDS + MINI DASH, Lane 2) — same sessions, same tabs, typing
 * works, zero mirrored/duplicate terminal code.
 *
 * THE BUG THIS ORIGINALLY FIXED: page.tsx used to render the terminal via its
 * per-nav `SCREENS[activeNavId]` swap, so leaving the Terminal screen
 * UNMOUNTED TerminalScreen → TabBar (whose open-tab list is local state) →
 * every TerminalPane. The server PTYs survived (wsClient is a module
 * singleton, the ws stays open), but the CLIENT threw the windows away — you
 * came back to an empty tab strip. Now the terminal lives here instead,
 * mounted inside AppShell's SessionProvider subtree (so useSession keeps
 * working) and shown/hidden with CSS/position rather than mounted/unmounted.
 * page.tsx's SCREENS.terminal is `null` so it is never double-mounted.
 *
 * ANCHOR-PORTAL (Lane 2): this component now wraps `children` (AppShell passes
 * the rest of the app's screen content through it) and exposes
 * `useDashboardTerminalAnchor(active)` — a hook DashboardScreen's "Terminal"
 * tab tile calls with `active = activeTab === 'terminal'`. While active, the
 * hook registers its tile element as the live anchor; this host then measures
 * that element's real viewport rect (ResizeObserver + scroll/resize listeners)
 * and renders the SAME `<TerminalScreen />` instance `position:fixed` directly
 * over it. The full-screen "terminal" NAV position always takes priority over
 * the dashboard anchor (you can't be on both at once, but a stale dashboard
 * anchor registration must never fight the real terminal screen).
 *
 * VISIBILITY, NOT display:none: when neither position is active the host
 * stays in layout and is only made `visibility:hidden` + `pointer-events:none`
 * (see .persistent-terminal-host in AppShell.css). Because the element keeps
 * its real box the whole time, xterm never loses its measured dimensions, so
 * navigating back needs no refit — the one gotcha a display:none toggle would
 * have introduced. (TerminalPane also still refits via its own ResizeObserver
 * as a backstop.)
 *
 * KEEP-ALIVE, LAZY FIRST MOUNT: the host renders nothing until the terminal is
 * opened for the first time (`everActive` — either the full terminal nav or
 * the dashboard's Terminal tab), preserving the original lazy-load of the
 * app's heaviest chunk (xterm + three + PTY wiring) and its "Booting
 * terminal…" placeholder. Once opened it stays mounted for the rest of the
 * app session — you can only lose tabs you already created, and before the
 * first visit there are none. Terminal + all tabs die only on explicit tab
 * close or closing the app, never on nav.
 */

import dynamic from 'next/dynamic';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { NavId } from './AppShell';

// TerminalScreen pulls in xterm.js (a browser-only UMD lib that touches `self`
// at module scope), so it must load client-only — same ssr:false + on-brand
// boot placeholder page.tsx used before this host took ownership of the mount.
const TerminalScreen = dynamic(() => import('./screens/TerminalScreen'), {
  ssr: false,
  loading: () => (
    <div className="screen-boot" aria-busy="true" aria-live="polite">
      <span className="screen-boot__ring" aria-hidden="true" />
      <span className="screen-boot__label">Booting terminal…</span>
    </div>
  ),
});

interface AnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface AnchorContextValue {
  /** Dashboard's Terminal-tab tile calls this with its element while that tab
   * is the active dashboard tab, and with null when it isn't (or unmounts). */
  registerDashboardAnchor: (el: HTMLDivElement | null) => void;
}

const AnchorContext = createContext<AnchorContextValue>({ registerDashboardAnchor: () => {} });

/** Hook for DashboardScreen's Terminal-tab tile: returns a ref to attach to
 * the tile container div. While `active` is true, the host portals the live
 * terminal (position:fixed) over that tile's measured viewport rect instead
 * of its default full-screen "terminal" nav position. Registration clears
 * automatically when `active` goes false or the tile unmounts. */
export function useDashboardTerminalAnchor(active: boolean) {
  const { registerDashboardAnchor } = useContext(AnchorContext);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!active) {
      registerDashboardAnchor(null);
      return;
    }
    registerDashboardAnchor(ref.current);
    return () => registerDashboardAnchor(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref.current intentionally read once per active toggle, not tracked as a dep
  }, [active, registerDashboardAnchor]);

  return ref;
}

export interface PersistentTerminalHostProps {
  /** The app's active screen. The host is full-screen visible only when this is 'terminal'. */
  activeNavId: NavId;
  /** The rest of the app's screen content — rendered as a sibling so a
   * dashboard-registered anchor (a descendant of `children`) can reach this
   * host's context. */
  children?: ReactNode;
}

export default function PersistentTerminalHost({ activeNavId, children }: PersistentTerminalHostProps) {
  const isTerminalNav = activeNavId === 'terminal';

  const [dashAnchorEl, setDashAnchorEl] = useState<HTMLDivElement | null>(null);
  const [dashRect, setDashRect] = useState<AnchorRect | null>(null);

  // Lazily mount on first visit to EITHER the full terminal nav or the
  // dashboard's Terminal tab, then keep mounted forever (see header).
  const [everActive, setEverActive] = useState(isTerminalNav);
  useEffect(() => {
    if (isTerminalNav) setEverActive(true);
  }, [isTerminalNav]);
  useEffect(() => {
    if (dashAnchorEl) setEverActive(true);
  }, [dashAnchorEl]);

  const registerDashboardAnchor = useCallback((el: HTMLDivElement | null) => {
    setDashAnchorEl(el);
  }, []);

  // Measure + track the dashboard anchor's real viewport rect while it's
  // registered. Fixed positioning is always relative to the viewport (no
  // transformed ancestor sits between .dame-shell__content and <body> — see
  // AppShell.css), so raw getBoundingClientRect() coordinates apply directly.
  useEffect(() => {
    if (!dashAnchorEl) {
      setDashRect(null);
      return;
    }
    const measure = () => {
      const r = dashAnchorEl.getBoundingClientRect();
      setDashRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(dashAnchorEl);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [dashAnchorEl]);

  // The full terminal nav always wins over a (possibly stale) dashboard
  // anchor registration — the two are mutually exclusive screens anyway, but
  // this keeps the priority explicit and honest.
  const showOnDashboard = !isTerminalNav && dashAnchorEl !== null && dashRect !== null;
  const visible = isTerminalNav || showOnDashboard;

  const hostStyle: CSSProperties | undefined =
    showOnDashboard && dashRect
      ? {
          position: 'fixed',
          top: dashRect.top,
          left: dashRect.left,
          width: dashRect.width,
          height: dashRect.height,
          zIndex: 5,
        }
      : undefined;

  const classes = [
    'persistent-terminal-host',
    visible ? '' : 'persistent-terminal-host--hidden',
    showOnDashboard ? 'persistent-terminal-host--anchored' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <AnchorContext.Provider value={{ registerDashboardAnchor }}>
      {everActive && (
        <div className={classes} style={hostStyle} aria-hidden={!visible}>
          <TerminalScreen compact={showOnDashboard} />
        </div>
      )}
      {children}
    </AnchorContext.Provider>
  );
}
