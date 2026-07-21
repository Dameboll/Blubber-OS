'use client';

/**
 * QuickChat — the Dashboard's "Chat" tab (PILL WORLDS + MINI DASH, Lane 2).
 * A genuinely SEPARATE Claude session (pinned to the current top model),
 * backed by /api/quickchat (spawns real one-shot
 * `claude -p --model claude-opus-4-8 --resume …` processes — see that route's
 * header). This NEVER touches the main work terminal
 * (PersistentTerminalHost/TabBar/wsClient) — a different transcript, a
 * different Claude CLI session id, a different store file entirely.
 *
 * The badge shows the REAL model the CLI reported for the last reply (parsed
 * from its JSON result and persisted per message), mapped to a friendly label
 * — not a hardcoded name. Before the first reply it stays neutral.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { RotateCcw, Send } from 'lucide-react';
import AgentAvatar from '../AgentAvatar';
import './QuickChat.css';

interface QuickChatMessageDto {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  ts: string;
  model?: string | null;
}

type LoadState = 'loading' | 'ready' | 'error';

/** Real CLI model id -> friendly badge label (current lineup). Anything not
 * listed falls back to the raw id, so a genuinely new model still shows
 * honestly rather than as a stale name. */
const MODEL_LABELS: Record<string, string> = {
  'claude-opus-4-8': 'Opus 4.8',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-fable-5': 'Fable 5',
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
};

function friendlyModel(id: string): string {
  return MODEL_LABELS[id] ?? id;
}

export default function QuickChat() {
  const [messages, setMessages] = useState<QuickChatMessageDto[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const loadTranscript = useCallback(() => {
    fetch('/api/quickchat')
      .then((res) => {
        if (!res.ok) throw new Error(`quickchat fetch failed: ${res.status}`);
        return res.json() as Promise<{ messages?: QuickChatMessageDto[] }>;
      })
      .then((json) => {
        setMessages(Array.isArray(json.messages) ? json.messages : []);
        setState('ready');
      })
      .catch(() => setState('error'));
  }, []);

  useEffect(() => {
    loadTranscript();
  }, [loadTranscript]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight });
  }, [messages, sending]);

  const handleSend = useCallback(
    (event?: FormEvent) => {
      event?.preventDefault();
      const text = input.trim();
      if (!text || sending) return;
      setInput('');
      setSending(true);
      fetch('/api/quickchat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })
        .catch(() => {
          // The route itself always appends an honest error bubble on
          // failure — the reload below picks it up either way.
        })
        .finally(() => {
          setSending(false);
          loadTranscript();
        });
    },
    [input, sending, loadTranscript],
  );

  const handleNewChat = useCallback(() => {
    fetch('/api/quickchat', { method: 'DELETE' })
      .then(() => setMessages([]))
      .finally(() => loadTranscript());
  }, [loadTranscript]);

  // The real model from the most recent reply that reported one. Neutral until
  // the first reply lands — we never claim a model we haven't seen answer.
  let lastModel: string | null = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role === 'assistant' && m.model) {
      lastModel = m.model;
      break;
    }
  }
  const badgeLabel = lastModel
    ? `${friendlyModel(lastModel)} · separate session`
    : 'Separate session';

  return (
    <div className="quick-chat">
      <div className="quick-chat__head">
        <span className="quick-chat__title">Quick Chat</span>
        <span className="quick-chat__badge">{badgeLabel}</span>
        <button
          type="button"
          className="quick-chat__new"
          onClick={handleNewChat}
          title="Start a new Quick Chat session (clears this transcript only)"
        >
          <RotateCcw size={11} aria-hidden="true" />
          New chat
        </button>
      </div>

      <div className="quick-chat__list" ref={listRef}>
        {state === 'loading' && <p className="quick-chat__empty">Loading…</p>}
        {state === 'error' && <p className="quick-chat__empty">Couldn&rsquo;t reach Quick Chat.</p>}
        {state === 'ready' && messages.length === 0 && (
          <p className="quick-chat__empty">
            Ask Blubber anything — this is a separate Claude session, it never touches your main work terminal.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`quick-chat__row quick-chat__row--${m.role}`}>
            {m.role === 'assistant' && (
              <AgentAvatar
                name="Blubber"
                size={24}
                tier="mid"
                expressionOverride="happy"
                className="quick-chat__avatar"
              />
            )}
            <span className="quick-chat__bubble">{m.text}</span>
          </div>
        ))}
        {sending && (
          <div className="quick-chat__row quick-chat__row--assistant">
            <AgentAvatar
              name="Blubber"
              size={24}
              tier="mid"
              expressionOverride="thinking"
              className="quick-chat__avatar"
            />
            <span className="quick-chat__bubble quick-chat__bubble--shimmer">Thinking…</span>
          </div>
        )}
      </div>

      <form className="quick-chat__input-row" onSubmit={handleSend}>
        <input
          type="text"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Message Blubber…"
          disabled={sending}
          aria-label="Quick chat message"
        />
        <button type="submit" disabled={sending || input.trim().length === 0} aria-label="Send message">
          <Send size={13} aria-hidden="true" />
        </button>
      </form>
    </div>
  );
}
