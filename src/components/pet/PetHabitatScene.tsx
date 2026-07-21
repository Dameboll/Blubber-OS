'use client';

/**
 * PetHabitatScene — the living room the Virtual Blubber lives in. It is the
 * green pixel-tube interior: a photographic backdrop, a real-time day/night
 * ambient wash, drifting bubbles, a pointer-parallaxed set of depth layers, a
 * clickable goo vat prop, and the live 3D hero Blubber rendered through the
 * shared FlubberHost.
 *
 * The scene is reused in two frames: the Care tab wraps it inside the CRT-TV
 * bezel ('crt'); the Habitat tab shows it larger and standalone ('room').
 *
 * FREE-ROAM (LANE E): with `freeRoam`, the hero is a real toy — grab it, drag it
 * anywhere in the tube, and fling it. usePetToss runs the throw physics (gravity,
 * wall bounce, squash on impact, indignant face, ease-home). A quick press that
 * never moves is still a pet (onPetStart). Without `freeRoam` the hero stays
 * centred and press-drag = petting, exactly as before.
 *
 * PLAY (LANE 3): `wrestlers` (2–4) pops that many INTERACTIVE mini Flubbers in
 * beside the hero (usePetPlaymates): each mini roams the tube, is grab/drag/poke
 * -able like the hero, and the hero immediately chases + bumps them (a two-way
 * tussle). They wander off the edge and fade once their lifetime is up.
 *
 * Interaction is bounded and delegated up so VirtualPetScreen stays the single
 * owner of pet state and payoffs:
 *   - pointer move over the tube parallaxes the depth layers (--px/--py vars)
 *   - press-drag/toss over the model (onPetStart / onPetMove / onTossGrab / onTossLand)
 *   - clicking the vat pokes it (onPokeVat)
 *
 * prefers-reduced-motion: parallax + throw flight are disabled (drag still
 * works, release snaps home); the ambient tint and honest interactions remain.
 */

import {
  forwardRef,
  useCallback,
  useRef,
  type CSSProperties,
  type MouseEvent,
  type MutableRefObject,
  type PointerEvent,
  type RefObject,
} from 'react';
import Flubber3D from '../Flubber3D';
import type { FlubberSlotHandle } from '../../lib/flubber3d/host';
import { usePetToss } from './usePetToss';
import { usePetPlaymates } from './usePetPlaymates';
import './PetHabitatScene.css';

export interface PetHabitatSceneProps {
  /** Expression the hero plays (brain-driven). */
  expression: string;
  /** Increment to fire a one-shot squash pulse on the hero. */
  pulseKey: number;
  /** Hero render size in px (square). */
  heroSize: number;
  reduceMotion: boolean;
  /** 0..1 day/night factor — 1 = brightest midday, 0 = deep night. */
  ambient: number;
  /** 'crt' (Care tab, inside the TV bezel) or 'room' (Habitat tab, standalone). */
  variant?: 'crt' | 'room';
  /** Attached to the character wrapper so the parent can aim the feed pellet. */
  characterRef?: RefObject<HTMLDivElement>;
  /** Enable grab / drag / throw physics on the hero (Care tab free-roam). */
  freeRoam?: boolean;
  /** Number of wrestling play-minis to show beside the hero (0 = none). */
  wrestlers?: number;
  /** Bump to restart the wrestling minis' entry on a fresh Play. */
  wrestlersKey?: number;
  /** Receives the hero's live slot handle (null on unmount). */
  onSlotReady?: (handle: FlubberSlotHandle | null) => void;
  onPokeVat?: (clientX: number, clientY: number) => void;
  onPetStart?: (clientX: number, clientY: number) => void;
  onPetMove?: (clientX: number, clientY: number) => void;
  /** Fired when a real drag/throw of the hero begins (surprised face). */
  onTossGrab?: () => void;
  /** Fired on a throw impact / landing (indignant face). */
  onTossLand?: () => void;
  /** Fired (parent-throttled) when the hero and a playmate mess around — hero
   *  bumps a mini, or a mini is poked. Lets the parent flash a playful mood. */
  onHeroPlay?: () => void;
}

const PetHabitatScene = forwardRef<HTMLDivElement, PetHabitatSceneProps>(function PetHabitatScene(
  props,
  forwardedRef,
) {
  const {
    expression,
    pulseKey,
    heroSize,
    reduceMotion,
    ambient,
    variant = 'crt',
    characterRef,
    freeRoam = false,
    wrestlers = 0,
    wrestlersKey,
    onSlotReady,
    onPokeVat,
    onPetStart,
    onPetMove,
    onTossGrab,
    onTossLand,
    onHeroPlay,
  } = props;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const localCharRef = useRef<HTMLDivElement | null>(null);
  const pressingRef = useRef(false);
  const heroPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const wrestlerCountRef = useRef(0);
  wrestlerCountRef.current = wrestlers;

  const reportHeroPos = useCallback((x: number, y: number) => {
    heroPosRef.current.x = x;
    heroPosRef.current.y = y;
  }, []);

  const playmateSize = Math.max(64, Math.round(heroSize * 0.34));

  // Rest anchor: the backdrop photo's cushioned pedestal sits below the
  // tube's geometric centre, so the hero's home/wander/tap-reset position is
  // biased down by this fraction of the field height (see usePetToss's
  // groundBiasFrac) — tuned against the real pet.webp crop so the hero's feet
  // read as planted on the pedestal instead of floating mid-tube.
  const GROUND_BIAS_FRAC = 0.04;

  const playmates = usePetPlaymates({
    fieldRef: rootRef,
    heroPosRef,
    enabled: freeRoam,
    reduceMotion,
    spawnKey: wrestlersKey ?? 0,
    countRef: wrestlerCountRef,
    bodySize: playmateSize,
    onPoke: onHeroPlay,
    onHeroBump: onHeroPlay,
  });

  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      rootRef.current = el;
      if (typeof forwardedRef === 'function') forwardedRef(el);
      else if (forwardedRef) (forwardedRef as MutableRefObject<HTMLDivElement | null>).current = el;
    },
    [forwardedRef],
  );

  const setCharRef = useCallback(
    (el: HTMLDivElement | null) => {
      localCharRef.current = el;
      if (characterRef) (characterRef as MutableRefObject<HTMLDivElement | null>).current = el;
    },
    [characterRef],
  );

  const onTap = useCallback(() => {
    const el = localCharRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    onPetStart?.(r.left + r.width / 2, r.top + r.height / 2);
  }, [onPetStart]);

  const toss = usePetToss({
    fieldRef: rootRef,
    charRef: localCharRef,
    enabled: freeRoam,
    reduceMotion,
    groundBiasFrac: GROUND_BIAS_FRAC,
    onGrab: onTossGrab,
    onLand: onTossLand,
    onTap,
    reportPos: reportHeroPos,
    getChaseTarget: playmates.getChaseTarget,
    onBump: onHeroPlay,
  });

  const handlePointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const el = rootRef.current;
      if (el && !reduceMotion && !freeRoam) {
        const r = el.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        el.style.setProperty('--px', px.toFixed(3));
        el.style.setProperty('--py', py.toFixed(3));
      }
      if (pressingRef.current) onPetMove?.(e.clientX, e.clientY);
    },
    [reduceMotion, freeRoam, onPetMove],
  );

  const resetParallax = useCallback(() => {
    pressingRef.current = false;
    const el = rootRef.current;
    if (el) {
      el.style.setProperty('--px', '0');
      el.style.setProperty('--py', '0');
    }
  }, []);

  const handleCharPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (freeRoam) {
        toss.onPointerDown(e);
        return;
      }
      pressingRef.current = true;
      onPetStart?.(e.clientX, e.clientY);
    },
    [freeRoam, toss, onPetStart],
  );

  const stopPressing = useCallback(() => {
    pressingRef.current = false;
  }, []);

  const handleVat = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      onPokeVat?.(r.left + r.width / 2, r.top + r.height / 2);
    },
    [onPokeVat],
  );

  return (
    <div
      ref={setRoot}
      className={`pet-hab pet-hab--${variant}${freeRoam ? ' pet-hab--roam' : ''}`}
      style={{ '--ambient': ambient.toFixed(3) } as CSSProperties}
      onPointerMove={handlePointerMove}
      onPointerLeave={resetParallax}
      onPointerUp={stopPressing}
    >
      <span className="pet-hab__backdrop" aria-hidden="true" />
      <span className="pet-hab__ambient pet-hab__ambient--night" aria-hidden="true" />
      <span className="pet-hab__ambient pet-hab__ambient--day" aria-hidden="true" />
      <span className="pet-hab__tint" aria-hidden="true" />
      <span className="pet-hab__scanlines" aria-hidden="true" />
      <span className="pet-hab__curve" aria-hidden="true" />
      <span className="pet-hab__glow" aria-hidden="true" />
      <span className="pet-hab__amb-bubble pet-hab__amb-bubble--1" aria-hidden="true" />
      <span className="pet-hab__amb-bubble pet-hab__amb-bubble--2" aria-hidden="true" />
      <span className="pet-hab__amb-bubble pet-hab__amb-bubble--3" aria-hidden="true" />

      <button type="button" className="pet-hab__vat" onClick={handleVat} aria-label="Poke the goo vat">
        <span className="pet-hab__vat-goo" aria-hidden="true" />
        <span className="pet-hab__vat-shine" aria-hidden="true" />
      </button>

      {Array.from({ length: playmates.renderCount }).map((_, i) => (
        <div
          key={`${playmates.cohortKey}-${i}`}
          className="pet-hab__playmate"
          ref={(el) => playmates.registerEl(i, el)}
          onPointerDown={(e) => playmates.onBodyPointerDown(i, e)}
          role="button"
          tabIndex={-1}
          aria-label="Play with the wrestling Blubber"
        >
          <Flubber3D
            expression="excited"
            size={playmateSize}
            tier="mid"
            seed={90 + i}
            onSlotReady={(h) => {
              playmates.registerSlot(i, h);
              if (!h) return;
              h.setMovement({ wander: true, bounciness: 1, speed: 1 });
              h.playGesture('bounce');
            }}
          />
        </div>
      ))}

      <div
        ref={setCharRef}
        className={`pet-hab__character${freeRoam ? ' pet-hab__character--roam' : ''}`}
        onPointerDown={handleCharPointerDown}
      >
        <Flubber3D
          expression={expression}
          size={heroSize}
          pulseKey={pulseKey}
          tier="hero"
          onSlotReady={onSlotReady}
        />
      </div>
    </div>
  );
});

export default PetHabitatScene;
