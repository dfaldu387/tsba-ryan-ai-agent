import { useState, type FormEvent } from 'react';
import { ApiError, login } from '../api';

export function PasswordGate({ onAuthed }: { onAuthed: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(password);
      onAuthed();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'wrong_password' ? 'That password didn’t match.' : 'Couldn’t sign in. Try again.');
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
            <h1>TSBA Assistant · Preview</h1>
            <small className="eyebrow">Password protected</small>
          </div>
        </div>
        <p>Enter the password Ryan was sent to open the preview.</p>
        <div className="field">
          <label className="eyebrow" htmlFor="pw">Password</label>
          <input
            id="pw"
            type="password"
            value={password}
            autoFocus
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </div>
        {error && <span className="err" role="alert">{error}</span>}
        <button className="btn" type="submit" disabled={busy || !password}>
          {busy ? 'Checking…' : 'Open preview'}
        </button>
      </form>
    </div>
  );
}
