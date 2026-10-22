// Types and label maps shared by the backend and the frontend.

// ─── Users, roles & permissions (RBAC) ───────────────────────────────────────
// The admin panel is multi-user. Every account has exactly one role; each role
// grants a fixed set of permissions. Routes and UI are gated on permissions,
// not roles, so the mapping can change in one place.

export type Role = 'admin' | 'manager' | 'viewer';

export const ROLES: Role[] = ['admin', 'manager', 'viewer'];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  manager: 'Manager',
  viewer: 'Viewer',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: 'Full control: manage users, connections, knowledge sources and approvals.',
  manager: 'Run scans/ingest, ask the agent and approve drafts. No user management.',
  viewer: 'Read-only: view the dashboard, knowledge base and drafts.',
};

export type Permission =
  | 'manage_users' // create/edit/disable users and change roles
  | 'manage_connections' // connect/disconnect Google accounts
  | 'run_ingest' // scan Drive folders / Gmail labels into the knowledge base
  | 'approve_drafts' // approve/reject/edit drafts
  | 'ask' // create drafts (ask the agent)
  | 'view'; // read the dashboard, KB and drafts

export const PERMISSIONS: Permission[] = [
  'manage_users',
  'manage_connections',
  'run_ingest',
  'approve_drafts',
  'ask',
  'view',
];

export const PERMISSION_LABELS: Record<Permission, string> = {
  manage_users: 'Manage users',
  manage_connections: 'Manage connections',
  run_ingest: 'Run scans & ingest',
  approve_drafts: 'Approve drafts',
  ask: 'Ask the agent',
  view: 'View dashboard',
};

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ['manage_users', 'manage_connections', 'run_ingest', 'approve_drafts', 'ask', 'view'],
  manager: ['manage_connections', 'run_ingest', 'approve_drafts', 'ask', 'view'],
  viewer: ['view'],
};

export function isRole(v: unknown): v is Role {
  return v === 'admin' || v === 'manager' || v === 'viewer';
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
