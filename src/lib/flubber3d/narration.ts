/**
 * flubber3d/narration — a tiny, framework-free event bus for Flubber
 * "narration": the short first-person lines the mascot emits as it reacts to
 * real activity (a build passing, a pet being fed, ambient personality
 * chatter). Phase 1 of the flubber-core upgrade.
 *
 * Deliberately dependency-free (no React, no three): the 3D layer, the brain
 * provider, and any UI caption strip all speak the same channel without
 * importing each other. Producers call narrate(); consumers subscribe and get
 * an unsubscribe back. Delivery is synchronous and best-effort — a throwing
 * subscriber never blocks the others.
 */

export type NarrationMood = 'chill' | 'hype' | 'focused';

export interface NarrationMessage {
  text: string;
  /** Emotional register — lets a caption strip tint/animate accordingly. */
  mood: NarrationMood;
  /** Emission timestamp (ms epoch). */
  ts: number;
}

type NarrationListener = (msg: NarrationMessage) => void;

const listeners = new Set<NarrationListener>();

/** Emit a narration line to every current subscriber. `mood` defaults to
 * 'chill'. Safe to call from anywhere (framework-free). */
export function narrate(text: string, opts?: { mood?: NarrationMood }): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const msg: NarrationMessage = {
    text: trimmed,
    mood: opts?.mood ?? 'chill',
    ts: Date.now(),
  };
  // Snapshot so a subscriber that (un)subscribes during dispatch can't mutate
  // the set mid-iteration.
  for (const listener of Array.from(listeners)) {
    try {
      listener(msg);
    } catch {
      /* one bad subscriber never blocks the rest */
    }
  }
}

/** Subscribe to narration. Returns an unsubscribe function. */
export function subscribeNarration(cb: NarrationListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
