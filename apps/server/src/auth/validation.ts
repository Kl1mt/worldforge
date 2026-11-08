import { PLAYER_TEXT_RULES, normalizePlayerText, validatePlayerText } from '@worldforge/game-core';

/**
 * Registration rules. JSON Schema checks the shape; these check the content and report
 * every failing field at once so the form can mark them all.
 */

export const EMAIL_MAX = 254;
export const DISPLAY_NAME_MIN = PLAYER_TEXT_RULES.displayName.min;
export const DISPLAY_NAME_MAX = PLAYER_TEXT_RULES.displayName.max;
export const PASSWORD_MIN = 10;
/** argon2 cost is per byte; a cap keeps a single request from burning CPU. */
export const PASSWORD_MAX = 128;

export interface RegistrationInput {
  email: string;
  displayName: string;
  password: string;
}

export type RegistrationField = keyof RegistrationInput;
export type FieldErrors = Partial<Record<RegistrationField, string>>;

// Pragmatic check (something@something.tld, no spaces). Deliverability is proven by email
// verification (ticket 5.7), not by a regex.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function normalizeEmail(email: string): string {
  return email.trim();
}

/** The player-text module's normalisation (ticket 4.1): NFKC, no invisible characters, one space. */
export function normalizeDisplayName(name: string): string {
  return normalizePlayerText(name);
}

/** The display-name rule (game-core `validatePlayerText('displayName')`, ticket 4.1), or null. */
export function displayNameError(name: string): string | null {
  const result = validatePlayerText('displayName', name);
  if (result.ok) return null;
  if (result.problem === 'too_short' || result.problem === 'too_long') {
    return `Use ${DISPLAY_NAME_MIN}–${DISPLAY_NAME_MAX} characters.`;
  }
  return result.message;
}

/** The email rule (normalised input), or null. Ticket 5.7: shared with the email change. */
export function emailError(email: string): string | null {
  if (email.length === 0) return 'Enter your email address.';
  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) return 'Enter a valid email address.';
  return null;
}

/** The password rule, or null. Ticket 5.7: shared with the password reset. */
export function passwordError(password: string, email: string): string | null {
  const length = [...password].length;
  if (length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (password.toLowerCase() === email.toLowerCase()) {
    return 'Choose a password that is not your email address.';
  }
  return null;
}

export function validateRegistration(input: RegistrationInput): {
  value: RegistrationInput;
  errors: FieldErrors;
} {
  const value = {
    email: normalizeEmail(input.email),
    displayName: normalizeDisplayName(input.displayName),
    password: input.password,
  };
  const errors: FieldErrors = {};

  const emailProblem = emailError(value.email);
  if (emailProblem) errors.email = emailProblem;

  const nameError = displayNameError(value.displayName);
  if (nameError) errors.displayName = nameError;

  const passwordProblem = passwordError(value.password, value.email);
  if (passwordProblem) errors.password = passwordProblem;

  return { value, errors };
}
