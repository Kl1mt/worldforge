import { describe, expect, it } from 'vitest';
import { uuidv7 } from './uuid.js';

describe('uuidv7', () => {
  it('produces RFC 9562 version-7 UUIDs', () => {
    expect(uuidv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('encodes the timestamp in the first 48 bits, so ids sort by time', () => {
    const t = Date.UTC(2026, 10, 4, 12, 0, 0);
    const id = uuidv7(t);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(t);
    expect(uuidv7(t) < uuidv7(t + 1)).toBe(true);
  });

  it('is unique across many calls', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => uuidv7(1)));
    expect(ids.size).toBe(5000);
  });
});
