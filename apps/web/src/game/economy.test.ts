import { describe, expect, it } from 'vitest';
import { ActionKeys, isUncertain, itemsAction, restockIn } from './economy';

const failure = (status: number) => ({ status, code: 'x', message: 'x', fields: {} });

describe('ActionKeys', () => {
  it('keeps the key across uncertain failures and drops it after an answer', () => {
    let n = 0;
    const keys = new ActionKeys(() => `key-${++n}`);
    expect(keys.keyFor('sell:a')).toBe('key-1');
    keys.settle('sell:a', failure(0));
    expect(keys.keyFor('sell:a')).toBe('key-1');
    keys.settle('sell:a', failure(503));
    expect(keys.keyFor('sell:a')).toBe('key-1');
    keys.settle('sell:a', null);
    expect(keys.keyFor('sell:a')).toBe('key-2');
    keys.settle('sell:a', failure(422));
    expect(keys.keyFor('sell:a')).toBe('key-3');
    expect(keys.keyFor('buy:b')).toBe('key-4');
  });

  it('classifies failures', () => {
    expect(isUncertain(failure(0))).toBe(true);
    expect(isUncertain(failure(500))).toBe(true);
    expect(isUncertain(failure(409))).toBe(false);
  });

  it('names item actions independent of order', () => {
    expect(itemsAction('sell', ['b', 'a'])).toBe(itemsAction('sell', ['a', 'b']));
  });
});

describe('restockIn', () => {
  const now = Date.parse('2026-11-04T18:30:00Z');
  it('formats the time to the next stock', () => {
    expect(restockIn('2026-11-05T00:00:00.000Z', now)).toBe('5 h 30 min');
    expect(restockIn('2026-11-04T18:42:00.000Z', now)).toBe('12 min');
    expect(restockIn('2026-11-04T18:30:30.000Z', now)).toBe('under a minute');
  });
});
