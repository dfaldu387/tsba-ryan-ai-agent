import { useEffect, useState } from 'react';
import {
  CONNECTION_LABELS,
  hasPermission,
  type AuthenticatedUser,
  type ConnectionProvider,
  type ConnectionStatus,
} from '@tsba/shared';
import { AuthError, disconnect, listConnections, startConnect } from '../api';
import { DriveBrowser } from './DriveBrowser';
import { GmailScanner } from './GmailScanner';

// The connections section of the Admin panel: connect Google Drive & Gmail,
// then (once connected) select Drive folders / scan Gmail labels into the
// knowledge base. Rendered inline inside the Admin panel's column — returns a
// <section> rather than its own <main>.

const SCOPE_LABELS: Record<string, string> = {
  'https://www.googleapis.com/auth/drive.readonly': 'Read Drive files',
  'https://www.googleapis.com/auth/drive': 'Read Drive files & OCR',
  'https://www.googleapis.com/auth/gmail.readonly': 'Read email',
  'https://www.googleapis.com/auth/gmail.send': 'Send email',
  openid: 'Identity',
  email: 'Email address',
  profile: 'Basic profile',
};

function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope.replace('https://www.googleapis.com/auth/', '');
}

const BANNERS: Record<string, { tone: 'ok' | 'warn'; text: string }> = {
  connected: { tone: 'ok', text: 'Connected successfully.' },
  denied: { tone: 'warn', text: 'Access was denied on the Google consent screen.' },
  error: { tone: 'warn', text: 'Something went wrong completing the connection. Please try again.' },
  invalid_state: { tone: 'warn', text: 'The connection link expired. Please try again.' },
  no_code: { tone: 'warn', text: 'Google did not return an authorization code. Please try again.' },
};

/** Read ?status/&provider from the OAuth callback redirect, then clean the URL. */
function readCallbackBanner(): { tone: 'ok' | 'warn'; text: string } | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('status');
    if (!status) return null;
    const providerKey = params.get('provider') as ConnectionProvider | null;
    const name = providerKey ? CONNECTION_LABELS[providerKey] ?? '' : '';
    const base = BANNERS[status];
    window.history.replaceState({}, '', `${window.location.pathname}?tab=admin`);
    if (!base) return null;
    return { tone: base.tone, text: name ? `${name}: ${base.text}` : base.text };
  } catch {
    return null;
  }
}

export function ConnectionsManager({
  user,
  onAuthError,
}: {
  user: AuthenticatedUser;
  onAuthError: () => void;
}) {
  const canManage = hasPermission(user.role, 'manage_connections');
  const canIngest = hasPermission(user.role, 'run_ingest');
  const [rows, setRows] = useState<ConnectionStatus[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<ConnectionProvider | null>(null);
  const [banner, setBanner] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(() =>
    readCallbackBanner(),
  );

  const load = () =>
    listConnections()
      .then((r) => setRows(r.connections))
      .catch((err) => {
        if (err instanceof AuthError) return onAuthError();
        setError('Couldn’t load connections.');
      });

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onConnect(provider: ConnectionProvider) {
    setBusy(provider);
    setError('');
    try {
      const { url } = await startConnect(provider);
      window.location.href = url; // full-page redirect to Google's consent screen
    } catch (err) {
      if (err instanceof AuthError) return onAuthError();
      setError('Couldn’t start the connection.');
      setBusy(null);
    }
  }

  async function onDisconnect(provider: ConnectionProvider) {
    setBusy(provider);
    setError('');
    try {
      await disconnect(provider);
      setBanner({ tone: 'ok', text: `${CONNECTION_LABELS[provider]}: disconnected.` });
      await load();
    } catch (err) {
      if (err instanceof AuthError) return onAuthError();
      setError('Couldn’t disconnect.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card" id="connections">
      <div className="card-h">
        <h2>Connections &amp; knowledge sources</h2>
        <span className="eyebrow">Google Drive &amp; Gmail</span>
      </div>
      <p className="section-lead">
        Connect <b>Google Drive</b> (documents) and <b>Gmail</b> (email) as knowledge sources. Once
        connected, select Drive folders and scan Gmail labels to ingest their content into the RAG
        knowledge base. Read-only — nothing is sent without approval.
      </p>

      {banner && (
        <div className={`pill ${banner.tone === 'ok' ? 'green' : 'amber'}`} style={{ marginTop: 12 }}>
          {banner.text}
        </div>
      )}
      {error && <span className="err">{error}</span>}

      <div className="conn-list">
        {rows?.map((c) => (
          <div key={c.provider} className="conn-item">
            <div className="conn-head">
              <div>
                <span className="conn-name">{c.label}</span>
                <span className={`pill ${c.connected ? 'green' : 'amber'}`}>
                  {c.connected ? 'Connected' : 'Not connected'}
                </span>
              </div>
              {!c.configured ? (
                <span className="eyebrow">Not configured</span>
              ) : !canManage ? (
                <span className="eyebrow">Admin/Manager only</span>
              ) : c.connected ? (
                <button
                  className="btn ghost"
                  disabled={busy === c.provider}
                  onClick={() => onDisconnect(c.provider)}
                >
                  {busy === c.provider ? '…' : 'Disconnect'}
                </button>
              ) : (
                <button
                  className="btn"
                  disabled={busy === c.provider}
                  onClick={() => onConnect(c.provider)}
                >
                  {busy === c.provider ? '…' : `Connect ${c.label}`}
                </button>
              )}
            </div>

            <p className="conn-purpose">{c.purpose}</p>

            {c.connected && (
              <div className="conn-meta">
                {c.account_email && (
                  <span>
                    Account: <b>{c.account_email}</b>
                  </span>
                )}
                {c.connected_at && <span>Connected {new Date(c.connected_at).toLocaleDateString()}</span>}
                {c.scopes.length > 0 && (
                  <span className="conn-scopes">
                    {c.scopes
                      .filter((s) => !/openid|userinfo|(^|\/)(email|profile)$/.test(s))
                      .map((s) => (
                        <span key={s} className="scope-chip">
                          {scopeLabel(s)}
                        </span>
                      ))}
                  </span>
                )}
              </div>
            )}

            {!c.configured && (
              <p className="conn-hint">
                Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to the server{' '}
                <code>.env</code> to enable this connector. See <code>.env.example</code> for the Google
                Cloud setup steps.
              </p>
            )}

            {c.provider === 'google-drive' && c.connected && <DriveBrowser onAuthError={onAuthError} />}
            {c.provider === 'gmail' && c.connected && canIngest && (
              <GmailScanner onAuthError={onAuthError} />
            )}
          </div>
        ))}
        {rows === null && !error && <p className="how">Loading…</p>}
      </div>
    </section>
  );
}
