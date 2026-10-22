import { useEffect, useState } from 'react';
import type { AdminOverview, AuthenticatedUser } from '@tsba/shared';
import { AuthError, getOverview } from '../api';

function Row({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' }) {
  return (
    <div className="set-row">
      <span className="set-label">{label}</span>
      <span className={`set-value ${tone ? `tone-${tone}` : ''}`}>{value}</span>
    </div>
  );
}

export function SettingsTab({ user, onAuthError }: { user: AuthenticatedUser; onAuthError: () => void }) {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    getOverview()
      .then(setData)
      .catch((err) => {
        if (err instanceof AuthError) return onAuthError();
        setError('Couldn’t load settings.');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const drive = data?.connections.find((c) => c.provider === 'google-drive');
  const googleConfigured = Boolean(drive?.configured);

  return (
    <div className="col">
      {error && <span className="err">{error}</span>}

      <section className="card">
        <div className="card-h">
          <h2>System</h2>
          <span className="eyebrow">Runtime</span>
        </div>
        <p className="section-lead">How the agent is currently configured. These are set in the server <code>.env</code>.</p>
        {data && (
          <div className="set-list">
            <Row
              label="Drafting engine"
              value={data.system.anthropic ? `Claude · ${data.system.model}` : 'Offline fallback'}
              tone={data.system.anthropic ? 'ok' : 'warn'}
            />
            <Row label="Embedding provider" value={data.system.embeddingProvider} />
            <Row
              label="Storage"
              value={data.system.usesPostgres ? 'PostgreSQL (durable)' : 'In-memory (resets on restart)'}
              tone={data.system.usesPostgres ? 'ok' : 'warn'}
            />
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-h">
          <h2>Integrations</h2>
          <span className="eyebrow">Google OAuth</span>
        </div>
        <p className="section-lead">
          The Google OAuth client powering the Drive &amp; Gmail connectors.
        </p>
        <div className="set-list">
          <Row
            label="Google OAuth client"
            value={googleConfigured ? 'Configured' : 'Not configured'}
            tone={googleConfigured ? 'ok' : 'warn'}
          />
          <Row label="Google Drive" value={drive?.connected ? `Connected · ${drive.account_email ?? ''}` : 'Not connected'} tone={drive?.connected ? 'ok' : undefined} />
          <Row
            label="Gmail"
            value={
              data?.connections.find((c) => c.provider === 'gmail')?.connected
                ? `Connected · ${data.connections.find((c) => c.provider === 'gmail')?.account_email ?? ''}`
                : 'Not connected'
            }
            tone={data?.connections.find((c) => c.provider === 'gmail')?.connected ? 'ok' : undefined}
          />
        </div>
        {!googleConfigured && (
          <p className="conn-hint">
            Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to the server{' '}
            <code>.env</code> and restart to enable the connectors.
          </p>
        )}
      </section>

      <section className="card">
        <div className="card-h">
          <h2>Your account</h2>
          <span className="eyebrow">Session</span>
        </div>
        <div className="set-list">
          <Row label="Name" value={user.name || '—'} />
          <Row label="Email" value={user.email} />
          <Row label="Role" value={user.role} />
          <Row label="Permissions" value={user.permissions.join(', ')} />
        </div>
      </section>
    </div>
  );
}
