/**
 * Registration rules. JSON Schema checks the shape; these check the content and report
 * every failing field at once so the form can mark them all.
 */

export const EMAIL_MAX = 254;
export const DISPLAY_NAME_MIN = 3;
export const DISPLAY_NAME_MAX = 20;
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
// Letters (any script), digits, single spaces, hyphens, apostrophes and underscores, starting
// and ending with a letter or digit.
const DISPLAY_NAME_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N}_'-]| (?! ))*[\p{L}\p{N}]$/u;

export function normalizeEmail(email: string): string {
  return email.trim();
}

export function normalizeDisplayName(name: string): string {
  return name.trim();
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

  const nameLength = [...value.displayName].length;
  if (nameLength < DISPLAY_NAME_MIN || nameLength > DISPLAY_NAME_MAX) {
    errors.displayName = `Use ${DISPLAY_NAME_MIN}–${DISPLAY_NAME_MAX} characters.`;
  } else if (!DISPLAY_NAME_RE.test(value.displayName)) {
    errors.displayName = 'Use letters, numbers, single spaces, hyphens or apostrophes.';
  }

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
