import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
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

// The voice picker always shows exactly these 6, on every device/browser.
// The browser only has some of them installed (the Microsoft voices are
// Windows-only, the Google ones ship with Chrome), so we render the fixed
// list regardless and resolve the real voice at speak time — falling back to
// the option's locale when that device doesn't have the exact voice.
const VOICE_OPTIONS: { name: string; lang: string }[] = [
  { name: 'Microsoft David - English (United States)', lang: 'en-US' },
  { name: 'Microsoft Mark - English (United States)', lang: 'en-US' },
  { name: 'Microsoft Zira - English (United States)', lang: 'en-US' },
  { name: 'Google US English', lang: 'en-US' },
  { name: 'Google UK English Female', lang: 'en-GB' },
  { name: 'Google UK English Male', lang: 'en-GB' },
];

const DEFAULT_VOICE = 'Google UK English Female';

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
  // Continuous hands-free mode: listen → answer → speak → listen again.
  const [handsFree, setHandsFree] = useState(false);
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceName, setVoiceName] = useState<string>(DEFAULT_VOICE);
  // Manual-entry fallback when speech recognition isn't available.
  const [typed, setTyped] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [flagged, setFlagged] = useState<Record<number, 'pending' | 'done' | 'error'>>({});
  const [copiedId, setCopiedId] = useState<number | null>(null);
  // KB-grounded opening suggestions for an empty chat (generated, not hardcoded).
  const [starters, setStarters] = useState<string[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Live mirrors of state read inside speech callbacks (which capture stale state).
  const handsFreeRef = useRef(false);
  const listeningRef = useRef(false);
  const thinkingRef = useRef(false);
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

  // Keep refs in sync for the speech-recognition / synthesis callbacks.
  useEffect(() => {
    handsFreeRef.current = handsFree;
  }, [handsFree]);
  useEffect(() => {
    listeningRef.current = listening;
  }, [listening]);
  useEffect(() => {
    thinkingRef.current = thinking;
  }, [thinking]);

  // Auto-grow the composer textarea: one line by default, expanding with content
  // (capped by max-height in CSS), and snapping back to one line when cleared.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [typed]);

  // Persist the conversation whenever it changes.
  useEffect(() => {
    try {
      localStorage.setItem(VOICE_LOG_KEY, JSON.stringify(turns));
    } catch {
      /* ignore */
    }
  }, [turns]);

  // Load the system TTS voices (populated asynchronously). We keep the full
  // installed list only to resolve the chosen voice when speaking — the picker
  // itself always shows the fixed VOICE_OPTIONS, not whatever is installed.
  useEffect(() => {
    if (!synthSupported) return;
    const load = () => {
      setVoices(window.speechSynthesis.getVoices());
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
      handsFreeRef.current = false; // stop the loop from reopening the mic
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
    if (voice) {
      u.voice = voice;
    } else {
      // This device doesn't have the selected voice installed (e.g. a Windows
      // voice on macOS) — fall back to its locale so the browser picks the
      // closest available voice instead of an unrelated default.
      u.lang = VOICE_OPTIONS.find((o) => o.name === voiceName)?.lang ?? 'en-GB';
    }
    u.rate = 1;
    u.onstart = () => setSpeakingId(turn.id);
    u.onend = () => {
      setSpeakingId((id) => (id === turn.id ? null : id));
      resumeHandsFree(); // continuous mode: start listening again after speaking
    };
    u.onerror = () => {
      setSpeakingId((id) => (id === turn.id ? null : id));
      resumeHandsFree();
    };
    window.speechSynthesis.speak(u);
  }

  function stopSpeaking() {
    if (synthSupported) window.speechSynthesis.cancel();
    setSpeakingId(null);
  }

  function clearChat() {
    stopSpeaking();
    handsFreeRef.current = false;
    setHandsFree(false);
    stopListening();
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
      if (autoSpeak && synthSupported && reply) speak({ id, question: q, reply });
      else resumeHandsFree(); // no spoken reply to wait on — resume the loop now
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
      listeningRef.current = false;
      setInterim('');
      const said = finalRef.current.trim();
      finalRef.current = '';
      if (said) void ask(said);
      else resumeHandsFree(); // heard nothing — keep the hands-free loop alive
    };

    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
      listeningRef.current = true;
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

  // ── Continuous hands-free mode ────────────────────────────────────────────
  // After each spoken reply (or when nothing was heard), automatically start
  // listening again, so it's a back-and-forth conversation, not push-to-talk.
  function resumeHandsFree() {
    if (!handsFreeRef.current || !getRecognitionCtor()) return;
    window.setTimeout(() => {
      if (handsFreeRef.current && !listeningRef.current && !thinkingRef.current) startListening();
    }, 350); // brief gap so TTS fully stops before the mic reopens
  }

  function startHandsFree() {
    if (!getRecognitionCtor()) return;
    handsFreeRef.current = true;
    setHandsFree(true);
    if (synthSupported) setAutoSpeak(true); // the loop reads replies aloud
    startListening();
  }

  function stopHandsFree() {
    handsFreeRef.current = false;
    setHandsFree(false);
    stopListening();
    stopSpeaking();
  }

  function toggleHandsFree() {
    if (handsFree) stopHandsFree();
    else startHandsFree();
  }

  // Enter sends; Shift+Enter inserts a newline (matches the reference composer).
  function onComposerKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (thinking) return;
      const q = typed;
      setTyped('');
      void ask(q);
    }
  }

  return (
    <div className="voice-page full">
      {/* ── Conversation (agentic chat, full-width) ──────────────────────── */}
      <section className="card voice-log-card jchat voice-full">
        <div className="voice-head">
          {/* Controls (who's asking + voice) + chat actions on one row. */}
          <div className="voice-head-right">
          <div className="voice-head-controls">
            <div className="seg" role="group" aria-label="Who's asking">
              {AUDIENCES.map((a) => (
                <button key={a} type="button" aria-pressed={audience === a} onClick={() => setAudience(a)}>
                  {AUDIENCE_LABELS[a]}
                </button>
              ))}
            </div>

            {synthSupported && (
              <select
                className="voice-select"
                aria-label="Voice"
                value={voiceName}
                onChange={(e) => setVoiceName(e.target.value)}
              >
                {VOICE_OPTIONS.map((o) => (
                  <option key={o.name} value={o.name}>
                    {o.name} ({o.lang})
                  </option>
                ))}
              </select>
            )}

            {synthSupported && (
              <label className="voice-toggle">
                <input type="checkbox" checked={autoSpeak} onChange={(e) => setAutoSpeak(e.target.checked)} />
                <span>Speak aloud</span>
              </label>
            )}
          </div>

          <div className="voice-head-actions">
            {recognitionSupported && (
              <button
                className={`jbtn-ghost hands-free-btn ${handsFree ? 'on' : ''}`}
                type="button"
                onClick={toggleHandsFree}
                aria-pressed={handsFree}
                title={
                  handsFree
                    ? 'Stop the hands-free voice conversation'
                    : 'Start a hands-free voice conversation (speak, listen, repeat)'
                }
              >
                {handsFree ? (
                  <>
                    <span className="hf-dot" aria-hidden="true" /> Stop hands-free
                  </>
                ) : (
                  <>🎙 Hands-free</>
                )}
              </button>
            )}
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

        {(listening || interim) && (
          <div className="composer-listening" aria-live="polite">
            <span className="listening-dot" aria-hidden="true" />
            <span>{interim || 'Listening…'}</span>
          </div>
        )}
        {error && (
          <span className="err" role="status" style={{ marginTop: 10 }}>
            {error}
          </span>
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
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
              strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <textarea
            ref={taRef}
            className="voice-input"
            rows={1}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={onComposerKey}
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
        <p className="composer-hint">Enter to send · Shift+Enter for a new line</p>
      </section>
    </div>
  );
}
