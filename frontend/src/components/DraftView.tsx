import { useEffect, useState } from 'react';
import {
  AUDIENCE_LABELS,
  CHANNEL_LABELS,
  OUTCOME_LABELS,
  type Draft,
  type DraftAction,
} from '@tsba/shared';
import { SourceCardView } from './SourceCard';

export function DraftView({
  draft,
  onAction,
  busy,
}: {
  draft: Draft | null;
  onAction: (action: DraftAction) => void;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');

  useEffect(() => {
    setEditing(false);
    setText(draft?.reply ?? '');
  }, [draft?.id, draft?.reply]);

  if (!draft) {
    return (
      <p className="empty">
        Ask a question above. The assistant drafts a reply from TSBA&rsquo;s knowledge, shows its sources, and waits
        for Ryan&rsquo;s approval before anything is sent.
      </p>
    );
  }

  const [label, cls] = OUTCOME_LABELS[draft.outcome];

  function commitEdit() {
    setEditing(false);
    if (text.trim() !== draft!.reply.trim()) onAction({ action: 'edit', text: text.trim() });
  }

  return (
    <>
      <div className="meta">
        {AUDIENCE_LABELS[draft.audience]} · {CHANNEL_LABELS[draft.channel]} · &ldquo;{draft.question}&rdquo;
      </div>
      <div className="card-h" style={{ marginTop: -4 }}>
        <span className={`status ${cls}`}>{label}</span>
      </div>

      {editing ? (
        <textarea value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 160 }} autoFocus />
      ) : (
        <div className="reply">{draft.reply}</div>
      )}

      {draft.team_handover && draft.outcome === 'handover' && (
        <div className="hand">
          <b>For the team: </b>
          {draft.team_handover.summary}
          {draft.team_handover.needed.length > 0 && (
            <ul>
              {draft.team_handover.needed.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {draft.sources.length > 0 && (
        <>
          <span className="eyebrow">Sources</span>
          <div className="sources">
            {draft.sources.map((s) => (
              <SourceCardView key={s.id} source={s} />
            ))}
          </div>
        </>
      )}

      {draft.note_for_ryan && (
        <div className="note">
          <b>Note for Ryan</b>
          {draft.note_for_ryan}
        </div>
      )}

      <div className="row">
        {draft.status === 'pending' ? (
          <>
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={() => {
                if (editing) commitEdit();
                onAction({ action: 'approve', text: text.trim() });
              }}
            >
              Approve &amp; send
            </button>
            <button className="ghost" type="button" disabled={busy} onClick={() => (editing ? commitEdit() : setEditing(true))}>
              {editing ? 'Done editing' : 'Edit'}
            </button>
            <button className="ghost danger" type="button" disabled={busy} onClick={() => onAction({ action: 'reject' })}>
              Reject
            </button>
          </>
        ) : (
          <span className="meta">
            {draft.status === 'sent'
              ? draft.edited
                ? 'Approved with edits · sent'
                : 'Approved · sent'
              : draft.status === 'team'
                ? 'Approved · reply sent, question with the team'
                : 'Rejected'}
          </span>
        )}
      </div>

      {draft.delivery && (
        <div className={`meta delivery delivery-${draft.delivery.status}`}>
          {draft.delivery.status === 'delivered'
            ? '✓ Delivered'
            : draft.delivery.status === 'failed'
              ? '✗ Delivery failed'
              : 'Delivery skipped'}
          {draft.recipient ? ` to ${draft.recipient}` : ''} · via {draft.delivery.channel} — {draft.delivery.detail}
        </div>
      )}
    </>
  );
}
