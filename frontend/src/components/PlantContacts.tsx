import { useEffect, useMemo, useState } from 'react';
import type { AuthenticatedUser, PlantContact, PlantContacts as PlantContactsMap } from '@tsba/shared';
import { AuthError, getPlantContacts, updatePlantContacts, getSolarOverview, type SolarStation } from '../api';

/**
 * Admin-maintained owner/contact details per plant. Used by the alert emailer
 * when the monitoring platform doesn't expose owner details (and to override
 * them). Lists the fleet's plants; by default shows the ones that already have a
 * contact, with a search to find any other plant to add one.
 */
export function PlantContacts({ user, onAuthError }: { user: AuthenticatedUser; onAuthError: () => void }) {
  const canEdit = user.permissions.includes('manage_connections');
  const [stations, setStations] = useState<SolarStation[]>([]);
  const [contacts, setContacts] = useState<PlantContactsMap>({});
  const [baseline, setBaseline] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([getPlantContacts(), getSolarOverview()])
      .then(([c, ov]) => {
        setContacts(c.contacts);
        setBaseline(JSON.stringify(c.contacts));
        setStations(ov.stations.slice().sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch((err) => {
        if (err instanceof AuthError) return onAuthError();
        setError('Couldn’t load plant contacts.');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const keyOf = (s: SolarStation) => `${s.provider}:${s.id}`;
  const dirty = useMemo(() => JSON.stringify(contacts) !== baseline, [contacts, baseline]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q) return stations.filter((s) => s.name.toLowerCase().includes(q) || s.provider.toLowerCase().includes(q));
    // No search: show plants that already have a contact.
    return stations.filter((s) => contacts[keyOf(s)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, stations, contacts]);

  const withContacts = useMemo(() => Object.values(contacts).filter((c) => c.name || c.email || c.phone).length, [contacts]);

  function edit(key: string, field: keyof PlantContact, value: string, plantName: string) {
    setContacts((prev) => {
      const next = { ...prev };
      const cur: PlantContact = { ...(next[key] ?? {}), plantName };
      (cur[field] as string) = value;
      next[key] = cur;
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError('');
    setStatus('');
    try {
      const { contacts: saved } = await updatePlantContacts(contacts);
      setContacts(saved);
      setBaseline(JSON.stringify(saved));
      setStatus('Saved · used in alert emails');
    } catch (err) {
      if (err instanceof AuthError) return onAuthError();
      setError((err as Error).message || 'Couldn’t save contacts.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card">
      <div className="card-h">
        <h2>Plant owner contacts</h2>
        <span className="eyebrow">Solar</span>
      </div>
      <p className="section-lead">
        Owner / contact details per plant, included in alert emails. These fill in (and override) what the
        monitoring platform exposes — useful where the platform returns no owner. {withContacts} saved.
      </p>

      {error && <span className="err">{error}</span>}

      <input
        type="search"
        placeholder="Search plants by name or platform to add a contact…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        disabled={!canEdit}
      />

      {visible.length === 0 ? (
        <p className="al-hint">{search ? 'No plants match.' : 'No contacts yet — search for a plant above to add one.'}</p>
      ) : (
        <div className="pc-list">
          {visible.map((s) => {
            const key = keyOf(s);
            const c = contacts[key] ?? {};
            return (
              <div className="pc-row" key={key}>
                <div className="pc-plant">
                  <span className="pc-name">{s.name}</span>
                  <span className="pc-meta">{s.provider} · {s.status}</span>
                </div>
                <div className="pc-fields">
                  <input type="text" placeholder="Owner name" value={c.name ?? ''} disabled={!canEdit}
                    onChange={(e) => edit(key, 'name', e.target.value, s.name)} />
                  <input type="email" placeholder="Email" value={c.email ?? ''} disabled={!canEdit}
                    onChange={(e) => edit(key, 'email', e.target.value, s.name)} />
                  <input type="text" placeholder="Phone" value={c.phone ?? ''} disabled={!canEdit}
                    onChange={(e) => edit(key, 'phone', e.target.value, s.name)} />
                  <input type="text" placeholder="Notes (optional)" value={c.notes ?? ''} disabled={!canEdit}
                    onChange={(e) => edit(key, 'notes', e.target.value, s.name)} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {canEdit && (
        <div className="al-actions">
          <button className="btn" onClick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save contacts'}</button>
          <span className={`al-saved ${status ? 'ok' : ''}`}>{status || (dirty ? 'Unsaved changes' : '')}</span>
        </div>
      )}
    </section>
  );
}
