// The Progress tab content. Edit this (and `lastUpdated`) every few days —
// that single edit is what shows Ryan steady progress.

export type ProgressState = 'done' | 'in_progress' | 'next';

export interface ProgressItem {
  state: ProgressState;
  text: string;
}

export interface ProgressBoard {
  lastUpdated: string; // human date shown at the top
  items: ProgressItem[];
  sheet: { label: string; url: string };
}

export function progressBoard(): ProgressBoard {
  return {
    lastUpdated: '20 Oct 2026',
    items: [
      { state: 'done', text: 'Product library reviewed: 263 documents, 17 brands' },
      { state: 'done', text: '1,025 real support questions analysed; 96 turned into a test set' },
      { state: 'done', text: 'Battery installation rules (AS/NZS 5139) and Safe Work electrical code loaded' },
      { state: 'done', text: '66 manufacturer answers loaded (pending Ryan’s approval)' },
      { state: 'in_progress', text: '“System offline” guide: SOFAR draft done; Deye and SAJ waiting on Dhaval' },
      { state: 'in_progress', text: 'Test results on the 96 questions: due Fri 24 Oct' },
      { state: 'next', text: 'Full product PDFs, network rules, email/text/chat connection: next' },
    ],
    sheet: {
      label: 'TSBA – Requests & Decisions (shared sheet)',
      // Placeholder — replace with the real shared-sheet URL before sending to Ryan.
      url: 'https://docs.google.com/spreadsheets/d/REPLACE_WITH_SHARED_SHEET_ID/edit',
    },
  };
}
