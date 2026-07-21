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

import { useMemo, useState, type ReactNode } from 'react';
import AppShell, { type NavId } from '../components/AppShell';
import AmbientGlow from '../components/AmbientGlow';
import { FlubberBrainProvider } from '../components/FlubberBrainProvider';
import DashboardScreen from '../components/screens/DashboardScreen';
import AgentsScreen from '../components/screens/AgentsScreen';
import ProjectsScreen from '../components/screens/ProjectsScreen';
import MemoryScreen from '../components/screens/MemoryScreen';
import AnalyticsScreen from '../components/screens/AnalyticsScreen';
import MusicPlayerScreen from '../components/screens/MusicPlayerScreen';
import VirtualPetScreen from '../components/screens/VirtualPetScreen';
import SettingsScreen from '../components/screens/SettingsScreen';
import './page.css';

// BackgroundField removed (LANE 7: fullscreen shader + 14k particles = main lag source).
// Static CSS gradient replaces it in globals.css; per-panel slime bubbles preserved.

export default function Home() {
  const [activeNavId, setActiveNavId] = useState<NavId>('dashboard');

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
      settings: <SettingsScreen />,
    }),
    [],
  );

  return (
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
    </>
  );
}
