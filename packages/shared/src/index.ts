// Types and label maps shared by the backend and the frontend.

export type Audience = 'customer' | 'installer' | 'sales';
export type Channel = 'chat' | 'text' | 'email';
export type Outcome = 'answer' | 'handover' | 'decline' | 'clarify';
export type DraftStatus = 'pending' | 'sent' | 'team' | 'rejected';
export type KnowledgeKind = 'rule' | 'maker';

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
