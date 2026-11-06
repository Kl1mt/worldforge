import type { AccountRole, GuideState, GuideStepId } from '@worldforge/game-core';
import { describeSanction, sanctionOf } from '../social/api';
import { apiRequest, type ApiResult } from '../lib/api';

/** The public account shape returned by the server (`AccountView` in apps/server). */
export interface Account {
  id: string;
  email: string;
  displayName: string;
  /** Public handle (ticket 4.1). */
  handle: string;
  /** Ticket 4.1: staff see the moderator queue (the server checks it on every request). */
  role: AccountRole;
  characterSlots: number;
  createdAt: string;
  /** First-session guide (ticket 2.7). */
  guide: GuideState;
}

export type GuideUpdate = { step: GuideStepId } | { dismissed: boolean };

export interface LoginInput {
  email: string;
  password: string;
}

export interface RegisterInput extends LoginInput {
  displayName: string;
  /** Ticket D.2: needed when the server's registration mode is `invite`. */
  inviteCode?: string;
}

type AccountResult = ApiResult<{ account: Account }>;

export const authApi = {
  current: (signal?: AbortSignal, f?: typeof fetch): Promise<AccountResult> =>
    apiRequest('/account', signal ? { signal } : {}, f),
  login: (input: LoginInput, f?: typeof fetch): Promise<AccountResult> =>
    apiRequest('/auth/login', { method: 'POST', body: input }, f),
  register: (input: RegisterInput, f?: typeof fetch): Promise<AccountResult> =>
    apiRequest('/auth/register', { method: 'POST', body: input }, f),
  guide: (update: GuideUpdate, f?: typeof fetch): Promise<AccountResult> =>
    apiRequest('/account/guide', { method: 'POST', body: update }, f),
  logout: (f?: typeof fetch): Promise<ApiResult<void>> =>
    apiRequest('/auth/logout', { method: 'POST' }, f),
};

/** Form-level message for a failed login/registration; field errors are shown inline instead. */
export function describeAuthFailure(error: {
  code: string;
  message: string;
  retryAfterSeconds?: number;
  details?: unknown;
}): string {
  switch (error.code) {
    case 'account_suspended': {
      const s = sanctionOf(error);
      return s ? `${describeSanction(s)} Reason: ${s.reason}` : 'This account is suspended.';
    }
    case 'invalid_credentials':
      return 'That email and password do not match an account.';
    case 'rate_limited': {
      const s = error.retryAfterSeconds;
      if (s === undefined) return 'Too many attempts. Wait a little, then try again.';
      const wait = s >= 90 ? `${Math.ceil(s / 60)} minutes` : `${s} seconds`;
      return `Too many attempts. Try again in ${wait}.`;
    }
    case 'invite_invalid':
      return 'That invite code cannot be used. Check it, or ask for a new one.';
    case 'registration_closed':
      return 'Registration is closed right now.';
    case 'validation_failed':
    case 'email_taken':
    case 'display_name_taken':
      return 'Some fields need attention.';
    case 'network':
      return 'The server cannot be reached. Check your connection and try again.';
    default:
      return 'Something went wrong on our side. Try again in a moment.';
  }
}
