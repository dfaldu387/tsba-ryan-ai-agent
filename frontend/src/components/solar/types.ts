// Shared props passed from the Solar shell down to each section view.
import type { SolarAlertsResult, SolarOverview, SolarProviderInfo, SolarStation } from '../../api';

export interface SolarViewProps {
  providers: SolarProviderInfo[];
  /** Live fleet overview (stations + per-provider errors). */
  overview: SolarOverview | null;
  stations: SolarStation[];
  /** Fleet alert scan (shared, polled). null until first load. */
  alerts: SolarAlertsResult | null;
  alertsLoading: boolean;
  lastUpdated: number | null;
  refreshing: boolean;
  refresh: () => void;
  providerName: (id: string) => string;
  openStation: (s: SolarStation) => void;
  /** Jump to another sub-section (e.g. a tile linking to Plants/Alerts). */
  goTo: (view: 'overview' | 'plants' | 'analytics' | 'devices' | 'alerts' | 'integrations') => void;
}
