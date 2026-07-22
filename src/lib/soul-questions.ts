// soul-questions — the single source of truth for the Soul Interview's 8
// questions (see src/components/soul/SoulInterview.tsx). Shared between the
// client component (renders `prompt` one at a time) and the server route
// (src/app/api/soul/route.ts uses `heading` to lay out ~/.claude/blubber-profile.md)
// so the question text and the markdown section names can never drift apart
// into two separately-maintained lists. Plain data, no React/DOM here — safe
// to import from a Next.js server route.

export interface SoulQuestion {
  /** Stable key — used as the answers object's key and the markdown anchor. */
  id: string;
  /** Blubber's chat-bubble prompt text, spoken in his voice. */
  prompt: string;
  /** Markdown section heading used when writing the profile file. */
  heading: string;
}

export const SOUL_QUESTIONS: SoulQuestion[] = [
  {
    id: 'identity',
    prompt: "Who are you? What should I call you?",
    heading: 'Identity',
  },
  {
    id: 'building',
    prompt: 'What do you build?',
    heading: 'What They Build',
  },
  {
    id: 'stack',
    prompt: "What's your stack?",
    heading: 'Stack',
  },
  {
    id: 'workStyle',
    prompt: 'How do you like to work?',
    heading: 'Work Style',
  },
  {
    id: 'tone',
    prompt: 'What tone should I take with you?',
    heading: 'Tone',
  },
  {
    id: 'purpose',
    prompt: 'What should Blubber BE for you?',
    heading: 'What Blubber Should Be',
  },
  {
    id: 'visions',
    prompt: "What are you building toward? Your visions.",
    heading: 'Visions',
  },
  {
    id: 'anythingElse',
    prompt: 'Anything else I should know?',
    heading: 'Anything Else',
  },
];
