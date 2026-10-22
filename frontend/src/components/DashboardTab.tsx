import { useEffect, useState } from 'react';
import type { AdminOverview } from '@tsba/shared';
import { AuthError, getOverview } from '../api';

/** A small labelled metric tile. */
function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

export function DashboardTab({ onAuthError }: { onAuthError: () => void }) {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    getOverview()
      .then(setData)
      .catch((err) => {
        if (err instanceof AuthError) return onAuthError();
        setError('Couldn’t load the overview.');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const agent = data?.agent;

  return (
    <div className="col">
      {/* ── Who the agent is ─────────────────────────────────────────────── */}
      <section className="card agent-hero">
        <div className="agent-mark" aria-hidden="true">AI</div>
        <div className="agent-intro">
          <span className="eyebrow">Agent overview</span>
          <h2>{agent?.name ?? 'TSBA Technical Support AI'}</h2>
          <p className="agent-tagline">{agent?.tagline ?? ''}</p>
          <p className="agent-role">{agent?.role ?? ''}</p>
        </div>
      </section>

      {error && <span className="err">{error}</span>}

      {/* ── KPI strip ────────────────────────────────────────────────────── */}
      {data && (
        <div className="kpi-row">
          <div className="kpi">
            <span className="kpi-value">{data.knowledge?.documents ?? 0}</span>
            <span className="kpi-label">Documents</span>
          </div>
          <div className="kpi">
            <span className="kpi-value">{data.knowledge?.chunks ?? 0}</span>
            <span className="kpi-label">Knowledge chunks</span>
          </div>
          <div className="kpi">
            <span className="kpi-value">{data.users?.total ?? 0}</span>
            <span className="kpi-label">Users</span>
          </div>
          <div className="kpi">
            <span className="kpi-value">{data.drafts?.pending ?? 0}</span>
            <span className="kpi-label">Drafts awaiting</span>
          </div>
        </div>
      )}

      {/* ── What it does / guardrails ────────────────────────────────────── */}
      {agent && (
        <div className="admin-grid-2">
          <section className="card">
            <div className="card-h">
              <h2>What it can do</h2>
              <span className="eyebrow">Capabilities</span>
            </div>
            <ul className="feature-list">
              {(agent.capabilities ?? []).map((c, i) => (
                <li key={i}>
                  <span className="tick" aria-hidden="true">✓</span>
                  {c}
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <div className="card-h">
              <h2>Guardrails</h2>
              <span className="eyebrow">Always on</span>
            </div>
            <ul className="feature-list guard">
              {(agent.guardrails ?? []).map((g, i) => (
                <li key={i}>
                  <span className="tick shield" aria-hidden="true">●</span>
                  {g}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      {/* ── Live system status ───────────────────────────────────────────── */}
      <section className="card">
        <div className="card-h">
          <h2>System status</h2>
          <span className="eyebrow">Live</span>
        </div>
        {data?.system ? (
          <div className="stat-row">
            <Stat
              label="Drafting engine"
              value={data.system.anthropic ? 'Claude · live' : 'Offline fallback'}
              hint={data.system.anthropic ? data.system.model : 'Set ANTHROPIC_API_KEY'}
            />
            <Stat label="Embeddings" value={data.system.embeddingProvider} />
            <Stat
              label="Storage"
              value={data.system.usesPostgres ? 'PostgreSQL' : 'In-memory'}
              hint={data.system.usesPostgres ? 'durable' : 'resets on restart'}
            />
          </div>
        ) : (
          !error && <p className="how">Loading…</p>
        )}
      </section>

      {/* ── Knowledge base ───────────────────────────────────────────────── */}
      {data && (
        <section className="card">
          <div className="card-h">
            <h2>Knowledge base</h2>
            <span className="eyebrow">Ingested sources</span>
          </div>
          <div className="stat-row">
            <Stat label="Documents" value={data.knowledge?.documents ?? 0} />
            <Stat label="Knowledge chunks" value={data.knowledge?.chunks ?? 0} />
            <Stat label="Drive folder sources" value={data.knowledge?.folderSources ?? 0} />
            <Stat label="From Drive" value={data.knowledge?.driveDocuments ?? 0} />
            <Stat label="From Email" value={data.knowledge?.emailDocuments ?? 0} />
          </div>
        </section>
      )}

      {/* ── Draft activity ───────────────────────────────────────────────── */}
      {data && (
        <section className="card">
          <div className="card-h">
            <h2>Draft activity</h2>
            <span className="eyebrow">All time</span>
          </div>
          <div className="stat-row">
            <Stat label="Total" value={data.drafts?.total ?? 0} />
            <Stat label="Awaiting approval" value={data.drafts?.pending ?? 0} />
            <Stat label="Approved / sent" value={data.drafts?.sent ?? 0} />
            <Stat label="To team" value={data.drafts?.team ?? 0} />
          </div>
        </section>
      )}
    </div>
  );
}
