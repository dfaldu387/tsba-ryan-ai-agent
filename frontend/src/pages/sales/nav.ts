// Sales view names + sidebar mapping. Kept apart from SalesPage so the app
// shell can highlight the sidebar without loading the (lazy) sales screens.
export type SalesView =
  | 'today' | 'agent' | 'board' | 'clients' | 'score' | 'add' | 'client' | 'review' | 'setup' // the rep's own work
  | 'overview' | 'pipeline' | 'messages' | 'optouts' | 'reps' | 'settings'; // sales admin

export const SALES_ADMIN_VIEWS: SalesView[] = ['overview', 'pipeline', 'messages', 'optouts', 'reps', 'settings'];

/** The sidebar item a view belongs to (detail screens highlight their parent). */
export function salesNavView(search: string, canTeam: boolean): SalesView {
  const v = new URLSearchParams(search).get('v') as SalesView | 'team' | null;
  if (v === 'team') return 'overview';
  if (v === 'review') return 'today';
  if (v === 'client' || v === 'add') return 'clients';
  if (v === 'setup') return 'setup';
  return v ?? (canTeam ? 'overview' : 'today');
}
