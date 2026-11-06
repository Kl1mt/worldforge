import { apiRequest, type ApiResult } from '../lib/api';
import type { LegalRoute } from '../lib/route';

/** `GET /api/legal/:page` (ticket D.2). `template`: the owner has not filled the page in yet. */
export interface LegalDocument {
  page: LegalRoute;
  markdown: string;
  template: boolean;
}

export type RegistrationMode = 'open' | 'invite' | 'closed';

/** `GET /api/config` (ticket D.2): public server settings the gate needs. */
export interface PublicConfig {
  registration: { mode: RegistrationMode };
}

export const legalApi = {
  page: (
    page: LegalRoute,
    signal?: AbortSignal,
    f?: typeof fetch,
  ): Promise<ApiResult<LegalDocument>> => apiRequest(`/legal/${page}`, signal ? { signal } : {}, f),
  config: (signal?: AbortSignal, f?: typeof fetch): Promise<ApiResult<PublicConfig>> =>
    apiRequest('/config', signal ? { signal } : {}, f),
};

/** Footer links on every screen (ticket D.2). */
export const LEGAL_LINKS: readonly { route: LegalRoute; label: string }[] = [
  { route: 'impressum', label: 'Impressum' },
  { route: 'datenschutz', label: 'Datenschutz' },
];

export const LEGAL_TITLES: Record<LegalRoute, string> = {
  impressum: 'Impressum',
  datenschutz: 'Datenschutzerklärung',
};
