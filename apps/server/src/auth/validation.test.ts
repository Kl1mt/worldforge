import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';
import { validateRegistration } from './validation.js';

const valid = {
  email: 'ash@graumark.test',
  displayName: 'Ash Walker',
  password: 'correct-horse-9',
};

describe('validateRegistration', () => {
  it('accepts and trims a valid registration', () => {
    const { value, errors } = validateRegistration({
      ...valid,
      email: '  ash@graumark.test ',
      displayName: ' Ash Walker ',
    });
    expect(errors).toEqual({});
    expect(value).toEqual(valid);
  });

  it.each([
    ['', 'Enter your email address.'],
    ['ash', 'Enter a valid email address.'],
    ['ash@graumark', 'Enter a valid email address.'],
    ['a sh@graumark.test', 'Enter a valid email address.'],
    [`${'a'.repeat(250)}@x.test`, 'Enter a valid email address.'],
  ])('rejects email %j', (email, message) => {
    expect(validateRegistration({ ...valid, email }).errors).toEqual({ email: message });
  });

  it.each(["O'Brann", 'Kael-9', 'Ríven Ásh', 'snake_case', 'Ash'])('accepts name %j', (name) => {
    expect(validateRegistration({ ...valid, displayName: name }).errors).toEqual({});
  });

  it('normalises the name (ticket 4.1: NFKC, invisible characters, one space)', () => {
    const { value, errors } = validateRegistration({
      ...valid,
      displayName: 'Ｔwo \u200b  Spaces',
    });
    expect(errors).toEqual({});
    expect(value.displayName).toBe('Two Spaces');
  });

  it.each([
    ['Admin', /reserved/],
    ['Sh1t Lord', /not allowed/],
    ['Gold dot com', /Links/],
  ])('rejects filtered name %j', (name, message) => {
    expect(validateRegistration({ ...valid, displayName: name }).errors.displayName).toMatch(
      message,
    );
  });

  it.each(['Ab', 'A'.repeat(21), 'A\u200b\u200bb', '-Edge', 'Edge-', 'semi;colon', '<b>x</b>'])(
    'rejects name %j',
    (name) => {
      expect(validateRegistration({ ...valid, displayName: name }).errors.displayName).toBeTruthy();
    },
  );

  it('enforces password length and difference from the email', () => {
    expect(validateRegistration({ ...valid, password: 'nine-char' }).errors.password).toMatch(
      /at least 10/,
    );
    expect(validateRegistration({ ...valid, password: 'x'.repeat(129) }).errors.password).toMatch(
      /at most 128/,
    );
    expect(
      validateRegistration({ ...valid, password: 'ASH@graumark.test' }).errors.password,
    ).toMatch(/not your email/);
  });
});

describe('password hashing', () => {
  it('hashes with argon2id and verifies', async () => {
    const h = await hashPassword('correct-horse-9');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(h, 'correct-horse-9')).toBe(true);
    expect(await verifyPassword(h, 'correct-horse-8')).toBe(false);
    expect(await hashPassword('correct-horse-9')).not.toBe(h); // salted
  });

  it('treats a malformed stored hash as a mismatch', async () => {
    expect(await verifyPassword('not-a-phc-string', 'x')).toBe(false);
  });
});
