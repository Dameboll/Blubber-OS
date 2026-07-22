'use client';

/**
 * page.tsx — top-level page assembly.
 *
 * INTEGRATION PASS: every nav id in AppShell's `SCREENS` map now renders its
 * real screen component from src/components/screens/*Screen.tsx instead of
 * the old placeholder. Dashboard assembles the previously-unplugged
 * command-deck pieces (Core3D, MiniFlubberField, MusicPlayer, LiveBar,
 * WeeklyRecap) itself — see DashboardScreen.tsx's header for exactly how.
 * TabBar stays scoped entirely inside TerminalScreen (see that file's own
 * header comment) — it is never mounted here.
 *
 * TERMINAL IS PERSISTENT (LANE P): the terminal is NOT swapped in/out per nav
 * from the SCREENS map below — that used to unmount TabBar + every xterm pane
 * on leaving the Terminal screen, wiping the open-tab list. It's now mounted
 * once inside AppShell (see PersistentTerminalHost.tsx) and shown/hidden with
 * CSS, so its PTYs and tabs survive nav switches. SCREENS.terminal is therefore
 * `null` here — the host owns that mount, and this avoids double-mounting it.
 *
 * BackgroundField was removed (LANE 7 perf pass). The "living green" it used to
 * provide is now split between a breathing radial wash (CSS-only, globals.css)
 * and AmbientGlow — one cheap fixed 2D-canvas mote layer that reacts to real
 * token burn (no new WebGL context; the flubber3d host owns the only GL
 * context). Per-panel floating slime bubbles stay (CSS-based).
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import AppShell, { type NavId } from '../components/AppShell';
import AmbientGlow from '../components/AmbientGlow';
import IntroCinematic from '../components/IntroCinematic';
import { consumeTourPending, TOUR_EVENT } from '../lib/tour';
import { consumeSoulPending, SOUL_EVENT } from '../lib/soul';
import { FlubberBrainProvider } from '../components/FlubberBrainProvider';
// Dashboard is the always-first screen, so it stays a static import — it must
// be in the initial chunk for the fastest possible first paint.
import DashboardScreen from '../components/screens/DashboardScreen';
import './page.css';

// The other 8 screens each mount only when their nav item is selected, and
// exactly one screen is ever mounted at a time. Statically importing them all
// pulled every screen's code (charts, xterm-adjacent bits, the whole music
// library, settings, etc.) into the initial page chunk, parsed on every boot
// regardless of which screen shows first. next/dynamic splits each into its
// own chunk that loads on first visit — from local disk in the packaged app,
// so the load is instant with no visible penalty. Same ssr:false + on-brand
// boot placeholder the app already uses for TerminalScreen
// (PersistentTerminalHost.tsx). Placeholder styles live in page.css (.screen-boot).
const screenLoader = (label: string) =>
  function ScreenBoot() {
    return (
      <div className="screen-boot" aria-busy="true" aria-live="polite">
        <span className="screen-boot__ring" aria-hidden="true" />
        <span className="screen-boot__label">{label}</span>
      </div>
    );
  };

const AgentsScreen = dynamic(() => import('../components/screens/AgentsScreen'), {
  ssr: false,
  loading: screenLoader('Loading agents…'),
});
const ProjectsScreen = dynamic(() => import('../components/screens/ProjectsScreen'), {
  ssr: false,
  loading: screenLoader('Loading projects…'),
});
const MemoryScreen = dynamic(() => import('../components/screens/MemoryScreen'), {
  ssr: false,
  loading: screenLoader('Loading memory…'),
});
const AnalyticsScreen = dynamic(() => import('../components/screens/AnalyticsScreen'), {
  ssr: false,
  loading: screenLoader('Loading analytics…'),
});
const MusicPlayerScreen = dynamic(() => import('../components/screens/MusicPlayerScreen'), {
  ssr: false,
  loading: screenLoader('Loading music…'),
});
const VirtualPetScreen = dynamic(() => import('../components/screens/VirtualPetScreen'), {
  ssr: false,
  loading: screenLoader('Loading pet…'),
});
const AcademyScreen = dynamic(() => import('../components/screens/AcademyScreen'), {
  ssr: false,
  loading: screenLoader('Loading academy…'),
});
const SettingsScreen = dynamic(() => import('../components/screens/SettingsScreen'), {
  ssr: false,
  loading: screenLoader('Loading settings…'),
});

// First-run / kit-gated overlays: none render on a normal boot (onboarding is
// first-machine-only; tour + interview are kit-gated), so they don't belong in
// the initial chunk either. IntroCinematic stays static — it paints on every
// single launch.
const OnboardingOverlay = dynamic(() => import('../components/onboarding/OnboardingOverlay'), {
  ssr: false,
});
const DashboardTour = dynamic(() => import('../components/tour/DashboardTour'), { ssr: false });
const SoulInterview = dynamic(() => import('../components/soul/SoulInterview'), { ssr: false });

// BackgroundField removed (LANE 7: fullscreen shader + 14k particles = main lag source).
// Static CSS gradient replaces it in globals.css; per-panel slime bubbles preserved.

export default function Home() {
  const [activeNavId, setActiveNavId] = useState<NavId>('dashboard');

  // First-run gate (Lane B1). `null` = still checking (render nothing under
  // the intro cinematic rather than flashing the real app or the overlay
  // before we actually know); `false` = show OnboardingOverlay in place of
  // the app; `true` = render the app normally. Fails open (treats as seen)
  // on a fetch error so a broken check can never trap a user behind a
  // permanently blank screen.
  const [onboardingSeen, setOnboardingSeen] = useState<boolean | null>(null);

  // Starter-Kit dashboard walkthrough (see src/lib/tour.ts). Launches either
  // from a pending flag set during onboarding (kit was detected + user opted
  // in) or from a live 'blubber:start-tour' event (kit injected from Settings
  // this session). Only ever fires when the kit is present — the request side
  // is gated on kit detection, never the free build.
  const [showTour, setShowTour] = useState(false);

  // Soul Interview (Lane 3, see src/lib/soul.ts's header for the three launch
  // paths). Same pending-flag + live-event shape as the tour above, same gate
  // (only ever requested from Starter-Kit-only code paths — the free build
  // never calls requestSoulInterview()).
  const [showSoul, setShowSoul] = useState(false);

  useEffect(() => {
    if (onboardingSeen !== true) return;
    if (consumeTourPending()) setShowTour(true);
    const onTour = () => setShowTour(true);
    window.addEventListener(TOUR_EVENT, onTour);
    return () => window.removeEventListener(TOUR_EVENT, onTour);
  }, [onboardingSeen]);

  useEffect(() => {
    if (onboardingSeen !== true) return;
    if (consumeSoulPending()) setShowSoul(true);
    const onSoul = () => setShowSoul(true);
    window.addEventListener(SOUL_EVENT, onSoul);
    return () => window.removeEventListener(SOUL_EVENT, onSoul);
  }, [onboardingSeen]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/onboarding')
      .then((res) => res.json() as Promise<{ seen: boolean }>)
      .then((data) => {
        if (!cancelled) setOnboardingSeen(Boolean(data?.seen));
      })
      .catch(() => {
        if (!cancelled) setOnboardingSeen(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // One real screen component per nav id -- see file header. Kept as one
  // map so AppShell's own SCREENS[activeNavId] lookup stays a single line.
  const SCREENS = useMemo<Record<NavId, ReactNode>>(
    () => ({
      dashboard: <DashboardScreen />,
      // null on purpose — the terminal is mounted persistently in AppShell
      // (PersistentTerminalHost), never swapped in/out here. See file header.
      terminal: null,
      agents: <AgentsScreen />,
      projects: <ProjectsScreen />,
      memory: <MemoryScreen />,
      analytics: <AnalyticsScreen />,
      music: <MusicPlayerScreen />,
      pet: <VirtualPetScreen />,
      academy: <AcademyScreen />,
      settings: <SettingsScreen />,
    }),
    [],
  );

  let content: ReactNode = null;
  if (onboardingSeen === false) {
    // First run on this machine — the overlay replaces the app entirely
    // until it marks itself seen (server-side) and calls onComplete.
    content = <OnboardingOverlay onComplete={() => setOnboardingSeen(true)} />;
  } else if (onboardingSeen === true) {
    content = (
      <>
        {/* Living-green ambient layer: fixed 2D canvas at z-index:-1, painted
            behind the transparent app-shell. Decorative + pointer-events:none;
            self-manages its rAF loop (paused when hidden/off-screen) and renders
            nothing under prefers-reduced-motion. */}
        <AmbientGlow />
        {/* One brain wraps the whole app so terminal/music/nav/pet events reach
            every mood-synced Blubber, cross-screen. (The old click-drag roaming
            pet was removed — the main Blubber is the star, living in each
            screen's hero, not a draggable overlay.) */}
        <FlubberBrainProvider activeNavId={activeNavId}>
          <AppShell activeNavId={activeNavId} onNavChange={setActiveNavId}>
            {SCREENS[activeNavId]}
          </AppShell>
        </FlubberBrainProvider>
        {showTour && (
          <DashboardTour onNavChange={setActiveNavId} onClose={() => setShowTour(false)} />
        )}
        {showSoul && <SoulInterview onClose={() => setShowSoul(false)} />}
      </>
    );
  }
  // onboardingSeen === null: content stays null while the check is in flight —
  // IntroCinematic below still mounts/paints over it as normal.

  // IntroCinematic wraps everything: it renders `content` immediately underneath
  // (even while `content` is null / mid-onboarding-check) and only paints its
  // one-time full-viewport cinematic overlay on top when the intro hasn't
  // played yet on this machine — see that component's own header for the
  // exact sequencing. Net order for a brand-new machine: intro cinematic
  // plays first (on top), then once it clears, OnboardingOverlay takes over
  // underneath if onboarding hasn't been seen either.
  return <IntroCinematic>{content}</IntroCinematic>;
}
