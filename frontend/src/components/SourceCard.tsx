import type { SourceCard as Source } from '@tsba/shared';

export function SourceCardView({ source }: { source: Source }) {
  const isRule = source.kind === 'rule';
  return (
    <div className="src">
      <span className="lab">
        <i className="dot" style={{ background: isRule ? 'var(--ok)' : 'var(--mid)' }} />
        {isRule ? 'Verified rule' : 'Manufacturer support · pending TSBA approval'}
      </span>
      <span className="t">{source.title}</span>
      <span className="s">{source.source}</span>
    </div>
  );
}
