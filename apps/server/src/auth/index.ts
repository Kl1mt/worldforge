export {
  registerAuth,
  accountView,
  DEFAULT_AUTH_OPTIONS,
  SESSION_COOKIE,
  type AccountView,
  type AuthOptions,
  type RateLimit,
  type RequestAuth,
} from './routes.js';
export { hashPassword, verifyPassword } from './password.js';
export { createSession, resolveSession, revokeSession, sessionIdFor } from './session.js';
export { validateRegistration, type FieldErrors, type RegistrationInput } from './validation.js';
export {
  DEFAULT_ACCOUNT_RATE_LIMIT,
  createAccountRateLimiter,
  type AccountRateLimit,
} from './account-rate-limit.js';
