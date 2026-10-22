import { useEffect, useState, type FormEvent } from 'react';
import {
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  ROLES,
  type AuthenticatedUser,
  type Role,
  type User,
} from '@tsba/shared';
import { ApiError, AuthError, createUser, deleteUser, listUsers, updateUser } from '../api';

export function UsersPanel({ me, onAuthError }: { me: AuthenticatedUser; onAuthError: () => void }) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  // New-user form
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [password, setPassword] = useState('');
  const [adding, setAdding] = useState(false);

  const handle = (err: unknown, fallback: string) => {
    if (err instanceof AuthError) return onAuthError();
    setError(err instanceof ApiError ? err.message || fallback : fallback);
  };

  const load = () =>
    listUsers()
      .then((r) => setUsers(r.users))
      .catch((err) => handle(err, 'Couldn’t load users.'));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function addUser(e: FormEvent) {
    e.preventDefault();
    setError('');
    setAdding(true);
    try {
      await createUser({ email, name, role, password });
      setEmail('');
      setName('');
      setRole('viewer');
      setPassword('');
      await load();
    } catch (err) {
      handle(err, 'Couldn’t create the user.');
    } finally {
      setAdding(false);
    }
  }

  async function changeRole(u: User, nextRole: Role) {
    setBusyId(u.id);
    setError('');
    try {
      await updateUser(u.id, { role: nextRole });
      await load();
    } catch (err) {
      handle(err, 'Couldn’t change the role.');
    } finally {
      setBusyId(null);
    }
  }

  async function toggleDisabled(u: User) {
    setBusyId(u.id);
    setError('');
    try {
      await updateUser(u.id, { disabled: !u.disabled });
      await load();
    } catch (err) {
      handle(err, 'Couldn’t update the user.');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(u: User) {
    setBusyId(u.id);
    setError('');
    try {
      await deleteUser(u.id);
      await load();
    } catch (err) {
      handle(err, 'Couldn’t delete the user.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="card">
      <div className="card-h">
        <h2>Users &amp; roles</h2>
        <span className="eyebrow">Admin only</span>
      </div>

      <form className="user-form" onSubmit={addUser}>
        <div className="user-form-row">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="email@tsba.local"
            aria-label="Email"
            required
          />
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Full name"
            aria-label="Name"
          />
          <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">
            {ROLES.map((r) => (
              <option key={r} value={r}>{ROLE_LABELS[r]}</option>
            ))}
          </select>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Temp password (8+ chars)"
            aria-label="Password"
            minLength={8}
            required
          />
          <button className="btn" type="submit" disabled={adding || !email || password.length < 8}>
            {adding ? 'Adding…' : 'Add user'}
          </button>
        </div>
        <p className="role-hint">{ROLE_DESCRIPTIONS[role]}</p>
      </form>

      {error && <span className="err">{error}</span>}

      <div className="user-table">
        {users?.map((u) => (
          <div key={u.id} className={`user-row ${u.disabled ? 'is-disabled' : ''}`}>
            <div className="user-row-main">
              <span className="user-name">{u.name || '—'}</span>
              <span className="user-email">{u.email}</span>
              {u.id === me.id && <span className="pill">You</span>}
              {u.disabled && <span className="pill amber">Disabled</span>}
            </div>
            <div className="user-row-actions">
              <select
                value={u.role}
                disabled={busyId === u.id}
                onChange={(e) => changeRole(u, e.target.value as Role)}
                aria-label={`Role for ${u.email}`}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </select>
              <button
                className="btn ghost sm"
                disabled={busyId === u.id}
                onClick={() => toggleDisabled(u)}
              >
                {u.disabled ? 'Enable' : 'Disable'}
              </button>
              <button
                className="btn ghost sm danger"
                disabled={busyId === u.id || u.id === me.id}
                onClick={() => remove(u)}
                title={u.id === me.id ? 'You can’t delete your own account' : 'Delete user'}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
        {users === null && !error && <p className="how">Loading users…</p>}
        {users?.length === 0 && <p className="how">No users yet.</p>}
      </div>
    </section>
  );
}
