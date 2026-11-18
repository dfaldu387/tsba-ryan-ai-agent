import { useState, type FormEvent } from 'react';
import { ROLE_LABELS, type AuthenticatedUser, type Role } from '@tsba/shared';
import { AuthError, changeMyPassword, updateMyProfile } from '../api';
import { Icon } from '../ui';
import './profile.css';

/**
 * Your own profile — available to every role (sales reps included). Edit your
 * display name, change your password, see your role and what it lets you do.
 */

const ROLE_BLURB: Record<Role, string> = {
  admin: 'Full access, including users, settings and connections.',
  manager: 'Runs support, monitoring and sales; can change alert settings and connections.',
  viewer: 'Read-only access to monitoring and support.',
  rep: 'Uses the sales follow-up agent.',
};

function initialsOf(u: AuthenticatedUser): string {
  return (u.name || u.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
}

export function ProfilePage({ user, onAuthError }: { user: AuthenticatedUser; onAuthError: () => void }) {
  const [name, setName] = useState(user.name ?? '');
  const [nameState, setNameState] = useState<{ saving?: boolean; ok?: string; err?: string }>({});

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [pwState, setPwState] = useState<{ saving?: boolean; ok?: string; err?: string }>({});

  const nameDirty = name.trim() !== (user.name ?? '');

  async function saveName(e: FormEvent) {
    e.preventDefault();
    if (!nameDirty) return;
    setNameState({ saving: true });
    try {
      await updateMyProfile({ name: name.trim() });
      setNameState({ ok: 'Name updated' });
    } catch (err) {
      if (err instanceof AuthError) return onAuthError();
      setNameState({ err: (err as Error).message || 'Couldn’t save your name.' });
    }
  }

  const pwProblem =
    next && next.length < 8 ? 'At least 8 characters.' : confirm && next !== confirm ? 'The two new passwords don’t match.' : '';

  async function savePassword(e: FormEvent) {
    e.preventDefault();
    if (!current || !next || pwProblem || next !== confirm) return;
    setPwState({ saving: true });
    try {
      await changeMyPassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setPwState({ ok: 'Password changed. You’ve been signed out everywhere else.' });
    } catch (err) {
      if (err instanceof AuthError) return onAuthError();
      setPwState({ err: (err as Error).message || 'Couldn’t change your password.' });
    }
  }

  return (
    <div className="pf">
      <section className="pf-hero">
        <span className="pf-avatar" aria-hidden="true">{initialsOf(user)}</span>
        <div className="pf-id">
          <h2>{user.name || user.email}</h2>
          <span>{user.email}</span>
        </div>
        <span className="pf-role">{ROLE_LABELS[user.role] ?? user.role}</span>
      </section>

      <div className="pf-grid">
        <form className="pf-card" onSubmit={saveName}>
          <h3>Details</h3>
          <p className="pf-lead">Your name appears in the header, on approvals and on alert triage (“Acknowledged by …”).</p>
          <label className="pf-field">
            <span>Display name</span>
            <input value={name} maxLength={120} onChange={(e) => { setName(e.target.value); setNameState({}); }} placeholder="e.g. Alex Smith" autoComplete="name" />
          </label>
          <label className="pf-field">
            <span>Email</span>
            <input value={user.email} readOnly disabled />
            <small>Ask an admin to change your sign-in email.</small>
          </label>
          <div className="pf-actions">
            <button type="submit" className="c-btn primary" disabled={!nameDirty || nameState.saving}>
              {nameState.saving ? 'Saving…' : 'Save name'}
            </button>
            {nameState.ok && <span className="pf-ok" role="status"><Icon name="check" size={14} /> {nameState.ok}</span>}
            {nameState.err && <span className="pf-err" role="alert">{nameState.err}</span>}
          </div>
        </form>

        <form className="pf-card" onSubmit={savePassword}>
          <h3>Password</h3>
          <p className="pf-lead">Changing it signs you out on every other device.</p>
          <label className="pf-field">
            <span>Current password</span>
            <input type={show ? 'text' : 'password'} value={current} onChange={(e) => { setCurrent(e.target.value); setPwState({}); }} autoComplete="current-password" required />
          </label>
          <label className="pf-field">
            <span>New password</span>
            <input type={show ? 'text' : 'password'} value={next} onChange={(e) => { setNext(e.target.value); setPwState({}); }} autoComplete="new-password" minLength={8} required />
          </label>
          <label className="pf-field">
            <span>Confirm new password</span>
            <input type={show ? 'text' : 'password'} value={confirm} onChange={(e) => { setConfirm(e.target.value); setPwState({}); }} autoComplete="new-password" required />
          </label>
          <label className="pf-check">
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show passwords
          </label>
          {pwProblem && <span className="pf-err">{pwProblem}</span>}
          <div className="pf-actions">
            <button type="submit" className="c-btn primary" disabled={!current || !next || !confirm || Boolean(pwProblem) || pwState.saving}>
              {pwState.saving ? 'Changing…' : 'Change password'}
            </button>
            {pwState.ok && <span className="pf-ok" role="status"><Icon name="check" size={14} /> {pwState.ok}</span>}
            {pwState.err && <span className="pf-err" role="alert">{pwState.err}</span>}
          </div>
        </form>

        <section className="pf-card pf-wide">
          <h3>Role &amp; access</h3>
          <p className="pf-lead">
            <strong>{ROLE_LABELS[user.role] ?? user.role}</strong> — {ROLE_BLURB[user.role] ?? 'Access set by an admin.'}
          </p>
          <ul className="pf-perms">
            {user.permissions.map((p) => (
              <li key={p}><Icon name="check" size={13} /> {p.replace(/_/g, ' ')}</li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
