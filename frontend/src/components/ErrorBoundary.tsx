import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * Catches render-time errors anywhere below it and shows the message instead of
 * a blank white page (React unmounts the whole tree on an uncaught render error).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface it in the console too, for debugging.
    console.error('[ErrorBoundary] render crash:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div style={{ maxWidth: 720, margin: '10vh auto', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
        <h1 style={{ fontSize: 20, margin: '0 0 8px' }}>Something went wrong</h1>
        <p style={{ color: '#64748b', margin: '0 0 16px' }}>
          The app hit an error while rendering. The details are below — a reload may clear it.
        </p>
        <pre
          style={{
            background: '#0f172a',
            color: '#fecaca',
            padding: 16,
            borderRadius: 8,
            overflow: 'auto',
            fontSize: 13,
            whiteSpace: 'pre-wrap',
          }}
        >
          {error.message}
          {'\n\n'}
          {error.stack}
        </pre>
        <button
          type="button"
          onClick={() => location.reload()}
          style={{ marginTop: 12, padding: '8px 14px', borderRadius: 8, border: '1px solid #cbd5e1', cursor: 'pointer' }}
        >
          Reload
        </button>
      </div>
    );
  }
}
