/**
 * Shared types for the Virtual Pet mini-games arcade (src/components/games/**).
 * Every game in GAMES (GamesHub.tsx) implements GameComponentProps and reports
 * a real, session-only score back to the hub via onFinish -- there is no
 * fake persistence or leaderboard anywhere in this module.
 */

export type GameId =
  | 'snake'
  | 'pong'
  | 'connect-four'
  | 'flubber-toss'
  | 'reaction-tap'
  | 'memory-match';

/** Live status of a single game session, used to drive the shared GameChrome overlay. */
export type GameStatus = 'playing' | 'paused' | 'over';

export interface GameComponentProps {
  /** True when the OS-level prefers-reduced-motion query is active -- games
   * must skip screen shake/flash but keep the core loop running (motion IS
   * the gameplay here, only decorative juice is cut). */
  reduceMotion: boolean;
  /** This game's best score from earlier rounds THIS SESSION (0 if none yet).
   * Shown live in GameChrome next to the current score; the hub is the only
   * owner of this number, updated once per onFinish call. */
  best: number;
  /** Return to the GamesHub grid without necessarily finishing a round. */
  onExit: () => void;
  /** Called exactly once per completed session with the final score shown to
   * the player and the XP that session earned (5-15, scaled by performance
   * inside each game). The hub owns turning this into a best-this-session
   * number and forwarding XP to onXp. */
  onFinish: (score: number, xp: number) => void;
}

export interface GameDef {
  id: GameId;
  name: string;
  tagline: string;
  /** Whether a bigger score number is a better result -- false for the two
   * games where the reported score is a cost to minimize (Reaction Tap's
   * average ms, Memory Match's flip count). Drives both the "best this
   * session" comparison and (indirectly) how that number reads on the card. */
  higherIsBetter: boolean;
  /** Human-readable score formatting for the hub card, e.g. "12 eaten",
   * "340ms avg". Keeps each game's unit out of the shared card markup. */
  formatScore: (score: number) => string;
  /** Draws a small static canvas icon for the hub card. Pure function of a
   * 2D context + the card's pixel size -- no animation loop, no state. */
  drawIcon: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
}
