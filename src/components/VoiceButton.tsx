'use client';

import { Mic, MicOff } from 'lucide-react';
import { useVoicePushToTalk } from '@/hooks/useVoicePushToTalk';
import styles from './VoiceButton.module.css';

export interface VoiceButtonProps {
  /** Ref to the terminal pane wrapper. Push-to-talk only arms while focus is inside this element. */
  containerRef: React.RefObject<HTMLElement | null>;
  /**
   * Called with the finalized transcript on Space release (after the hold threshold).
   * Wire this to send `{ type: "input", sessionId: activeSessionId, data: transcript }`
   * over the shared WebSocket client - same effect as the user typing it.
   */
  onTranscript: (transcript: string) => void;
  /**
   * Called once when Space is tapped (released before the hold threshold) instead of held.
   * Wire this to send a single literal space character through the same send-input path
   * as `onTranscript`, so a quick tap behaves like a normal keystroke.
   */
  onSpaceTap?: () => void;
  /** Disable voice input, e.g. no active session selected for this tab. */
  disabled?: boolean;
  className?: string;
}

/**
 * Visual indicator + wiring for hold-space-to-talk voice input.
 * Renders a status pill: idle / listening (with live interim transcript) / unsupported.
 * All push-to-talk logic lives in useVoicePushToTalk - this component just reflects its state.
 */
export function VoiceButton({
  containerRef,
  onTranscript,
  onSpaceTap,
  disabled = false,
  className,
}: VoiceButtonProps) {
  const { isSupported, isListening, interimTranscript, error } = useVoicePushToTalk({
    containerRef,
    onTranscript,
    onSpaceTap,
    disabled,
  });

  if (!isSupported) {
    return (
      <div
        className={[styles.badge, styles.unsupported, className].filter(Boolean).join(' ')}
        title="Voice input isn't supported in this browser. Try Chrome or Edge."
      >
        <MicOff size={14} strokeWidth={2} aria-hidden="true" />
        <span className={styles.label}>Voice unavailable</span>
      </div>
    );
  }

  const statusText = error
    ? `Mic error: ${error}`
    : isListening
      ? interimTranscript || 'Listening…'
      : 'Hold Space to talk';

  return (
    <div
      className={[styles.badge, isListening ? styles.listening : '', disabled ? styles.disabled : '', className]
        .filter(Boolean)
        .join(' ')}
      role="status"
      aria-live="polite"
    >
      <Mic size={14} strokeWidth={2} aria-hidden="true" className={isListening ? styles.pulseIcon : undefined} />
      <span className={styles.label}>{statusText}</span>
    </div>
  );
}
