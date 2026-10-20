import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AUDIENCES,
  AUDIENCE_LABELS,
  CHANNELS,
  CHANNEL_LABELS,
  type Audience,
  type Channel,
  type Draft,
  type DraftAction,
} from '@tsba/shared';
import { ApiError, AuthError, createDraft, listDrafts, patchDraft } from '../api';
import { SUGGESTIONS } from '../data/suggestions';
import { DraftView } from './DraftView';
import { QueueLists } from './QueueLists';

export function AskTab({ onAuthError }: { onAuthError: () => void }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [audience, setAudience] = useState<Audience>('installer');
  const [channel, setChannel] = useState<Channel>('chat');
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState('');
  const draftCardRef = useRef<HTMLDivElement>(null);

  function handleError(err: unknown) {
    if (err instanceof AuthError) return onAuthError();
    if (err instanceof ApiError && err.code === 'llm_not_configured') {
      setError('Live drafting is off on the server (no Anthropic key set).');
    } else if (err instanceof ApiError && err.code === 'draft_failed') {
      setError('The draft didn’t come through. Try again.');
    } else {
      setError('Something went wrong. Try again.');
    }
  }

  useEffect(() => {
    listDrafts().then(setDrafts).catch(handleError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = drafts.find((d) => d.id === currentId) ?? null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const q = question.trim();
    setError('');
    if (!q) return;
    setLoading(true);
    setCurrentId(null);
    try {
      const draft = await createDraft({ question: q, audience, channel });
      setDrafts((prev) => [...prev, draft]);
      setCurrentId(draft.id);
      setQuestion('');
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(false);
    }
  }

  async function onAction(action: DraftAction) {
    if (currentId == null) return;
    setActionBusy(true);
    try {
      const updated = await patchDraft(currentId, action);
      setDrafts((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
    } catch (err) {
      handleError(err);
    } finally {
      setActionBusy(false);
    }
  }

  function selectDraft(d: Draft) {
    setCurrentId(d.id);
    draftCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <main className="wrap">
      <div className="col">
        <section className="card" aria-labelledby="h-in">
          <div className="card-h">
            <h2 id="h-in">Incoming question</h2>
            <span className="eyebrow">Arrives as if from a real channel</span>
          </div>
          <div className="row">
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
            <div className="field">
              <span className="eyebrow">Arrives by</span>
              <div className="seg" role="group" aria-label="Channel">
                {CHANNELS.map((c) => (
                  <button key={c} type="button" aria-pressed={channel === c} onClick={() => setChannel(c)}>
                    {CHANNEL_LABELS[c]}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <form className="field" style={{ gap: 10 }} onSubmit={submit}>
            <label className="eyebrow" htmlFor="q">Their message</label>
            <textarea
              id="q"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="e.g. What's the minimum spacing between a battery stack and a window?"
            />
            <div className="row">
              <button className="btn" type="submit" disabled={loading}>
                {loading ? 'Drafting…' : 'Draft a reply'}
              </button>
              {error && <span className="err" role="status">{error}</span>}
            </div>
          </form>
        </section>

        <section className="card" aria-labelledby="h-draft" ref={draftCardRef}>
          <div className="card-h">
            <h2 id="h-draft">Drafted reply</h2>
          </div>
          {loading ? (
            <div className="thinking">
              <span className="spin" aria-hidden="true" />
              <span>Reading TSBA&rsquo;s knowledge and drafting a reply…</span>
            </div>
          ) : (
            <DraftView draft={current} onAction={onAction} busy={actionBusy} />
          )}
        </section>
      </div>

      <div className="col">
        <section className="card" aria-labelledby="h-try">
          <div className="card-h">
            <h2 id="h-try">Try one of these</h2>
            <span className="eyebrow">Real questions from TSBA</span>
          </div>
          <div className="chips">
            {SUGGESTIONS.map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  setAudience(s.audience);
                  setQuestion(s.question);
                  document.getElementById('q')?.focus();
                }}
              >
                <i>{AUDIENCE_LABELS[s.audience]}</i>
                {s.question}
              </button>
            ))}
          </div>
        </section>

        <QueueLists drafts={drafts} currentId={currentId} onSelect={selectDraft} />

        <section className="card how">
          <span className="eyebrow">What it knows today</span>
          <p>
            <b>Verified rules:</b> the battery installation requirements (AS/NZS 5139), the Safe Work electrical code,
            and the SOFAR SAR-100 offline-support safety rules.
          </p>
          <p>
            <b>Manufacturer answers:</b> 66 answers from TSBA&rsquo;s Deye, SAJ and SOFAR support chats, personal
            details removed. These are marked as pending TSBA approval.
          </p>
          <p>
            <b>Not yet loaded:</b> the 263 product PDFs, network rules, and live system data.
          </p>
        </section>
      </div>
    </main>
  );
}
