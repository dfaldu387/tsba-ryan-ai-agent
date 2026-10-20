import { useState } from 'react';
import { getToken } from './api';
import { PasswordGate } from './components/PasswordGate';
import { AskTab } from './components/AskTab';
import { ProgressTab } from './components/ProgressTab';

type Tab = 'ask' | 'progress';

export function App() {
  const [authed, setAuthed] = useState<boolean>(() => Boolean(getToken()));
  const [tab, setTab] = useState<Tab>('ask');

  if (!authed) {
    return <PasswordGate onAuthed={() => setAuthed(true)} />;
  }

  const onAuthError = () => setAuthed(false);

  return (
    <>
      <header className="top">
        <div className="wrap">
          <div className="brand">
            <div className="logo">TSBA</div>
            <div>
              <h1>TSBA Assistant · Preview</h1>
              <small>Technical Support assistant · working demo on TSBA&rsquo;s own material</small>
            </div>
          </div>
          <span className="pill amber">Demo · not connected to any channel</span>
        </div>
      </header>

      <nav className="tabs" aria-label="Views">
        <div className="wrap">
          <button className="tab" role="tab" aria-selected={tab === 'ask'} onClick={() => setTab('ask')}>
            Ask
          </button>
          <button className="tab" role="tab" aria-selected={tab === 'progress'} onClick={() => setTab('progress')}>
            Progress
          </button>
        </div>
      </nav>

      {tab === 'ask' ? <AskTab onAuthError={onAuthError} /> : <ProgressTab onAuthError={onAuthError} />}
    </>
  );
}
