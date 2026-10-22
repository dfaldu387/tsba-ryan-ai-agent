import { useState, type FormEvent } from 'react';
import type { AuthenticatedUser } from '@tsba/shared';
import { ApiError, login } from '../api';

export function LoginForm({ onAuthed }: { onAuthed: (user: AuthenticatedUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const user = await login(email, password);
      onAuthed(user);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'invalid_credentials'
          ? 'That email and password didn’t match.'
          : 'Couldn’t sign in. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gate">
      <form className="card" onSubmit={submit}>
        <div className="brand">
          <div className="logo">TSBA</div>
          <div>
            <h1>TSBA Assistant</h1>
            <small className="eyebrow">Admin panel · sign in</small>
          </div>
        </div>
        <p>Use your admin-panel account to manage the agent, connections and knowledge base.</p>
        <div className="field">
          <label className="eyebrow" htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            autoFocus
            autoComplete="username"
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@tsba.local"
          />
        </div>
        <div className="field">
          <label className="eyebrow" htmlFor="pw">Password</label>
          <input
            id="pw"
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </div>
        {error && <span className="err" role="alert">{error}</span>}
        <button className="btn" type="submit" disabled={busy || !email || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="gate-foot">🔒 Secure session · roles &amp; permissions enforced</p>
      </form>
    </div>
  );
}
