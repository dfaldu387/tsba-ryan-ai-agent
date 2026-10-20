// Frontend-only view types (the API shapes live in @tsba/shared).

export type ProgressState = 'done' | 'in_progress' | 'next';

export interface ProgressItem {
  state: ProgressState;
  text: string;
}

export interface ProgressBoard {
  lastUpdated: string;
  items: ProgressItem[];
  sheet: { label: string; url: string };
}
