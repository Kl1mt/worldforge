import { describe, expect, it } from 'vitest';
import { HANDLE_ALPHABET, HANDLE_RE } from '@worldforge/game-core';
import { HANDLE_ALPHABET_FOR_TEST, newHandle } from './handles.js';

describe('newHandle', () => {
  it('uses game-core’s alphabet and shape, and is random', () => {
    expect(HANDLE_ALPHABET_FOR_TEST).toBe(HANDLE_ALPHABET);
    const handles = Array.from({ length: 500 }, newHandle);
    for (const h of handles) expect(h).toMatch(HANDLE_RE);
    expect(new Set(handles).size).toBe(handles.length);
  });
});
