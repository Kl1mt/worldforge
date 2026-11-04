import { describe, expect, it } from 'vitest';
import { charactersApi, describeCharacterFailure } from './api';

function recorder() {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Response.json({ character: { id: 'c1' } });
  }) as unknown as typeof fetch;
  return { calls, f };
}

describe('charactersApi', () => {
  it('sends intents only: name, class and banner', async () => {
    const { calls, f } = recorder();
    await charactersApi.create(
      { name: 'Edric', classId: 'mage', appearance: { banner: 'dusk' } },
      f,
    );
    expect(calls).toEqual([
      {
        url: '/api/characters',
        method: 'POST',
        body: { name: 'Edric', classId: 'mage', appearance: { banner: 'dusk' } },
      },
    ]);
  });

  it('selects by id on the select sub-resource', async () => {
    const { calls, f } = recorder();
    await charactersApi.select('01900000-0000-7000-8000-000000000000', f);
    expect(calls[0]).toMatchObject({
      url: '/api/characters/01900000-0000-7000-8000-000000000000/select',
      method: 'POST',
    });
  });
});

describe('describeCharacterFailure', () => {
  it('maps server codes to player-facing text', () => {
    expect(describeCharacterFailure({ code: 'no_free_slot' })).toBe(
      'Every character slot is taken.',
    );
    expect(describeCharacterFailure({ code: 'character_name_taken' })).toBe(
      'Some choices need attention.',
    );
    expect(describeCharacterFailure({ code: 'network' })).toMatch(/cannot be reached/);
    expect(describeCharacterFailure({ code: 'something_new' })).toMatch(/on our side/);
  });
});
