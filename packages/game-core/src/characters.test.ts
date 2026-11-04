import { describe, expect, it } from 'vitest';
import {
  BANNERS,
  BANNER_IDS,
  DEFAULT_APPEARANCE,
  isBannerId,
  validateCharacterName,
} from './characters.js';

describe('validateCharacterName', () => {
  it.each(['Edric', 'Mael-Dun', "O'Rourke", 'abc', 'Abcdefghijklmnop'])('accepts %s', (name) => {
    expect(validateCharacterName(name)).toEqual({ ok: true, name });
  });

  it('trims surrounding whitespace', () => {
    expect(validateCharacterName('  Edric ')).toEqual({ ok: true, name: 'Edric' });
  });

  it.each([
    ['', 'Enter a name.'],
    ['   ', 'Enter a name.'],
    ['Ed', 'Use 3–16 letters.'],
    ['Abcdefghijklmnopq', 'Use 3–16 letters.'],
  ])('rejects length of %j', (name, message) => {
    expect(validateCharacterName(name)).toEqual({ ok: false, message });
  });

  it.each(['Edric Vael', 'Ed1ric', '-Edric', "Edric'", 'Ed--ric', "Ed'-ric", 'Édric', 'Еdric'])(
    'rejects the shape of %j',
    (name) => {
      const result = validateCharacterName(name);
      expect(result.ok).toBe(false);
    },
  );

  it('rejects reserved names case-insensitively', () => {
    expect(validateCharacterName('ADMIN')).toEqual({
      ok: false,
      message: 'This name is reserved.',
    });
  });
});

describe('banners', () => {
  it('defines every banner id once and defaults to a valid one', () => {
    expect(BANNERS.map((b) => b.id)).toEqual([...BANNER_IDS]);
    expect(isBannerId(DEFAULT_APPEARANCE.banner)).toBe(true);
    expect(isBannerId('gold')).toBe(false);
    expect(isBannerId(3)).toBe(false);
  });
});
