// Sales pipeline workspace. Screens are addressed by the URL (/sales?v=…&id=…)
// so the sidebar, back/forward and deep links all work. Rep screens are a
// phone-width column; the admin screens (managers) are full width.
import { useCallback, useEffect, useState } from 'react';
import { hasPermission } from '@tsba/shared';
import { AuthError, kw } from '../../api';
import { useConsole } from '../../lib/console';
import type { KwStatus } from '../../lib/kw-types';
import { Icon } from '../../ui';
import { MessageLog, OptOutList, PipelineView, RepsView, SalesOverview, SalesSettings } from './Admin';
import { AgentView } from './Agent';
import { Board } from './Board';
import { AddClient, ClientDetail, ClientList } from './Clients';
import { Scoreboard } from './Scoreboard';
import { Setup } from './Setup';
import { Review, Today } from './Today';
import { errText } from './parts';
import './sales.css';

import { SALES_ADMIN_VIEWS, salesNavView, type SalesView } from './nav';
export { SALES_ADMIN_VIEWS, salesNavView, type SalesView };

const REP_TABS: { v: SalesView; label: string; icon: string }[] = [
  { v: 'today', label: 'Today', icon: 'dashboard' },
  { v: 'agent', label: 'Agent', icon: 'ai' },
  { v: 'board', label: 'Pipeline', icon: 'columns' },
  { v: 'clients', label: 'Clients', icon: 'book' },
  { v: 'score', label: 'Scoreboard', icon: 'trend' },
];

export function SalesPage({ search }: { search: string }) {
  const { user, navigate, onAuthError } = useConsole();
  const [status, setStatus] = useState<KwStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const params = new URLSearchParams(search);
  const canTeam = hasPermission(user.role, 'sales_team');
  const raw = params.get('v') as SalesView | 'team' | null;
  // Managers land on the team overview; reps on their own Today.
  let view: SalesView = raw === 'team' ? 'overview' : raw ?? (canTeam ? 'overview' : 'today');
  if (SALES_ADMIN_VIEWS.includes(view) && !canTeam) view = 'today';
  const id = params.get('id') ?? '';
  const preset = params.get('f') ?? '';

  const go = useCallback((v: string, idArg?: string, filter?: string) => {
    const qs = new URLSearchParams({ v });
    if (idArg) qs.set('id', idArg);
    if (filter) qs.set('f', filter);
    navigate('sales', `?${qs.toString()}`);
  }, [navigate]);

  const loadStatus = useCallback(() => {
    kw.status().then(setStatus).catch((e) => (e instanceof AuthError ? onAuthError() : setErr(errText(e))));
  }, [onAuthError]);
  useEffect(loadStatus, [loadStatus]);

  if (err) return <div className="kw-root"><div className="kw-phone"><p className="kw-err">{err}</p></div></div>;
  if (!status) return <div className="kw-root"><div className="kw-phone"><div className="kw-think"><i />Loading…</div></div></div>;

  const isAdmin = SALES_ADMIN_VIEWS.includes(view);
  // Admin screens don't need a rep profile; the rep's own screens do.
  const needsSetup = !status.profile && !isAdmin;

  let body;
  if (needsSetup || view === 'setup') {
    body = <Setup existing={status.profile} onCancel={status.profile || canTeam ? () => go(status.profile ? 'today' : 'overview') : undefined}
      onDone={() => { loadStatus(); go('today'); }} />;
  } else if (view === 'overview') {
    body = <SalesOverview targets={status.targets} onOpen={(v, f) => go(v, undefined, f)} />;
  } else if (view === 'pipeline') {
    body = <PipelineView key={preset} preset={preset} />;
  } else if (view === 'messages') {
    body = <MessageLog key={preset} preset={preset} />;
  } else if (view === 'optouts') {
    body = <OptOutList />;
  } else if (view === 'reps') {
    body = <RepsView />;
  } else if (view === 'settings') {
    body = <SalesSettings onSaved={loadStatus} />;
  } else if (view === 'review' && id) {
    body = <Review key={id} messageId={id} onBack={() => go('today')} onNext={(next) => (next ? go('review', next) : go('today'))} onClient={(cid) => go('client', cid)} />;
  } else if (view === 'clients') {
    body = <ClientList onOpen={(cid) => go('client', cid)} onAdd={() => go('add')} />;
  } else if (view === 'client' && id) {
    body = <ClientDetail key={id} id={id} status={status} onBack={() => (window.history.length > 1 ? window.history.back() : go('clients'))}
      onReview={(mid) => go('review', mid)} onDeleted={() => go('clients')} />;
  } else if (view === 'add') {
    body = <AddClient onCancel={() => go('clients')} onDone={(cid) => go('client', cid)} />;
  } else if (view === 'agent') {
    body = <AgentView status={status} onReview={(mid) => go('review', mid)} onClient={(cid) => go('client', cid)} onBoard={() => go('board')} />;
  } else if (view === 'board') {
    body = <Board onClient={(cid) => go('client', cid)} onAgent={() => go('agent')} />;
  } else if (view === 'score') {
    body = <Scoreboard targets={status.targets} />;
  } else {
    body = <Today profile={status.profile!} onReview={(mid) => go('review', mid)} onAdd={() => go('add')} onClient={(cid) => go('client', cid)} onScore={() => go('score')} onAgent={() => go('agent')} />;
  }

  const repChrome = !isAdmin && !needsSetup && view !== 'setup';
  const navView = salesNavView(search, canTeam);
  return (
    <div className={`kw-root ${isAdmin || view === 'board' ? 'is-wide' : ''}`}>
      {(repChrome || (isAdmin && status.sms.mode === 'outbox')) && (
        <div className="kw-topline">
          {/* On phones the sidebar is a drawer, so reps get thumb-reachable tabs here. */}
          {repChrome && (
            <nav className="kw-tabs kw-mobile-only" aria-label="Follow-ups">
              {REP_TABS.map((t) => (
                <button key={t.v} type="button" aria-current={navView === t.v ? 'page' : undefined} onClick={() => go(t.v)}>
                  <Icon name={t.icon} size={16} /> {t.label}
                </button>
              ))}
            </nav>
          )}
          <div className="kw-topline-r">
            {status.sms.mode === 'outbox' && (
              <span className="kw-mode" title="No SMS provider is connected yet. Approved texts are recorded but not delivered.">Test mode: texts aren’t delivered</span>
            )}
          </div>
        </div>
      )}
      {body}
      {repChrome && status.profile && view !== 'add' && view !== 'review' && (
        <button type="button" className="kw-fab" aria-label="Add a client" onClick={() => go('add')}><Icon name="plus" size={24} /></button>
      )}
    </div>
  );
}
