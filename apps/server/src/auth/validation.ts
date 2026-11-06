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

// Pragmatic check (something@something.tld, no spaces). Deliverability is proven later by
// email verification (follow-up), not by a regex.
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

  if (value.email.length === 0) errors.email = 'Enter your email address.';
  else if (value.email.length > EMAIL_MAX || !EMAIL_RE.test(value.email)) {
    errors.email = 'Enter a valid email address.';
  }

  const nameError = displayNameError(value.displayName);
  if (nameError) errors.displayName = nameError;

  const passwordLength = [...value.password].length;
  if (passwordLength < PASSWORD_MIN) {
    errors.password = `Use at least ${PASSWORD_MIN} characters.`;
  } else if (passwordLength > PASSWORD_MAX) {
    errors.password = `Use at most ${PASSWORD_MAX} characters.`;
  } else if (value.password.toLowerCase() === value.email.toLowerCase()) {
    errors.password = 'Choose a password that is not your email address.';
  }

  return { value, errors };
}
