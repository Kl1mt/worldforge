import { apiRequest, type ApiResult } from '../lib/api';

/** The public account shape returned by the server (`AccountView` in apps/server). */
export interface Account {
  id: string;
  email: string;
  displayName: string;
  characterSlots: number;
  createdAt: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface RegisterInput extends LoginInput {
  displayName: string;
}

type AccountResult = ApiResult<{ account: Account }>;

export const authApi = {
  current: (signal?: AbortSignal, f?: typeof fetch): Promise<AccountResult> =>
    apiRequest('/account', signal ? { signal } : {}, f),
  login: (input: LoginInput, f?: typeof fetch): Promise<AccountResult> =>
    apiRequest('/auth/login', { method: 'POST', body: input }, f),
  register: (input: RegisterInput, f?: typeof fetch): Promise<AccountResult> =>
    apiRequest('/auth/register', { method: 'POST', body: input }, f),
  logout: (f?: typeof fetch): Promise<ApiResult<void>> =>
    apiRequest('/auth/logout', { method: 'POST' }, f),
};

/** Form-level message for a failed login/registration; field errors are shown inline instead. */
export function describeAuthFailure(error: {
  code: string;
  message: string;
  retryAfterSeconds?: number;
}): string {
  switch (error.code) {
    case 'invalid_credentials':
      return 'That email and password do not match an account.';
    case 'rate_limited': {
      const s = error.retryAfterSeconds;
      if (s === undefined) return 'Too many attempts. Wait a little, then try again.';
      const wait = s >= 90 ? `${Math.ceil(s / 60)} minutes` : `${s} seconds`;
      return `Too many attempts. Try again in ${wait}.`;
    }
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
