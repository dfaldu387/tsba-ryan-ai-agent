import type { DriveFolderSource } from '@tsba/shared';
import { query } from './db.js';

interface FolderRow {
  id: string;
  name: string;
  web_url: string | null;
  recursive: boolean;
  added_at: Date;
  last_synced_at: Date | null;
  last_file_count: number | null;
}

const SELECT = 'id, name, web_url, recursive, added_at, last_synced_at, last_file_count';

function toFolder(r: FolderRow): DriveFolderSource {
  return {
    id: r.id,
    name: r.name,
    web_url: r.web_url,
    recursive: r.recursive,
    added_at: r.added_at.toISOString(),
    last_synced_at: r.last_synced_at ? r.last_synced_at.toISOString() : null,
    last_file_count: r.last_file_count,
  };
}

export async function listFolders(): Promise<DriveFolderSource[]> {
  const res = await query<FolderRow>(`SELECT ${SELECT} FROM drive_folders ORDER BY name ASC`);
  return res.rows.map(toFolder);
}

export async function getFolder(id: string): Promise<DriveFolderSource | null> {
  const res = await query<FolderRow>(`SELECT ${SELECT} FROM drive_folders WHERE id = $1`, [id]);
  return res.rows[0] ? toFolder(res.rows[0]) : null;
}

export async function upsertFolder(f: DriveFolderSource): Promise<DriveFolderSource> {
  const res = await query<FolderRow>(
    `INSERT INTO drive_folders (id, name, web_url, recursive, added_at, last_synced_at, last_file_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE SET
       name=EXCLUDED.name, web_url=EXCLUDED.web_url, recursive=EXCLUDED.recursive,
       last_synced_at=EXCLUDED.last_synced_at, last_file_count=EXCLUDED.last_file_count
     RETURNING ${SELECT}`,
    [f.id, f.name, f.web_url, f.recursive, f.added_at, f.last_synced_at, f.last_file_count],
  );
  return toFolder(res.rows[0]);
}

export async function removeFolder(id: string): Promise<DriveFolderSource | null> {
  const res = await query<FolderRow>(`DELETE FROM drive_folders WHERE id = $1 RETURNING ${SELECT}`, [id]);
  return res.rows[0] ? toFolder(res.rows[0]) : null;
}
