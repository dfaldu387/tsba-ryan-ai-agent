import { useEffect, useRef, useState } from 'react';
import { AUDIENCES, AUDIENCE_LABELS, type Audience, type SourceCard } from '@tsba/shared';
import {
  ApiError,
  AuthError,
  flagVoiceAnswer,
  getVoiceStarters,
  voiceChat,
  type VoiceAttachment,
  type VoiceChatMessage,
} from '../api';
import { ApprovalCard } from './ApprovalCard';

// Files the agent can read: images (vision) and PDFs (document input).
const ACCEPT_TYPES = 'image/png,image/jpeg,image/gif,image/webp,application/pdf';
const ALLOWED_MEDIA = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 20_000_000; // ~20MB per file

interface Attachment extends VoiceAttachment {
  name: string;
  size: number;
}

/** Read a File into a base64 string (without the data: prefix). */
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

// ─── Voice Agent ──────────────────────────────────────────────────────────────
// A hands-free console: speak a question (Web Speech API → speech-to-text), the
// grounded draft pipeline answers it, and the reply is read back aloud (speech
// synthesis). Everything stays in the browser except the draft call itself, so
// no new server surface and no audio ever leaves the device.

// Minimal typings for the vendor-prefixed SpeechRecognition (not in lib.dom).
interface SpeechRecognitionResultLike {
  0: { transcript: string };
  isFinal: boolean;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [i: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

interface Turn {
  id: number;
  type?: 'qa' | 'approvals';
  question: string;
  reply: string;
  sources?: SourceCard[];
  attachments?: string[];
  at?: string; // ISO timestamp
  pending?: boolean; // awaiting the agent's reply
  suggestions?: string[]; // follow-ups generated from this answer
}

// The approvals chip is special: it renders a live approval card instead of
// asking the model. Starter and follow-up suggestions are generated, not fixed.
const APPROVALS_PROMPT = 'What needs my approval?';

function formatTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Persist the conversation so it survives tab switches and reloads.
const VOICE_LOG_KEY = 'tsba.voice.turns';

function loadTurns(): Turn[] {
  try {
    const raw = localStorage.getItem(VOICE_LOG_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is Turn =>
        Boolean(t) &&
        typeof (t as Turn).id === 'number' &&
        typeof (t as Turn).question === 'string' &&
        typeof (t as Turn).reply === 'string' &&
        (t as Turn).reply !== '' && // drop incomplete (pending) turns
        (t as Turn).type !== 'approvals', // live cards aren't restored
    );
  } catch {
    return [];
  }
}

export function VoiceAgent({ onAuthError }: { onAuthError: () => void }) {
  const recognitionSupported = Boolean(getRecognitionCtor());
  const synthSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

  const [audience, setAudience] = useState<Audience>('installer');
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState('');
  const [turns, setTurns] = useState<Turn[]>(loadTurns);
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceName, setVoiceName] = useState<string>('');
  // Manual-entry fallback when speech recognition isn't available.
  const [typed, setTyped] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [flagged, setFlagged] = useState<Record<number, 'pending' | 'done' | 'error'>>({});
  const [copiedId, setCopiedId] = useState<number | null>(null);
  // KB-grounded opening suggestions for an empty chat (generated, not hardcoded).
  const [starters, setStarters] = useState<string[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const finalRef = useRef('');
  const logRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(turns.reduce((m, t) => Math.max(m, t.id), 0) + 1);

  // Fetch KB-grounded opening suggestions once, for the empty-chat state.
  useEffect(() => {
    let alive = true;
    getVoiceStarters()
      .then((r) => alive && setStarters(Array.isArray(r.suggestions) ? r.suggestions : []))
      .catch(() => {
        /* best-effort — no chips if it fails */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Persist the conversation whenever it changes.
  useEffect(() => {
    try {
      localStorage.setItem(VOICE_LOG_KEY, JSON.stringify(turns));
    } catch {
      /* ignore */
    }
  }, [turns]);

  // Load the list of system TTS voices (populated asynchronously).
  useEffect(() => {
    if (!synthSupported) return;
    const load = () => {
      const all = window.speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
      setVoices(all);
      setVoiceName((cur) => cur || all.find((v) => /AU|GB/.test(v.lang))?.name || all[0]?.name || '');
    };
    load();
    window.speechSynthesis.onvoiceschanged = load;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, [synthSupported]);

  // Keep the conversation scrolled to the latest turn.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, thinking]);

  // Stop everything on unmount.
  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.abort();
      } catch {
        /* ignore */
      }
      if (synthSupported) window.speechSynthesis.cancel();
    };
  }, [synthSupported]);

  function speak(turn: Turn) {
    if (!synthSupported || !turn.reply) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(turn.reply);
    const voice = voices.find((v) => v.name === voiceName);
    if (voice) u.voice = voice;
    u.rate = 1;
    u.onstart = () => setSpeakingId(turn.id);
    u.onend = () => setSpeakingId((id) => (id === turn.id ? null : id));
    u.onerror = () => setSpeakingId((id) => (id === turn.id ? null : id));
    window.speechSynthesis.speak(u);
  }

  function stopSpeaking() {
    if (synthSupported) window.speechSynthesis.cancel();
    setSpeakingId(null);
  }

  function clearChat() {
    stopSpeaking();
    setTurns([]);
    setAttachments([]);
    nextId.current = 1;
  }

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

  // Render a live "awaiting approval" card as its own turn (no model call).
  function showApprovals() {
    setTurns((prev) => [
      ...prev,
      {
        id: nextId.current++,
        type: 'approvals',
        question: APPROVALS_PROMPT,
        reply: 'Here’s what’s waiting on you right now.',
        at: new Date().toISOString(),
      },
    ]);
  }

  function handleStarter(prompt: string) {
    if (prompt === APPROVALS_PROMPT) showApprovals();
    else void ask(prompt);
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
      await flagVoiceAnswer(turn.question, turn.reply, audience);
      setFlagged((f) => ({ ...f, [turn.id]: 'done' }));
    } catch (err) {
      if (err instanceof AuthError) return onAuthError();
      setFlagged((f) => ({ ...f, [turn.id]: 'error' }));
    }
  }

  async function ask(questionText: string) {
    const q = questionText.trim();
    const files = attachments;
    if (!q && !files.length) return;
    setError('');
    setAttachments([]);

    // Build the history from completed turns BEFORE we add the new one.
    const history: VoiceChatMessage[] = [];
    for (const t of turns) {
      if (t.type === 'approvals' || !t.reply) continue;
      history.push({ role: 'user', content: t.question });
      history.push({ role: 'assistant', content: t.reply });
    }
    history.push({ role: 'user', content: q || 'Please review the attached file(s).' });

    // Show the question immediately as a pending turn; fill the reply when it lands.
    const id = nextId.current++;
    setTurns((prev) => [
      ...prev,
      {
        id,
        type: 'qa',
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
      const { reply, sources, suggestions } = await voiceChat(history, audience, payload);
      setTurns((prev) =>
        prev.map((t) =>
          t.id === id
            ? { ...t, reply, sources, pending: false, suggestions: Array.isArray(suggestions) ? suggestions : [] }
            : t,
        ),
      );
      if (autoSpeak) speak({ id, question: q, reply });
    } catch (err) {
      setTurns((prev) => prev.filter((t) => t.id !== id)); // drop the pending turn
      setAttachments(files); // restore so the user doesn't lose them on a failure
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

  function startListening() {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    stopSpeaking();
    setError('');
    setInterim('');
    finalRef.current = '';

    const rec = new Ctor();
    rec.lang = 'en-AU';
    rec.continuous = false;
    rec.interimResults = true;

    rec.onresult = (e) => {
      let interimText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalRef.current += res[0].transcript;
        else interimText += res[0].transcript;
      }
      setInterim(interimText);
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setError('Microphone access was blocked. Allow it in your browser to use voice.');
      } else if (e.error !== 'aborted' && e.error !== 'no-speech') {
        setError(`Voice error: ${e.error}`);
      }
    };
    rec.onend = () => {
      setListening(false);
      setInterim('');
      const said = finalRef.current.trim();
      finalRef.current = '';
      if (said) void ask(said);
    };

    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      /* already started */
    }
  }

  function stopListening() {
    try {
      recognitionRef.current?.stop();
    } catch {
      /* ignore */
    }
  }

  function toggleMic() {
    if (listening) stopListening();
    else startListening();
  }

  return (
    <div className="voice-page">
      {/* ── Mic console ──────────────────────────────────────────────────── */}
      <section className="card voice-console">
        <div className="card-h">
          <h2>Talk to the agent</h2>
          <span className="eyebrow">Hands-free · grounded in TSBA knowledge</span>
        </div>

        <div className="voice-controls">
          <div className="field">
            <span className="eyebrow">Who&rsquo;s asking</span>
            <div className="seg" role="group" aria-label="Who's asking">
              {AUDIENCES.map((a) => (
                <button key={a} type="button" aria-pressed={audience === a} onClick={() => setAudience(a)}>
                  {AUDIENCE_LABELS[a]}
                </button>
              ))}
            </div>
          </div>

          <label className="voice-toggle">
            <input type="checkbox" checked={autoSpeak} onChange={(e) => setAutoSpeak(e.target.checked)} />
            <span>Speak replies aloud</span>
          </label>

          {synthSupported && voices.length > 0 && (
            <div className="field">
              <span className="eyebrow">Voice</span>
              <select className="voice-select" value={voiceName} onChange={(e) => setVoiceName(e.target.value)}>
                {voices.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name} ({v.lang})
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {recognitionSupported ? (
          <div className="mic-area">
            <button
              type="button"
              className={`mic-btn ${listening ? 'listening' : ''}`}
              onClick={toggleMic}
              disabled={thinking}
              aria-pressed={listening}
              aria-label={listening ? 'Stop listening' : 'Start listening'}
            >
              <svg className="mic-glyph" viewBox="0 0 24 24" width="38" height="38" fill="none"
                stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10v2a7 7 0 0 0 14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="22" />
                <line x1="8" y1="22" x2="16" y2="22" />
              </svg>
            </button>
            <p className="mic-status">
              {listening
                ? 'Listening… tap to stop'
                : thinking
                  ? 'Thinking…'
                  : 'Tap the mic to speak, or type below'}
            </p>
            {(interim || listening) && <p className="mic-interim">{interim || '…'}</p>}
          </div>
        ) : (
          <p className="how" style={{ marginTop: 8 }}>
            In-browser speech recognition isn’t available here (Chrome or Edge support it). You can
            still type your questions below{synthSupported ? ' — replies are read aloud.' : '.'}
          </p>
        )}

        {error && <span className="err" role="status">{error}</span>}
      </section>

      {/* ── Conversation (agentic chat) ──────────────────────────────────── */}
      <section className="card voice-log-card jchat">
        <div className="card-h">
          <h2>Conversation</h2>
          <div className="drive-selall">
            {speakingId != null && (
              <button className="jbtn-ghost" type="button" onClick={stopSpeaking}>
                ■ Stop speaking
              </button>
            )}
            <button
              className="jbtn-ghost"
              type="button"
              onClick={showApprovals}
              disabled={thinking}
              title="Show replies awaiting approval"
            >
              ⚑ Approvals
            </button>
            <button
              className="jbtn-ghost"
              type="button"
              onClick={clearChat}
              disabled={thinking || turns.length === 0}
              title="Start a new conversation"
            >
              + New chat
            </button>
          </div>
        </div>

        <div className="voice-log jlog" ref={logRef}>
          {turns.length === 0 && !thinking && (
            <div className="jempty">
              <div className="javatar big" aria-hidden="true">AI</div>
              <p className="jempty-lead">Good day. Ask me anything about the inverters in TSBA’s knowledge base, or say what you need.</p>
            </div>
          )}

          {turns.map((t) => (
            <div key={t.id} className="jturn">
              {t.type !== 'approvals' && (
                <div className="jmsg user">
                  <div className="jbubble user">
                    <p>{t.question}</p>
                    {t.attachments && t.attachments.length > 0 && (
                      <div className="bubble-attachments">
                        {t.attachments.map((name, i) => (
                          <span key={i} className="bubble-attachment" title={name}>📎 {name}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="jmsg agent">
                <div className="javatar" aria-hidden="true">AI</div>
                <div className="jagent-body">
                  <span className="jeyebrow">{t.type === 'approvals' ? 'Awaiting approval' : 'Agent'}</span>

                  {t.type === 'approvals' ? (
                    <ApprovalCard onAuthError={onAuthError} />
                  ) : t.pending ? (
                    <div className="thinking">
                      <span className="spin" aria-hidden="true" />
                      <span>Reading TSBA&rsquo;s knowledge and answering…</span>
                    </div>
                  ) : (
                    <>
                      <div className="jcard">
                        <p className="jreply">{t.reply}</p>
                        {t.sources && t.sources.length > 0 && (
                          <div className="jsources">
                            <span className="jsources-label">Grounded in</span>
                            <div className="jsource-chips">
                              {t.sources.map((s) => (
                                <span key={s.id} className="jsource-chip" title={s.source}>{s.title}</span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="jmeta">
                        <button type="button" className="jmeta-btn" onClick={() => void copyReply(t)}>
                          {copiedId === t.id ? '✓ Copied' : '⧉ Copy'}
                        </button>
                        {synthSupported && (
                          <button
                            type="button"
                            className="jmeta-btn"
                            onClick={() => (speakingId === t.id ? stopSpeaking() : speak(t))}
                          >
                            {speakingId === t.id ? '■ Stop' : '🔊 Listen'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="jmeta-btn flag"
                          onClick={() => void flagAnswer(t)}
                          disabled={flagged[t.id] === 'pending' || flagged[t.id] === 'done'}
                        >
                          {flagged[t.id] === 'done'
                            ? '✓ Flagged for team'
                            : flagged[t.id] === 'pending'
                              ? 'Flagging…'
                              : '⚑ Flag for team'}
                        </button>
                        {t.at && <span className="jmeta-time">{formatTime(t.at)}</span>}
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

        {/* Suggested prompts — all generated: KB-grounded starters when empty,
            follow-ups from the latest answer once the chat is going. */}
        {(() => {
          const last = [...turns].reverse().find((t) => t.type !== 'approvals' && !t.pending && t.suggestions);
          const dynamic = last?.suggestions ?? [];
          const chips = dynamic.length > 0 ? dynamic : starters;
          if (chips.length === 0) return null;
          return (
            <div className="jsuggest">
              {chips.map((p) => (
                <button key={p} type="button" className="jchip" onClick={() => handleStarter(p)} disabled={thinking}>
                  {p}
                </button>
              ))}
            </div>
          );
        })()}

        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((a, i) => (
              <span key={i} className="composer-chip" title={a.name}>
                <span className="composer-chip-ico" aria-hidden="true">
                  {a.mediaType === 'application/pdf' ? '📄' : '🖼️'}
                </span>
                <span className="composer-chip-name">{a.name}</span>
                <button
                  type="button"
                  className="composer-chip-x"
                  onClick={() => removeAttachment(i)}
                  aria-label={`Remove ${a.name}`}
                  disabled={thinking}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}

        <form
          className="voice-composer"
          onSubmit={(e) => {
            e.preventDefault();
            const q = typed;
            setTyped('');
            void ask(q);
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT_TYPES}
            multiple
            hidden
            onChange={(e) => void addFiles(e.target.files)}
          />
          <button
            type="button"
            className="composer-icon-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={thinking || attachments.length >= MAX_ATTACHMENTS}
            aria-label="Attach files"
            title="Attach images or PDFs"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
              strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <input
            className="voice-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Ask the agent anything, or say what you need…"
            disabled={thinking}
            aria-label="Type a message to the agent"
          />
          {recognitionSupported && (
            <button
              type="button"
              className={`composer-icon-btn ${listening ? 'listening' : ''}`}
              onClick={toggleMic}
              disabled={thinking}
              aria-pressed={listening}
              aria-label={listening ? 'Stop listening' : 'Speak your message'}
              title={listening ? 'Stop listening' : 'Speak'}
            >
              <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor"
                strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10v2a7 7 0 0 0 14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="22" />
                <line x1="8" y1="22" x2="16" y2="22" />
              </svg>
            </button>
          )}
          <button
            className="composer-icon-btn send"
            type="submit"
            disabled={thinking || (!typed.trim() && attachments.length === 0)}
            aria-label={thinking ? 'Sending' : 'Send message'}
            title="Send"
          >
            {thinking ? (
              <span className="spin" aria-hidden="true" />
            ) : (
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
                strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            )}
          </button>
        </form>
      </section>
    </div>
  );
}
