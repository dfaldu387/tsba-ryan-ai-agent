import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import {
  AUDIENCE_LABELS,
  AUTOMATED_RESPONSE_PREFIX,
  CHANNEL_LABELS,
  type Audience,
  type Channel,
  type SourceCard,
} from '@tsba/shared';
import {
  ApiError,
  AuthError,
  flagVoiceAnswer,
  getVoiceStarters,
  supportChat,
  type VoiceAttachment,
  type VoiceChatMessage,
} from '../api';

// ─── Support chat ─────────────────────────────────────────────────────────────
// A customer-support-style chat widget (NOT the voice console). The agent
// auto-detects who's asking and the channel from each message and answers
// instantly, grounded in TSBA's knowledge. A "Flag for team" button escalates a
// tricky answer; nothing is sent to a real customer channel from here.

const ACCEPT_TYPES = 'image/png,image/jpeg,image/gif,image/webp,application/pdf';
const ALLOWED_MEDIA = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 20_000_000;
const SESSIONS_KEY = 'tsba.support.sessions';
const MAX_SESSIONS = 50;

interface Attachment extends VoiceAttachment {
  name: string;
  size: number;
}

interface Turn {
  id: number;
  question: string;
  reply: string;
  sources?: SourceCard[];
  attachments?: string[];
  at?: string;
  pending?: boolean;
  suggestions?: string[];
  audience?: Audience;
  channel?: Channel;
}

/** One saved support conversation, listed on the page. */
interface ChatSession {
  id: string;
  at: string; // last activity (ISO)
  title: string; // first question — the "request"
  turns: Turn[];
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

function formatTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Show the mandated opener in italics; render the rest as normal text.
function ReplyText({ text }: { text: string }) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith(AUTOMATED_RESPONSE_PREFIX)) {
    const rest = trimmed.slice(AUTOMATED_RESPONSE_PREFIX.length).trimStart();
    return (
      <>
        <em className="sc-prefix">{AUTOMATED_RESPONSE_PREFIX}</em>
        {rest ? (
          <>
            <br />
            {rest}
          </>
        ) : null}
      </>
    );
  }
  return <>{text}</>;
}

function loadSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is ChatSession =>
        Boolean(s) &&
        typeof (s as ChatSession).id === 'string' &&
        Array.isArray((s as ChatSession).turns),
    );
  } catch {
    return [];
  }
}

function saveSessions(list: ChatSession[]): void {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(list.slice(0, MAX_SESSIONS)));
  } catch {
    /* ignore */
  }
}

function formatWhen(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function lastReplyOf(turns: Turn[]): string {
  const withReply = [...turns].reverse().find((t) => t.reply);
  if (!withReply) return '';
  const r = withReply.reply.trimStart();
  const clean = r.startsWith(AUTOMATED_RESPONSE_PREFIX) ? r.slice(AUTOMATED_RESPONSE_PREFIX.length).trim() : r;
  return clean.replace(/\s+/g, ' ').slice(0, 90);
}

const OVERRIDES: Array<Audience | 'auto'> = ['auto', 'customer', 'installer', 'sales'];

export function SupportChat({
  onAuthError,
  floatingOnly = false,
}: {
  onAuthError: () => void;
  /** When true, render only the floating bubble + window (no on-page list). */
  floatingOnly?: boolean;
}) {
  const [sessions, setSessions] = useState<ChatSession[]>(loadSessions);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [typed, setTyped] = useState('');
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [override, setOverride] = useState<Audience | 'auto'>('auto');
  const [starters, setStarters] = useState<string[]>([]);
  const [flagged, setFlagged] = useState<Record<number, 'pending' | 'done' | 'error'>>({});
  const [copiedId, setCopiedId] = useState<number | null>(null);
  // The chat launches from a floating bot bubble; open it to show the window.
  const [open, setOpen] = useState(false);
  // The conversation currently loaded in the bubble (null = a fresh, unsaved one).
  const activeIdRef = useRef<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);

  const lastDetected = [...turns].reverse().find((t) => !t.pending && t.audience);

  useEffect(() => {
    let alive = true;
    getVoiceStarters()
      .then((r) => alive && setStarters(Array.isArray(r.suggestions) ? r.suggestions : []))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Persist the active conversation into the sessions list (upsert) whenever it
  // changes, so the on-page list always reflects it.
  useEffect(() => {
    const done = turns.filter((t) => t.reply);
    if (done.length === 0) return;
    const id = activeIdRef.current ?? `s${Date.now()}`;
    activeIdRef.current = id;
    const session: ChatSession = {
      id,
      at: new Date().toISOString(),
      title: done[0].question.slice(0, 90),
      turns: done,
    };
    setSessions((prev) => {
      const next = [session, ...prev.filter((s) => s.id !== id)].slice(0, MAX_SESSIONS);
      saveSessions(next);
      return next;
    });
  }, [turns]);

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [typed]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, thinking]);

  // When the bubble opens, focus the composer and jump to the latest message.
  useEffect(() => {
    if (!open) return;
    taRef.current?.focus();
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [open]);

  async function addFiles(files: FileList | null) {
    if (!files || !files.length) return;
    setError('');
    const next: Attachment[] = [];
    for (const file of Array.from(files)) {
      if (attachments.length + next.length >= MAX_ATTACHMENTS) {
        setError(`You can attach up to ${MAX_ATTACHMENTS} files.`);
        break;
      }
      if (!ALLOWED_MEDIA.has(file.type)) {
        setError('Only images (PNG, JPG, GIF, WebP) and PDFs can be attached.');
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(`"${file.name}" is too large (max 20 MB).`);
        continue;
      }
      try {
        const data = await readAsBase64(file);
        next.push({ name: file.name, mediaType: file.type, data, size: file.size });
      } catch {
        setError(`Couldn’t read "${file.name}".`);
      }
    }
    if (next.length) setAttachments((prev) => [...prev, ...next].slice(0, MAX_ATTACHMENTS));
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }

  // Start a fresh conversation (the previous one is already saved in the list).
  function newConversation() {
    activeIdRef.current = null;
    setTurns([]);
    setAttachments([]);
    setError('');
    nextId.current = 1;
    setOpen(true);
  }

  // Load a saved conversation into the bubble and open it.
  function openSession(s: ChatSession) {
    activeIdRef.current = s.id;
    setTurns(s.turns);
    nextId.current = s.turns.reduce((m, t) => Math.max(m, t.id), 0) + 1;
    setAttachments([]);
    setError('');
    setOpen(true);
  }

  function deleteSession(id: string, e: ReactMouseEvent) {
    e.stopPropagation();
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      saveSessions(next);
      return next;
    });
    if (activeIdRef.current === id) {
      activeIdRef.current = null;
      setTurns([]);
    }
  }

  async function copyReply(turn: Turn) {
    try {
      await navigator.clipboard.writeText(turn.reply);
      setCopiedId(turn.id);
      window.setTimeout(() => setCopiedId((id) => (id === turn.id ? null : id)), 1500);
    } catch {
      setError('Couldn’t copy to the clipboard.');
    }
  }

  async function flagAnswer(turn: Turn) {
    setFlagged((f) => ({ ...f, [turn.id]: 'pending' }));
    try {
      await flagVoiceAnswer(turn.question, turn.reply, turn.audience ?? 'customer');
      setFlagged((f) => ({ ...f, [turn.id]: 'done' }));
    } catch (err) {
      if (err instanceof AuthError) return onAuthError();
      setFlagged((f) => ({ ...f, [turn.id]: 'error' }));
    }
  }

  async function ask(questionText: string) {
    const q = questionText.trim();
    const files = attachments;
    if ((!q && !files.length) || thinking) return;
    setError('');
    setAttachments([]);

    const history: VoiceChatMessage[] = [];
    for (const t of turns) {
      if (!t.reply) continue;
      history.push({ role: 'user', content: t.question });
      history.push({ role: 'assistant', content: t.reply });
    }
    history.push({ role: 'user', content: q || 'Please review the attached file(s).' });

    const id = nextId.current++;
    setTurns((prev) => [
      ...prev,
      {
        id,
        question: q || '(attached file)',
        reply: '',
        attachments: files.map((f) => f.name),
        at: new Date().toISOString(),
        pending: true,
      },
    ]);
    setThinking(true);

    try {
      const payload: VoiceAttachment[] = files.map((f) => ({ mediaType: f.mediaType, data: f.data }));
      const res = await supportChat(history, payload, override);
      setTurns((prev) =>
        prev.map((t) =>
          t.id === id
            ? {
                ...t,
                reply: res.reply,
                sources: res.sources,
                suggestions: Array.isArray(res.suggestions) ? res.suggestions : [],
                audience: res.audience,
                channel: res.channel,
                pending: false,
              }
            : t,
        ),
      );
    } catch (err) {
      setTurns((prev) => prev.filter((t) => t.id !== id));
      setAttachments(files);
      if (err instanceof AuthError) return onAuthError();
      if (err instanceof ApiError && err.code === 'chat_failed') {
        setError('The agent couldn’t answer that just now. Please try again.');
      } else if (err instanceof ApiError && err.code === 'attachment_too_large') {
        setError('That attachment is too large (max 20 MB per file).');
      } else {
        setError('Couldn’t get an answer. Please try again.');
      }
    } finally {
      setThinking(false);
    }
  }

  function onComposerKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const q = typed;
      setTyped('');
      void ask(q);
    }
  }

  return (
    <div className="sc-root">
      {/* On-page list of conversations (each is a support request + its chat) */}
      {!floatingOnly && (
      <div className="sc-list-panel">
        <div className="sc-list-head">
          <div>
            <h3>Support conversations</h3>
            <p className="sc-list-sub">Each is a request and its live chat. Open one to continue, or start a new chat.</p>
          </div>
          <button type="button" className="sc-page-cta" onClick={newConversation}>+ New conversation</button>
        </div>

        {sessions.length === 0 ? (
          <div className="sc-list-empty">
            <span className="sc-logo big" aria-hidden="true">TS</span>
            <p>No conversations yet. Start one with the button above, or the chat bubble in the bottom-right corner.</p>
          </div>
        ) : (
          <ul className="sc-list">
            {sessions.map((s) => {
              const det = [...s.turns].reverse().find((t) => t.audience);
              return (
                <li
                  key={s.id}
                  className={`sc-list-item ${activeIdRef.current === s.id ? 'active' : ''}`}
                  onClick={() => openSession(s)}
                >
                  <span className="sc-list-ava" aria-hidden="true">TS</span>
                  <div className="sc-list-main">
                    <div className="sc-list-top">
                      <span className="sc-list-title">{s.title || '(no message)'}</span>
                      <span className="sc-list-when">{formatWhen(s.at)}</span>
                    </div>
                    <p className="sc-list-snippet">{lastReplyOf(s.turns) || '…'}</p>
                    <div className="sc-list-tags">
                      {det?.audience && <span className="sc-list-tag">{AUDIENCE_LABELS[det.audience]}</span>}
                      {det?.channel && <span className="sc-list-tag ch">{CHANNEL_LABELS[det.channel]}</span>}
                      <span className="sc-list-count">{s.turns.length} message{s.turns.length === 1 ? '' : 's'}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="sc-list-del"
                    onClick={(e) => deleteSession(s.id, e)}
                    aria-label="Delete conversation"
                    title="Delete conversation"
                  >
                    🗑
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      )}

      <div className={`sc-widget ${open ? 'open' : ''}`} role="dialog" aria-label="TSBA support chat" aria-hidden={!open}>
        <div className="sc">
          {/* Header — a chat-bot widget identity bar */}
          <div className="sc-head">
            <div className="sc-ident">
              <span className="sc-logo" aria-hidden="true">TS</span>
              <div className="sc-ident-text">
                <span className="sc-ident-name">TSBA Technical Support</span>
                <span className="sc-ident-status">
                  <span className="sc-online" aria-hidden="true" /> Online · typically replies instantly
                </span>
              </div>
            </div>
            <div className="sc-head-actions">
              <button
                type="button"
                className="sc-head-btn"
                onClick={newConversation}
                disabled={thinking}
                title="Start a new conversation"
                aria-label="New chat"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" />
                </svg>
              </button>
              <button
                type="button"
                className="sc-head-btn"
                onClick={() => setOpen(false)}
                title="Minimise chat"
                aria-label="Minimise chat"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" aria-hidden="true">
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Auto-detected source + audience override */}
          <div className="sc-subbar">
            <span className="sc-source" title="The agent auto-detects who's asking and the channel from each message.">
              {lastDetected?.audience ? (
                <>
                  <span className="sc-source-k">Detected</span>
                  <b>{AUDIENCE_LABELS[lastDetected.audience]}</b>
                  {lastDetected.channel ? <span className="sc-source-ch">{CHANNEL_LABELS[lastDetected.channel]}</span> : null}
                </>
              ) : (
                <>
                  <span className="sc-source-dot" aria-hidden="true" /> Auto-detecting source
                </>
              )}
            </span>
            <select
              className="sc-override"
              aria-label="Audience"
              value={override}
              onChange={(e) => setOverride(e.target.value as Audience | 'auto')}
              title="Force an audience instead of auto-detecting it."
            >
              {OVERRIDES.map((o) => (
                <option key={o} value={o}>
                  {o === 'auto' ? 'Auto audience' : AUDIENCE_LABELS[o]}
                </option>
              ))}
            </select>
          </div>

      {/* Conversation thread */}
      <div className="sc-thread" ref={threadRef}>
        {turns.length === 0 && !thinking && (
          <div className="sc-welcome">
            <span className="sc-logo big" aria-hidden="true">TS</span>
            <p className="sc-welcome-lead">Hi there 👋</p>
            <p className="sc-welcome-sub">
              Ask your solar, battery or inverter question and I’ll answer right away.
            </p>
            {starters.length > 0 && (
              <div className="sc-welcome-chips">
                <span className="sc-welcome-chips-k">Try asking</span>
                {starters.map((p) => (
                  <button key={p} type="button" className="sc-welcome-chip" onClick={() => void ask(p)}>{p}</button>
                ))}
              </div>
            )}
          </div>
        )}

        {turns.map((t) => (
          <div key={t.id} className="sc-turn">
            {/* User message, right-aligned */}
            <div className="sc-row user">
              <div className="sc-bubble user">
                <p>{t.question}</p>
                {t.attachments && t.attachments.length > 0 && (
                  <div className="sc-atts">
                    {t.attachments.map((name, i) => (
                      <span key={i} className="sc-att" title={name}>📎 {name}</span>
                    ))}
                  </div>
                )}
              </div>
              {t.at && <span className="sc-time user">{formatTime(t.at)}</span>}
            </div>

            {/* Agent reply, left-aligned with avatar */}
            <div className="sc-row agent">
              <span className="sc-ava" aria-hidden="true">TS</span>
              <div className="sc-agent-col">
                {t.pending ? (
                  <div className="sc-bubble agent typing">
                    <span className="sc-dot" /><span className="sc-dot" /><span className="sc-dot" />
                  </div>
                ) : (
                  <>
                    <div className="sc-bubble agent">
                      <p className="sc-reply"><ReplyText text={t.reply} /></p>
                    </div>
                    <div className="sc-meta">
                      <button type="button" className="sc-meta-btn" onClick={() => void copyReply(t)}>
                        {copiedId === t.id ? '✓ Copied' : 'Copy'}
                      </button>
                      <button
                        type="button"
                        className="sc-meta-btn flag"
                        onClick={() => void flagAnswer(t)}
                        disabled={flagged[t.id] === 'pending' || flagged[t.id] === 'done'}
                      >
                        {flagged[t.id] === 'done'
                          ? '✓ Flagged for team'
                          : flagged[t.id] === 'pending'
                            ? 'Flagging…'
                            : '⚑ Flag for team'}
                      </button>
                    </div>
                    {flagged[t.id] === 'error' && (
                      <span className="err" role="status">Couldn’t flag that — please try again.</span>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Quick replies */}
      {attachments.length > 0 && (
        <div className="sc-pending-atts">
          {attachments.map((a, i) => (
            <span key={i} className="sc-pending-att" title={a.name}>
              <span aria-hidden="true">{a.mediaType === 'application/pdf' ? '📄' : '🖼️'}</span>
              <span className="sc-pending-att-name">{a.name}</span>
              <button type="button" onClick={() => removeAttachment(i)} aria-label={`Remove ${a.name}`} disabled={thinking}>✕</button>
            </span>
          ))}
        </div>
      )}

      {error && <span className="err sc-err" role="status">{error}</span>}

      {/* Composer */}
      <form
        className="sc-composer"
        onSubmit={(e) => {
          e.preventDefault();
          const q = typed;
          setTyped('');
          void ask(q);
        }}
      >
        <input ref={fileInputRef} type="file" accept={ACCEPT_TYPES} multiple hidden onChange={(e) => void addFiles(e.target.files)} />
        <div className="sc-inbar">
          <button
            type="button"
            className="sc-attach"
            onClick={() => fileInputRef.current?.click()}
            disabled={thinking || attachments.length >= MAX_ATTACHMENTS}
            aria-label="Attach files"
            title="Attach images or PDFs"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21.44 11.05 12 20.5a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a1.5 1.5 0 0 1-2.12-2.12l8.49-8.49" />
            </svg>
          </button>
          <textarea
            ref={taRef}
            className="sc-input"
            rows={1}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={onComposerKey}
            placeholder="Type your message…"
            disabled={thinking}
            aria-label="Type a message to the agent"
          />
        </div>
        <button
          className="sc-send"
          type="submit"
          disabled={thinking || (!typed.trim() && attachments.length === 0)}
          aria-label={thinking ? 'Sending' : 'Send message'}
          title="Send"
        >
          {thinking ? (
            <span className="spin" aria-hidden="true" />
          ) : (
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          )}
        </button>
      </form>
        </div>
      </div>

      {/* Greeting teaser, shown beside the bubble while the chat is closed */}
      {!open && turns.length === 0 && (
        <button type="button" className="sc-teaser" onClick={() => setOpen(true)}>
          <span className="sc-teaser-x" aria-hidden="true">Hi 👋 Need a hand? Ask me anything.</span>
        </button>
      )}

      {/* Floating bot bubble launcher */}
      <button
        type="button"
        className={`sc-launcher ${open ? 'open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? 'Close support chat' : 'Open support chat'}
        aria-expanded={open}
      >
        {open ? (
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true">
            <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="4" y="7" width="16" height="12" rx="3" />
            <path d="M12 7V4" /><circle cx="12" cy="3" r="1" />
            <circle cx="9" cy="13" r="1.2" fill="currentColor" stroke="none" />
            <circle cx="15" cy="13" r="1.2" fill="currentColor" stroke="none" />
            <path d="M2 11v4" /><path d="M22 11v4" />
          </svg>
        )}
      </button>
    </div>
  );
}
