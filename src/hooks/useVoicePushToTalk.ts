'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const SPACE_CODE = 'Space';

/**
 * Threshold that separates "tap Space to type a space" from "hold Space to talk",
 * mirroring the push-to-talk feel of the Claude Code CLI terminal. Released before
 * this passes -> treated as a normal keystroke. Held past it -> arms voice
 * recognition. 450ms is comfortably longer than an incidental/fast keystroke but
 * still reads as instant when someone actually means to hold the key down.
 */
const HOLD_TO_TALK_MS = 450;

export interface UseVoicePushToTalkOptions {
  /** Push-to-talk only arms while document.activeElement is inside this element. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Fires once, on Space release after the hold threshold, with the finalized transcript. Not called if the transcript is empty. */
  onTranscript: (transcript: string) => void;
  /**
   * Fires once when Space is tapped (released before `HOLD_TO_TALK_MS`) while focus is
   * inside `containerRef`. Wire this to send a literal space character to the active
   * session - same effect as if the space had been typed normally. Optional: if
   * omitted, a tap is simply swallowed (no space is emitted).
   */
  onSpaceTap?: () => void;
  /** Disable push-to-talk entirely (e.g. no active terminal session). Defaults to false. */
  disabled?: boolean;
  /** BCP-47 language tag. Defaults to 'en-US'. */
  lang?: string;
}

export interface UseVoicePushToTalkResult {
  /** False when SpeechRecognition/webkitSpeechRecognition isn't available - render a disabled state, don't crash. */
  isSupported: boolean;
  isListening: boolean;
  /** Live in-progress transcript while the key is held, for UI preview. */
  interimTranscript: string;
  error: string | null;
}

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

/**
 * Space is dual-purpose while focus is inside `containerRef`:
 * - Tap Space (release before `HOLD_TO_TALK_MS`) -> behaves like a normal keystroke.
 *   `onSpaceTap` fires once so the caller can send a literal space to the active session.
 * - Hold Space past `HOLD_TO_TALK_MS` -> starts listening. Release Space after that point
 *   stops listening and calls `onTranscript` with the finalized text, exactly as if it
 *   had been typed into the active session.
 *
 * Scoped intentionally: the keydown/keyup listeners check
 * `containerRef.current.contains(document.activeElement)` before touching the event,
 * so Space keeps its normal behavior everywhere else in the app.
 */
export function useVoicePushToTalk({
  containerRef,
  onTranscript,
  onSpaceTap,
  disabled = false,
  lang = 'en-US',
}: UseVoicePushToTalkOptions): UseVoicePushToTalkResult {
  const [isSupported] = useState(() => getSpeechRecognitionConstructor() !== null);
  const [isListening, setIsListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const recognitionActiveRef = useRef(false);
  const keyHeldRef = useRef(false);
  /** Pending "hold past threshold" timer, armed on keydown. Non-null only while Space is held and the threshold hasn't fired yet. */
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalTranscriptRef = useRef('');
  const interimTranscriptRef = useRef('');
  const onTranscriptRef = useRef(onTranscript);
  const onSpaceTapRef = useRef(onSpaceTap);
  const disabledRef = useRef(disabled);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  useEffect(() => {
    onSpaceTapRef.current = onSpaceTap;
  }, [onSpaceTap]);

  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);

  const getRecognition = useCallback((): SpeechRecognition | null => {
    if (!isSupported) return null;
    if (recognitionRef.current) return recognitionRef.current;

    const Ctor = getSpeechRecognitionConstructor();
    if (!Ctor) return null;

    const recognition = new Ctor();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) {
          finalTranscriptRef.current += text;
        } else {
          interim += text;
        }
      }
      interimTranscriptRef.current = interim;
      setInterimTranscript(interim);
    };

    recognition.onerror = (event) => {
      // "no-speech" (brief pause) and "aborted" (we called stop/abort ourselves) are routine, not errors.
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        setError(event.error);
      }
    };

    recognition.onend = () => {
      recognitionActiveRef.current = false;

      if (keyHeldRef.current) {
        // Some browsers auto-stop recognition after a silence timeout even while still "listening".
        // Space is still held, so keep the session going rather than dropping the transcript.
        try {
          recognition.start();
          recognitionActiveRef.current = true;
        } catch {
          // Already starting/started - ignore, next onend will retry if needed.
        }
        return;
      }

      const transcript = `${finalTranscriptRef.current} ${interimTranscriptRef.current}`.trim();
      finalTranscriptRef.current = '';
      interimTranscriptRef.current = '';
      setInterimTranscript('');
      setIsListening(false);

      if (transcript) {
        onTranscriptRef.current(transcript);
      }
    };

    recognitionRef.current = recognition;
    return recognition;
  }, [isSupported, lang]);

  const startListening = useCallback(() => {
    const recognition = getRecognition();
    if (!recognition) return;

    setError(null);
    finalTranscriptRef.current = '';
    interimTranscriptRef.current = '';
    setInterimTranscript('');

    try {
      recognition.start();
      recognitionActiveRef.current = true;
      setIsListening(true);
    } catch {
      // start() throws if a recognition session is already active - state already reflects that.
    }
  }, [getRecognition]);

  const stopListening = useCallback(() => {
    const recognition = recognitionRef.current;
    if (recognition && recognitionActiveRef.current) {
      recognition.stop(); // Resolves via onend, which finalizes and emits the transcript.
    } else {
      setIsListening(false);
    }
  }, []);

  // Force-stop if the caller disables push-to-talk mid-hold (e.g. active session was killed).
  useEffect(() => {
    if (disabled && keyHeldRef.current) {
      keyHeldRef.current = false;
      if (holdTimerRef.current !== null) {
        // Still under the tap/hold threshold - recognition never started, just cancel the timer.
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
        return;
      }
      stopListening();
    }
  }, [disabled, stopListening]);

  useEffect(() => {
    if (!isSupported) return;

    function isFocusInsideContainer(): boolean {
      const container = containerRef.current;
      const active = document.activeElement;
      return Boolean(container && active && container.contains(active));
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.code !== SPACE_CODE || event.repeat) return;
      if (disabledRef.current) return;
      if (keyHeldRef.current) return; // Already tracking this hold.
      if (!isFocusInsideContainer()) return; // Not our pane - let Space behave normally.

      event.preventDefault();
      event.stopPropagation();
      keyHeldRef.current = true;

      // Don't start listening immediately - arm a timer. If Space is released before
      // this fires, it was a tap (see handleKeyUp) and voice recognition never starts.
      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null;
        startListening();
      }, HOLD_TO_TALK_MS);
    }

    function handleKeyUp(event: KeyboardEvent) {
      if (event.code !== SPACE_CODE) return;
      if (!keyHeldRef.current) return; // We weren't the one holding it - don't interfere.

      event.preventDefault();
      event.stopPropagation();
      keyHeldRef.current = false;

      if (holdTimerRef.current !== null) {
        // Released before the hold threshold - a tap, not a hold-to-talk. Recognition
        // never started, so just cancel the timer and emit a plain space instead.
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
        onSpaceTapRef.current?.();
        return;
      }

      // Threshold already passed - recognition is active. Finalize exactly as before.
      stopListening();
    }

    function handleWindowBlur() {
      if (!keyHeldRef.current) return;
      keyHeldRef.current = false;

      if (holdTimerRef.current !== null) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
        return; // Never started listening - nothing to stop.
      }

      stopListening();
    }

    // Capture phase so this runs before xterm.js's own key handling on the terminal's hidden textarea.
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('keyup', handleKeyUp, { capture: true });
    window.addEventListener('blur', handleWindowBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('keyup', handleKeyUp, { capture: true });
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [containerRef, isSupported, startListening, stopListening]);

  useEffect(() => {
    return () => {
      if (holdTimerRef.current !== null) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      recognitionRef.current?.abort();
    };
  }, []);

  return { isSupported, isListening, interimTranscript, error };
}
