import { useEffect, useRef, useState } from 'react';
import { AUDIENCES, AUDIENCE_LABELS, type Audience } from '@tsba/shared';
import { ApiError, AuthError, voiceChat, type VoiceChatMessage } from '../api';

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
  question: string;
  reply: string;
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
        typeof (t as Turn).reply === 'string',
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

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const finalRef = useRef('');
  const logRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(turns.reduce((m, t) => Math.max(m, t.id), 0) + 1);

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
    nextId.current = 1;
  }

  async function ask(questionText: string) {
    const q = questionText.trim();
    if (!q) return;
    setError('');
    setThinking(true);
    // Send the running conversation so replies stay in context.
    const history: VoiceChatMessage[] = [];
    for (const t of turns) {
      history.push({ role: 'user', content: t.question });
      history.push({ role: 'assistant', content: t.reply });
    }
    history.push({ role: 'user', content: q });
    try {
      const { reply } = await voiceChat(history, audience);
      const turn: Turn = { id: nextId.current++, question: q, reply };
      setTurns((prev) => [...prev, turn]);
      if (autoSpeak) speak(turn);
    } catch (err) {
      if (err instanceof AuthError) return onAuthError();
      if (err instanceof ApiError && err.code === 'chat_failed') {
        setError('The agent couldn’t answer that just now. Please try again.');
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

      {/* ── Conversation ─────────────────────────────────────────────────── */}
      <section className="card voice-log-card">
        <div className="card-h">
          <h2>Conversation</h2>
          <div className="drive-selall">
            {speakingId != null && (
              <button className="btn ghost sm" type="button" onClick={stopSpeaking}>
                ■ Stop speaking
              </button>
            )}
            {turns.length > 0 && (
              <button className="btn ghost sm" type="button" onClick={clearChat} disabled={thinking}>
                Clear
              </button>
            )}
          </div>
        </div>

        <div className="voice-log" ref={logRef}>
          {turns.length === 0 && !thinking && (
            <p className="how">No questions yet. Ask the agent something to get started.</p>
          )}

          {turns.map((t) => (
            <div key={t.id} className="voice-turn">
              <div className="bubble user">
                <span className="bubble-who">You</span>
                <p>{t.question}</p>
              </div>

              <div className="bubble agent">
                <div className="bubble-top">
                  <span className="bubble-who">Agent</span>
                  {synthSupported && (
                    <button
                      type="button"
                      className="speak-btn"
                      onClick={() => (speakingId === t.id ? stopSpeaking() : speak(t))}
                      aria-label={speakingId === t.id ? 'Stop' : 'Play reply'}
                      title={speakingId === t.id ? 'Stop' : 'Play reply'}
                    >
                      {speakingId === t.id ? '■' : '▶'}
                    </button>
                  )}
                </div>
                <p>{t.reply}</p>
              </div>
            </div>
          ))}

          {thinking && (
            <div className="thinking">
              <span className="spin" aria-hidden="true" />
              <span>Reading TSBA&rsquo;s knowledge and answering…</span>
            </div>
          )}
        </div>

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
            className="voice-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Type a message…"
            disabled={thinking}
            aria-label="Type a message to the agent"
          />
          <button className="btn" type="submit" disabled={thinking || !typed.trim()}>
            {thinking ? 'Sending…' : 'Send'}
          </button>
        </form>
      </section>
    </div>
  );
}
