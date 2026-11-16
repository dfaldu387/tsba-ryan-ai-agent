// Sidebar-foot workspace switcher: flips the console between the solar support
// workspace and the sales pipeline. Opens upwards (it sits at the bottom).
import { useEffect, useRef, useState } from 'react';
import type { Section } from '../lib/console';
import { Icon, type IconName } from './index';

export type WorkspaceId = 'support' | 'sales';

export interface Workspace {
  id: WorkspaceId;
  name: string;
  hint: string;
  icon: IconName;
  home: Section;
  search: string;
}

export function WorkspaceSwitcher({ current, options, collapsed, onSwitch }: {
  current: WorkspaceId;
  options: Workspace[];
  collapsed: boolean;
  onSwitch: (w: Workspace) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const cur = options.find((o) => o.id === current) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!cur) return null;

  // Only one workspace (e.g. a sales rep): show where you are, nothing to switch.
  if (options.length < 2) {
    return (
      <div className="c-ws is-static" title={collapsed ? cur.name : undefined}>
        <span className={`c-ws-icon is-${cur.id}`}><Icon name={cur.icon} size={16} /></span>
        <span className="c-ws-t"><strong>{cur.name}</strong><span>Every text is approved by you</span></span>
      </div>
    );
  }

  const move = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };

  return (
    <div className="c-ws-wrap" ref={ref}>
      {open && (
        <div className="c-ws-menu" role="menu" aria-label="Switch workspace" onKeyDown={move}>
          <div className="c-ws-menu-h">Switch workspace</div>
          {options.map((o) => (
            <button key={o.id} type="button" role="menuitemradio" aria-checked={o.id === current} className="c-ws-item"
              onClick={() => { setOpen(false); if (o.id !== current) onSwitch(o); }}>
              <span className={`c-ws-icon is-${o.id}`}><Icon name={o.icon} size={16} /></span>
              <span className="c-ws-t"><strong>{o.name}</strong><span>{o.hint}</span></span>
              {o.id === current && <Icon name="check" size={16} className="c-ws-check" />}
            </button>
          ))}
        </div>
      )}
      <button type="button" className="c-ws" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        title={collapsed ? `${cur.name} — switch workspace` : undefined} aria-label={`Workspace: ${cur.name}. Switch workspace`}>
        <span className={`c-ws-icon is-${cur.id}`}><Icon name={cur.icon} size={16} /></span>
        <span className="c-ws-t"><strong>{cur.name}</strong><span>Switch workspace</span></span>
        <Icon name="chevronDown" size={14} className={`c-ws-chev ${open ? 'is-open' : ''}`} />
      </button>
    </div>
  );
}
