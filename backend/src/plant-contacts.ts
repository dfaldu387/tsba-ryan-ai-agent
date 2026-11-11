import type { PlantContact, PlantContacts } from '@tsba/shared';
import { env } from './env.js';
import { getSetting, setSetting } from './settings-repo.js';

/**
 * Admin-maintained per-plant owner/contact store, used by the alert emailer when
 * a monitoring platform doesn't expose owner details (and to override them when
 * it does). Keyed by `${provider}:${plantId}`. Stored in the DB (app_settings,
 * key 'plant_contacts'); held in-process in memory mode.
 */

const KEY = 'plant_contacts';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let mem: PlantContacts | null = null;

export const plantKey = (provider: string, plantId: string): string => `${provider}:${plantId}`;

export async function getPlantContacts(): Promise<PlantContacts> {
  if (env.storage === 'postgres') return (await getSetting<PlantContacts>(KEY)) ?? {};
  return mem ?? {};
}

/** One plant's contact, or null. */
export async function getPlantContact(provider: string, plantId: string): Promise<PlantContact | null> {
  const all = await getPlantContacts();
  return all[plantKey(provider, plantId)] ?? null;
}

const str = (v: unknown): string => String(v ?? '').trim();

/** Trim a contact; return null when it carries no usable data. Throws on bad email. */
function cleanContact(raw: unknown): PlantContact | null {
  const r = (raw ?? {}) as Partial<PlantContact>;
  const email = str(r.email).toLowerCase();
  if (email && !EMAIL_RE.test(email)) throw new Error(`"${r.email}" is not a valid email address.`);
  const c: PlantContact = {
    name: str(r.name) || undefined,
    email: email || undefined,
    phone: str(r.phone) || undefined,
    notes: str(r.notes) || undefined,
    plantName: str(r.plantName) || undefined,
  };
  // Drop an entry that has no contact content (ignore plantName-only rows).
  if (!c.name && !c.email && !c.phone && !c.notes) return null;
  return c;
}

/** Validate + persist the full contacts map (empty entries are dropped). */
export async function savePlantContacts(next: PlantContacts): Promise<PlantContacts> {
  if (next == null || typeof next !== 'object') throw new Error('Contacts must be an object.');
  const clean: PlantContacts = {};
  for (const [k, v] of Object.entries(next)) {
    const c = cleanContact(v);
    if (c) clean[k] = c;
  }
  if (env.storage === 'postgres') await setSetting(KEY, clean);
  else mem = clean;
  return clean;
}
