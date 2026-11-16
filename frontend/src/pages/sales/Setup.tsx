// One-time rep setup: who is texting, what the business is, how they sound.
// Target: under two minutes, no help needed.
import { useState } from 'react';
import { KW_TONES } from '@tsba/shared';
import { kw } from '../../api';
import { useConsole } from '../../lib/console';
import type { KwProfile, KwTone, KwUnderstood } from '../../lib/kw-types';
import { Icon } from '../../ui';
import { VoiceBox, errText } from './parts';

const TSBA_EXAMPLE =
  "We're TSBA. We design and install solar and battery systems for homes and small businesses. Most of my clients are homeowners who've had a quote or a site visit and are weighing it up, plus past customers who send me referrals.";

export function Setup({ existing, onDone, onCancel }: { existing: KwProfile | null; onDone: () => void; onCancel?: () => void }) {
  const { user, toast } = useConsole();
  const [step, setStep] = useState(existing ? 3 : 0);
  const [name, setName] = useState(existing?.displayName ?? user.name ?? '');
  const [company, setCompany] = useState(existing?.company ?? 'TSBA');
  const [sign, setSign] = useState(existing?.signOff ?? (user.name ?? '').split(' ')[0] ?? '');
  const [about, setAbout] = useState(existing?.about ?? '');
  const [understood, setUnderstood] = useState<KwUnderstood | null>(existing?.understood ?? null);
  const [tone, setTone] = useState<KwTone>(existing?.tone ?? 'friendly');
  const [sendTime, setSendTime] = useState(existing?.sendTime ?? '09:00');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const readBack = async () => {
    setBusy(true);
    setErr(null);
    try {
      setUnderstood(await kw.understand(about, company));
      setStep(3);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await kw.saveProfile({
        displayName: name.trim(), company: company.trim(), signOff: sign.trim(), about: about.trim(), understood, tone, sendTime,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Australia/Sydney',
      });
      toast({ text: 'You’re set up. Add your first client.', tone: 'success' });
      onDone();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const dots = (
    <div className="kw-steps" aria-hidden="true">
      {[1, 2, 3].map((n) => <i key={n} className={step >= n ? 'on' : ''} />)}
    </div>
  );

  if (step === 0) {
    return (
      <div className="kw-phone kw-setup">
        <div className="kw-hero">
          <div className="kw-brandline"><Icon name="chat" size={18} /> Sales follow-ups</div>
          <h2 className="kw-big">Your old pipeline shouldn’t go cold while you chase the new one.</h2>
          <p className="kw-sub">Voice-note what you talked about. The agent drafts each follow-up text in your voice. You approve every one before it sends.</p>
        </div>
        <button type="button" className="kw-btn kw-wide" onClick={() => setStep(1)}>Set up in two minutes</button>
      </div>
    );
  }

  return (
    <div className="kw-phone kw-setup">
      <div className="kw-bar">
        {step > 1 || onCancel ? (
          <button type="button" className="kw-iconbtn" aria-label="Back" onClick={() => (step > 1 ? setStep(step === 3 ? 2 : step - 1) : onCancel?.())}>
            <Icon name="back" />
          </button>
        ) : <span />}
        {dots}
        <span />
      </div>

      {step === 1 && (
        <section className="kw-enter">
          <h2 className="kw-big">Who’s texting?</h2>
          <p className="kw-sub">Clients only ever see your name, never the app’s.</p>
          <label className="kw-label" htmlFor="kw-name">Your name</label>
          <input id="kw-name" className="kw-input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          <label className="kw-label" htmlFor="kw-co">Company</label>
          <input id="kw-co" className="kw-input" value={company} onChange={(e) => setCompany(e.target.value)} />
          <label className="kw-label" htmlFor="kw-sign">How you sign off a text</label>
          <input id="kw-sign" className="kw-input" value={sign} onChange={(e) => setSign(e.target.value)} placeholder="Sam" />
          <div className="kw-foot">
            <button type="button" className="kw-btn kw-wide" disabled={!name.trim()} onClick={() => { if (!sign.trim()) setSign(name.trim().split(' ')[0]); setStep(2); }}>
              Continue
            </button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="kw-enter">
          <h2 className="kw-big">Tell me about your business.</h2>
          <p className="kw-sub">What you sell and who you sell it to. Say it the way you’d explain it at a barbecue.</p>
          <VoiceBox label="About your business" value={about} onChange={setAbout} rows={7} placeholder="We install…" />
          <button type="button" className="kw-linkbtn" onClick={() => setAbout(TSBA_EXAMPLE)}>Use the TSBA example</button>
          {err && <p className="kw-err">{err}</p>}
          <div className="kw-foot">
            <button type="button" className="kw-btn kw-wide" disabled={about.trim().length < 10 || busy} onClick={readBack}>
              {busy ? 'Reading what you told me…' : 'Continue'}
            </button>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="kw-enter">
          <h2 className="kw-big">Here’s what I understood.</h2>
          {understood ? (
            <div className="kw-card kw-kv">
              <div><b>You sell</b><span>{understood.sells}</span></div>
              <div><b>Your clients</b><span>{understood.clients}</span></div>
              <div><b>How people buy</b><span>{understood.howTheyBuy}</span></div>
              <div><b>Good reasons to text</b><span>{understood.reasonsToText}</span></div>
            </div>
          ) : (
            <p className="kw-sub">Nothing read back yet.</p>
          )}
          <button type="button" className="kw-linkbtn" onClick={() => setStep(2)}>Not quite right? Change what you said</button>

          <h3 className="kw-sec">How do you text?</h3>
          <div className="kw-list">
            {KW_TONES.map((t) => (
              <button key={t.id} type="button" className={`kw-card kw-choice ${tone === t.id ? 'is-on' : ''}`} aria-pressed={tone === t.id} onClick={() => setTone(t.id)}>
                <div className="kw-name">{t.name}</div>
                <div className="kw-small">{t.eg.replace(/Sam/g, sign || 'Sam').replace('TSBA', company || 'TSBA')}</div>
              </button>
            ))}
          </div>

          <h3 className="kw-sec">Usual time to send</h3>
          <input type="time" className="kw-input kw-time" value={sendTime} onChange={(e) => setSendTime(e.target.value)} aria-label="Usual time to send" />
          <p className="kw-small">Drafts are ready each morning. Texts never go out early in the morning, late at night or on Sundays.</p>

          {err && <p className="kw-err">{err}</p>}
          <div className="kw-foot">
            <button type="button" className="kw-btn kw-wide" disabled={busy || !name.trim()} onClick={save}>{busy ? 'Saving…' : 'Looks right'}</button>
          </div>
        </section>
      )}
    </div>
  );
}
