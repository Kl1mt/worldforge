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
// Ticket 5.7: email verification (trading, T.4, reads `isEmailVerified`) and the pruning job.
export { isEmailVerified, pruneAuthRows } from './tokens.js';
export {
  DEFAULT_LOGIN_THROTTLE,
  createLoginThrottle,
  type LoginThrottleLimit,
} from './login-throttle.js';
