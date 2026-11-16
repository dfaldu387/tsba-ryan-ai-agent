// Small building blocks for the sales follow-up screens (namespace `kw-`).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KwClient, KwMix, KwTextType, KwWarmth } from '../../lib/kw-types';
import { Icon } from '../../ui';

export const firstName = (n: string) => n.trim().split(/[\s&]+/)[0] || n;
export const initials = (n: string) =>
  n.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?';

export const TYPE_LABEL: Record<KwTextType, string> = { business: 'Business follow-up', friendly: 'Friendly check-in' };
export const MIX_LABEL: Record<KwMix, string> = { business: 'Business', friendly: 'Friendly', mix: 'A mix of both' };

export function cadenceLabel(d: number | null): string {
  if (!d) return 'No rhythm';
  return ({ 7: 'Weekly', 14: 'Fortnightly', 30: 'Monthly', 90: 'Every 3 months' } as Record<number, string>)[d] ?? `Every ${d} days`;
}

export const WARMTH_LABEL: Record<KwWarmth, string> = {
  warm: 'Warm', cooling: 'Cooling', due: 'Due today', cold: 'Going cold', paused: 'Mid-conversation', stopped: 'Asked to stop',
};

export function fmtDate(d: string | null | undefined, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }): string {
  if (!d) return '';
  const date = d.length === 10 ? new Date(`${d}T12:00:00`) : new Date(d);
  return date.toLocaleDateString('en-AU', opts);
}

export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }).toLowerCase()
    : d.toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).toLowerCase();
}

export function smsCount(text: string): string {
  const n = text.length;
  const parts = n <= 160 ? 1 : Math.ceil(n / 153);
  return `${n} characters · ${parts} text${parts > 1 ? 's' : ''}`;
}

/** The warmth ring: fill drains as the next text approaches. */
export function Ring({ client, size = 40 }: { client: Pick<KwClient, 'name' | 'warmth' | 'warmthPct'>; size?: number }) {
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  const pct = client.warmth === 'paused' ? 100 : client.warmthPct;
  return (
    <span className={`kw-ring is-${client.warmth}`} style={{ width: size, height: size }} title={WARMTH_LABEL[client.warmth]}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} className="kw-ring-track" />
        <circle cx={size / 2} cy={size / 2} r={r} className="kw-ring-fill"
          strokeDasharray={`${(pct / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <b style={{ fontSize: Math.max(11, size * 0.3) }}>{initials(client.name)}</b>
    </span>
  );
}

export function WarmthTag({ warmth }: { warmth: KwWarmth }) {
  return <span className={`kw-tag is-${warmth}`}>{WARMTH_LABEL[warmth]}</span>;
}

// ─── Dictation (browser speech recognition, en-AU) ──────────────────────────
interface SpeechRec {
  lang: string; continuous: boolean; interimResults: boolean;
  start(): void; stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}
type SpeechCtor = new () => SpeechRec;

function speechCtor(): SpeechCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Live dictation. `onText(final, interim)` gets the words said so far in this
 * session, so the caller can show them as they arrive.
 */
export function useDictation(onText: (finalText: string, interim: string) => void) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<SpeechRec | null>(null);
  const cb = useRef(onText);
  cb.current = onText;
  const supported = speechCtor() !== null;

  const stop = useCallback(() => {
    rec.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Ctor = speechCtor();
    if (!Ctor) {
      setError('Voice isn’t available in this browser. Type instead, or use your keyboard’s mic.');
      return;
    }
    setError(null);
    const r = new Ctor();
    r.lang = 'en-AU';
    r.continuous = true;
    r.interimResults = true;
    let finalText = '';
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += `${res[0].transcript.trim()} `;
        else interim += res[0].transcript;
      }
      cb.current(finalText.trim(), interim.trim());
    };
    r.onerror = (e) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') setError(e.error === 'not-allowed' ? 'Microphone permission was blocked.' : `Voice stopped (${e.error}).`);
    };
    r.onend = () => setListening(false);
    rec.current = r;
    r.start();
    setListening(true);
  }, []);

  useEffect(() => () => rec.current?.stop(), []);
  return { supported, listening, error, start, stop };
}

/** Text area + mic: dictated words are appended to whatever was typed. */
export function VoiceBox({ value, onChange, placeholder, rows = 5, label, autoFocus }: {
  value: string; onChange: (v: string) => void; placeholder?: string; rows?: number; label: string; autoFocus?: boolean;
}) {
  const base = useRef('');
  const [interim, setInterim] = useState('');
  const d = useDictation((fin, int) => {
    onChange(`${base.current}${base.current && fin ? ' ' : ''}${fin}`);
    setInterim(int);
  });
  const toggle = () => {
    if (d.listening) {
      d.stop();
      setInterim('');
    } else {
      base.current = value.trim();
      d.start();
    }
  };
  return (
    <div className={`kw-voicebox ${d.listening ? 'is-live' : ''}`}>
      <textarea aria-label={label} value={value} rows={rows} placeholder={placeholder} autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)} />
      {interim && <div className="kw-interim">{interim}…</div>}
      <div className="kw-voicebox-bar">
        <button type="button" className={`kw-mic ${d.listening ? 'is-on' : ''}`} onClick={toggle} aria-pressed={d.listening}>
          <Icon name={d.listening ? 'stop' : 'voice'} size={16} />
          {d.listening ? 'Stop' : 'Say it instead'}
        </button>
        {d.listening && <span className="kw-live-dot">Listening</span>}
        {d.error && <span className="kw-err-inline">{d.error}</span>}
      </div>
    </div>
  );
}

/** Upcoming send dates for a rhythm, skipping Sundays, alternating for a mix. */
export function previewDates(cadence: number, mix: KwMix, count = 4, first?: string): { date: string; type: KwTextType }[] {
  const out: { date: string; type: KwTextType }[] = [];
  const d = first ? new Date(`${first}T12:00:00`) : new Date();
  if (!first) d.setDate(d.getDate() + cadence);
  let type: KwTextType = mix === 'friendly' ? 'friendly' : 'business';
  for (let i = 0; i < count; i++) {
    const x = new Date(d);
    if (x.getDay() === 0) x.setDate(x.getDate() + 1);
    out.push({ date: `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`, type });
    if (mix === 'mix') type = type === 'business' ? 'friendly' : 'business';
    d.setDate(d.getDate() + cadence);
  }
  return out;
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}
