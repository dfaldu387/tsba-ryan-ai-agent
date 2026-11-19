import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { AlertResolutionRule, DriveFolderSource, IngestedDocument } from '@tsba/shared';
import { ApiError, AuthError, listFolderFileIds, listFolderSources } from '../api';
import { Icon } from '../ui';
import './resolution-rules.css';

/**
 * Editor for the alert "resolution guide" rules: each rule is a card — keyword
 * chips ("when an alert mentions…") and a searchable document picker that can
 * be narrowed to one knowledge-base folder. Order matters (first match wins),
 * so rules can be moved up and down. Own `rr-` CSS namespace.
 */

type FolderState = string[] | 'loading' | 'error' | 'no-drive';

const splitKw = (s: string): string[] => s.split(/[,;]+/).map((k) => k.trim()).filter(Boolean);
const joinKw = (list: string[]): string => list.join(', ');

function docKind(d: IngestedDocument): string {
  const m = d.mime_type || '';
  if (m.includes('pdf')) return 'PDF';
  if (m.includes('word') || m.includes('document')) return 'Doc';
  if (m.includes('sheet') || m.includes('excel') || m.includes('csv')) return 'Sheet';
  if (m.includes('presentation')) return 'Slides';
  if (d.source === 'gmail') return 'Email';
  return 'File';
}

function fmtSize(b: number | null): string {
  if (!b) return '';
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/** Title with the matched search terms wrapped in <mark>. */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const rx = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
  return <>{text.split(rx).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}</>;
}

// ─── Keyword chips ───────────────────────────────────────────────────────────
function KeywordInput({ value, onChange, id }: { value: string; onChange: (v: string) => void; id: string }) {
  const [draft, setDraft] = useState('');
  const chips = splitKw(value);
  const add = (raw: string) => {
    const next = splitKw(raw).filter((k) => !chips.some((c) => c.toLowerCase() === k.toLowerCase()));
    if (next.length) onChange(joinKw([...chips, ...next]));
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === ',') && draft.trim()) {
      e.preventDefault();
      add(draft);
    } else if (e.key === 'Backspace' && !draft && chips.length) {
      onChange(joinKw(chips.slice(0, -1)));
    }
  };
  return (
    <div className="rr-chips" onClick={() => document.getElementById(id)?.focus()}>
      {chips.map((c) => (
        <span key={c} className="rr-chip">
          {c}
          <button type="button" aria-label={`Remove keyword ${c}`} onClick={(e) => { e.stopPropagation(); onChange(joinKw(chips.filter((x) => x !== c))); }}>
            <Icon name="x" size={12} />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        placeholder={chips.length ? 'Add another…' : 'Type a keyword and press Enter — e.g. offline, wifi, F35'}
        onChange={(e) => (e.target.value.includes(',') ? add(e.target.value) : setDraft(e.target.value))}
        onKeyDown={onKey}
        onBlur={() => draft.trim() && add(draft)}
      />
    </div>
  );
}

// ─── Document picker ─────────────────────────────────────────────────────────
function DocPicker({
  docs, folders, folderFiles, loadFolder, value, onPick,
}: {
  docs: IngestedDocument[];
  folders: DriveFolderSource[];
  folderFiles: Record<string, FolderState>;
  loadFolder: (id: string) => void;
  value: { id: string; title: string };
  onPick: (d: IngestedDocument) => void;
}) {
  const selected = docs.find((d) => d.id === value.id);
  const [open, setOpen] = useState(!value.id);
  const [q, setQ] = useState('');
  const [folder, setFolder] = useState('all');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (folder !== 'all') loadFolder(folder); }, [folder, loadFolder]);

  const inFolder = folder === 'all' ? null : folderFiles[folder];
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const results = useMemo(() => {
    let list = docs.filter((d) => d.status !== 'failed');
    if (Array.isArray(inFolder)) {
      const set = new Set(inFolder);
      list = list.filter((d) => set.has(d.id));
    }
    if (terms.length) list = list.filter((d) => terms.every((t) => d.title.toLowerCase().includes(t)));
    return list.sort((a, b) => a.title.localeCompare(b.title));
  }, [docs, inFolder, terms.join(' ')]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setCursor(0), [q, folder]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const pick = (d: IngestedDocument) => {
    onPick(d);
    setOpen(false);
    setQ('');
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(results.length - 1, c + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    else if (e.key === 'Enter' && results[cursor]) { e.preventDefault(); pick(results[cursor]); }
    else if (e.key === 'Escape' && value.id) { e.preventDefault(); setOpen(false); }
  };

  if (!open) {
    return (
      <div className={`rr-picked ${selected ? '' : 'missing'}`}>
        <span className="rr-doc-ico"><Icon name="doc" size={18} /></span>
        <div className="rr-picked-main">
          <strong title={selected?.title ?? value.title}>{selected?.title ?? value.title ?? 'Unknown document'}</strong>
          <span>{selected ? [docKind(selected), fmtSize(selected.byte_size)].filter(Boolean).join(' · ') : 'No longer in the knowledge base — choose another'}</span>
        </div>
        {selected?.web_url && (
          <a className="rr-iconbtn" href={selected.web_url} target="_blank" rel="noreferrer" title="Open in Drive" aria-label="Open document in Drive">
            <Icon name="external" size={15} />
          </a>
        )}
        <button type="button" className="rr-btn" onClick={() => { setOpen(true); setTimeout(() => searchRef.current?.focus(), 0); }}>Change</button>
      </div>
    );
  }

  const folderState = folder === 'all' ? null : folderFiles[folder];
  return (
    <div className="rr-picker" onKeyDown={onKey}>
      <div className="rr-picker-bar">
        <div className="rr-search">
          <Icon name="search" size={15} />
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search documents by name…"
            aria-label="Search documents"
            role="combobox"
            aria-expanded="true"
            aria-controls="rr-results"
          />
          {q && <button type="button" className="rr-clear" aria-label="Clear search" onClick={() => setQ('')}><Icon name="x" size={13} /></button>}
        </div>
        {folders.length > 0 && (
          <select className="rr-folder" value={folder} onChange={(e) => setFolder(e.target.value)} aria-label="Folder">
            <option value="all">All folders</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        )}
      </div>
      <ul className="rr-results" id="rr-results" role="listbox" ref={listRef}>
        {folderState === 'loading' ? (
          <li className="rr-empty">Reading folder from Drive…</li>
        ) : folderState === 'no-drive' ? (
          <li className="rr-empty">Google Drive isn’t connected, so folders can’t be read. Connect it under Connections, or search “All folders”.</li>
        ) : folderState === 'error' ? (
          <li className="rr-empty">Couldn’t read that folder from Drive. Pick it again to retry, or search “All folders”.</li>
        ) : results.length === 0 ? (
          <li className="rr-empty">{docs.length ? 'No documents match.' : 'No knowledge-base documents yet — ingest PDFs under Knowledge base first.'}</li>
        ) : (
          results.slice(0, 200).map((d, i) => (
            <li
              key={d.id}
              data-i={i}
              role="option"
              aria-selected={d.id === value.id}
              className={`${i === cursor ? 'cur' : ''} ${d.id === value.id ? 'sel' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(d); }}
            >
              <span className="rr-kind">{docKind(d)}</span>
              <span className="rr-title" title={d.title}><Highlight text={d.title} terms={terms} /></span>
              {d.id === value.id && <Icon name="check" size={14} />}
            </li>
          ))
        )}
      </ul>
      <div className="rr-picker-foot">
        <span>{results.length > 200 ? `Showing 200 of ${results.length} — refine the search` : `${results.length} document${results.length === 1 ? '' : 's'}`}</span>
        <span className="rr-keys">↑↓ to move · Enter to pick{value.id ? ' · Esc to cancel' : ''}</span>
        {value.id && <button type="button" className="rr-link" onClick={() => setOpen(false)}>Cancel</button>}
      </div>
    </div>
  );
}

// ─── Rule list ───────────────────────────────────────────────────────────────
export function ResolutionRuleEditor({
  rules, docs, onChange, onAuthError,
}: {
  rules: AlertResolutionRule[];
  docs: IngestedDocument[];
  onChange: (rules: AlertResolutionRule[]) => void;
  onAuthError: () => void;
}) {
  const [folders, setFolders] = useState<DriveFolderSource[]>([]);
  const [folderFiles, setFolderFiles] = useState<Record<string, FolderState>>({});
  // Stable keys for cards so reordering doesn't remount pickers mid-edit.
  const keys = useRef<number[]>([]);
  const nextKey = useRef(0);
  while (keys.current.length < rules.length) keys.current.push(nextKey.current++);
  if (keys.current.length > rules.length) keys.current.length = rules.length;

  // Parent may pass a fresh callback each render; don't refetch for that.
  const authRef = useRef(onAuthError);
  authRef.current = onAuthError;
  useEffect(() => {
    listFolderSources().then((r) => setFolders(r.folders)).catch((err) => { if (err instanceof AuthError) authRef.current(); });
  }, []);

  const requested = useRef(new Set<string>());
  const loadFolder = useCallback((id: string) => {
    if (requested.current.has(id)) return;
    requested.current.add(id);
    setFolderFiles((p) => ({ ...p, [id]: 'loading' }));
    listFolderFileIds(id)
      .then((r) => setFolderFiles((p) => ({ ...p, [id]: r.fileIds })))
      .catch((err) => {
        if (err instanceof AuthError) authRef.current();
        requested.current.delete(id); // allow a retry by re-selecting the folder
        setFolderFiles((p) => ({ ...p, [id]: err instanceof ApiError && err.code === 'drive_not_connected' ? 'no-drive' : 'error' }));
      });
  }, []);

  const update = (i: number, patch: Partial<AlertResolutionRule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= rules.length) return;
    const next = [...rules];
    [next[i], next[j]] = [next[j], next[i]];
    const k = keys.current;
    [k[i], k[j]] = [k[j], k[i]];
    onChange(next);
  };
  const remove = (i: number) => {
    keys.current.splice(i, 1);
    onChange(rules.filter((_, j) => j !== i));
  };

  return (
    <div className="rr">
      {rules.length === 0 && (
        <div className="rr-none">
          <Icon name="sliders" size={18} />
          <span>No rules — the best-matching guide is picked automatically. Add a rule to force a specific document for certain alerts.</span>
        </div>
      )}
      {rules.map((rule, i) => {
        const kws = splitKw(rule.keywords);
        const incomplete = !kws.length || !rule.documentId;
        return (
          <div className={`rr-card ${incomplete ? 'incomplete' : ''}`} key={keys.current[i]}>
            <div className="rr-card-h">
              <span className="rr-num" title={`Checked ${i === 0 ? 'first' : `${i + 1}${i === 1 ? 'nd' : i === 2 ? 'rd' : 'th'}`}`}>{i + 1}</span>
              <span className="rr-card-title">Rule {i + 1}</span>
              <span className="rr-card-tools">
                <button type="button" className="rr-iconbtn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move rule up" title="Move up">
                  <Icon name="chevronDown" size={15} className="rr-up" />
                </button>
                <button type="button" className="rr-iconbtn" disabled={i === rules.length - 1} onClick={() => move(i, 1)} aria-label="Move rule down" title="Move down">
                  <Icon name="chevronDown" size={15} />
                </button>
                <button type="button" className="rr-iconbtn danger" onClick={() => remove(i)} aria-label={`Remove rule ${i + 1}`} title="Remove rule">
                  <Icon name="x" size={15} />
                </button>
              </span>
            </div>
            <label className="rr-label" htmlFor={`rr-kw-${keys.current[i]}`}>When an alert mentions any of</label>
            <KeywordInput id={`rr-kw-${keys.current[i]}`} value={rule.keywords} onChange={(v) => update(i, { keywords: v })} />
            <span className="rr-label">Attach this document</span>
            <DocPicker
              docs={docs}
              folders={folders}
              folderFiles={folderFiles}
              loadFolder={loadFolder}
              value={{ id: rule.documentId, title: rule.documentTitle }}
              onPick={(d) => update(i, { documentId: d.id, documentTitle: d.title })}
            />
            {incomplete && (
              <p className="rr-warn">
                <Icon name="alert" size={13} />
                {!kws.length && !rule.documentId ? 'Add a keyword and pick a document — incomplete rules are skipped.'
                  : !kws.length ? 'Add at least one keyword — this rule can’t match yet.'
                    : 'Pick a document — rules without one are dropped on save.'}
              </p>
            )}
          </div>
        );
      })}
      <button type="button" className="rr-add" onClick={() => onChange([...rules, { keywords: '', documentId: '', documentTitle: '' }])}>
        <Icon name="plus" size={15} /> Add rule
      </button>
    </div>
  );
}
