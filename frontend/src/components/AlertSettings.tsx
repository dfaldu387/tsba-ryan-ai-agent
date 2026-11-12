import { useEffect, useMemo, useState } from 'react';
import type { AuthenticatedUser, SolarAlertSettings, AlertResolutionRule, IngestedDocument } from '@tsba/shared';
import { AuthError, getAlertSettings, updateAlertSettings, sendTestAlert, listDocuments } from '../api';

/**
 * Admin-editable configuration for the solar alert monitor: who receives alerts,
 * how often the fleet is scanned, how long an issue must persist before it's
 * emailed (separately for admins and customers), sunset quiet hours, and the
 * customer-alert toggle. Managers/admins can edit; everyone else sees it
 * read-only.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** iOS-style toggle. */
function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <span className="switch">
      <input type="checkbox" role="switch" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" />
    </span>
  );
}

function ToggleRow({ checked, onChange, title, desc }: { checked: boolean; onChange: (v: boolean) => void; title: string; desc: string }) {
  return (
    <label className="al-toggle-row">
      <Switch checked={checked} onChange={onChange} label={title} />
      <span className="al-toggle-text">
        <strong>{title}</strong>
        <span>{desc}</span>
      </span>
    </label>
  );
}

/**
 * Multi-email input: each address is a removable chip. Type and press Enter,
 * comma or Tab (or paste a list) to add; Backspace on an empty field removes the
 * last chip. Invalid or duplicate entries are reported inline, not added.
 */
function EmailChips({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState('');

  const commit = (raw: string): string => {
    const parts = raw.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (!parts.length) return '';
    const next = [...value];
    const bad: string[] = [];
    for (const p of parts) {
      if (!EMAIL_RE.test(p)) bad.push(p);
      else if (!next.includes(p)) next.push(p);
    }
    onChange(next);
    setErr(bad.length ? `Not a valid email: ${bad.join(', ')}` : '');
    return bad.length ? bad.join(', ') : '';
  };

  return (
    <>
      <div className={`al-chips ${disabled ? 'is-disabled' : ''}`}>
        {value.map((email) => (
          <span className="al-chip" key={email}>
            {email}
            {!disabled && (
              <button type="button" aria-label={`Remove ${email}`} onClick={() => onChange(value.filter((e) => e !== email))}>
                ×
              </button>
            )}
          </span>
        ))}
        {!disabled && (
          <input
            className="al-chip-input"
            inputMode="email"
            value={draft}
            placeholder={value.length ? 'Add another…' : 'name@example.com'}
            onChange={(e) => {
              const v = e.target.value;
              // A comma/newline typed or pasted commits the entry.
              if (/[,;\n]/.test(v)) setDraft(commit(v));
              else {
                setDraft(v);
                if (err) setErr('');
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Tab') {
                if (draft.trim()) {
                  e.preventDefault();
                  setDraft(commit(draft));
                }
              } else if (e.key === 'Backspace' && !draft && value.length) {
                onChange(value.slice(0, -1));
              }
            }}
            onBlur={() => draft.trim() && setDraft(commit(draft))}
          />
        )}
      </div>
      {err && <span className="al-chip-err">{err}</span>}
    </>
  );
}

/** Signature for dirty-tracking. */
const sig = (s: SolarAlertSettings, recipients: string[]): string =>
  JSON.stringify([s.enabled, s.intervalMin, s.recovery, s.quietNight, s.lat, s.lng, s.admin.delayMin, s.customer.enabled, s.customer.delayMin, s.includeSolution, s.attachResolution, s.resolutionRules, recipients.join(','), s.schedule.enabled, s.schedule.times.join(','), s.schedule.timezone, s.schedule.maxPerDay]);

export function AlertSettings({ user, onAuthError }: { user: AuthenticatedUser; onAuthError: () => void }) {
  const canEdit = user.permissions.includes('manage_connections');
  const [s, setS] = useState<SolarAlertSettings | null>(null);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [docs, setDocs] = useState<IngestedDocument[]>([]);
  const [baseline, setBaseline] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  // Raw text buffer for the send-times field, so typing commas isn't fought by re-render.
  const [timesText, setTimesText] = useState('');

  useEffect(() => {
    getAlertSettings()
      .then(({ settings }) => {
        setS(settings);
        setRecipients(settings.admin.recipients);
        setTimesText(settings.schedule.times.join(', '));
        setBaseline(sig(settings, settings.admin.recipients));
      })
      .catch((err) => {
        if (err instanceof AuthError) return onAuthError();
        setError('Couldn’t load alert settings.');
      });
    if (canEdit) listDocuments().then((r) => setDocs(r.documents)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = useMemo(() => (s ? sig(s, recipients) !== baseline : false), [s, recipients, baseline]);

  if (!s) {
    return (
      <section className="card">
        <div className="card-h">
          <h2>Monitoring alerts</h2>
          <span className="eyebrow">Solar</span>
        </div>
        {error ? <span className="err">{error}</span> : <p className="section-lead">Loading…</p>}
      </section>
    );
  }

  const patch = <K extends keyof SolarAlertSettings>(k: K, v: SolarAlertSettings[K]) => setS({ ...s, [k]: v });
  const patchSchedule = (p: Partial<SolarAlertSettings['schedule']>) => setS({ ...s, schedule: { ...s.schedule, ...p } });
  const onTimesChange = (txt: string) => {
    setTimesText(txt);
    patchSchedule({ times: txt.split(',').map((t) => t.trim()).filter(Boolean) });
  };

  async function save() {
    if (!s) return;
    setSaving(true);
    setError('');
    setStatus('');
    try {
      const { settings } = await updateAlertSettings({
        enabled: s.enabled,
        intervalMin: s.intervalMin,
        recovery: s.recovery,
        quietNight: s.quietNight,
        lat: s.lat,
        lng: s.lng,
        admin: { recipients, delayMin: s.admin.delayMin },
        customer: { enabled: s.customer.enabled, delayMin: s.customer.delayMin },
        includeSolution: s.includeSolution,
        attachResolution: s.attachResolution,
        resolutionRules: s.resolutionRules,
        schedule: s.schedule,
      });
      setS(settings);
      setRecipients(settings.admin.recipients);
      setTimesText(settings.schedule.times.join(', '));
      setBaseline(sig(settings, settings.admin.recipients));
      setStatus('Saved · applies on the next scan');
    } catch (err) {
      if (err instanceof AuthError) return onAuthError();
      setError((err as Error).message || 'Couldn’t save settings.');
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setError('');
    setStatus('');
    try {
      const r = await sendTestAlert();
      if (r.sent) setStatus(`Test email sent to ${r.recipients?.join(', ')}`);
      else setError(`Test failed: ${r.detail ?? r.error}`);
    } catch (err) {
      if (err instanceof AuthError) return onAuthError();
      setError((err as Error).message || 'Test email failed.');
    } finally {
      setTesting(false);
    }
  }

  // Compact read-only view for non-editors.
  if (!canEdit) {
    return (
      <section className="card">
        <div className="card-h">
          <h2>Monitoring alerts</h2>
          <span className="eyebrow">Solar</span>
        </div>
        <div className="al-banner" data-on={s.enabled}>
          <div className="al-banner-main">
            <span className="al-dot" />
            <div>
              <div className="al-banner-title">{s.enabled ? 'Alerts active' : 'Alerts disabled'}</div>
              <div className="al-banner-sub">
                {s.enabled ? `Every ${s.intervalMin} min · notify after ${s.admin.delayMin} min offline` : 'No emails are sent'}
              </div>
            </div>
          </div>
        </div>
        <div className="set-list">
          <div className="set-row"><span className="set-label">Admin recipients</span><span className="set-value">{recipients.join(', ') || '—'}</span></div>
          <div className="set-row"><span className="set-label">Delivery schedule</span><span className="set-value">{s.schedule.enabled ? `Digest at ${s.schedule.times.join(', ')} (${s.schedule.timezone}) · max ${s.schedule.maxPerDay}/day` : 'One email per plant'}</span></div>
          <div className="set-row"><span className="set-label">Sunset quiet hours</span><span className="set-value">{s.quietNight ? 'On' : 'Off'}</span></div>
          <div className="set-row"><span className="set-label">Recovery emails</span><span className="set-value">{s.recovery ? 'On' : 'Off'}</span></div>
          <div className="set-row"><span className="set-label">Customer alerts</span><span className="set-value">{s.customer.enabled ? `On · after ${s.customer.delayMin} min` : 'Off'}</span></div>
        </div>
        <p className="al-hint">Only managers and admins can change these.</p>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="card-h">
        <h2>Monitoring alerts</h2>
        <span className="eyebrow">Solar</span>
      </div>
      <p className="section-lead">
        Email alerts when a plant or inverter goes offline, or a fault is reported — with the plant and owner
        details and the reason. Saved to the database; the monitor applies changes on its next scan.
      </p>

      {/* Live status + master switch */}
      <div className="al-banner" data-on={s.enabled}>
        <div className="al-banner-main">
          <span className="al-dot" />
          <div>
            <div className="al-banner-title">{s.enabled ? 'Alerts active' : 'Alerts disabled'}</div>
            <div className="al-banner-sub">
              {s.enabled
                ? `Scanning every ${s.intervalMin} min · ${recipients.length} recipient${recipients.length === 1 ? '' : 's'} · ${s.schedule.enabled ? `digest at ${s.schedule.times.join(', ') || '—'}` : 'per-plant emails'} · ${s.quietNight ? 'quiet hours on' : 'always on'}`
                : 'No emails will be sent while disabled'}
            </div>
          </div>
        </div>
        <Switch checked={s.enabled} onChange={(v) => patch('enabled', v)} label="Alerts enabled" />
      </div>

      {error && <span className="err">{error}</span>}

      {/* Recipients */}
      <div className="al-group">
        <div className="al-group-h">Recipients</div>
        <div className="field">
          <label>Admin emails <span className="al-hint">· add as many as you like — press Enter or comma</span></label>
          <EmailChips value={recipients} onChange={setRecipients} />
        </div>
      </div>

      {/* Timing */}
      <div className="al-group">
        <div className="al-group-h">Timing</div>
        <div className="al-fields">
          <div className="field">
            <label htmlFor="al-int">Scan interval</label>
            <div className="al-num">
              <input id="al-int" type="number" min={1} max={1440} value={s.intervalMin} onChange={(e) => patch('intervalMin', Number(e.target.value))} />
              <span className="unit">min</span>
            </div>
          </div>
          <div className="field">
            <label htmlFor="al-adelay">Notify admin after offline for</label>
            <div className="al-num">
              <input id="al-adelay" type="number" min={0} max={1440} value={s.admin.delayMin} onChange={(e) => setS({ ...s, admin: { ...s.admin, delayMin: Number(e.target.value) } })} />
              <span className="unit">min</span>
            </div>
          </div>
        </div>
        <ToggleRow checked={s.recovery} onChange={(v) => patch('recovery', v)} title="Recovery emails" desc="Send a note when a previously-reported issue clears" />
      </div>

      {/* Delivery schedule — batch into digests */}
      <div className="al-group">
        <div className="al-group-h">Delivery schedule</div>
        <ToggleRow
          checked={s.schedule.enabled}
          onChange={(v) => patchSchedule({ enabled: v })}
          title="Batch alerts into scheduled digests"
          desc="Instead of one email per plant as issues trip, hold everything and send one combined digest at the times below"
        />
        {s.schedule.enabled && (
          <div className="al-indent">
            <p className="al-hint" style={{ marginBottom: 10 }}>
              At each send time, every plant with an open issue goes into a single email. The number of times
              you list is how many digests you’ll get per day (capped below). Times are read in the timezone shown.
            </p>
            <div className="field" style={{ marginBottom: 12 }}>
              <label htmlFor="al-times">Send times <span className="al-hint">· 24-hour, comma-separated (e.g. 09:00, 17:00)</span></label>
              <input
                id="al-times"
                type="text"
                placeholder="09:00, 17:00"
                value={timesText}
                onChange={(e) => onTimesChange(e.target.value)}
              />
            </div>
            <div className="al-fields">
              <div className="field">
                <label htmlFor="al-tz">Timezone <span className="al-hint">· IANA name</span></label>
                <input
                  id="al-tz"
                  type="text"
                  placeholder="Australia/Sydney"
                  value={s.schedule.timezone}
                  onChange={(e) => patchSchedule({ timezone: e.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="al-max">Max digests per day</label>
                <div className="al-num">
                  <input
                    id="al-max"
                    type="number"
                    min={1}
                    max={48}
                    value={s.schedule.maxPerDay}
                    onChange={(e) => patchSchedule({ maxPerDay: Number(e.target.value) })}
                  />
                  <span className="unit">/day</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Quiet hours */}
      <div className="al-group">
        <div className="al-group-h">Quiet hours</div>
        <ToggleRow
          checked={s.quietNight}
          onChange={(v) => patch('quietNight', v)}
          title="Sunset quiet hours"
          desc="Hold a plant's emails overnight at its own location; send a morning catch-up for anything still down"
        />
        {s.quietNight && (
          <div className="al-indent">
            <p className="al-hint" style={{ marginBottom: 10 }}>
              Night is judged per plant from its installation coordinates (where the platform provides them).
              The fallback below is used only for plants whose location isn’t known.
            </p>
            <div className="al-fields">
              <div className="field">
                <label htmlFor="al-lat">Fallback latitude</label>
                <input id="al-lat" type="number" step="0.0001" value={s.lat} onChange={(e) => patch('lat', Number(e.target.value))} />
              </div>
              <div className="field">
                <label htmlFor="al-lng">Fallback longitude</label>
                <input id="al-lng" type="number" step="0.0001" value={s.lng} onChange={(e) => patch('lng', Number(e.target.value))} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Customer alerts */}
      <div className="al-group">
        <div className="al-group-h">Customer alerts</div>
        <ToggleRow
          checked={s.customer.enabled}
          onChange={(v) => setS({ ...s, customer: { ...s.customer, enabled: v } })}
          title="Also alert plant owners"
          desc="Delivery isn’t wired yet — stores the preference and delay; per-plant customer emails are added later"
        />
        {s.customer.enabled && (
          <div className="field al-indent" style={{ maxWidth: 260 }}>
            <label htmlFor="al-cdelay">Notify customer after offline for</label>
            <div className="al-num">
              <input id="al-cdelay" type="number" min={0} max={1440} value={s.customer.delayMin} onChange={(e) => setS({ ...s, customer: { ...s.customer, delayMin: Number(e.target.value) } })} />
              <span className="unit">min</span>
            </div>
          </div>
        )}
      </div>

      {/* Resolution: AI solution + attachment */}
      <div className="al-group">
        <div className="al-group-h">Resolution</div>
        <ToggleRow
          checked={s.includeSolution}
          onChange={(v) => patch('includeSolution', v)}
          title="Include a suggested solution"
          desc="Add an AI-written, knowledge-base-grounded fix for the fault to the email body (needs Claude configured)"
        />
        <ToggleRow
          checked={s.attachResolution}
          onChange={(v) => patch('attachResolution', v)}
          title="Attach a resolution guide"
          desc="Attach a matching PDF from the knowledge base (e.g. a Wi-Fi reconnect guide for an offline plant)"
        />
        {s.attachResolution && (
          <div className="al-indent">
            <p className="al-hint" style={{ marginBottom: 10 }}>
              Rules are checked in order — the first whose keyword appears in the alert wins. If none match, the
              best-matching knowledge-base document is found automatically; if nothing is confident, no file is attached.
            </p>
            {!docs.length && (
              <p className="al-hint" style={{ marginBottom: 10 }}>
                No knowledge-base documents found yet — ingest PDFs under Knowledge base first.
              </p>
            )}
            {s.resolutionRules.map((rule, i) => (
              <div className="al-rule" key={i}>
                <input
                  className="al-rule-kw"
                  value={rule.keywords}
                  placeholder="keywords e.g. offline, wifi"
                  onChange={(e) => {
                    const rules = [...s.resolutionRules];
                    rules[i] = { ...rules[i], keywords: e.target.value };
                    patch('resolutionRules', rules);
                  }}
                />
                <select
                  className="al-rule-doc"
                  value={rule.documentId}
                  onChange={(e) => {
                    const doc = docs.find((d) => d.id === e.target.value);
                    const rules = [...s.resolutionRules];
                    rules[i] = { ...rules[i], documentId: e.target.value, documentTitle: doc?.title ?? '' };
                    patch('resolutionRules', rules);
                  }}
                >
                  <option value="">Select a document…</option>
                  {docs.map((d) => (
                    <option key={d.id} value={d.id}>{d.title}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn ghost sm"
                  aria-label="Remove rule"
                  onClick={() => patch('resolutionRules', s.resolutionRules.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn ghost sm"
              style={{ marginTop: 4, alignSelf: 'flex-start' }}
              onClick={() => patch('resolutionRules', [...s.resolutionRules, { keywords: '', documentId: '', documentTitle: '' } as AlertResolutionRule])}
            >
              + Add rule
            </button>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="al-actions">
        <button className="btn" onClick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save settings'}</button>
        <button className="btn ghost" onClick={test} disabled={testing}>{testing ? 'Sending…' : 'Send test email'}</button>
        <span className={`al-saved ${status ? 'ok' : ''}`}>{status || (dirty ? 'Unsaved changes' : '')}</span>
      </div>
    </section>
  );
}
