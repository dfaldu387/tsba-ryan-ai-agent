// Resolved issues — the other half of the alert lifecycle. An issue that drops
// out of the scan shows here at once as "Confirming"; once it has stayed clear
// for the confirmation window it is "Resolved", with when it opened, when it
// cleared, how long it lasted and whether the team was emailed both ways.
import { useMemo } from 'react';
import type { ResolvedAlert } from '../../api';
import { useConsole } from '../../lib/console';
import { CATEGORY_LABEL, classify, faultName, type RawAlert } from '../../lib/alerts';
import { fmtAbs, fmtInt } from '../../lib/format';
import { EmptyState, Icon, Pager, Pill, ProviderChip, RelTime, SkeletonRows, usePaged } from '../../ui';

/** "2 h 15 min", "40 min", "3 days". */
export function fmtLasted(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 48) return m ? `${h} h ${m} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

function EmailState({ r, recoveryEmails }: { r: ResolvedAlert; recoveryEmails: boolean }) {
  if (!r.alerted) {
    return <span className="c-muted" title="It cleared before an alert email was due (debounce or quiet hours), so no emails were sent.">Not emailed</span>;
  }
  if (r.recoveryEmailedAt) {
    return <Pill tone="success" title={`Resolved email sent ${fmtAbs(r.recoveryEmailedAt)}`}><Icon name="mail" size={12} /> Alert + resolved sent</Pill>;
  }
  if (!r.confirmed) return <Pill tone="info" title="The resolved email goes out once the fix is confirmed.">Alert sent · resolved pending</Pill>;
  if (!recoveryEmails) return <Pill tone="neutral" title="Resolved emails are turned off in alert settings.">Alert sent</Pill>;
  return <Pill tone="info" title="Queued — held for quiet hours or the next digest.">Alert sent · resolved queued</Pill>;
}

export function ResolvedAlerts({ q, provider }: { q: string; provider: string }) {
  const { resolved, providerName, openPlant, alertsLoading } = useConsole();

  const rows = useMemo(() => {
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (resolved?.resolved ?? [])
      .filter((r) => provider === 'all' || r.provider === provider)
      .filter((r) => {
        if (!terms.length) return true;
        const hay = `${r.plant} ${r.title} ${r.detail ?? ''} ${r.deviceSn ?? ''} ${providerName(r.provider)}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      })
      // Confirming first (it just happened), then newest resolution first.
      .sort((a, b) => Number(a.confirmed) - Number(b.confirmed) || b.resolvedAt - a.resolvedAt);
  }, [resolved, q, provider, providerName]);

  const paged = usePaged(rows, [q, provider]);

  if (!resolved) return alertsLoading ? <SkeletonRows rows={6} cols={6} /> : <div className="c-pad c-muted">Resolved history isn’t available yet.</div>;
  if (!rows.length) {
    return (
      <EmptyState
        icon={resolved.resolved.length ? 'search' : 'check'}
        tone="neutral"
        title={resolved.resolved.length ? 'Nothing matches this view' : 'No issues resolved in the last 7 days'}
        hint={resolved.resolved.length ? 'Try clearing the search or provider filter.' : 'When an open issue clears and stays clear, it shows up here.'}
      />
    );
  }

  return (
    <div className="c-tablewrap">
      <p className="rs-note">
        <Icon name="check" size={14} /> An issue counts as resolved once it has stayed clear for {fmtInt(resolved.confirmMin)} min
        {resolved.recoveryEmails ? '. If an alert was sent, a resolved email follows.' : '. Resolved emails are off in settings.'}
      </p>
      <table className="c-table rs-table">
        <thead>
          <tr>
            <th>Status</th>
            <th>Plant</th>
            <th>Issue</th>
            <th>Opened</th>
            <th>Resolved</th>
            <th>Lasted</th>
            <th>Emails</th>
          </tr>
        </thead>
        <tbody>
          {paged.slice.map((r) => {
            const cat = classify(r as RawAlert).category;
            return (
              <tr key={`${r.id}@${r.resolvedAt}`} tabIndex={0} onClick={() => openPlant({ provider: r.provider, id: r.plantId })}
                onKeyDown={(e) => { if (e.key === 'Enter') openPlant({ provider: r.provider, id: r.plantId }); }}
                title="Open plant">
                <td>
                  {r.confirmed
                    ? <Pill tone="success" dot>Resolved</Pill>
                    : <Pill tone="info" dot title={`Cleared — confirming it stays clear for ${resolved.confirmMin} min. If it returns, it reopens as the same issue.`}>Confirming</Pill>}
                </td>
                <td className="name">
                  <strong title={r.plant}>{r.plant}</strong>
                  <span><ProviderChip id={r.provider} name={providerName(r.provider)} /></span>
                </td>
                <td>
                  <span className="c-trunc rs-issue" title={r.title}>{faultName(r as RawAlert)}</span>
                  <span className="c-muted rs-cat">{CATEGORY_LABEL[cat]}{r.deviceSn ? ` · ${r.deviceSn}` : ''}</span>
                </td>
                <td title={fmtAbs(r.openedAt)}><RelTime t={r.openedAt} /></td>
                <td title={fmtAbs(r.resolvedAt)}><RelTime t={r.resolvedAt} /></td>
                <td>{fmtLasted(r.resolvedAt - r.openedAt)}</td>
                <td><EmailState r={r} recoveryEmails={resolved.recoveryEmails} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Pager paged={paged} noun="issue" />
    </div>
  );
}
