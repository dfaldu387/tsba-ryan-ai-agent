import { useEffect, useState, type ReactNode } from 'react';
import type { AdminOverview, AuthenticatedUser } from '@tsba/shared';
import { AuthError, getOverview } from '../api';
import { Icon, usePref, type IconName } from '../ui';
import { useConsole } from '../lib/console';
import { AlertSettings } from './AlertSettings';
import { PlantContacts } from './PlantContacts';
import './settings.css';

/**
 * Settings, split into sections with a side menu (top chips on phones) instead
 * of one very long column. The alert form is the big one, so it gets its own
 * section; the read-only runtime/connection facts become status tiles.
 */

type SectionId = 'alerts' | 'contacts' | 'system' | 'account';

const SECTIONS: { id: SectionId; label: string; icon: IconName; hint: string }[] = [
  { id: 'alerts', label: 'Monitoring alerts', icon: 'bell', hint: 'Who is emailed, when, and what’s in the email' },
  { id: 'contacts', label: 'Plant contacts', icon: 'users', hint: 'Owner details used in alerts' },
  { id: 'system', label: 'Connections & system', icon: 'link', hint: 'AI engine, storage, Google' },
  { id: 'account', label: 'Your profile', icon: 'user', hint: 'Name, password, your access' },
];

type Tone = 'ok' | 'warn' | 'neutral';

function Tile({ icon, label, value, tone, note }: { icon: IconName; label: string; value: ReactNode; tone: Tone; note?: ReactNode }) {
  return (
    <div className={`st-tile t-${tone}`}>
      <span className="st-tile-ic" aria-hidden="true"><Icon name={icon} size={18} /></span>
      <div className="st-tile-body">
        <span className="st-tile-label">{label}</span>
        <span className="st-tile-value">{value}</span>
        {note && <span className="st-tile-note">{note}</span>}
      </div>
      <span className="st-tile-state">{tone === 'ok' ? 'OK' : tone === 'warn' ? 'Needs setup' : '—'}</span>
    </div>
  );
}

export function SettingsTab({ user, onAuthError }: { user: AuthenticatedUser; onAuthError: () => void }) {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState('');
  const [section, setSection] = usePref<SectionId>('settings.section', 'alerts');
  const { navigate } = useConsole();
  // 'account' now lives on its own Profile page; a remembered 'account' falls back to alerts.
  const current = SECTIONS.find((s) => s.id === section && s.id !== 'account') ?? SECTIONS[0];

  useEffect(() => {
    getOverview()
      .then(setData)
      .catch((err) => {
        if (err instanceof AuthError) return onAuthError();
        setError('Couldn’t load the system status.');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const drive = data?.connections.find((c) => c.provider === 'google-drive');
  const gmail = data?.connections.find((c) => c.provider === 'gmail');
  const googleConfigured = Boolean(drive?.configured);

  return (
    <div className="st-page">
      <nav className="st-nav" aria-label="Settings sections">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`st-nav-item${s.id === current.id ? ' on' : ''}`}
            aria-current={s.id === current.id ? 'page' : undefined}
            onClick={() => (s.id === 'account' ? navigate('profile') : setSection(s.id))}
          >
            <Icon name={s.icon} size={17} />
            <span className="st-nav-text">
              <strong>{s.label}</strong>
              <span>{s.hint}</span>
            </span>
          </button>
        ))}
      </nav>

      <div className="st-content">
        {current.id === 'alerts' && <AlertSettings user={user} onAuthError={onAuthError} />}

        {current.id === 'contacts' && <PlantContacts user={user} onAuthError={onAuthError} />}

        {current.id === 'system' && (
          <section className="card st-card">
            <header className="st-head">
              <h2>Connections &amp; system</h2>
              <p>How the agent is running right now. These are set in the server <code>.env</code>; change them there and restart.</p>
            </header>
            {error && <p className="err">{error}</p>}
            {!data && !error && <div className="st-tiles">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="st-tile st-skel" />)}</div>}
            {data && (
              <>
                <h3 className="st-sub">Runtime</h3>
                <div className="st-tiles">
                  <Tile
                    icon="ai"
                    label="Drafting engine"
                    value={data.system.anthropic ? `Claude · ${data.system.model}` : 'Offline fallback'}
                    tone={data.system.anthropic ? 'ok' : 'warn'}
                    note={data.system.anthropic ? undefined : 'Set ANTHROPIC_API_KEY for AI drafts and fixes'}
                  />
                  <Tile icon="book" label="Embeddings" value={data.system.embeddingProvider} tone="neutral" />
                  <Tile
                    icon="shield"
                    label="Storage"
                    value={data.system.usesPostgres ? 'PostgreSQL' : 'In-memory'}
                    tone={data.system.usesPostgres ? 'ok' : 'warn'}
                    note={data.system.usesPostgres ? 'Durable' : 'Resets on restart'}
                  />
                </div>
                <h3 className="st-sub">Google</h3>
                <div className="st-tiles">
                  <Tile icon="settings" label="OAuth client" value={googleConfigured ? 'Configured' : 'Not configured'} tone={googleConfigured ? 'ok' : 'warn'} />
                  <Tile
                    icon="doc"
                    label="Google Drive"
                    value={drive?.connected ? 'Connected' : 'Not connected'}
                    tone={drive?.connected ? 'ok' : 'warn'}
                    note={drive?.account_email ?? undefined}
                  />
                  <Tile
                    icon="mail"
                    label="Gmail"
                    value={gmail?.connected ? 'Connected' : 'Not connected'}
                    tone={gmail?.connected ? 'ok' : 'warn'}
                    note={gmail?.account_email ?? undefined}
                  />
                </div>
                {!googleConfigured && (
                  <p className="st-note">
                    Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to the server <code>.env</code> and restart to enable the connectors.
                  </p>
                )}
              </>
            )}
          </section>
        )}

      </div>
    </div>
  );
}
