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
  /** Ticket 5.7: whether the current email is verified. */
  emailVerified: boolean;
}

/** `GET /api/account/security` (ticket 5.7): the account screen's security panel. */
export interface AccountSecurity {
  email: string;
  emailVerified: boolean;
  emailVerifiedAt: string | null;
  /** A verification link is out and still valid. */
  verificationPending: boolean;
  /** Mail is set up on the server; without it verification and reset are unavailable. */
  mailEnabled: boolean;
  /** Live sessions other than this one. */
  otherSessions: number;
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
  // Ticket 5.7.
  security: (
    signal?: AbortSignal,
    f?: typeof fetch,
  ): Promise<ApiResult<{ security: AccountSecurity }>> =>
    apiRequest('/account/security', signal ? { signal } : {}, f),
  resendVerification: (f?: typeof fetch): Promise<ApiResult<{ sent: true }>> =>
    apiRequest('/account/verification', { method: 'POST' }, f),
  changeEmail: (
    input: { email: string; password: string },
    f?: typeof fetch,
  ): Promise<AccountResult> => apiRequest('/account/email', { method: 'POST', body: input }, f),
  revokeOtherSessions: (f?: typeof fetch): Promise<ApiResult<{ revoked: number }>> =>
    apiRequest('/account/sessions/revoke-others', { method: 'POST' }, f),
  verifyEmail: (token: string, f?: typeof fetch): Promise<ApiResult<{ verified: true }>> =>
    apiRequest('/auth/verify-email', { method: 'POST', body: { token } }, f),
  forgotPassword: (email: string, f?: typeof fetch): Promise<ApiResult<{ accepted: true }>> =>
    apiRequest('/auth/forgot-password', { method: 'POST', body: { email } }, f),
  resetPassword: (
    input: { token: string; password: string },
    f?: typeof fetch,
  ): Promise<ApiResult<{ reset: true }>> =>
    apiRequest('/auth/reset-password', { method: 'POST', body: input }, f),
};

/** `details.limit` of a `429`: `account` (login throttle), `mail` (letters), or another class. */
function limitOf(error: { details?: unknown }): string | null {
  const l = (error.details as { limit?: unknown } | undefined)?.limit;
  return typeof l === 'string' ? l : null;
}

function waitText(s: number): string {
  return s >= 90 ? `${Math.ceil(s / 60)} minutes` : `${s} seconds`;
}

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
      const limit = limitOf(error);
      // Ticket 5.7: the per-account lock after repeated wrong passwords.
      if (limit === 'account') {
        return `Too many wrong passwords for this account. Try again in ${waitText(s ?? 60)}, or choose a new password with "Forgot your password?".`;
      }
      if (limit === 'mail') {
        return `Enough letters for now. Try again in ${waitText(s ?? 60)}.`;
      }
      if (s === undefined) return 'Too many attempts. Wait a little, then try again.';
      return `Too many attempts. Try again in ${waitText(s)}.`;
    }
    case 'email_unavailable':
      return 'Email is not set up on this server yet, so letters cannot be sent. Your account works as usual.';
    case 'token_expired':
      return 'This link has expired. Ask for a new one.';
    case 'token_invalid':
      return 'This link is not valid: it was already used, replaced by a newer letter, or copied only in part.';
    case 'wrong_password':
      return 'That password is not right.';
    case 'already_verified':
      return 'This address is already verified.';
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
