import { env, whesConfigured } from '../env.js';
import { ProviderError, type NormalizedStation, type NormalizedDetail, type SolarProvider } from './types.js';

/**
 * WHES "ECOS Hub" monitoring.
 *
 * ⚠️ NOT IMPLEMENTED: no public API was found for WHES / ECOS Hub. This
 * placeholder keeps the platform in the provider list. To implement it we need:
 * the API base URL, the auth scheme (token vs app key vs account login), and the
 * station-list + station-detail endpoints — from WHES/ECOS Hub developer docs.
 *
 * Config-gated: setting WHES_BASE_URL marks it "configured" so it surfaces a
 * clear error (rather than silently doing nothing) once someone starts wiring it.
 */

export const whesProvider: SolarProvider = {
  id: 'whes',
  name: 'WHES (ECOS Hub)',
  configured: whesConfigured,

  async listStations(): Promise<NormalizedStation[]> {
    throw new ProviderError(
      'whes_not_implemented: no ECOS Hub API mapped yet — provide the API base URL, auth scheme and endpoints.',
    );
  },

  async stationDetail(_stationId: string): Promise<NormalizedDetail> {
    void env.whesBaseUrl;
    throw new ProviderError('whes_not_implemented: no ECOS Hub API mapped yet.');
  },
};
