'use client';

/**
 * SoulInterview — the Starter-Kit-gated personalization interview (Lane 3).
 *
 * Offered once, right after the guided dashboard tour finishes (or right
 * after the user declines it) — see src/lib/soul.ts's header for the exact
 * three launch paths and src/components/tour/DashboardTour.tsx /
 * src/components/onboarding/OnboardingOverlay.tsx for where each one fires
 * requestSoulInterview(). Never offered to Community Edition users: every
 * launch path is already behind the same Starter-Kit gate the tour itself is
 * behind, so this component doesn't re-check kit state on its own (mirrors
 * DashboardTour, which doesn't either).
 *
 * VISUAL LANGUAGE: matches DashboardTour/OnboardingOverlay — the official
 * static Blubber render (public/blubber-hero.png) floating on a slow bob next
 * to a chat bubble, over a dimmed full-screen backdrop. One question per
 * card. Chat-bubble feel throughout: Blubber "asks", the user answers in a
 * textarea, then clicks through.
 *
 * FULLY SKIPPABLE, TWO GRANULARITIES:
 *   - "Skip this one" on any question card advances without recording an
 *     answer for that question (it's simply absent from the payload — see
 *     POST /api/soul's honest "absence = skipped" contract).
 *   - The ghost "Skip interview" control is pinned at the bottom of every
 *     card (including the intro) and bails out immediately. Whatever was
 *     answered before that point is still saved; if nothing was answered at
 *     all, nothing is even sent to the server (see handleSkipInterview) —
 *     an entirely-skipped interview leaves zero trace.
 *
 * All answers are held in local state and sent as ONE POST /api/soul call
 * once the user reaches the end (either by finishing the last question or by
 * hitting "Skip interview" partway through with some answers already given)
 * — never one request per question. That single call is also what writes
 * ~/.claude/blubber-profile.md server-side (see that route).
 *
 * OWNERSHIP: this file + SoulInterview.css only.
 */

import { useCallback, useState } from 'react';
import { SOUL_QUESTIONS } from '../../lib/soul-questions';
import './SoulInterview.css';

type Phase = 'intro' | 'question' | 'done';

export interface SoulInterviewProps {
  /** Fires once the interview is fully done — finished, or bailed out of via
   * "Skip interview" at any point. Caller unmounts the overlay. */
  onClose: () => void;
}

export default function SoulInterview({ onClose }: SoulInterviewProps) {
  const [phase, setPhase] = useState<Phase>('intro');
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [profileWritten, setProfileWritten] = useState<boolean | null>(null);

  const question = SOUL_QUESTIONS[index];
  const isLastQuestion = index === SOUL_QUESTIONS.length - 1;
  const answeredCount = Object.keys(answers).length;

  // The one and only network call this component ever makes — fired once,
  // with whatever's been collected so far, whenever the flow reaches an end
  // point (finished the last question, or "Skip interview" with real answers
  // already in hand). See file header for why this isn't per-question.
  const submitAnswers = useCallback(async (finalAnswers: Record<string, string>) => {
    setSaving(true);
    try {
      const res = await fetch('/api/soul', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: finalAnswers }),
      });
      const data = (await res.json()) as { profileWritten?: boolean };
      setProfileWritten(res.ok ? Boolean(data?.profileWritten) : false);
    } catch (err) {
      console.error('[soul] failed to save interview:', err);
      setProfileWritten(false);
    } finally {
      setSaving(false);
    }
  }, []);

  const goToNextQuestionOrFinish = useCallback(
    (nextAnswers: Record<string, string>) => {
      if (isLastQuestion) {
        setPhase('done');
        submitAnswers(nextAnswers);
      } else {
        setIndex((i) => i + 1);
        setDraft('');
      }
    },
    [isLastQuestion, submitAnswers],
  );

  const handleNext = useCallback(() => {
    const trimmed = draft.trim();
    const nextAnswers = trimmed ? { ...answers, [question.id]: trimmed } : answers;
    setAnswers(nextAnswers);
    goToNextQuestionOrFinish(nextAnswers);
  }, [draft, answers, question.id, goToNextQuestionOrFinish]);

  const handleSkipQuestion = useCallback(() => {
    goToNextQuestionOrFinish(answers);
  }, [answers, goToNextQuestionOrFinish]);

  const handleStart = useCallback(() => setPhase('question'), []);

  // Bail out entirely. Only sends anything to the server if at least one
  // question was actually answered before the user backed out — see file
  // header. Doesn't block the close on the network call finishing.
  const handleSkipInterview = useCallback(() => {
    if (answeredCount > 0) {
      submitAnswers(answers);
    }
    onClose();
  }, [answeredCount, answers, submitAnswers, onClose]);

  return (
    <div className="soul" role="dialog" aria-modal="true" aria-label="Soul Interview">
      <div className="soul__veil" aria-hidden="true" />

      <div className="soul__card">
        {/* eslint-disable-next-line @next/next/no-img-element -- static /public asset, app-wide convention */}
        <img className="soul__blubber" src="/blubber-hero.png" alt="" aria-hidden="true" />

        {phase === 'intro' && (
          <div className="soul__bubble">
            <span className="soul__eyebrow">Before you dive in</span>
            <p className="soul__question">
              Got a minute? The more you tell me, the sharper I get for you — who you are, what you build, how you
              like to work. Totally optional, and every single question is skippable.
            </p>
            <div className="soul__actions">
              <button type="button" className="soul__btn soul__btn--primary" onClick={handleStart}>
                Let's talk
              </button>
            </div>
          </div>
        )}

        {phase === 'question' && (
          <div className="soul__bubble">
            <span className="soul__step-count">
              {index + 1} / {SOUL_QUESTIONS.length}
            </span>
            <p className="soul__question">{question.prompt}</p>
            <textarea
              className="soul__textarea"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type your answer…"
              maxLength={2000}
              rows={4}
              aria-label={question.prompt}
            />
            <div className="soul__actions">
              <button type="button" className="soul__btn soul__btn--primary" onClick={handleNext}>
                {isLastQuestion ? "That's it" : 'Next'}
              </button>
              <button type="button" className="soul__btn soul__btn--text" onClick={handleSkipQuestion}>
                Skip this one
              </button>
            </div>
          </div>
        )}

        {phase === 'done' && (
          <div className="soul__bubble">
            <span className="soul__eyebrow">All set</span>
            <p className="soul__question">
              {saving
                ? 'Saving what you told me…'
                : profileWritten
                  ? "Got it — I'll use this to work better with you from here on."
                  : answeredCount > 0
                    ? "Saved your answers locally, though I couldn't write your profile file — check the app's logs."
                    : 'No worries — nothing to save. You can always retake this from Settings.'}
            </p>
            <div className="soul__actions">
              <button type="button" className="soul__btn soul__btn--primary" onClick={onClose} disabled={saving}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>

      {phase !== 'done' && (
        <div className="soul__controls">
          <button type="button" className="soul__btn soul__btn--ghost" onClick={handleSkipInterview}>
            Skip interview
          </button>
        </div>
      )}
    </div>
  );
}
