import { useEffect, useState } from 'react';
import {
  CONNECTION_LABELS,
  hasPermission,
  type AuthenticatedUser,
  type ConnectionProvider,
  type ConnectionStatus,
} from '@tsba/shared';
import { AuthError, disconnect, listConnections, startConnect } from '../api';
import { GmailScanner } from './GmailScanner';

// The connections section of the Admin panel: connect Google Drive & Gmail,
// then (once connected) select Drive folders / scan Gmail labels into the
// knowledge base. Rendered inline inside the Admin panel's column — returns a
// <section> rather than its own <main>.

/** Per-scope short key + plain-language description, shown as a bulleted row
 *  on each connector card (mirrors Google's own consent wording). */
const SCOPE_META: Record<string, { key: string; desc: string }> = {
  'https://www.googleapis.com/auth/drive.readonly': { key: 'drive.readonly', desc: 'list and download files' },
  'https://www.googleapis.com/auth/drive': { key: 'drive', desc: 'read files & run OCR' },
  'https://www.googleapis.com/auth/gmail.readonly': { key: 'gmail.readonly', desc: 'read messages' },
  'https://www.googleapis.com/auth/gmail.send': { key: 'gmail.send', desc: 'send email — approval-gated' },
  'https://www.googleapis.com/auth/gmail.compose': { key: 'gmail.compose', desc: 'drafts only — never sends' },
};

function scopeMeta(scope: string): { key: string; desc: string } {
  return (
    SCOPE_META[scope] ?? { key: scope.replace('https://www.googleapis.com/auth/', ''), desc: '' }
  );
}

/** Scopes we hide from the card (identity scopes carry no user-facing meaning). */
function isMeaningfulScope(scope: string): boolean {
  return !/openid|userinfo|(^|\/)(email|profile)$/.test(scope);
}

// Display order on the group card: Gmail first, then Drive (matches the header).
const PROVIDER_ORDER: ConnectionProvider[] = ['gmail', 'google-drive'];

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

// ─── Provider glyphs ─────────────────────────────────────────────────────────

function GoogleGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path fill="#4285F4" d="M23.5 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.88c2.27-2.09 3.55-5.17 3.55-8.87Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.08 7.95-2.91l-3.88-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.26v3.09A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.27 14.29A7.21 7.21 0 0 1 4.89 12c0-.8.14-1.57.38-2.29V6.62H1.26A12 12 0 0 0 0 12c0 1.94.46 3.77 1.26 5.38l4.01-3.09Z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.26 6.62l4.01 3.09C6.22 6.86 8.87 4.75 12 4.75Z" />
    </svg>
  );
}

function GmailGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path fill="#EA4335" d="M2 6.5 12 13l10-6.5V6a2 2 0 0 0-2-2h-.5L12 9 4.5 4H4a2 2 0 0 0-2 2v.5Z" />
      <path fill="#C5221F" d="M2 6.5V18a2 2 0 0 0 2 2h1.5V8.4L2 6.5Z" />
      <path fill="#FBBC04" d="M22 6.5V18a2 2 0 0 1-2 2h-1.5V8.4L22 6.5Z" />
      <path fill="#4285F4" d="M5.5 20V8.4L12 13l6.5-4.6V20H5.5Z" opacity="0" />
    </svg>
  );
}

function DriveGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path fill="#0066DA" d="m6.4 20 3.8-6.6H24l-3.8 6.6H6.4Z" />
      <path fill="#00AC47" d="M12 13.4 8.2 20 4.4 13.4 8.2 6.8 12 13.4Z" transform="translate(-4.3 0)" />
      <path fill="#EA4335" d="M9.9 2 3.5 13.4h7.6L17.5 2H9.9Z" opacity="0" />
      <path fill="#FFBA00" d="M10.2 2 3.8 13.4l3.8 6.6 6.4-11.4L10.2 2Z" />
      <path fill="#00AC47" d="M10.2 2h7.3L24 13.4H16.7L10.2 2Z" />
      <path fill="#0066DA" d="M3.8 13.4 7.6 6.8h8.9l-3.8 6.6H3.8Z" opacity="0" />
    </svg>
  );
}

function ProviderGlyph({ provider }: { provider: ConnectionProvider }) {
  return provider === 'gmail' ? <GmailGlyph /> : <DriveGlyph />;
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
  const [busy, setBusy] = useState<ConnectionProvider | 'all' | null>(null);
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

  // "Disconnect Google": revoke every connected provider in one action.
  async function onDisconnectAll(connected: ConnectionStatus[]) {
    setBusy('all');
    setError('');
    try {
      for (const c of connected) await disconnect(c.provider);
      setBanner({ tone: 'ok', text: 'Google Workspace: disconnected.' });
      await load();
    } catch (err) {
      if (err instanceof AuthError) return onAuthError();
      setError('Couldn’t disconnect.');
    } finally {
      setBusy(null);
    }
  }

  // Order the connectors for display (Gmail, then Drive), keeping any unknown
  // providers the server might add at the end.
  const ordered = rows
    ? [...rows].sort((a, b) => {
        const ia = PROVIDER_ORDER.indexOf(a.provider);
        const ib = PROVIDER_ORDER.indexOf(b.provider);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      })
    : null;

  const configured = ordered?.filter((c) => c.configured) ?? [];
  const connected = configured.filter((c) => c.connected);
  const anyConfigured = configured.length > 0;
  const allConnected = anyConfigured && connected.length === configured.length;

  const workspaceBadge = !anyConfigured
    ? null
    : allConnected
      ? { tone: 'green' as const, text: 'Fully connected' }
      : connected.length > 0
        ? { tone: 'amber' as const, text: 'Partially connected' }
        : { tone: 'amber' as const, text: 'Not connected' };

  // Most-recent connection timestamp, for the group-card footer.
  const lastConnectedAt = connected
    .map((c) => c.connected_at)
    .filter((t): t is string => !!t)
    .sort()
    .at(-1);

  const gmailRow = ordered?.find((c) => c.provider === 'gmail');

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

      {rows === null && !error && <p className="how">Loading…</p>}

      {ordered && (
        <div className="ws-card">
          <div className="ws-head">
            <span className="ws-logo">
              <GoogleGlyph />
            </span>
            <div className="ws-head-text">
              <h3>Google Workspace</h3>
              <p>Gmail and Drive, together or separately. Read-only, plus drafts in Gmail. Revocable any time.</p>
            </div>
            {workspaceBadge && (
              <span className={`pill ${workspaceBadge.tone}`}>{workspaceBadge.text}</span>
            )}
          </div>

          <div className="ws-grid">
            {ordered.map((c) => {
              const scopes = c.scopes.filter(isMeaningfulScope);
              return (
                <div key={c.provider} className="ws-conn">
                  <div className="ws-conn-head">
                    <span className="ws-conn-ico">
                      <ProviderGlyph provider={c.provider} />
                    </span>
                    <div className="ws-conn-id">
                      <span className="ws-conn-name">{c.label}</span>
                      <span className="ws-conn-desc">{c.purpose}</span>
                    </div>
                    <span className={`pill ${c.connected ? 'green' : 'amber'}`}>
                      {c.connected ? 'Connected' : 'Not connected'}
                    </span>
                  </div>

                  {c.connected && c.account_email && (
                    <div className="ws-conn-acct">{c.account_email}</div>
                  )}

                  {c.connected && scopes.length > 0 && (
                    <ul className="ws-scopes">
                      {scopes.map((s) => {
                        const m = scopeMeta(s);
                        return (
                          <li key={s}>
                            <span className="ws-dot" />
                            <code>{m.key}</code>
                            {m.desc && <span className="ws-scope-desc">{m.desc}</span>}
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  {!c.configured && (
                    <p className="ws-hint">
                      Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to the
                      server <code>.env</code> to enable this connector. See <code>.env.example</code>{' '}
                      for the Google Cloud setup steps.
                    </p>
                  )}

                  <div className="ws-conn-foot">
                    {!c.configured ? (
                      <span className="eyebrow">Not configured</span>
                    ) : !canManage ? (
                      <span className="eyebrow">Admin/Manager only</span>
                    ) : c.connected ? (
                      <button
                        className="ghost"
                        disabled={busy === c.provider || busy === 'all'}
                        onClick={() => onDisconnect(c.provider)}
                      >
                        {busy === c.provider ? '…' : `Disconnect ${c.label}`}
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
                </div>
              );
            })}
          </div>

          {(lastConnectedAt || (canManage && connected.length > 0)) && (
            <div className="ws-foot">
              <span className="ws-foot-meta">
                {lastConnectedAt
                  ? `Last connected ${new Date(lastConnectedAt).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}`
                  : ''}
              </span>
              {canManage && connected.length > 0 && (
                <button
                  className="ws-disconnect-all"
                  disabled={busy !== null}
                  onClick={() => onDisconnectAll(connected)}
                >
                  {busy === 'all' ? 'Disconnecting…' : 'Disconnect Google'}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Gmail scanning stays here; Drive folder browsing lives on Knowledge base. */}
      {gmailRow?.connected && canIngest && (
        <div className="conn-tools">
          <GmailScanner onAuthError={onAuthError} />
        </div>
      )}
    </section>
  );
}
