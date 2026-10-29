import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
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
import {
  BriefcaseIcon,
  ChatIcon,
  MailIcon,
  TextIcon,
  UserIcon,
  WrenchIcon,
} from './icons';

// Icons for the audience / channel segmented controls.
const AUDIENCE_ICON: Record<Audience, ReactElement> = {
  customer: <UserIcon />,
  installer: <WrenchIcon />,
  sales: <BriefcaseIcon />,
};
const CHANNEL_ICON: Record<Channel, ReactElement> = {
  chat: <ChatIcon />,
  text: <TextIcon />,
  email: <MailIcon />,
};

export function AskTab({ onAuthError }: { onAuthError: () => void }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [audience, setAudience] = useState<Audience>('installer');
  const [channel, setChannel] = useState<Channel>('chat');
  const [recipient, setRecipient] = useState('');
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
  // Sample questions scoped to the selected audience — this page is managed
  // per audience (Customer / Installer / Sales rep).
  const audienceSuggestions = SUGGESTIONS.filter((s) => s.audience === audience);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const q = question.trim();
    setError('');
    if (!q) return;
    setLoading(true);
    setCurrentId(null);
    try {
      const draft = await createDraft({ question: q, audience, channel, recipient: recipient.trim() || null });
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

  // Loading a draft from the queue restores the audience + channel it arrived on,
  // so the composer reflects where the question came from (and where the reply
  // will go back out).
  function selectDraft(d: Draft) {
    setCurrentId(d.id);
    setAudience(d.audience);
    setChannel(d.channel);
    draftCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <>
      {/* Main page tabs — the audience scopes the whole page (questions, drafts,
          replies are managed per audience). */}
      <div className="ask-maintabs pilltabs-wrap">
        <div className="pilltabs" role="tablist" aria-label="Who's asking">
          {AUDIENCES.map((a) => (
            <button key={a} type="button" role="tab" aria-selected={audience === a} onClick={() => setAudience(a)}>
              {AUDIENCE_ICON[a]}
              {AUDIENCE_LABELS[a]}
            </button>
          ))}
        </div>
      </div>

      <main className="wrap">
      <div className="col">
        <section className="card ask-incoming" aria-labelledby="h-in">
          <div className="card-h">
            <h2 id="h-in">Incoming question</h2>
            <span className="eyebrow">Arrives as if from a real channel</span>
          </div>

          <div className="field">
            <span className="eyebrow">Arrived from</span>
            <div className="pilltabs arrived-pills" role="group" aria-label="Arrived from">
              {CHANNELS.map((c) => (
                <button key={c} type="button" aria-pressed={channel === c} onClick={() => setChannel(c)}>
                  {CHANNEL_ICON[c]}
                  {CHANNEL_LABELS[c]}
                </button>
              ))}
            </div>
            <span className="field-hint">The approved reply is sent back out on this channel.</span>
          </div>

          <div className="field">
            <label className="eyebrow" htmlFor="recipient">Send approved reply to <i>(optional)</i></label>
            <input
              id="recipient"
              type="text"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="e.g. customer@example.com or +61…"
            />
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
            <span className="eyebrow">{AUDIENCE_LABELS[audience]} questions from TSBA</span>
          </div>
          <div className="chips">
            {audienceSuggestions.length === 0 ? (
              <p className="empty">No sample {AUDIENCE_LABELS[audience]} questions yet.</p>
            ) : (
              audienceSuggestions.map((s, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    setChannel(s.channel); // auto-select the channel it arrived on
                    setQuestion(s.question);
                    document.getElementById('q')?.focus();
                  }}
                >
                  {s.question}
                </button>
              ))
            )}
          </div>
        </section>

        <QueueLists drafts={drafts} audience={audience} currentId={currentId} onSelect={selectDraft} />

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
    </>
  );
}
