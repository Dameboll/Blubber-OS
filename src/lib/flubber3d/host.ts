/**
 * flubber3d/host — THE single WebGL context for every non-hero-panel Blubber
 * in the app (Phase 1 of docs/plans/flubber-3d-everywhere.md).
 *
 * Why: ~30 live Flubbers can be on screen (Agents grid alone shows 10–20).
 * Browsers cap WebGL contexts at ~8–16 and silently kill the oldest beyond
 * that. So: ONE offscreen WebGLRenderer, many on-page 2D canvases ("slots").
 * Per rAF the host advances + renders each visible slot's FlubberInstance
 * into a scissored region of its internal canvas and blits it into the
 * slot's canvas with drawImage — the canonical three.js multiple-scenes
 * pattern, except the output canvases are ordinary DOM nodes so each panel
 * keeps correct z-order/overflow for free.
 *
 * Tier clocks: hero/mid render every frame; micro slots re-render at
 * MICRO_FPS (the instance clock accumulates dt so animation speed stays
 * correct — they just present less often).
 *
 * Culling: an IntersectionObserver marks offscreen slots; the loop skips
 * them entirely (no mixer update, no render, no blit).
 *
 * MID cap (LANE M): the shiny clearcoat MID tier renders EVERY frame — it is
 * never deferred by the per-frame budget below (only micro is). So the number
 * of live MID bodies is hard-capped at MAX_MID_BODIES. A slot that requests
 * MID once the cap is reached is granted MICRO instead — which IS
 * budget-throttled + culled — so a dense screen (the pool's 14 residents, a
 * music stage's self-spawned minis) degrades to the cheap flat matcap
 * gracefully instead of dropping frames. The granted tier is stamped on the
 * slot canvas as data-flubber-tier (honest: it can differ from the requested
 * data-flubber-3d) and surfaced in window.__flubberHostStats (mid / midOverflow).
 *
 * Context loss: the host listens for webglcontextlost/restored on its own
 * canvas. Textures with CPU-side sources re-upload automatically; the PMREM
 * environment (a render target, no CPU copy) is regenerated on restore.
 *
 * Debug/verification surface: window.__flubberHostStats — slot count,
 * visible count, frames rendered per tier, context-loss count. The grid
 * verify script asserts against this.
 */

import * as THREE from 'three';
import { REDUCED_MOTION_QUERY } from './assets';
import { GOO_TONE_MAPPING_EXPOSURE, createStudioEnvironment } from './materials';
import {
  createFlubberInstance,
  type FlubberAccessory,
  type FlubberInstance,
  type FlubberScene,
  type FlubberTier,
  type WorkstationState,
} from './instance';
import type { GestureName, MovementConfig } from './motion';

const MICRO_FPS = 20;
const MICRO_FRAME_INTERVAL_MS = 1000 / MICRO_FPS;
// The shared host renders each slot into an offscreen buffer, then blits it
// down to the slot's CSS box — so a slot's render-target resolution is
// size × DPR, and the hero tier's transmission pass (a full second render of
// the scene into a buffer, every frame) scales with that pixel count. At
// these blitted sizes DPR 1 vs 1.5 is imperceptible after the downscale, so
// the caps are kept low to keep the transmission pass cheap on dense screens
// (Agents grid + wandering MID roamer). See docs/plans/flubber-3d-everywhere.md
// "host blit throughput" risk.
const HERO_DPR_CAP = 1;
const MID_DPR_CAP = 1;
const MICRO_DPR = 1;
// Per-frame render budget (ms). The host renders visible slots in a rotating
// order until this is exceeded, then defers the rest to the next frame
// (their canvases hold their last blit — imperceptible for a continuously
// animated mascot). Guarantees the page stays smooth regardless of how many
// live Flubbers a screen packs in — graceful degradation instead of a cliff.
const FRAME_RENDER_BUDGET_MS = 9;

// LANE M — max number of live MID (shiny clearcoat-goo) bodies across the WHOLE
// app at once. MID is heavier than MICRO per body: a full lit clearcoat render
// every frame (lights + authored env + wobble shader) and, unlike MICRO, it is
// NOT deferred by FRAME_RENDER_BUDGET_MS. IMPORTANT: this caps REGISTERED mid
// bodies, but offscreen slots are CULLED (IntersectionObserver) and never
// actually render — so the real per-frame cost is the VISIBLE mid count, which
// stays ~15 even with 30+ slots alive. At 24 the cap was being eaten by
// offscreen holders (the pool's 14 residents, the dashboard spawned list) even
// while culled, forcing the small avatars the user actually looks at — the
// sidebar Recent Agents, spawned minis — to overflow to the flat MICRO matcap
// and read "old / matte". Raised to 40 so every mini a screen actually shows
// gets the glossy clearcoat; a genuine runaway (dozens of playmates) still
// overflows the excess to MICRO (budget-throttled + culled) — graceful degrade,
// no frame cliff. Blitted render targets are tiny (36–56px) so the clearcoat
// renders stay cheap; the expensive transmission pass is HERO-only, count-of-one.
const MAX_MID_BODIES = 40;

export interface FlubberHostStats {
  slots: number;
  visible: number;
  /** Live count of slots currently granted the MID tier (≤ midCap). */
  mid: number;
  /** The MAX_MID_BODIES ceiling — for the verify script to assert against. */
  midCap: number;
  /** Cumulative count of MID requests downgraded to MICRO by the cap. */
  midOverflow: number;
  renderedFrames: number;
  skippedCulled: number;
  contextLosses: number;
}

declare global {
  interface Window {
    __flubberHostStats?: FlubberHostStats;
  }
}

export interface FlubberSlotOptions {
  tier: FlubberTier;
  expression: string;
  /** CSS size in px (square). */
  size: number;
  seed?: number;
  /** Scene variant — 'workstation' gives the agent its own desk/laptop/holo. */
  scene?: FlubberScene;
  /** Worn accessory attached to the Head bone (e.g. DJ headphones). */
  accessory?: FlubberAccessory;
  /** Opt in to built-in pointer reactions: hovering the slot canvas perks the
   * Blubber, clicking makes it hop. Off by default (no behaviour change for
   * existing slots). A parent can also drive reactToPointer() manually. */
  interactive?: boolean;
}

export interface FlubberSlotHandle {
  setExpression(expression: string): void;
  pulse(): void;
  setSize(size: number): void;
  /** Drive the workstation spawn-in / progress (no-op without a workstation). */
  setWorkstation(state: WorkstationState): void;
  /** Configure procedural locomotion. null → inherit the global runtime config
   * (energyLevel/movementAmount from /api/brain). */
  setMovement(cfg: MovementConfig | null): void;
  /** Play a one-shot readable gesture. */
  playGesture(name: GestureName): void;
  /** Quick pointer reaction (turn/hop/expression). */
  reactToPointer(kind: 'hover' | 'click'): void;
  readonly instance: FlubberInstance;
  dispose(): void;
}

interface Slot {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  instance: FlubberInstance;
  tier: FlubberTier;
  sizeCss: number;
  dpr: number;
  visible: boolean;
  lastPresentedAt: number;
  pendingDt: number;
  loadedStamped: boolean;
  lastClipStamped: string | null;
  pointerCleanup: (() => void) | null;
}

function tierDpr(tier: FlubberTier): number {
  const deviceDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  // LANE 7 perf: cap all DPR at 1.5 to reduce render target memory + fill-rate
  const cappedDpr = Math.min(deviceDpr, 1.5);
  if (tier === 'hero') return Math.min(cappedDpr, HERO_DPR_CAP);
  if (tier === 'mid') return Math.min(cappedDpr, MID_DPR_CAP);
  return MICRO_DPR;
}

class FlubberHost {
  private renderer: THREE.WebGLRenderer | null = null;
  private glCanvas: HTMLCanvasElement | null = null;
  private environment: THREE.Texture | null = null;
  private slots = new Set<Slot>();
  private observer: IntersectionObserver | null = null;
  private slotByElement = new WeakMap<Element, Slot>();
  private rafId = 0;
  private running = false;
  private lastFrameAt = 0;
  private contextLost = false;
  private prefersReducedMotion = false;
  // Rotating start offset for MICRO slots so, when the per-frame render budget
  // can't service them all in one frame, coverage rotates fairly instead of
  // always starving the tail of the list.
  private microCursor = 0;
  // Live count of slots currently granted the MID tier — the cap gate reads
  // this at register time and it is decremented on dispose.
  private midCount = 0;
  // LANE 7 perf: visibility handler for pause/resume on page hide/show
  private visibilityHandler: (() => void) | null = null;
  private stats: FlubberHostStats = {
    slots: 0,
    visible: 0,
    mid: 0,
    midCap: MAX_MID_BODIES,
    midOverflow: 0,
    renderedFrames: 0,
    skippedCulled: 0,
    contextLosses: 0,
  };

  private ensureRenderer(): THREE.WebGLRenderer {
    if (this.renderer) return this.renderer;

    this.prefersReducedMotion = window.matchMedia(REDUCED_MOTION_QUERY).matches;
    const glCanvas = document.createElement('canvas');
    glCanvas.width = 64;
    glCanvas.height = 64;
    this.glCanvas = glCanvas;

    glCanvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.contextLost = true;
      this.stats.contextLosses += 1;
    });
    glCanvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      // The PMREM env is a render target — no CPU-side copy survives a lost
      // context. Regenerate and re-point every instance scene at it.
      if (this.renderer) {
        this.environment = createStudioEnvironment(this.renderer);
        this.slots.forEach((slot) => {
          if (slot.tier !== 'micro') slot.instance.scene.environment = this.environment;
        });
      }
    });

    const renderer = new THREE.WebGLRenderer({
      canvas: glCanvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // ACES for the goo tiers; micro materials opt out via toneMapped: false.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = GOO_TONE_MAPPING_EXPOSURE;
    renderer.setScissorTest(true);
    renderer.autoClear = false;
    this.renderer = renderer;
    this.environment = createStudioEnvironment(renderer);

    this.observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const slot = this.slotByElement.get(entry.target);
        if (slot) slot.visible = entry.isIntersecting;
      });
    });

    window.__flubberHostStats = this.stats;
    return renderer;
  }

  /** Grow-only backing store: big enough for the largest slot's pixel size. */
  private ensureBackingStore(w: number, h: number) {
    if (!this.renderer || !this.glCanvas) return;
    if (this.glCanvas.width >= w && this.glCanvas.height >= h) return;
    const nextW = Math.max(this.glCanvas.width, w);
    const nextH = Math.max(this.glCanvas.height, h);
    // false: never touch CSS style of the offscreen canvas.
    this.renderer.setSize(nextW, nextH, false);
  }

  register(canvas: HTMLCanvasElement, options: FlubberSlotOptions): FlubberSlotHandle {
    this.ensureRenderer();

    // MID cap gate: honour the requested tier, but if this is the
    // (MAX_MID_BODIES+1)-th live MID body, grant MICRO instead. HERO and MICRO
    // requests always pass through untouched. Registration-order, so the first
    // callers (typically the pool's residents) keep the shiny look and only the
    // overflow degrades. See MAX_MID_BODIES for the perf rationale.
    let grantedTier: FlubberTier = options.tier;
    if (grantedTier === 'mid' && this.midCount >= MAX_MID_BODIES) {
      grantedTier = 'micro';
      this.stats.midOverflow += 1;
    }

    const dpr = tierDpr(grantedTier);
    const sizePx = Math.max(1, Math.round(options.size * dpr));
    canvas.width = sizePx;
    canvas.height = sizePx;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('FlubberHost: slot canvas has no 2d context');

    const instance = createFlubberInstance({
      tier: grantedTier,
      expression: options.expression,
      environment: grantedTier === 'micro' ? null : this.environment,
      prefersReducedMotion: this.prefersReducedMotion,
      seed: options.seed ?? this.slots.size + 1,
      scene: options.scene,
      accessory: options.accessory,
    });

    if (grantedTier === 'mid') {
      this.midCount += 1;
      this.stats.mid = this.midCount;
    }
    // Honest granted-tier stamp — complements Flubber3D's requested
    // data-flubber-3d and lets the verify script tell shiny MID from
    // overflow-MICRO at a glance.
    canvas.dataset.flubberTier = grantedTier;

    const slot: Slot = {
      canvas,
      ctx,
      instance,
      tier: grantedTier,
      sizeCss: options.size,
      dpr,
      visible: true,
      lastPresentedAt: 0,
      pendingDt: 0,
      loadedStamped: false,
      lastClipStamped: null,
      pointerCleanup: null,
    };
    this.slots.add(slot);
    this.slotByElement.set(canvas, slot);
    this.observer?.observe(canvas);
    this.stats.slots = this.slots.size;
    this.ensureBackingStore(sizePx, sizePx);

    // Opt-in pointer reactions — listeners live on the slot's own 2D canvas so
    // each Blubber reacts to its own hover/click with no shared bookkeeping.
    if (options.interactive) {
      const onEnter = () => instance.reactToPointer('hover');
      const onDown = () => instance.reactToPointer('click');
      canvas.addEventListener('pointerenter', onEnter);
      canvas.addEventListener('pointerdown', onDown);
      slot.pointerCleanup = () => {
        canvas.removeEventListener('pointerenter', onEnter);
        canvas.removeEventListener('pointerdown', onDown);
      };
    }

    this.start();

    return {
      instance,
      setExpression: (expression: string) => instance.setExpression(expression),
      pulse: () => instance.pulse(),
      setWorkstation: (state: WorkstationState) => instance.setWorkstation(state),
      setMovement: (cfg: MovementConfig | null) => instance.setMovement(cfg),
      playGesture: (name: GestureName) => instance.playGesture(name),
      reactToPointer: (kind: 'hover' | 'click') => instance.reactToPointer(kind),
      setSize: (size: number) => {
        slot.sizeCss = size;
        const px = Math.max(1, Math.round(size * slot.dpr));
        slot.canvas.width = px;
        slot.canvas.height = px;
        this.ensureBackingStore(px, px);
      },
      dispose: () => {
        slot.pointerCleanup?.();
        slot.pointerCleanup = null;
        this.observer?.unobserve(canvas);
        this.slotByElement.delete(canvas);
        this.slots.delete(slot);
        instance.dispose();
        this.stats.slots = this.slots.size;
        if (slot.tier === 'mid') {
          this.midCount -= 1;
          this.stats.mid = this.midCount;
        }
        if (this.slots.size === 0) this.stop();
      },
    };
  }

  private start() {
    if (this.running) return;
    this.running = true;
    this.lastFrameAt = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(loop);
      this.frame(now);
    };
    // LANE 7 perf: pause rAF when page is hidden (document.hidden)
    this.visibilityHandler = () => {
      if (document.hidden) {
        cancelAnimationFrame(this.rafId);
      } else {
        this.lastFrameAt = performance.now();
        this.rafId = requestAnimationFrame(loop);
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
    this.rafId = requestAnimationFrame(loop);
  }

  private stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  private frame(now: number) {
    if (!this.renderer || !this.glCanvas || this.contextLost) return;
    const dt = Math.min((now - this.lastFrameAt) / 1000, 0.1);
    this.lastFrameAt = now;
    const nowS = now / 1000;
    const frameStart = performance.now();

    // Split visible slots by tier. Hero/mid need 60fps and are few — they
    // always render. Micro slots are throttled to MICRO_FPS and are what the
    // per-frame budget defers first (their staleness is invisible).
    const heroMid: Slot[] = [];
    const micro: Slot[] = [];
    let visibleCount = 0;
    this.slots.forEach((slot) => {
      if (!slot.visible) {
        this.stats.skippedCulled += 1;
        return;
      }
      visibleCount += 1;
      slot.pendingDt += dt;
      if (slot.tier === 'micro') micro.push(slot);
      else heroMid.push(slot);
    });
    this.stats.visible = visibleCount;

    // Hero + mid: render every frame (budget never blocks these — they are
    // the high-priority tiers and there are only a handful).
    for (const slot of heroMid) this.renderSlot(slot, now, nowS);

    // Micro: honour the MICRO_FPS clock, then spend whatever frame budget
    // remains, rotating the start cursor so coverage is fair when the budget
    // can't service them all.
    if (micro.length > 0) {
      const n = micro.length;
      const start = this.microCursor % n;
      let servicedAtLeastOne = false;
      for (let k = 0; k < n; k += 1) {
        const slot = micro[(start + k) % n];
        if (now - slot.lastPresentedAt < MICRO_FRAME_INTERVAL_MS) continue;
        if (servicedAtLeastOne && performance.now() - frameStart > FRAME_RENDER_BUDGET_MS) {
          // Out of budget — resume from this slot next frame.
          this.microCursor = (start + k) % n;
          return;
        }
        this.renderSlot(slot, now, nowS);
        servicedAtLeastOne = true;
      }
      // Full micro pass completed within budget — start fresh next frame.
      this.microCursor = 0;
    }
  }

  private renderSlot(slot: Slot, now: number, nowS: number) {
    slot.lastPresentedAt = now;
    const instance = slot.instance;
    instance.update(slot.pendingDt, nowS);
    slot.pendingDt = 0;
    if (!instance.ready) return;

    const px = Math.max(1, Math.round(slot.sizeCss * slot.dpr));
    this.ensureBackingStore(px, px);
    const glH = this.glCanvas!.height;

    instance.camera.aspect = 1;
    instance.camera.updateProjectionMatrix();
    // Render into the bottom-left corner of the GL canvas...
    this.renderer!.setViewport(0, 0, px, px);
    this.renderer!.setScissor(0, 0, px, px);
    this.renderer!.clear(true, true, false);
    this.renderer!.render(instance.scene, instance.camera);

    // ...which in image space is the top of the canvas flipped: GL origin is
    // bottom-left, drawImage origin is top-left, so the freshly rendered
    // px×px region sits at y = glH - px.
    slot.ctx.clearRect(0, 0, slot.canvas.width, slot.canvas.height);
    slot.ctx.drawImage(
      this.glCanvas!,
      0, glH - px, px, px,
      0, 0, slot.canvas.width, slot.canvas.height,
    );
    if (slot.tier === 'hero') {
      // The hero tier's in-scene goo backdrop is load-bearing for
      // transmission but reads as a dark rectangle where the canvas edge
      // crops it. destination-in radial mask fades the blit's own corners to
      // transparent — the body sits center, only the glow's square crop line
      // dies (docs/plans/flubber-3d-everywhere.md, the dark-rectangle fix).
      const w = slot.canvas.width;
      const cx = w / 2;
      // Fully transparent at the inscribed circle (r = cx): every straight
      // canvas edge sits at or beyond it, so no square crop line can survive;
      // the body spans ≤ 0.9·cx and never touches the fade band.
      const gradient = slot.ctx.createRadialGradient(cx, cx, 0, cx, cx, cx * Math.SQRT2);
      gradient.addColorStop(0, 'rgba(255,255,255,1)');
      gradient.addColorStop(0.64, 'rgba(255,255,255,1)');
      gradient.addColorStop(0.707, 'rgba(255,255,255,0)');
      slot.ctx.globalCompositeOperation = 'destination-in';
      slot.ctx.fillStyle = gradient;
      slot.ctx.fillRect(0, 0, w, w);
      slot.ctx.globalCompositeOperation = 'source-over';
    }
    this.stats.renderedFrames += 1;

    if (!slot.loadedStamped) {
      slot.loadedStamped = true;
      slot.canvas.dataset.flubberSlotLoaded = '1';
    }
    const clip = instance.currentClip;
    if (clip !== slot.lastClipStamped) {
      slot.lastClipStamped = clip;
      if (clip) slot.canvas.dataset.flubberClip = clip;
    }
  }

  /** Verification hook: force a context loss (grid test). Unlike a real
   * driver-level loss, WEBGL_lose_context does NOT auto-restore — the test
   * calls forceContextRestore() afterwards to simulate the browser's
   * restoration. */
  forceContextLoss() {
    this.renderer?.forceContextLoss();
  }

  forceContextRestore() {
    this.renderer?.forceContextRestore();
  }
}

let hostSingleton: FlubberHost | null = null;

export function getFlubberHost(): FlubberHost {
  if (!hostSingleton) hostSingleton = new FlubberHost();
  return hostSingleton;
}
