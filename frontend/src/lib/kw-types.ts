// Re-exports of the shared Keepwarm types, plus the note-extraction result
// (defined backend-side) so the sales screens import from one place.
export type {
  KwClient, KwMessage, KwMix, KwNote, KwNoteCat, KwProfile, KwScore, KwScoreboard, KwSendResult, KwStatus,
  KwTeamRow, KwTextType, KwToday, KwTone, KwUnderstood, KwQueueItem, KwWarmth, KwMetric,
  KwStage, KwAgentState, KwAgentTask, KwActivity, KwAgentMode, KwTaskKind, KwSettings,
} from '@tsba/shared';
import type { KwMix, KwNoteCat } from '@tsba/shared';

export interface KwExtractResult {
  notes: { cat: KwNoteCat; text: string }[];
  stage: string;
  suggestion: { cadenceDays: number; mix: KwMix; why: string };
}
