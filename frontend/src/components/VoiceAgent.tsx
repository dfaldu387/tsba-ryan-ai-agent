import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { AUTOMATED_RESPONSE_PREFIX, type Audience, type SourceCard } from '@tsba/shared';
import {
  ApiError,
  AuthError,
  flagVoiceAnswer,
  getVoiceStarters,
  voiceChat,
  type VoiceAttachment,
  type VoiceChatMessage,
} from '../api';
import { Drawer, Icon, Menu, type MenuItem } from '../ui';
import { useConsole } from '../lib/console';
import { ApprovalCard } from './ApprovalCard';
import './voice-agent.css';

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

// Resolve which installed voice to actually use. Prefer the exact pick, but if
// it isn't installed, fall back to a LOCAL (offline) English voice rather than a
// network/cloud voice — network voices lag before they start and clip the first
// words. Returns null only when no usable voice exists (then we set u.lang).
function pickVoice(
  voices: SpeechSynthesisVoice[],
  voiceName: string,
  lang: string,
): SpeechSynthesisVoice | null {
  const exact = voices.find((v) => v.name === voiceName);
  if (exact) return exact;
  const localSameLang = voices.find((v) => v.localService && v.lang === lang);
  if (localSameLang) return localSameLang;
  const localEnglish = voices.find((v) => v.localService && v.lang.toLowerCase().startsWith('en'));
  if (localEnglish) return localEnglish;
  return voices.find((v) => v.lang === lang) ?? null;
}

// The automated-response opener is shown on screen (in italics) but never read
// aloud — strip it from the text handed to speech synthesis.
function spokenText(reply: string): string {
  const trimmed = reply.trimStart();
  if (trimmed.startsWith(AUTOMATED_RESPONSE_PREFIX)) {
    return trimmed.slice(AUTOMATED_RESPONSE_PREFIX.length).trimStart();
  }
  return reply;
}

// Render a reply with the automated-response opener shown in italics (and not
// spoken). The rest of the reply renders as normal text.
function ReplyText({ text }: { text: string }) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith(AUTOMATED_RESPONSE_PREFIX)) {
    const rest = trimmed.slice(AUTOMATED_RESPONSE_PREFIX.length).trimStart();
    return (
      <>
        <em className="va-auto-prefix">{AUTOMATED_RESPONSE_PREFIX}</em>
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

// ─── Needs-human-review heuristic ─────────────────────────────────────────────
// There's no explicit "handover" flag on a chat reply, so infer it from the text:
// the agent says it lacks the information / defers to the team, or it answered
// without citing a single knowledge-base source.
const REVIEW_PATTERNS: RegExp[] = [
  /\b(?:don['’]t|do not|doesn['’]t|does not) have\b/i,
  /\bnot (?:in|covered (?:in|by)|included in|part of) (?:the |our |tsba['’]s )?(?:knowledge|documentation|docs|manuals?|datasheets?)/i,
  /\b(?:can['’]t|cannot|can not|unable to|couldn['’]t|could not) (?:confirm|find|verify|locate)\b/i,
  /\bno (?:information|details|data|record)\b/i,
  /\bteam will\b/i,
  /\bcontact\b/i,
  /\bnot sure\b/i,
  /\bhand(?:ed|ing)? (?:this |it )?over\b/i,
];

function needsHumanReview(t: Turn): boolean {
  if (t.type === 'approvals' || t.pending || !t.reply) return false;
  if (!t.sources || t.sources.length === 0) return true;
  const body = spokenText(t.reply);
  return REVIEW_PATTERNS.some((re) => re.test(body));
}

// Per-answer thumbs up/down. There's no feedback API, so it lives in this
// browser only, keyed by the message (timestamp + id survive reloads/archives).
const VOICE_FEEDBACK_KEY = 'tsba.voice.feedback';
type Feedback = 'up' | 'down';
const feedbackKey = (t: Turn) => `${t.at ?? ''}#${t.id}`;

function loadFeedback(): Record<string, Feedback> {
  try {
    const raw = localStorage.getItem(VOICE_FEEDBACK_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, Feedback>) : {};
  } catch {
    return {};
  }
}

function saveFeedback(map: Record<string, Feedback>): void {
  try {
    localStorage.setItem(VOICE_FEEDBACK_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

type ReviewStatus = 'pending' | 'done';
interface ReviewState {
  drafts?: ReviewStatus;
  flag?: ReviewStatus;
}

function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.9}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {on ? (
        <rect x="6" y="6" width="12" height="12" rx="2" />
      ) : (
        <>
          <path d="M11 5 6 9H2v6h4l5 4z" />
          <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />
        </>
      )}
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.9}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
    </svg>
  );
}

// Persist the conversation so it survives tab switches and reloads.
const VOICE_LOG_KEY = 'tsba.voice.turns';
// Past conversations, archived when the user starts a new chat.
const VOICE_HISTORY_KEY = 'tsba.voice.history';
const MAX_SESSIONS = 30;

/** One archived conversation shown in the history popup. */
interface ChatSession {
  id: string;
  at: string; // when it was archived (ISO)
  title: string; // first question, for the list
  turns: Turn[];
}

function loadHistory(): ChatSession[] {
  try {
    const raw = localStorage.getItem(VOICE_HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is ChatSession =>
        Boolean(s) && typeof (s as ChatSession).id === 'string' && Array.isArray((s as ChatSession).turns),
    );
  } catch {
    return [];
  }
}

function saveHistory(list: ChatSession[]): void {
  try {
    localStorage.setItem(VOICE_HISTORY_KEY, JSON.stringify(list.slice(0, MAX_SESSIONS)));
  } catch {
    /* ignore */
  }
}

function formatDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// How long a pause (ms) counts as "the speaker is finished". The browser's own
// end-of-speech detection is far more aggressive than this and cuts people off
// mid-thought, so we run recognition continuously and judge the end ourselves.
const SILENCE_MS = 2500;

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

// Default to a LOCAL (offline) voice so playback starts instantly with no clip.
// Network voices (Google *) lag and swallow opening words; users can still pick
// one from the dropdown, and pickVoice() falls back to any local voice if this
// exact one isn't installed.
const DEFAULT_VOICE = 'Microsoft Zira - English (United States)';

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

  // Fixed audience for the voice agent (the picker was removed from the UI).
  const [audience] = useState<Audience>('installer');
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
  // Per-answer "Send to drafts" / "Flag for team" progress, keyed by message.
  const [review, setReview] = useState<Record<string, ReviewState>>({});
  // Which answer has its inline "Flag for team" note form open, and the note.
  const [flagFormId, setFlagFormId] = useState<string | null>(null);
  const [flagNote, setFlagNote] = useState('');
  const [feedback, setFeedback] = useState<Record<string, Feedback>>(loadFeedback);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const { toast, navigate, upsertDraft } = useConsole();
  const uid = useId();
  // KB-grounded opening suggestions for an empty chat (generated, not hardcoded).
  const [starters, setStarters] = useState<string[]>([]);
  // Past conversations + the history popup.
  const [history, setHistory] = useState<ChatSession[]>(loadHistory);
  const [showHistory, setShowHistory] = useState(false);
  const [viewing, setViewing] = useState<ChatSession | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Live mirrors of state read inside speech callbacks (which capture stale state).
  const handsFreeRef = useRef(false);
  const listeningRef = useRef(false);
  const thinkingRef = useRef(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const finalRef = useRef('');
  // The latest not-yet-finalized words. Kept so that if the mic stops before the
  // browser finalises them, we don't lose the tail of what was said.
  const interimRef = useRef('');
  // Bumped on every speak()/stopSpeaking() so a delayed start can tell whether
  // it's still the current one (guards the settle delay below).
  const speakSeqRef = useRef(0);
  // Keep-alive interval: Chrome stops speaking a long utterance after ~15s, so
  // we nudge it periodically to read the whole reply. Cleared when speech stops.
  const keepAliveRef = useRef<number | null>(null);
  // Whether we still intend the mic to be open. The browser ends a recognition
  // session on its own (short silence, or an internal time cap); while this is
  // true we transparently reopen it so one logical "listen" spans those gaps.
  const wantListeningRef = useRef(false);
  // Pending end-of-speech commit; reset on every new word, fires after SILENCE_MS.
  const silenceTimerRef = useRef<number | null>(null);
  const firstScrollRef = useRef(true);
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

  // Keep the latest turn in view. The PAGE scrolls (no nested scroll area), so
  // scroll the window to the end; the composer is sticky at the bottom.
  useEffect(() => {
    if (turns.length === 0) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const behavior: ScrollBehavior = firstScrollRef.current || reduce ? 'auto' : 'smooth';
    firstScrollRef.current = false;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
  }, [turns.length, thinking]);

  // Stop everything on unmount.
  useEffect(() => {
    return () => {
      handsFreeRef.current = false; // stop the loop from reopening the mic
      wantListeningRef.current = false; // and stop onend from restarting it
      if (silenceTimerRef.current != null) window.clearTimeout(silenceTimerRef.current);
      speakSeqRef.current++; // invalidate any pending delayed speak
      if (keepAliveRef.current != null) window.clearInterval(keepAliveRef.current);
      try {
        recognitionRef.current?.abort();
      } catch {
        /* ignore */
      }
      if (synthSupported) window.speechSynthesis.cancel();
    };
  }, [synthSupported]);

  // Keep speech alive past Chrome's ~15s single-utterance cutoff by nudging it
  // before the timer trips, so the WHOLE reply is read. Only matters for long
  // replies; short ones finish before the first nudge.
  function startKeepAlive() {
    stopKeepAlive();
    keepAliveRef.current = window.setInterval(() => {
      if (!window.speechSynthesis.speaking) {
        stopKeepAlive();
        return;
      }
      window.speechSynthesis.pause();
      window.speechSynthesis.resume();
    }, 9000);
  }
  function stopKeepAlive() {
    if (keepAliveRef.current != null) {
      window.clearInterval(keepAliveRef.current);
      keepAliveRef.current = null;
    }
  }

  function speak(turn: Turn) {
    if (!synthSupported || !turn.reply) return;
    const seq = ++speakSeqRef.current; // mark this as the current speak request
    window.speechSynthesis.cancel();
    stopKeepAlive();
    // Read everything except the automated-response opener (shown, not spoken).
    const toSpeak = spokenText(turn.reply);
    if (!toSpeak) {
      resumeHandsFree(); // nothing to say — keep the hands-free loop alive
      return;
    }

    const fallbackLang = VOICE_OPTIONS.find((o) => o.name === voiceName)?.lang ?? 'en-GB';
    const voice = pickVoice(voices, voiceName, fallbackLang);
    // Speak the reply as ONE utterance: no chunk boundaries to slur/clip words,
    // and no multi-utterance chain that can stall if Chrome skips an onend — so
    // the full response is always read, smoothly and in order. The keep-alive
    // below handles the only downside (Chrome's long-utterance cutoff).
    const u = new SpeechSynthesisUtterance(toSpeak);
    if (voice) u.voice = voice;
    else u.lang = fallbackLang;
    u.rate = 1;
    u.onstart = () => setSpeakingId(turn.id);
    const finish = () => {
      stopKeepAlive();
      setSpeakingId((id) => (id === turn.id ? null : id));
      resumeHandsFree(); // continuous mode: start listening again after speaking
    };
    u.onend = finish;
    u.onerror = finish;

    // Short settle delay so Chrome doesn't clip the first word after cancel().
    window.setTimeout(() => {
      if (seq !== speakSeqRef.current) return; // superseded by a newer speak/stop
      // Prime the engine with a SILENT warm-up utterance first. Network voices
      // (e.g. Google) have start-up latency, so Chrome begins the real utterance
      // before audio is ready and swallows the opening words. The warm-up absorbs
      // that start-up so the real reply begins cleanly ("There are…", not "are…").
      const warm = new SpeechSynthesisUtterance('.');
      if (voice) warm.voice = voice;
      else warm.lang = fallbackLang;
      warm.volume = 0; // inaudible
      window.speechSynthesis.speak(warm);
      window.speechSynthesis.speak(u);
      startKeepAlive();
    }, 60);
  }

  function stopSpeaking() {
    speakSeqRef.current++; // cancel any pending delayed speak
    stopKeepAlive();
    if (synthSupported) window.speechSynthesis.cancel();
    setSpeakingId(null);
  }

  // Archive the current conversation to history (so "New chat" doesn't lose it).
  function archiveCurrent() {
    const done = turns.filter((t) => t.type !== 'approvals' && t.reply);
    if (done.length === 0) return;
    const session: ChatSession = {
      id: `s${Date.now()}`,
      at: new Date().toISOString(),
      title: done[0].question.slice(0, 80),
      turns: done,
    };
    setHistory((prev) => {
      const next = [session, ...prev].slice(0, MAX_SESSIONS);
      saveHistory(next);
      return next;
    });
  }

  function clearChat() {
    stopSpeaking();
    handsFreeRef.current = false;
    setHandsFree(false);
    stopListening();
    archiveCurrent();
    setTurns([]);
    setAttachments([]);
    nextId.current = 1;
  }

  // Re-open a past conversation as the active chat so it can be continued.
  // Archives whatever is currently open first, and removes the session from the
  // list so it isn't duplicated (it re-archives on the next New chat / clear).
  function resumeSession(s: ChatSession) {
    stopSpeaking();
    handsFreeRef.current = false;
    setHandsFree(false);
    stopListening();
    archiveCurrent();
    setTurns(s.turns);
    nextId.current = s.turns.reduce((m, t) => Math.max(m, t.id), 0) + 1;
    setAttachments([]);
    setHistory((prev) => {
      const next = prev.filter((x) => x.id !== s.id);
      saveHistory(next);
      return next;
    });
    setViewing(null);
    setShowHistory(false);
  }

  function deleteSession(id: string) {
    setHistory((prev) => {
      const next = prev.filter((s) => s.id !== id);
      saveHistory(next);
      return next;
    });
    setViewing((v) => (v?.id === id ? null : v));
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
      window.setTimeout(() => setCopiedId((id) => (id === turn.id ? null : id)), 2000);
      toast({ text: 'Answer copied to the clipboard', tone: 'success' });
    } catch {
      toast({ text: 'Couldn’t copy to the clipboard', tone: 'danger' });
    }
  }

  function rate(turn: Turn, value: Feedback) {
    const key = feedbackKey(turn);
    const clearing = feedback[key] === value;
    setFeedback((prev) => {
      const next = { ...prev };
      if (clearing) delete next[key];
      else next[key] = value;
      saveFeedback(next);
      return next;
    });
    if (!clearing) toast({ text: 'Thanks for the feedback', tone: 'success' });
  }

  function setReviewStatus(id: string, kind: keyof ReviewState, status: ReviewStatus | undefined) {
    setReview((r) => ({ ...r, [id]: { ...r[id], [kind]: status } }));
  }

  // Both actions create a team-review draft in Drafts & approvals — the only
  // "send to drafts / flag" endpoint. They differ in the note attached.
  async function submitForReview(turn: Turn, kind: keyof ReviewState, note: string) {
    setReviewStatus(feedbackKey(turn), kind, 'pending');
    try {
      const draft = await flagVoiceAnswer(turn.question, turn.reply, audience, note);
      upsertDraft(draft);
      setReviewStatus(feedbackKey(turn), kind, 'done');
      toast({
        text: kind === 'drafts' ? 'Sent to Drafts & approvals' : 'Flagged for team review',
        tone: 'success',
        action: { label: 'Open drafts', run: () => navigate('drafts') },
      });
      return true;
    } catch (err) {
      setReviewStatus(feedbackKey(turn), kind, undefined);
      if (err instanceof AuthError) {
        onAuthError();
        return false;
      }
      toast({
        text: kind === 'drafts' ? 'Couldn’t send that to drafts — please try again' : 'Couldn’t flag that — please try again',
        tone: 'danger',
      });
      return false;
    }
  }

  function sendToDrafts(turn: Turn) {
    void submitForReview(turn, 'drafts', 'Sent to drafts from chat');
  }

  function openFlagForm(turn: Turn) {
    setFlagNote('');
    setFlagFormId(feedbackKey(turn));
  }

  async function submitFlag(turn: Turn) {
    const extra = flagNote.trim();
    const note = extra ? `Flagged for team from chat: ${extra}` : 'Flagged for team from chat';
    const ok = await submitForReview(turn, 'flag', note);
    if (ok) {
      setFlagFormId(null);
      setFlagNote('');
    }
  }

  const closeHistory = useCallback(() => setShowHistory(false), []);
  const closeSettings = useCallback(() => setShowSettings(false), []);

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
      // A recoverable error shouldn't break the hands-free loop — keep the mic
      // open so the user can just try again by speaking, without re-arming it.
      resumeHandsFree();
    } finally {
      setThinking(false);
    }
  }

  function clearSilenceTimer() {
    if (silenceTimerRef.current != null) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }

  // The speaker has gone quiet long enough — treat the utterance as finished and
  // close the mic so onend can hand the transcript off to the agent.
  function armSilenceTimer() {
    clearSilenceTimer();
    silenceTimerRef.current = window.setTimeout(() => {
      wantListeningRef.current = false; // a real stop — don't auto-reopen
      try {
        recognitionRef.current?.stop();
      } catch {
        /* ignore */
      }
    }, SILENCE_MS);
  }

  function startListening() {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    stopSpeaking();
    setError('');
    setInterim('');
    finalRef.current = '';
    interimRef.current = '';
    clearSilenceTimer();
    wantListeningRef.current = true;

    const rec = new Ctor();
    rec.lang = 'en-AU';
    // Continuous: a brief pause no longer ends the session, so the speaker can
    // breathe mid-sentence. We decide when they're actually done (armSilenceTimer).
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (e) => {
      let interimText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalRef.current += res[0].transcript;
        else interimText += res[0].transcript;
      }
      interimRef.current = interimText; // remember the tail in case the mic stops
      setInterim(interimText);
      armSilenceTimer(); // reset the end-of-speech countdown on every word
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        wantListeningRef.current = false; // fatal — stop trying to reopen
        setError('Microphone access was blocked. Allow it in your browser to use voice.');
      } else if (e.error !== 'aborted' && e.error !== 'no-speech') {
        setError(`Voice error: ${e.error}`);
      }
      // 'no-speech' / 'aborted' are expected when the browser closes an idle
      // session; onend then reopens it while wantListeningRef is still true.
    };
    rec.onend = () => {
      // The browser ended the session. If we still intend to be listening (the
      // user hasn't paused long enough to commit), reopen it so the mic doesn't
      // close out from under a slow or mid-sentence speaker.
      if (wantListeningRef.current) {
        try {
          rec.start();
          return;
        } catch {
          /* fall through to finalize if it can't restart */
        }
      }
      clearSilenceTimer();
      setListening(false);
      listeningRef.current = false;
      setInterim('');
      // Combine finalised text with any trailing interim words the browser
      // hadn't finalised yet, so the end of a sentence isn't cut off.
      const said = `${finalRef.current} ${interimRef.current}`.trim();
      finalRef.current = '';
      interimRef.current = '';
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
    wantListeningRef.current = false; // user-initiated stop — don't auto-reopen
    clearSilenceTimer();
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
    // Keep retrying until the agent is idle, so the loop never gets stuck
    // "paused" if it's still thinking or speaking when the first check runs.
    let tries = 0;
    const tryStart = () => {
      if (!handsFreeRef.current) return; // hands-free was turned off
      if (listeningRef.current) return; // already listening again
      const busy =
        thinkingRef.current || (synthSupported && window.speechSynthesis.speaking);
      if (busy) {
        if (tries++ < 40) window.setTimeout(tryStart, 250); // ~10s of retries
        return;
      }
      startListening();
    };
    window.setTimeout(tryStart, 300); // brief gap so TTS fully stops before the mic reopens
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


  function submitComposer() {
    if (thinking) return;
    const q = typed;
    setTyped('');
    void ask(q);
  }

  const isEmpty = turns.length === 0;
  // Follow-up suggestions are only offered under the most recent answer.
  const lastAnswered = [...turns].reverse().find((t) => t.type !== 'approvals' && !t.pending && t.reply);
  const followUps = lastAnswered?.suggestions ?? [];

  // Everything that used to crowd the toolbar lives in ONE overflow menu.
  const menuItems: (MenuItem | 'sep')[] = [];
  if (recognitionSupported) {
    menuItems.push({
      label: handsFree ? 'Stop hands-free conversation' : 'Start hands-free conversation',
      icon: 'voice',
      hint: handsFree ? 'On' : undefined,
      onSelect: toggleHandsFree,
    });
  }
  if (synthSupported) {
    menuItems.push({
      label: 'Read replies aloud',
      icon: 'bell',
      hint: autoSpeak ? 'On' : 'Off',
      onSelect: () => setAutoSpeak(!autoSpeak),
    });
    menuItems.push({ label: 'Voice settings…', icon: 'settings', onSelect: () => setShowSettings(true) });
  }
  menuItems.push({
    label: 'Conversation history',
    icon: 'clock',
    hint: history.length > 0 ? String(history.length) : undefined,
    onSelect: () => {
      setViewing(null);
      setShowHistory(true);
    },
  });
  menuItems.push('sep');
  menuItems.push({ label: APPROVALS_PROMPT, icon: 'inbox', onSelect: showApprovals, disabled: thinking });

  return (
    <div className="va">
      {/* ── Slim toolbar: status on the left, New chat + overflow on the right ── */}
      <header className="va-bar">
        <div className="va-bar-status">
          {handsFree ? (
            <span className="c-pill t-brand">
              <span className="va-live-dot" aria-hidden="true" />
              Hands-free on
            </span>
          ) : (
            <span className="va-bar-hint">Grounded in TSBA manuals, warranties and datasheets</span>
          )}
          {speakingId != null && (
            <button type="button" className="c-btn sm" onClick={stopSpeaking}>
              <SpeakerIcon on />
              Stop speaking
            </button>
          )}
        </div>
        <div className="va-bar-actions">
          {handsFree && (
            <button type="button" className="c-btn sm" onClick={stopHandsFree}>
              Stop hands-free
            </button>
          )}
          <button
            type="button"
            className="c-btn sm"
            onClick={clearChat}
            disabled={thinking || isEmpty}
            title="Archive this conversation and start a new one"
          >
            <Icon name="plus" size={16} />
            New chat
          </button>
          <Menu label="Chat options" items={menuItems} />
        </div>
      </header>

      {/* ── Empty state: starter questions only when there's no conversation ── */}
      {isEmpty && !thinking && (
        <section className="va-empty" aria-labelledby={`${uid}-empty`}>
          <span className="va-empty-ico" aria-hidden="true">
            <Icon name="ai" size={22} />
          </span>
          <h2 id={`${uid}-empty`}>Ask about TSBA’s products</h2>
          <p>
            Answers come from TSBA’s manuals, warranties and datasheets. Type a question, attach a photo or
            PDF{recognitionSupported ? ', or tap the mic to speak' : ''}.
          </p>
          {starters.length > 0 && (
            <>
              <h3 className="va-empty-sub">Try asking</h3>
              <ul className="va-starters">
                {starters.map((p) => (
                  <li key={p}>
                    <button type="button" className="va-starter" onClick={() => handleStarter(p)} disabled={thinking}>
                      <span>{p}</span>
                      <Icon name="chevron" size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {/* ── Conversation: the page scrolls, not this element ─────────────── */}
      <div
        className="va-log"
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="Conversation with the agent"
        aria-busy={thinking}
      >
        {turns.map((t) => {
          const key = feedbackKey(t);
          const rv = review[key] ?? {};
          const fb = feedback[key];
          const needsReview = needsHumanReview(t);
          const flagOpen = flagFormId === key && rv.flag !== 'done';
          const busy = rv.drafts === 'pending' || rv.flag === 'pending';
          const noteId = `${uid}-note-${t.id}`;
          return (
            <article key={t.id} className="va-turn">
              {t.type !== 'approvals' && (
                <div className="va-q">
                  <div className="va-q-bubble">
                    <span className="c-sr">You asked: </span>
                    <p>{t.question}</p>
                    {t.attachments && t.attachments.length > 0 && (
                      <ul className="va-q-files" aria-label="Attached files">
                        {t.attachments.map((name, i) => (
                          <li key={i} title={name}>
                            <PaperclipIcon />
                            <span>{name}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}

              <div className="va-a">
                <span className="va-avatar" aria-hidden="true">
                  <Icon name="ai" size={16} />
                </span>
                <div className="va-a-body">
                  <div className="va-a-head">
                    <strong>{t.type === 'approvals' ? 'Awaiting your approval' : 'TSBA agent'}</strong>
                    {t.at && (
                      <time className="va-time" dateTime={t.at}>
                        {formatTime(t.at)}
                      </time>
                    )}
                  </div>

                  {t.type === 'approvals' ? (
                    <ApprovalCard onAuthError={onAuthError} />
                  ) : t.pending ? (
                    <div className="va-thinking">
                      <span className="va-spin" aria-hidden="true" />
                      <span>Reading TSBA’s knowledge and answering…</span>
                    </div>
                  ) : (
                    <>
                      <div className="va-reply">
                        <ReplyText text={t.reply} />
                      </div>

                      {needsReview && (
                        <div className="va-review" role="note">
                          <Icon name="alert" size={18} />
                          <div className="va-review-text">
                            <strong>Human review required</strong>
                            <span>The agent didn’t find this in the knowledge base.</span>
                          </div>
                          {rv.flag === 'done' ? (
                            <span className="c-pill t-success">
                              <Icon name="check" size={14} />
                              Flagged
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="c-btn sm primary"
                              onClick={() => openFlagForm(t)}
                              disabled={busy || flagOpen}
                              aria-controls={flagOpen ? noteId : undefined}
                            >
                              <Icon name="flag" size={16} />
                              Flag for team
                            </button>
                          )}
                        </div>
                      )}

                      {t.sources && t.sources.length > 0 && (
                        <details className="va-sources">
                          <summary>
                            <Icon name="chevron" size={14} className="va-chev" />
                            Sources <span className="va-num">({t.sources.length})</span>
                          </summary>
                          <ul>
                            {t.sources.map((s) => (
                              <li key={s.id}>
                                <span className="va-src-title">{s.title}</span>
                                {s.source && s.source !== s.title && <span className="va-src-file">{s.source}</span>}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}

                      <div className="va-actions" role="group" aria-label="Answer actions">
                        <button
                          type="button"
                          className={`va-act icon ${fb === 'up' ? 'on' : ''}`}
                          onClick={() => rate(t, 'up')}
                          aria-pressed={fb === 'up'}
                          aria-label="Helpful answer"
                          title="Helpful"
                        >
                          <Icon name="thumbUp" size={16} />
                        </button>
                        <button
                          type="button"
                          className={`va-act icon ${fb === 'down' ? 'on' : ''}`}
                          onClick={() => rate(t, 'down')}
                          aria-pressed={fb === 'down'}
                          aria-label="Not helpful"
                          title="Not helpful"
                        >
                          <Icon name="thumbDown" size={16} />
                        </button>
                        <button
                          type="button"
                          className="va-act icon"
                          onClick={() => void copyReply(t)}
                          aria-label={copiedId === t.id ? 'Answer copied' : 'Copy answer'}
                          title={copiedId === t.id ? 'Copied' : 'Copy'}
                        >
                          <Icon name={copiedId === t.id ? 'check' : 'copy'} size={16} />
                        </button>
                        {synthSupported && (
                          <button
                            type="button"
                            className={`va-act icon ${speakingId === t.id ? 'on' : ''}`}
                            onClick={() => (speakingId === t.id ? stopSpeaking() : speak(t))}
                            aria-label={speakingId === t.id ? 'Stop reading aloud' : 'Read answer aloud'}
                            title={speakingId === t.id ? 'Stop' : 'Listen'}
                          >
                            <SpeakerIcon on={speakingId === t.id} />
                          </button>
                        )}
                        <span className="va-act-sep" aria-hidden="true" />
                        <button
                          type="button"
                          className={`va-act ${rv.drafts === 'done' ? 'done' : ''}`}
                          onClick={() => sendToDrafts(t)}
                          disabled={busy || rv.drafts === 'done'}
                        >
                          <Icon name={rv.drafts === 'done' ? 'check' : 'drafts'} size={16} />
                          <span>
                            {rv.drafts === 'done' ? 'In drafts' : rv.drafts === 'pending' ? 'Sending…' : 'Send to drafts'}
                          </span>
                        </button>
                        <button
                          type="button"
                          className={`va-act ${rv.flag === 'done' ? 'done' : ''}`}
                          onClick={() => (flagOpen ? setFlagFormId(null) : openFlagForm(t))}
                          disabled={busy || rv.flag === 'done'}
                          aria-expanded={rv.flag === 'done' ? undefined : flagOpen}
                          aria-controls={flagOpen ? noteId : undefined}
                        >
                          <Icon name={rv.flag === 'done' ? 'check' : 'flag'} size={16} />
                          <span>
                            {rv.flag === 'done' ? 'Flagged' : rv.flag === 'pending' ? 'Flagging…' : 'Flag for team'}
                          </span>
                        </button>
                      </div>

                      {flagOpen && (
                        <form
                          className="va-flagform"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void submitFlag(t);
                          }}
                        >
                          <label htmlFor={noteId}>
                            Note for the team <span>(optional)</span>
                          </label>
                          <input
                            id={noteId}
                            className="c-input"
                            value={flagNote}
                            onChange={(e) => setFlagNote(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') setFlagFormId(null);
                            }}
                            maxLength={280}
                            placeholder="What should the team check?"
                            autoFocus
                            disabled={rv.flag === 'pending'}
                          />
                          <div className="va-flagform-actions">
                            <button type="submit" className="c-btn sm primary" disabled={rv.flag === 'pending'}>
                              <Icon name="flag" size={16} />
                              {rv.flag === 'pending' ? 'Flagging…' : 'Flag for team'}
                            </button>
                            <button
                              type="button"
                              className="c-btn sm ghost"
                              onClick={() => setFlagFormId(null)}
                              disabled={rv.flag === 'pending'}
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      )}

                      {t === lastAnswered && followUps.length > 0 && (
                        <div className="va-followups" role="group" aria-label="Suggested follow-up questions">
                          {followUps.map((p) => (
                            <button
                              key={p}
                              type="button"
                              className="va-followup"
                              onClick={() => handleStarter(p)}
                              disabled={thinking}
                            >
                              {p}
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {/* ── Composer: sticky to the bottom of the viewport ───────────────── */}
      <div className="va-dock">
        {error && (
          <div className="va-error" role="alert">
            <Icon name="alert" size={16} />
            <span>{error}</span>
            <button type="button" className="c-iconbtn" onClick={() => setError('')} aria-label="Dismiss error">
              <Icon name="x" size={16} />
            </button>
          </div>
        )}

        {(listening || interim) && (
          <div className="va-listening" aria-live="polite">
            <span className="va-live-dot" aria-hidden="true" />
            <span>{interim || 'Listening…'}</span>
          </div>
        )}

        <form
          className="va-composer"
          onSubmit={(e) => {
            e.preventDefault();
            submitComposer();
          }}
        >
          {attachments.length > 0 && (
            <ul className="va-files" aria-label="Files to send">
              {attachments.map((a, i) => (
                <li key={i} className="va-file" title={a.name}>
                  <Icon name={a.mediaType === 'application/pdf' ? 'doc' : 'monitor'} size={14} />
                  <span className="va-file-name">{a.name}</span>
                  <button
                    type="button"
                    className="va-file-x"
                    onClick={() => removeAttachment(i)}
                    aria-label={`Remove ${a.name}`}
                    disabled={thinking}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="va-composer-row">
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
              className="c-iconbtn"
              onClick={() => fileInputRef.current?.click()}
              disabled={thinking || attachments.length >= MAX_ATTACHMENTS}
              aria-label="Attach images or PDFs"
              title="Attach images or PDFs"
            >
              <PaperclipIcon />
            </button>
            <textarea
              ref={taRef}
              className="va-input"
              rows={1}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={onComposerKey}
              placeholder="Ask about a product, fault or warranty…"
              disabled={thinking}
              aria-label="Message the agent"
            />
            {recognitionSupported && (
              <button
                type="button"
                className={`va-mic ${listening ? 'on' : ''}`}
                onClick={toggleMic}
                disabled={thinking}
                aria-pressed={listening}
                aria-label={listening ? 'Stop listening' : 'Speak your question'}
                title={listening ? 'Stop listening' : 'Speak'}
              >
                <Icon name="voice" size={20} />
              </button>
            )}
            <button
              className="va-send"
              type="submit"
              disabled={thinking || (!typed.trim() && attachments.length === 0)}
              aria-label={thinking ? 'Sending' : 'Send message'}
              title="Send"
            >
              {thinking ? <span className="va-spin" aria-hidden="true" /> : <Icon name="send" size={18} />}
            </button>
          </div>
        </form>
        <p className="va-hint">Enter to send · Shift+Enter for a new line</p>
      </div>

      {/* ── Conversation history ─────────────────────────────────────────── */}
      <Drawer
        open={showHistory}
        onClose={closeHistory}
        title={viewing ? 'Conversation' : 'Conversation history'}
        sub={viewing ? formatDate(viewing.at) : 'Saved here when you start a new chat'}
        footer={
          viewing ? (
            <>
              <button type="button" className="c-btn primary" onClick={() => resumeSession(viewing)}>
                Continue this conversation
              </button>
              <button type="button" className="c-btn ghost" onClick={() => setViewing(null)}>
                Back to list
              </button>
            </>
          ) : undefined
        }
      >
        {viewing ? (
          <div className="va-hist-transcript">
            {viewing.turns.map((t) => (
              <div key={t.id} className="va-hist-turn">
                <p className="va-hist-q">{t.question}</p>
                <p className="va-hist-a">
                  <ReplyText text={t.reply} />
                </p>
              </div>
            ))}
          </div>
        ) : history.length === 0 ? (
          <p className="va-muted">No past conversations yet.</p>
        ) : (
          <ul className="va-hist-list">
            {history.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="va-hist-item"
                  onClick={() => resumeSession(s)}
                  title="Open and continue this conversation"
                >
                  <span className="va-hist-title">{s.title || '(untitled)'}</span>
                  <span className="va-hist-meta">
                    {formatDate(s.at)} · <span className="va-num">{s.turns.length}</span> message
                    {s.turns.length === 1 ? '' : 's'}
                  </span>
                </button>
                <button
                  type="button"
                  className="c-iconbtn"
                  onClick={() => setViewing(s)}
                  aria-label={`Preview “${s.title || 'untitled'}”`}
                  title="Preview"
                >
                  <Icon name="doc" size={16} />
                </button>
                <button
                  type="button"
                  className="c-iconbtn va-hist-del"
                  onClick={() => deleteSession(s.id)}
                  aria-label={`Delete “${s.title || 'untitled'}”`}
                  title="Delete"
                >
                  <Icon name="x" size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Drawer>

      {/* ── Voice & reply settings ───────────────────────────────────────── */}
      <Drawer open={showSettings} onClose={closeSettings} title="Voice settings" sub="Applies to this browser tab">
        <label className="va-check">
          <input type="checkbox" checked={autoSpeak} onChange={(e) => setAutoSpeak(e.target.checked)} />
          <span>
            <strong>Read replies aloud</strong>
            <span className="va-muted">Speak each answer as it arrives (always on in hands-free).</span>
          </span>
        </label>
        <div className="va-field">
          <label htmlFor={`${uid}-voice`}>Voice</label>
          <select
            id={`${uid}-voice`}
            className="c-select"
            value={voiceName}
            onChange={(e) => setVoiceName(e.target.value)}
          >
            {VOICE_OPTIONS.map((o) => (
              <option key={o.name} value={o.name}>
                {o.name} ({o.lang})
              </option>
            ))}
          </select>
          <span className="va-muted">If a voice isn’t installed on this device, the closest local English voice is used.</span>
        </div>
        {recognitionSupported && (
          <div className="va-field">
            <span className="va-field-label">Hands-free conversation</span>
            <span className="va-muted">Listen, answer, speak, then listen again — no buttons needed.</span>
            <div>
              <button type="button" className={`c-btn sm ${handsFree ? '' : 'primary'}`} onClick={toggleHandsFree}>
                <Icon name="voice" size={16} />
                {handsFree ? 'Stop hands-free' : 'Start hands-free'}
              </button>
            </div>
          </div>
        )}
        <div className="va-field">
          <span className="va-field-label">Answers written for</span>
          <span>{audience === 'installer' ? 'Installers' : audience}</span>
        </div>
      </Drawer>
    </div>
  );
}
