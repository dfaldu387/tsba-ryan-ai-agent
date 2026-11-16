// Global Ctrl/⌘+K command palette: jump to any plant (by name, location,
// customer or inverter serial), document, draft or console page.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { IngestedDocument } from '@tsba/shared';
import { listDocuments } from '../api';
import { useConsole, type Section } from '../lib/console';
import { Icon, type IconName } from './index';

interface Item {
  id: string;
  group: 'Pages' | 'Plants' | 'Serials' | 'Documents' | 'Drafts';
  icon: IconName;
  title: string;
  sub?: string;
  keywords: string;
  run: () => void;
}

const PAGES: { label: string; section: Section; search?: string; icon: IconName }[] = [
  { label: 'Dashboard', section: 'dashboard', icon: 'dashboard' },
  { label: 'Fleet overview', section: 'solar', icon: 'fleet' },
  { label: 'Plants', section: 'solar', search: '?view=plants', icon: 'plant' },
  { label: 'Alerts', section: 'solar', search: '?view=alerts', icon: 'alert' },
  { label: 'Devices', section: 'solar', search: '?view=devices', icon: 'monitor' },
  { label: 'Analytics', section: 'solar', search: '?view=analytics', icon: 'fleet' },
  { label: 'Map', section: 'map', icon: 'map' },
  { label: 'Inbox', section: 'ask', icon: 'inbox' },
  { label: 'Drafts & approvals', section: 'drafts', icon: 'drafts' },
  { label: 'Voice / chat agent', section: 'voice', icon: 'voice' },
  { label: 'Connections', section: 'connections', icon: 'link' },
  { label: 'Knowledge base', section: 'knowledge', icon: 'book' },
  { label: 'Users & roles', section: 'users', icon: 'users' },
  { label: 'Settings', section: 'settings', icon: 'settings' },
];

const norm = (s: string) => s.toLowerCase().normalize('NFKD');

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { stations, groups, drafts, navigate, openPlant, providerName, canSeePii } = useConsole();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [docs, setDocs] = useState<IngestedDocument[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setSel(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
    if (docs == null) listDocuments().then((r) => setDocs(r.documents)).catch(() => setDocs([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const all = useMemo<Item[]>(() => {
    const items: Item[] = [];
    for (const p of PAGES) {
      items.push({ id: `page:${p.label}`, group: 'Pages', icon: p.icon, title: p.label, keywords: norm(p.label), run: () => navigate(p.section, p.search ?? '') });
    }
    for (const s of stations) {
      const owner = canSeePii ? s.owner ?? '' : '';
      items.push({
        id: `plant:${s.provider}:${s.id}`, group: 'Plants', icon: 'plant', title: s.name,
        sub: [providerName(s.provider), canSeePii ? s.location : null, owner].filter(Boolean).join(' · '),
        keywords: norm(`${s.name} ${s.id} ${canSeePii ? s.location ?? '' : ''} ${owner} ${providerName(s.provider)}`),
        run: () => openPlant(s),
      });
    }
    const seen = new Set<string>();
    for (const g of groups) {
      for (const sn of g.devices) {
        if (seen.has(sn)) continue;
        seen.add(sn);
        items.push({
          id: `sn:${sn}`, group: 'Serials', icon: 'monitor', title: sn, sub: `${g.plant} · ${providerName(g.provider)}`,
          keywords: norm(`${sn} ${g.plant}`), run: () => openPlant({ provider: g.provider, id: g.plantId }, { tab: 'devices' }),
        });
      }
    }
    for (const d of docs ?? []) {
      items.push({
        id: `doc:${d.id}`, group: 'Documents', icon: 'doc', title: d.title, sub: d.source === 'gmail' ? 'Email' : 'Google Drive',
        keywords: norm(d.title),
        run: () => (d.web_url ? window.open(d.web_url, '_blank', 'noopener') : navigate('knowledge', `?q=${encodeURIComponent(d.title)}`)),
      });
    }
    for (const d of drafts ?? []) {
      items.push({
        id: `draft:${d.id}`, group: 'Drafts', icon: 'drafts', title: d.question, sub: `${d.status} · ${d.audience}`,
        keywords: norm(`${d.question} ${d.recipient ?? ''}`), run: () => navigate('drafts', `?draft=${d.id}`),
      });
    }
    return items;
  }, [stations, groups, drafts, docs, navigate, openPlant, providerName, canSeePii]);

  const results = useMemo(() => {
    const terms = norm(q).split(/\s+/).filter(Boolean);
    if (!terms.length) return all.filter((i) => i.group === 'Pages');
    const hits = all.filter((i) => terms.every((t) => i.keywords.includes(t)));
    const cap: Record<Item['group'], number> = { Pages: 5, Plants: 8, Serials: 5, Documents: 6, Drafts: 5 };
    const counts: Record<string, number> = {};
    return hits.filter((i) => (counts[i.group] = (counts[i.group] ?? 0) + 1) <= cap[i.group]);
  }, [all, q]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;

  const choose = (i: Item | undefined) => {
    if (!i) return;
    onClose();
    i.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(results.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(results[sel]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  let lastGroup = '';
  return (
    <div className="c-cmdk-root">
      <div className="c-cmdk-scrim" onClick={onClose} aria-hidden="true" />
      <div className="c-cmdk" role="dialog" aria-modal="true" aria-label="Search the console" onKeyDown={onKey}>
        <div className="c-cmdk-in">
          <Icon name="search" />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} role="combobox" aria-expanded="true"
            aria-controls="c-cmdk-list" aria-activedescendant={results[sel] ? `cmdk-${sel}` : undefined}
            placeholder="Search plants, customers, serials, documents, drafts…" />
          <kbd>Esc</kbd>
        </div>
        <div className="c-cmdk-list" id="c-cmdk-list" role="listbox" ref={listRef}>
          {results.length === 0 ? (
            <p className="c-emptystate">No matches for “{q}”.</p>
          ) : (
            results.map((r, i) => {
              const head = r.group !== lastGroup ? <div className="c-cmdk-h" role="presentation">{r.group}</div> : null;
              lastGroup = r.group;
              return (
                <div key={r.id}>
                  {head}
                  <button type="button" id={`cmdk-${i}`} role="option" aria-selected={i === sel} className="c-cmdk-item"
                    onMouseMove={() => setSel(i)} onClick={() => choose(r)}>
                    <Icon name={r.icon} />
                    <span className="c-cmdk-item-t">
                      <strong>{r.title}</strong>
                      {r.sub && <span>{r.sub}</span>}
                    </span>
                    {i === sel && <Icon name="chevron" size={16} />}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="c-cmdk-foot"><span>↑↓ navigate</span><span>↵ open</span><span>Esc close</span></div>
      </div>
    </div>
  );
}
