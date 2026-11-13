import type {
  AdminOverview,
  AuthenticatedUser,
  Audience,
  Channel,
  ConnectionProvider,
  ConnectionStatus,
  Draft,
  DraftAction,
  DraftResult,
  DriveFile,
  DriveFolderSource,
  DriveListing,
  FolderSyncResult,
  GmailLabel,
  GmailScanResult,
  IngestResult,
  IngestedDocument,
  Role,
  SolarAlertSettings,
  PlantContacts,
  SourceCard,
  User,
} from '@tsba/shared';
import type { ProgressBoard } from './types';

const TOKEN_KEY = 'tsba-preview-token';
const USER_KEY = 'tsba-preview-user';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
function setToken(t: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* ignore */
  }
}
export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
}

export function getStoredUser(): AuthenticatedUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthenticatedUser>;
    // Reject a stale/malformed cached user (e.g. from an older schema) so the app
    // falls back to a fresh /api/me (or login) instead of crashing on render.
    if (!parsed || typeof parsed.email !== 'string' || typeof parsed.id !== 'string') {
      localStorage.removeItem(USER_KEY);
      return null;
    }
    return parsed as AuthenticatedUser;
  } catch {
    return null;
  }
}
function setStoredUser(u: AuthenticatedUser): void {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(u));
  } catch {
    /* ignore */
  }
}

export class AuthError extends Error {}
export class ApiError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  // Only declare a JSON body when we actually send one — a POST/PATCH with no
  // body + Content-Type: application/json makes Fastify reject it as empty JSON.
  if (init.body != null) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) {
    clearToken();
    throw new AuthError('unauthorized');
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError((body.message as string) || (body.error as string) || `HTTP ${res.status}`, body.error as string);
  }
  return body as T;
}

export async function login(email: string, password: string): Promise<AuthenticatedUser> {
  const { token, user } = await request<{ token: string; user: AuthenticatedUser }>('/api/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  setToken(token);
  setStoredUser(user);
  return user;
}

/** Restore the session from the stored token; returns the live user or null. */
export async function getMe(): Promise<AuthenticatedUser> {
  const user = await request<AuthenticatedUser>('/api/me');
  setStoredUser(user);
  return user;
}

// ─── User management (admin only) ───────────────────────────────────────────
export function listUsers(): Promise<{ users: User[] }> {
  return request<{ users: User[] }>('/api/users');
}

export function createUser(body: { email: string; name: string; role: Role; password: string }): Promise<User> {
  return request<User>('/api/users', { method: 'POST', body: JSON.stringify(body) });
}

export function updateUser(
  id: string,
  patch: { role?: Role; disabled?: boolean; name?: string; password?: string },
): Promise<User> {
  return request<User>(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export function deleteUser(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/users/${id}`, { method: 'DELETE' });
}

// ─── Gmail scan ─────────────────────────────────────────────────────────────
export function listGmailLabels(): Promise<{ labels: GmailLabel[] }> {
  return request<{ labels: GmailLabel[] }>('/api/gmail/labels');
}

export function scanGmailLabel(labelId: string, max?: number): Promise<GmailScanResult> {
  return request<GmailScanResult>('/api/gmail/scan', {
    method: 'POST',
    body: JSON.stringify({ labelId, ...(max ? { max } : {}) }),
  });
}

export function createDraft(body: {
  question: string;
  audience: Audience | 'auto';
  channel: Channel | 'auto';
  recipient?: string | null;
}): Promise<Draft> {
  return request<Draft>('/api/draft', { method: 'POST', body: JSON.stringify(body) });
}

export interface VoiceChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface VoiceAttachment {
  /** image/png | image/jpeg | image/gif | image/webp | application/pdf */
  mediaType: string;
  /** Base64-encoded file bytes (no data: prefix). */
  data: string;
}

export function voiceChat(
  messages: VoiceChatMessage[],
  audience: Audience,
  attachments: VoiceAttachment[] = [],
): Promise<{ reply: string; sources: SourceCard[]; suggestions: string[] }> {
  return request<{ reply: string; sources: SourceCard[]; suggestions: string[] }>('/api/voice/chat', {
    method: 'POST',
    body: JSON.stringify({ messages, audience, attachments }),
  });
}

/**
 * Live support chat: the agent auto-detects who's asking (audience) and the
 * channel from the message, answers instantly (no approval gate), and returns
 * what it detected so the UI can show it. Reuses the grounded /api/voice/chat
 * pipeline in text mode.
 */
export function supportChat(
  messages: VoiceChatMessage[],
  attachments: VoiceAttachment[] = [],
  audience: Audience | 'auto' = 'auto',
): Promise<{
  reply: string;
  sources: SourceCard[];
  suggestions: string[];
  audience: Audience;
  channel: Channel;
}> {
  return request('/api/voice/chat', {
    method: 'POST',
    body: JSON.stringify({ messages, audience, mode: 'text', attachments }),
  });
}

export function getVoiceStarters(): Promise<{ suggestions: string[] }> {
  return request<{ suggestions: string[] }>('/api/voice/suggestions');
}

export function flagVoiceAnswer(
  question: string,
  reply: string,
  audience: Audience,
  note = '',
): Promise<Draft> {
  return request<Draft>('/api/voice/flag', {
    method: 'POST',
    body: JSON.stringify({ question, reply, audience, note }),
  });
}

// ─── Gmail inbox as the query list ──────────────────────────────────────────
export interface GmailQuery {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  webUrl: string;
}

export function getGmailQueries(labelId = 'INBOX', max = 30): Promise<{ queries: GmailQuery[] }> {
  const qs = new URLSearchParams({ labelId, max: String(max) });
  return request<{ queries: GmailQuery[] }>(`/api/gmail/queries?${qs.toString()}`);
}

export function draftGmailQuery(id: string): Promise<{
  audience: Audience;
  channel: Channel;
  from: string;
  subject: string;
  result: DraftResult;
  sources: SourceCard[];
}> {
  return request(`/api/gmail/queries/${encodeURIComponent(id)}/draft`, { method: 'POST' });
}

export function replyGmailQuery(id: string, text: string): Promise<{ ok: true }> {
  return request(`/api/gmail/queries/${encodeURIComponent(id)}/reply`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

export function listDrafts(): Promise<Draft[]> {
  return request<Draft[]>('/api/drafts');
}

export function patchDraft(id: number, action: DraftAction): Promise<Draft> {
  return request<Draft>(`/api/drafts/${id}`, { method: 'PATCH', body: JSON.stringify(action) });
}

export function getProgress(): Promise<ProgressBoard> {
  return request<ProgressBoard>('/api/progress');
}

export function getOverview(): Promise<AdminOverview> {
  return request<AdminOverview>('/api/overview');
}

export function listConnections(): Promise<{ connections: ConnectionStatus[] }> {
  return request<{ connections: ConnectionStatus[] }>('/api/connections');
}

/** Start an OAuth flow; returns the Google consent URL to redirect the browser to. */
export function startConnect(provider: ConnectionProvider): Promise<{ url: string }> {
  return request<{ url: string }>(`/api/connections/${provider}/connect`, { method: 'POST' });
}

export function disconnect(provider: ConnectionProvider): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/connections/${provider}`, { method: 'DELETE' });
}

export function listDriveFiles(folderId?: string, pageToken?: string): Promise<DriveListing> {
  const qs = new URLSearchParams();
  if (folderId) qs.set('folderId', folderId);
  if (pageToken) qs.set('pageToken', pageToken);
  const q = qs.toString();
  return request<DriveListing>(`/api/drive/files${q ? `?${q}` : ''}`);
}

export function searchDriveFiles(q: string): Promise<{ files: DriveFile[] }> {
  return request<{ files: DriveFile[] }>(`/api/drive/search?q=${encodeURIComponent(q)}`);
}

export function ingestDriveFiles(fileIds: string[]): Promise<{ results: IngestResult[] }> {
  return request<{ results: IngestResult[] }>('/api/drive/ingest', {
    method: 'POST',
    body: JSON.stringify({ fileIds }),
  });
}

export function listDocuments(): Promise<{ documents: IngestedDocument[] }> {
  return request<{ documents: IngestedDocument[] }>('/api/drive/documents');
}

export function removeDocument(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/drive/documents/${id}`, { method: 'DELETE' });
}

/** Assess stored text quality for all Drive docs (no OCR) and record the flags. */
export function assessDocuments(): Promise<{ assessed: number; ok: number; low: number; corrupted: number }> {
  return request<{ assessed: number; ok: number; low: number; corrupted: number }>(
    '/api/drive/documents/assess',
    { method: 'POST' },
  );
}

/** Re-ingest (with OCR) every Drive document whose text is flagged low/corrupted. */
export function reingestFlaggedDocuments(): Promise<{ reingested: number; results: IngestResult[] }> {
  return request<{ reingested: number; results: IngestResult[] }>('/api/drive/documents/reingest-flagged', {
    method: 'POST',
  });
}

export function listFolderSources(): Promise<{ folders: DriveFolderSource[] }> {
  return request<{ folders: DriveFolderSource[] }>('/api/drive/folders');
}

export function addFolderSource(folderId: string, recursive: boolean): Promise<FolderSyncResult> {
  return request<FolderSyncResult>('/api/drive/folders', {
    method: 'POST',
    body: JSON.stringify({ folderId, recursive }),
  });
}

export function addFolderSourcesBulk(
  folderIds: string[],
  recursive: boolean,
): Promise<{ folders: FolderSyncResult[] }> {
  return request<{ folders: FolderSyncResult[] }>('/api/drive/folders/bulk', {
    method: 'POST',
    body: JSON.stringify({ folderIds, recursive }),
  });
}

export function syncFolderSource(id: string): Promise<FolderSyncResult> {
  return request<FolderSyncResult>(`/api/drive/folders/${id}/sync`, { method: 'POST' });
}

export function syncAllFolderSources(): Promise<{ folders: FolderSyncResult[] }> {
  return request<{ folders: FolderSyncResult[] }>('/api/drive/folders/sync-all', { method: 'POST' });
}

/** Delete all Drive documents + chunks, then re-sync every folder from scratch. */
export function resyncAll(): Promise<{ folders: FolderSyncResult[] }> {
  return request<{ folders: FolderSyncResult[] }>('/api/drive/resync-all', { method: 'POST' });
}

export function removeFolderSource(id: string, purge: boolean): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/drive/folders/${id}${purge ? '?purge=1' : ''}`, { method: 'DELETE' });
}

// ─── Solar monitoring (multi-provider: Deye, GoodWe, …) ─────────────────────
export type StationStatus = 'online' | 'waiting' | 'partial' | 'offline' | 'unknown';

export interface SolarStation {
  id: string;
  provider: string;
  name: string;
  status: StationStatus;
  currentPowerW?: number;
  dailyEnergyKwh?: number;
  monthlyEnergyKwh?: number;
  totalEnergyKwh?: number;
  capacityKw?: number;
  batterySoc?: number;
  location?: string;
  lastUpdate?: number;
}

export interface SolarProviderInfo {
  id: string;
  name: string;
  configured: boolean;
}

export interface SolarOverview {
  stations: SolarStation[];
  errors: { provider: string; name: string; error: string }[];
  /** Optional/unverified providers that returned no data (awaiting verification). */
  unavailable?: string[];
  providerCount: number;
}

export interface SolarDevice {
  sn: string;
  type?: string;
  online?: boolean;
}

export interface SolarAlert {
  id: string;
  name: string;
  code?: string;
  deviceSn?: string;
  start?: number;
  level?: string;
  /** Provider-reported root cause (e.g. SAJ alarmCauses). */
  reason?: string;
  /** Provider-reported remediation steps, one per line (e.g. SAJ solutions). */
  solution?: string;
  /** Provider-reported handling state (e.g. SAJ "Pending"). */
  status?: string;
}

export interface SolarPowerPoint {
  t: number;
  powerW: number;
}

export interface SolarLatest {
  currentPowerW?: number;
  consumptionPowerW?: number;
  gridPowerW?: number;
  batteryPowerW?: number;
  batterySoc?: number;
  dailyEnergyKwh?: number;
  monthlyEnergyKwh?: number;
  totalEnergyKwh?: number;
  lastUpdate?: number;
}

export interface SolarInfoItem {
  label: string;
  value: string;
}

export interface SolarStationDetail {
  provider: string;
  stationId: string;
  latest: SolarLatest | null;
  devices: SolarDevice[];
  alerts: SolarAlert[];
  power: SolarPowerPoint[];
  info: SolarInfoItem[];
}

export type SolarAlertSeverity = 'offline' | 'partial' | 'fault' | 'alert' | 'device';

export interface SolarMonitorAlert {
  id: string;
  severity: SolarAlertSeverity;
  provider: string;
  plant: string;
  plantId: string;
  title: string;
  detail?: string;
  deviceSn?: string;
  at?: number;
}

export interface SolarAlertsResult {
  alerts: SolarMonitorAlert[];
  generatedAt: number;
  scannedPlants: number;
  /** Total devices reported across the fleet (0 for providers with no device API, e.g. Sigenergy). */
  totalDevices?: number;
  /** Of totalDevices, how many are communicating. */
  onlineDevices?: number;
  errors: { provider: string; name: string; error: string }[];
}

// ─── Rich plant Overview (detail dashboard) ──────────────────────────────────

export interface EnergyFlow {
  pvPowerW?: number;
  loadPowerW?: number;
  gridPowerW?: number;
  batteryPowerW?: number;
  batterySoc?: number;
  batteryDirection?: string;
  gridDirection?: string;
  hasPv?: boolean;
  hasGrid?: boolean;
  hasBattery?: boolean;
  hasGenerator?: boolean;
  generatorPowerW?: number;
  systemPowerKw?: number;
  runningState?: string;
  userMode?: string;
  todayPvEnergyKwh?: number;
  dataTime?: string;
}
export interface EnergyStat {
  kind: 'pv' | 'load' | 'grid' | 'battery';
  todayKwh?: number;
  totalKwh?: number;
  today2Kwh?: number;
  total2Kwh?: number;
  selfUsePercentage?: number;
}
export interface SelfUseBreakdown {
  pvEnergy?: number;
  loadEnergy?: number;
  sellEnergy?: number;
  buyEnergy?: number;
  chargeEnergy?: number;
  dischargeEnergy?: number;
  pvSelfConsumedEnergy?: number;
  loadSelfConsumedEnergy?: number;
  pvSelfConsumedRate?: number;
  pvSellRate?: number;
  loadSelfConsumedRate?: number;
  loadBuyRate?: number;
  unit?: string;
}
export interface ChartSeries {
  name: string;
  color?: string;
  unit?: string;
  secondaryAxis?: boolean;
  data: (number | null)[];
}
export interface ChartData {
  kind: 'line' | 'bar';
  xLabels: string[];
  series: ChartSeries[];
}
export interface Environmental {
  co2SavedT?: number;
  treesEquivalent?: number;
  coalSavedT?: number;
}
export interface StationOverview {
  provider: string;
  stationId: string;
  flow?: EnergyFlow;
  stats?: EnergyStat[];
  selfUse?: SelfUseBreakdown;
  powerCurve?: ChartData;
  comparison?: ChartData;
  environmental?: Environmental;
  strategy?: string;
}

/** Rich Overview dashboard for one plant. Resolves null when the provider doesn't
 *  expose it (HTTP 501) so the UI falls back to the basic detail. */
export async function getStationOverview(provider: string, id: string): Promise<StationOverview | null> {
  try {
    return await request<StationOverview>(`/api/solar/${provider}/stations/${encodeURIComponent(id)}/overview`);
  } catch (err) {
    if (err instanceof AuthError) throw err;
    return null; // 501/unsupported or transient — caller shows basic detail
  }
}

export function getSolarProviders(): Promise<{ providers: SolarProviderInfo[] }> {
  return request<{ providers: SolarProviderInfo[] }>('/api/solar/providers');
}

export function getSolarAlerts(): Promise<SolarAlertsResult> {
  return request<SolarAlertsResult>('/api/solar/alerts');
}

/** A single month's fleet production, kWh (from persisted snapshots). */
export interface MonthlyProductionPoint {
  month: string; // 'YYYY-MM'
  kwh: number;
}
export function getSolarMonthlyProduction(months = 6): Promise<{ months: MonthlyProductionPoint[] }> {
  return request<{ months: MonthlyProductionPoint[] }>(`/api/solar/history/monthly?months=${months}`);
}

export function getSolarOverview(): Promise<SolarOverview> {
  return request<SolarOverview>('/api/solar/overview');
}

export function getSolarStationDetail(provider: string, id: string): Promise<SolarStationDetail> {
  return request<SolarStationDetail>(`/api/solar/${encodeURIComponent(provider)}/stations/${encodeURIComponent(id)}/detail`);
}

// ─── Solar alert settings (admin) ───────────────────────────────────────────
export function getAlertSettings(): Promise<{ settings: SolarAlertSettings }> {
  return request<{ settings: SolarAlertSettings }>('/api/solar/alerts/settings');
}

export function updateAlertSettings(patch: Partial<SolarAlertSettings>): Promise<{ settings: SolarAlertSettings }> {
  return request<{ settings: SolarAlertSettings }>('/api/solar/alerts/settings', {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

// ─── Per-plant owner/contact store ──────────────────────────────────────────
export function getPlantContacts(): Promise<{ contacts: PlantContacts }> {
  return request<{ contacts: PlantContacts }>('/api/solar/plant-contacts');
}

export function updatePlantContacts(contacts: PlantContacts): Promise<{ contacts: PlantContacts }> {
  return request<{ contacts: PlantContacts }>('/api/solar/plant-contacts', {
    method: 'PUT',
    body: JSON.stringify({ contacts }),
  });
}

/** Send a one-off test alert email to the configured recipients. */
export function sendTestAlert(): Promise<{ test: boolean; sent: boolean; recipients?: string[]; detail?: string; error?: string }> {
  return request('/api/solar/alerts/run?test=1', { method: 'POST' });
}
