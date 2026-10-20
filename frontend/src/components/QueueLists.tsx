import {
  AUDIENCE_LABELS,
  CHANNEL_LABELS,
  OUTCOME_LABELS,
  type Draft,
  type DraftStatus,
} from '@tsba/shared';

function QueueList({
  title,
  status,
  drafts,
  currentId,
  onSelect,
  empty,
}: {
  title: string;
  status: DraftStatus;
  drafts: Draft[];
  currentId: number | null;
  onSelect: (d: Draft) => void;
  empty: string;
}) {
  const items = drafts.filter((d) => d.status === status).slice().reverse();
  return (
    <section className="card">
      <div className="card-h">
        <h2>{title}</h2>
        <span className="count">{items.length}</span>
      </div>
      <div className="q-list">
        {items.length === 0 ? (
          <p className="empty">{empty}</p>
        ) : (
          items.map((d) => {
            const [label, cls] = OUTCOME_LABELS[d.outcome];
            return (
              <button
                key={d.id}
                type="button"
                className="q-item"
                aria-current={currentId === d.id ? 'true' : undefined}
                onClick={() => onSelect(d)}
              >
                <span className="qt">{d.question}</span>
                <span className={`status ${cls}`}>{label}</span>
                <span className="qm">
                  {AUDIENCE_LABELS[d.audience]} · {CHANNEL_LABELS[d.channel]}
                </span>
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}

export function QueueLists({
  drafts,
  currentId,
  onSelect,
}: {
  drafts: Draft[];
  currentId: number | null;
  onSelect: (d: Draft) => void;
}) {
  return (
    <>
      <QueueList
        title={'Waiting for Ryan’s approval'}
        status="pending"
        drafts={drafts}
        currentId={currentId}
        onSelect={onSelect}
        empty="Nothing waiting. Every reply lands here first."
      />
      <QueueList
        title="Handed to the team"
        status="team"
        drafts={drafts}
        currentId={currentId}
        onSelect={onSelect}
        empty="Questions that need live system data or a site check appear here."
      />
      <QueueList
        title="Sent"
        status="sent"
        drafts={drafts}
        currentId={currentId}
        onSelect={onSelect}
        empty="Approved replies. In the real system these go out by email, text or chat."
      />
    </>
  );
}
