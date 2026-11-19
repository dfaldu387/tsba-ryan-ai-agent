// Types and label maps shared by the backend and the frontend.

// ─── Users, roles & permissions (RBAC) ───────────────────────────────────────
// The admin panel is multi-user. Every account has exactly one role; each role
// grants a fixed set of permissions. Routes and UI are gated on permissions,
// not roles, so the mapping can change in one place.

export type Role = 'admin' | 'manager' | 'viewer' | 'rep';

export const ROLES: Role[] = ['admin', 'manager', 'viewer', 'rep'];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  manager: 'Manager',
  viewer: 'Viewer',
  rep: 'Sales rep',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: 'Full control: manage users, connections, knowledge sources and approvals.',
  manager: 'Run scans/ingest, ask the agent and approve drafts. No user management.',
  viewer: 'Read-only: view the dashboard, knowledge base and drafts.',
  rep: 'Sales follow-up only: their own clients, drafts and scoreboard.',
};

export type Permission =
  | 'manage_users' // create/edit/disable users and change roles
  | 'manage_connections' // connect/disconnect Google accounts
  | 'run_ingest' // scan Drive folders / Gmail labels into the knowledge base
  | 'approve_drafts' // approve/reject/edit drafts
  | 'ask' // create drafts (ask the agent)
  | 'view' // read the dashboard, KB and drafts
  | 'sales' // use the sales follow-up agent for your own clients
  | 'sales_team'; // see every rep's scoreboard and cold clients

export const PERMISSIONS: Permission[] = [
  'manage_users',
  'manage_connections',
  'run_ingest',
  'approve_drafts',
  'ask',
  'view',
  'sales',
  'sales_team',
];

export const PERMISSION_LABELS: Record<Permission, string> = {
  manage_users: 'Manage users',
  manage_connections: 'Manage connections',
  run_ingest: 'Run scans & ingest',
  approve_drafts: 'Approve drafts',
  ask: 'Ask the agent',
  view: 'View dashboard',
  sales: 'Sales follow-ups',
  sales_team: 'Sales team view',
};

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ['manage_users', 'manage_connections', 'run_ingest', 'approve_drafts', 'ask', 'view', 'sales', 'sales_team'],
  manager: ['manage_connections', 'run_ingest', 'approve_drafts', 'ask', 'view', 'sales', 'sales_team'],
  viewer: ['view'],
  rep: ['sales'],
};

export function isRole(v: unknown): v is Role {
  return v === 'admin' || v === 'manager' || v === 'viewer' || v === 'rep';
}

export function permissionsForRole(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function hasPermission(role: Role, perm: Permission): boolean {
  return permissionsForRole(role).includes(perm);
}

/** The public shape of a user account — never includes the password hash. */
export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  created_at: string;
  last_login_at: string | null;
}

/** Returned by login / "who am I": the user plus the permissions their role grants. */
export interface AuthenticatedUser extends User {
  permissions: Permission[];
}

export type Audience = 'customer' | 'installer' | 'sales';
export type Channel = 'chat' | 'text' | 'email';
export type Outcome = 'answer' | 'handover' | 'decline' | 'clarify';
export type DraftStatus = 'pending' | 'sent' | 'team' | 'rejected';
export type KnowledgeKind = 'rule' | 'maker';

/** Outcome of actually dispatching an approved reply on the outbound channel. */
export type DeliveryStatus = 'skipped' | 'delivered' | 'failed';
export interface DraftDelivery {
  status: DeliveryStatus;
  /** The provider that handled it, e.g. 'console' (dry-run) or 'webhook'. */
  channel: string;
  /** Human-readable detail: where it went, or why it was skipped/failed. */
  detail: string;
  at: string; // ISO timestamp
}

export const AUDIENCE_LABELS: Record<Audience, string> = {
  customer: 'Customer',
  installer: 'Installer',
  sales: 'Sales rep',
};

export const CHANNEL_LABELS: Record<Channel, string> = {
  chat: 'Chat',
  text: 'Text',
  email: 'Email',
};

// [label, css-class] — mirrors the reference page's OUT map.
export const OUTCOME_LABELS: Record<Outcome, [string, string]> = {
  answer: ['Answer', 's-answer'],
  handover: ['Handed to team', 's-handover'],
  decline: ['Declined', 's-decline'],
  clarify: ['Needs more info', 's-clarify'],
};

export const AUDIENCES: Audience[] = ['customer', 'installer', 'sales'];
export const CHANNELS: Channel[] = ['chat', 'text', 'email'];

export const AUTOMATED_RESPONSE_PREFIX =
  'This is an automated response from TSBA Technical Support.';

/** A knowledge-base entry (verified rule or manufacturer answer). */
export interface KnowledgeEntry {
  id: string;
  kind: KnowledgeKind;
  brand: string;
  model: string;
  topic: string;
  title: string;
  text: string;
  source: string;
  confidence?: 'high' | 'medium';
}

/** The source cards shown under a draft. */
export interface SourceCard {
  id: string;
  kind: KnowledgeKind;
  title: string;
  source: string;
}

export interface TeamHandover {
  summary: string;
  needed: string[];
}

/** The JSON contract the model returns and the API passes through. */
export interface DraftResult {
  outcome: Outcome;
  reply: string;
  sources: string[];
  note_for_ryan: string;
  team_handover: TeamHandover | null;
}

export interface DraftRequest {
  question: string;
  audience: Audience;
  channel: Channel;
  /** Where an approved reply should be sent (email address, phone, chat id). */
  recipient?: string | null;
}

/** A persisted draft row as returned by the API. */
export interface Draft {
  id: number;
  question: string;
  audience: Audience;
  channel: Channel;
  outcome: Outcome;
  reply: string;
  reply_original: string;
  sources: SourceCard[];
  note_for_ryan: string;
  team_handover: TeamHandover | null;
  status: DraftStatus;
  edited: boolean;
  /** Destination for the approved reply; null when none was captured. */
  recipient: string | null;
  /** Set once an approved reply has been dispatched (or an attempt was made). */
  delivery: DraftDelivery | null;
  created_at: string;
  decided_at: string | null;
}

export type DraftAction =
  | { action: 'approve'; text?: string }
  | { action: 'reject' }
  | { action: 'edit'; text: string };

export function isOutcome(v: unknown): v is Outcome {
  return v === 'answer' || v === 'handover' || v === 'decline' || v === 'clarify';
}

export function isAudience(v: unknown): v is Audience {
  return v === 'customer' || v === 'installer' || v === 'sales';
}

export function isChannel(v: unknown): v is Channel {
  return v === 'chat' || v === 'text' || v === 'email';
}

// ─── Connections (OAuth integrations) ────────────────────────────────────────
// The external accounts TSBA connects: Google Drive as a knowledge source
// (blueprint Lane 1) and Gmail as the email support channel. Both use Google
// OAuth 2.0 but are modelled separately so one can be connected without the other.

export type ConnectionProvider = 'google-drive' | 'gmail';

export const CONNECTION_PROVIDERS: ConnectionProvider[] = ['google-drive', 'gmail'];

export const CONNECTION_LABELS: Record<ConnectionProvider, string> = {
  'google-drive': 'Google Drive',
  gmail: 'Gmail',
};

/** What each connector is for, shown in the Connections UI. */
export const CONNECTION_PURPOSE: Record<ConnectionProvider, string> = {
  'google-drive': 'Ingest product guides, warranties and data sheets as knowledge sources.',
  gmail: 'Receive and send support email (replies stay approval-gated).',
};

export function isConnectionProvider(v: unknown): v is ConnectionProvider {
  return v === 'google-drive' || v === 'gmail';
}

/**
 * The public status of one connector. Never carries tokens — only whether it is
 * connected, which account, and the granted scopes.
 */
export interface ConnectionStatus {
  provider: ConnectionProvider;
  label: string;
  purpose: string;
  /** false when the server has no Google OAuth credentials configured at all. */
  configured: boolean;
  connected: boolean;
  account_email: string | null;
  scopes: string[];
  connected_at: string | null;
  /** Access-token expiry; the server refreshes automatically when it lapses. */
  expires_at: string | null;
}

// ─── Admin overview ──────────────────────────────────────────────────────────
// A single snapshot for the Admin panel: who the agent is plus the live system,
// knowledge-base, connection and draft-activity numbers. Read-only; no secrets.

/** Static identity of the assistant, shown in the Admin "introduction" card. */
export interface AgentProfile {
  name: string;
  tagline: string;
  role: string;
  /** What the assistant can do, one capability per line. */
  capabilities: string[];
  /** The guardrails it always follows (approval-gating, no pricing, etc.). */
  guardrails: string[];
}

export const AGENT_PROFILE: AgentProfile = {
  name: 'TSBA Technical Support AI',
  tagline: 'Drafts accurate solar, battery & inverter support answers — for a human to approve.',
  role: 'Technical-support assistant for TSBA installers, customers and sales staff.',
  capabilities: [
    'Answers from TSBA’s own product guides, warranties and data sheets (Google Drive).',
    'Grounds every reply in retrieved knowledge and cites its sources.',
    'Adapts tone and detail to the audience: customer, installer or sales.',
    'Applies AS/NZS 5139 battery-install rules and Safe Work electrical code.',
    'Hands complex or unsafe cases to the human team instead of guessing.',
  ],
  guardrails: [
    'Every reply is a draft — nothing is sent without human approval.',
    'Never quotes or invents pricing.',
    'Only states what the connected knowledge base supports.',
    'OAuth tokens are encrypted at rest and never leave the server.',
  ],
};

export interface AdminOverview {
  agent: AgentProfile;
  system: {
    /** Claude is configured and will draft live (vs. offline fallback). */
    anthropic: boolean;
    model: string;
    embeddingProvider: string;
    storage: string;
    usesPostgres: boolean;
  };
  knowledge: {
    documents: number;
    chunks: number;
    folderSources: number;
    driveDocuments: number;
    emailDocuments: number;
  };
  users: {
    total: number;
    admins: number;
  };
  connections: ConnectionStatus[];
  drafts: {
    total: number;
    pending: number;
    sent: number;
    team: number;
    rejected: number;
  };
}

// ─── Google Drive: browse & ingest ───────────────────────────────────────────

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/** One item from a Drive folder listing (file or folder). */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  /** Whether this file's content can be extracted and ingested. */
  ingestable: boolean;
  webViewLink: string | null;
  modifiedTime: string | null;
  /** Bytes, when Drive reports it (Google-native docs have none). */
  size: number | null;
}

export interface DriveListing {
  /** The folder being listed ('root' at the top level). */
  folderId: string;
  files: DriveFile[];
  nextPageToken: string | null;
}

export type IngestStatus = 'ingested' | 'skipped' | 'failed';

/** Per-file result of an ingest run. */
export interface IngestResult {
  fileId: string;
  name: string;
  status: IngestStatus;
  chunks: number;
  /** Present on 'skipped' / 'failed' — why. */
  reason?: string;
}

export type IngestSource = 'google-drive' | 'gmail';

/**
 * Quality of a document's extracted text in the KB:
 * - 'ok'        usable prose
 * - 'low'       little/no usable text (image-based, extraction poor)
 * - 'corrupted' broken font encoding (dropped glyphs) — needs OCR re-ingest
 */
export type TextQuality = 'ok' | 'low' | 'corrupted';

/** A document that has been ingested from a connected source into the knowledge base. */
export interface IngestedDocument {
  id: string; // the Drive file id, or `gmail:<messageId>`
  source: IngestSource;
  title: string;
  mime_type: string;
  web_url: string | null;
  chunk_count: number;
  byte_size: number | null;
  status: IngestStatus;
  /** Quality of the stored text; undefined for older rows not yet assessed. */
  text_quality?: TextQuality;
  ingested_at: string;
}

/**
 * A Drive folder the admin has selected as a knowledge-base source. Its
 * supported files are ingested on add and whenever it's re-synced.
 */
export interface DriveFolderSource {
  id: string; // the Drive folder id
  name: string;
  web_url: string | null;
  /** Include files in subfolders too. */
  recursive: boolean;
  added_at: string;
  last_synced_at: string | null;
  /** Supported files found at the last sync. */
  last_file_count: number | null;
}

/** Summary returned after ingesting a folder's contents. */
export interface FolderSyncResult {
  folderId: string;
  name: string;
  filesFound: number;
  ingested: number;
  skipped: number;
  failed: number;
  results: IngestResult[];
  /** Set when the folder itself couldn't be synced (e.g. access error); the rest still run. */
  error?: string;
}

// ─── Gmail: scan a label into the knowledge base ─────────────────────────────

/** A Gmail label the user can pick as a scan source. */
export interface GmailLabel {
  id: string;
  name: string;
  /** 'system' labels (INBOX, SENT…) vs. 'user' labels. */
  type: 'system' | 'user';
  messagesTotal: number | null;
}

/** Summary returned after scanning a Gmail label into the knowledge base. */
export interface GmailScanResult {
  labelId: string;
  labelName: string;
  messagesFound: number;
  ingested: number;
  skipped: number;
  failed: number;
  results: IngestResult[];
}

// ─── Solar monitoring alert settings (admin-configurable, stored in the DB) ──

/** Admin-side alert recipients and how long an issue must persist first. */
export interface AdminAlertChannel {
  /** Email addresses that receive fleet alerts. */
  recipients: string[];
  /** Only notify once an issue has persisted at least this many minutes (0 = immediately). */
  delayMin: number;
}

/**
 * Customer (plant-owner) alert settings. Delivery is not wired yet — enabling
 * this stores the preference and the debounce; per-plant customer addresses are
 * added later.
 */
export interface CustomerAlertChannel {
  enabled: boolean;
  delayMin: number;
}

/**
 * Admin-maintained owner/contact details for one plant, used when the monitoring
 * platform doesn't expose them (or to override what it does). Surfaced in alert
 * emails. Keyed by `${provider}:${plantId}` in the PlantContacts map.
 */
export interface PlantContact {
  /** Owner / primary contact name. */
  name?: string;
  email?: string;
  phone?: string;
  /** Free-text note (site access, preferred contact hours, …). */
  notes?: string;
  /** Plant name, stored for display so the editor needn't re-resolve it. */
  plantName?: string;
}

/** All plant contacts, keyed by `${provider}:${plantId}`. */
export type PlantContacts = Record<string, PlantContact>;

/**
 * One admin rule mapping an issue to a knowledge-base document: when any of the
 * comma-separated keywords appears in an alert's text, that document (a Drive
 * PDF in the KB) is attached to the alert email.
 */
export interface AlertResolutionRule {
  /** Comma/space separated match terms, e.g. "offline, wifi, not communicating". */
  keywords: string;
  /** KB document id (the Drive file id). */
  documentId: string;
  /** Document title, for display and the attachment filename. */
  documentTitle: string;
}

/**
 * Scheduled digest delivery. When enabled, admin alerts are not emailed one per
 * plant as they trip; instead every open issue is held and sent as ONE combined
 * digest email at the configured clock times, capped per day. This is what keeps
 * the inbox from filling with a separate email per plant.
 */
export interface AlertScheduleConfig {
  /** On → batch into scheduled digests. Off → the legacy one-email-per-plant flow. */
  enabled: boolean;
  /** 24-hour "HH:MM" times (in `timezone`) at which a digest is sent. The count
   *  of times listed is "how many times a day". */
  times: string[];
  /** IANA timezone the `times` are read in, e.g. "Australia/Sydney". */
  timezone: string;
  /** Hard cap on digests per day regardless of `times` — a safety limit. */
  maxPerDay: number;
  /**
   * Send new problems (plant offline/partial, device offline, inverter fault)
   * IMMEDIATELY on the scan that detects them, with the suggested fix — instead
   * of holding them for the next digest. The digests then act as a roll-up of
   * what's still open plus recoveries. Quiet hours still apply.
   */
  instant: boolean;
}

/**
 * Configuration for the background solar alert monitor. Persisted in the DB and
 * edited in the admin UI; the monitor reads it live (no restart needed).
 */
export interface SolarAlertSettings {
  /** Master switch for the monitor. */
  enabled: boolean;
  /** How often the fleet is scanned, minutes. */
  intervalMin: number;
  /** Send a recovery email when a previously-alerted issue clears. */
  recovery: boolean;
  /** Minutes an issue must stay clear before it counts as resolved (and the
   *  "resolved" email goes out). Stops a flapping plant sending resolved/alert
   *  pairs every scan. 0 = resolve on the first clean scan. */
  recoveryConfirmMin: number;
  /** Suppress all emails while it is night at the fleet location; send a morning catch-up. */
  quietNight: boolean;
  /** Fleet reference location used for the sunset/sunrise calculation. */
  lat: number;
  lng: number;
  admin: AdminAlertChannel;
  customer: CustomerAlertChannel;
  /** Include an AI-written, KB-grounded solution in the alert email body. */
  includeSolution: boolean;
  /** Attach a matching resolution guide (PDF from the KB) to alert emails. */
  attachResolution: boolean;
  /** Keyword→document rules, evaluated in order; first match wins. Falls back to
   *  automatic KB retrieval when no rule matches and attachResolution is on. */
  resolutionRules: AlertResolutionRule[];
  /** Scheduled digest delivery (times + daily cap). */
  schedule: AlertScheduleConfig;
  /** ISO timestamp of the last save (server-set). */
  updatedAt?: string;
}

// ─── Sales follow-up agent (Keepwarm) ────────────────────────────────────────
// A rep voice-notes each client meeting, sets a follow-up rhythm, and approves
// every AI-drafted text. Six rules the product never breaks: the rep approves
// every text; the rep is always the sender; friendly check-ins never sell; a
// client reply pauses the rhythm; STOP is forever; quiet hours are respected.

export type KwTone = 'relaxed' | 'friendly' | 'direct';
export type KwTextType = 'business' | 'friendly';
export type KwMix = 'business' | 'friendly' | 'mix';
export type KwNoteCat = 'want' | 'situation' | 'decides' | 'personal' | 'promised';
export type KwMessageKind = 'due' | 'reply' | 'new' | 'adhoc' | 'inbound';
export type KwMessageStatus = 'draft' | 'scheduled' | 'sent' | 'failed' | 'skipped' | 'held' | 'received';
export type KwMetric = 'calls' | 'convos' | 'booked' | 'attended' | 'proposals' | 'pipeline' | 'followups';
export type KwLoggedMetric = 'calls' | 'convos' | 'booked' | 'attended' | 'proposals' | 'revenue';
export type KwWarmth = 'warm' | 'cooling' | 'due' | 'cold' | 'paused' | 'stopped';

export const KW_NOTE_LABELS: Record<KwNoteCat, string> = {
  want: 'Interested in',
  situation: 'Their situation',
  decides: 'What decides it',
  personal: 'Personal',
  promised: 'You promised',
};
export const KW_NOTE_CATS: KwNoteCat[] = ['want', 'situation', 'decides', 'personal', 'promised'];

export const KW_TONES: { id: KwTone; name: string; eg: string }[] = [
  { id: 'relaxed', name: 'Relaxed', eg: 'Hey Priya, Sam here. Just seeing how you went with the quote. Sing out if you want to chat it through.' },
  { id: 'friendly', name: 'Friendly and professional', eg: 'Hi Priya, Sam from TSBA. Just checking whether you had any questions on the quote. Happy to walk you through it.' },
  { id: 'direct', name: 'Straight to the point', eg: 'Hi Priya, Sam from TSBA. Any questions on the quote? I can call today if useful.' },
];

/** Harry Rizk, page 103: seven inputs and one result. Nothing else. */
export const KW_METRICS: { k: KwMetric; label: string; hint: string; day: number; auto?: boolean }[] = [
  { k: 'calls', label: 'Phone calls made', hint: 'Every dial counts, answered or not', day: 30 },
  { k: 'convos', label: 'Conversations had', hint: 'Someone picked up and talked', day: 8 },
  { k: 'booked', label: 'Meetings booked', hint: 'They said yes to a time', day: 3 },
  { k: 'attended', label: 'Meetings attended', hint: 'They turned up', day: 2 },
  { k: 'proposals', label: 'Proposals sent', hint: 'A formal offer in their hands', day: 2 },
  { k: 'pipeline', label: 'Pipeline additions', hint: 'New people added', day: 3, auto: true },
  { k: 'followups', label: 'Follow-ups', hint: 'People you got back in touch with', day: 5, auto: true },
];

export const KW_CADENCES: { days: number; label: string }[] = [
  { days: 7, label: 'Every week' },
  { days: 14, label: 'Every fortnight' },
  { days: 30, label: 'Every month' },
  { days: 90, label: 'Every 3 months' },
];

// ─── Deal pipeline + the agent that works it on the rep's behalf ─────────────
export type KwStage = 'lead' | 'contacted' | 'meeting' | 'quoted' | 'negotiating' | 'won' | 'lost';

/**
 * The stages a deal moves through. `prob` weights the forecast; `staleDays` is
 * how long a deal can sit in the stage before the agent asks the rep to act.
 */
export const KW_STAGES: { id: KwStage; label: string; prob: number; staleDays: number; hint: string }[] = [
  { id: 'lead', label: 'New lead', prob: 0.05, staleDays: 2, hint: 'Not spoken to yet' },
  { id: 'contacted', label: 'Contacted', prob: 0.15, staleDays: 7, hint: 'Talking, no meeting yet' },
  { id: 'meeting', label: 'Site visit', prob: 0.3, staleDays: 3, hint: 'Meeting or site visit booked/done' },
  { id: 'quoted', label: 'Quote sent', prob: 0.5, staleDays: 5, hint: 'Proposal in their hands' },
  { id: 'negotiating', label: 'Deciding', prob: 0.7, staleDays: 7, hint: 'Weighing it up, questions, other quotes' },
  { id: 'won', label: 'Won', prob: 1, staleDays: 0, hint: 'Signed' },
  { id: 'lost', label: 'Lost', prob: 0, staleDays: 0, hint: 'Went elsewhere or not going ahead' },
];
export const KW_OPEN_STAGES: KwStage[] = ['lead', 'contacted', 'meeting', 'quoted', 'negotiating'];
export const isKwStage = (v: unknown): v is KwStage => KW_STAGES.some((s) => s.id === v);
export const kwStageLabel = (s: KwStage): string => KW_STAGES.find((x) => x.id === s)?.label ?? s;

/** What the agent can propose. Nothing here ever sends a text by itself. */
export type KwTaskKind =
  | 'move_stage' // a reply or event suggests the deal moved
  | 'chase' // deal has gone quiet in its stage: draft a nudge
  | 'call' // a new lead nobody has called
  | 'log_outcome' // a meeting should have happened: what came of it?
  | 'set_rhythm' // active deal with no follow-up rhythm
  | 'add_value' // quote stage but no deal value, so the forecast is blind
  | 'close_lost' // silent for so long it is probably gone
  | 'handback'; // a rep-handled conversation looks finished: give it back to the agent?
export type KwTaskStatus = 'open' | 'done' | 'dismissed';

export interface KwAgentTask {
  id: string;
  clientId: string;
  clientName: string;
  kind: KwTaskKind;
  title: string;
  /** Why the agent raised it, in one sentence the rep can check. */
  reason: string;
  priority: 1 | 2 | 3; // 1 = do first
  payload: { toStage?: KwStage; cadenceDays?: number; quote?: string; intent?: string };
  status: KwTaskStatus;
  createdAt: string;
  resolvedAt: string | null;
}

export type KwActor = 'agent' | 'rep';
export interface KwActivity {
  id: string;
  clientId: string | null;
  clientName: string;
  actor: KwActor;
  action: string; // machine key, e.g. 'stage', 'sent', 'reply', 'task_done'
  detail: string; // human sentence
  at: string;
  /** Agent changes the rep can take back (only when nothing has changed since). */
  undoable: boolean;
}

export type KwAgentMode = 'suggest' | 'assist';

/** Who answers the client's next message. See db/schema.sql (kw_clients.convo). */
export type KwConvo = 'idle' | 'agent' | 'rep';
export type KwSender = 'rep' | 'agent';

export interface KwAgentState {
  mode: KwAgentMode;
  lastRunAt: string | null;
  running: boolean;
  tasks: KwAgentTask[];
  activity: KwActivity[];
  /** One-line summary the agent writes for the top of the screen. */
  brief: string;
}

export interface KwPipelineTotals {
  stage: KwStage;
  count: number;
  value: number;
  weighted: number;
}

export interface KwNote {
  id: string;
  cat: KwNoteCat;
  text: string;
}

export interface KwUnderstood {
  sells: string;
  clients: string;
  howTheyBuy: string;
  reasonsToText: string;
}

export interface KwProfile {
  displayName: string;
  company: string;
  signOff: string;
  about: string;
  understood: KwUnderstood | null;
  tone: KwTone;
  sendTime: string; // HH:MM, rep's local time
  timezone: string;
}

export interface KwClient {
  id: string;
  name: string;
  phone: string;
  email: string;
  stage: string;
  notes: KwNote[];
  cadenceDays: number | null;
  mix: KwMix;
  nextType: KwTextType;
  sendTime: string | null;
  nextDue: string | null; // YYYY-MM-DD
  paused: boolean;
  optedOut: boolean;
  lastContactAt: string | null;
  lastReplyAt: string | null;
  createdAt: string;
  warmth: KwWarmth;
  /** 0–100: how much of the gap until the next text is left (the ring fill). */
  warmthPct: number;
  daysSinceContact: number | null;
  dealStage: KwStage;
  dealValue: number | null; // AUD
  stageChangedAt: string;
  daysInStage: number;
  expectedClose: string | null; // YYYY-MM-DD
  lostReason: string;
  convo: KwConvo;
  convoSince: string | null;
  /** Why the agent handed over / took it, in one sentence. */
  convoReason: string;
}

export interface KwMessage {
  id: string;
  clientId: string;
  direction: 'out' | 'in';
  kind: KwMessageKind;
  type: KwTextType;
  status: KwMessageStatus;
  body: string;
  usedNotes: string[];
  approvedAt: string | null;
  scheduledFor: string | null;
  sentAt: string | null;
  error: string | null;
  createdAt: string;
  sentBy: KwSender;
}

export interface KwQueueItem {
  message: KwMessage;
  client: KwClient;
}

export type KwScore = Record<KwMetric | 'revenue', number>;

export interface KwToday {
  date: string;
  replies: KwQueueItem[];
  due: KwQueueItem[];
  scheduled: KwQueueItem[];
  noRhythm: KwClient[];
  /** Conversations the agent is answering by itself right now. */
  agentHandling: KwClient[];
  score: KwScore;
  generating: number;
}

export interface KwScoreboard {
  range: 'day' | 'week';
  from: string;
  to: string;
  score: KwScore;
  /** Per-day totals for the week view (Mon → Sun). */
  days: { date: string; score: KwScore }[];
}

export interface KwSendResult {
  message: KwMessage;
  client: KwClient;
  /** Human sentence: "Sent", or why it is waiting (quiet hours / send time). */
  note: string;
}

export interface KwTeamRow {
  userId: string;
  name: string;
  email: string;
  setUp: boolean;
  clients: number;
  overdue: number;
  waitingReplies: number;
  draftsWaiting: number;
  today: KwScore;
  week: KwScore;
  lastActiveAt: string | null;
  /** Share of texts (last 30 days) sent exactly as the AI drafted them. */
  sentAsIsPct: number | null;
}

export interface KwStatus {
  profile: KwProfile | null;
  sms: { mode: 'twilio' | 'outbox'; from: string | null };
  ai: boolean;
  quietHours: { start: string; end: string; sunday: boolean };
  targets: Record<KwMetric, number>;
  agentMode: KwAgentMode;
  autoReply: boolean;
}

// ─── Sales admin (managers) ──────────────────────────────────────────────────
/** Team-wide settings for the sales follow-up agent. Sundays are always quiet. */
export interface KwSettings {
  /** Daily target per scoreboard input; weekly = daily × 5. */
  targets: Record<KwMetric, number>;
  quietStart: string; // HH:MM, earliest send time (rep's zone)
  quietEnd: string; // HH:MM, latest send time
  /**
   * How much the pipeline agent does by itself. 'suggest': every change waits
   * for the rep. 'assist': it applies clear-cut stage moves (never Won/Lost)
   * and logs them with an undo. Texts always need the rep's approval.
   */
  agentMode: KwAgentMode;
  /**
   * Let the agent answer routine client replies by itself (thanks, confirming
   * a time, simple questions). Off by default: it breaks the "rep approves
   * every text" rule, so it needs sign-off before being switched on.
   */
  autoReply: boolean;
}

export interface KwAdminClient extends KwClient {
  repId: string;
  repName: string;
}

export interface KwAdminMessage extends KwMessage {
  clientName: string;
  repId: string;
  repName: string;
}

export interface KwOptOut {
  phone: string;
  source: string;
  createdAt: string;
  clients: { name: string; repName: string }[];
}
