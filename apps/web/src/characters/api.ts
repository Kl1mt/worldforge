import type { BannerId, ClassId } from '@worldforge/game-core';
import { apiRequest, type ApiFailure, type ApiResult } from '../lib/api';

/** The public character shape returned by the server (`CharacterView` in apps/server). */
export interface Character {
  id: string;
  name: string;
  classId: ClassId;
  appearance: { banner: BannerId };
  level: number;
  experience: number;
  gold: number;
  createdAt: string;
}

export interface Roster {
  characters: Character[];
  slots: { used: number; total: number };
  activeCharacterId: string | null;
}

export interface CreateCharacterInput {
  name: string;
  classId: ClassId;
  appearance: { banner: BannerId };
}

type CharacterResult = ApiResult<{ character: Character }>;

export const charactersApi = {
  list: (signal?: AbortSignal, f?: typeof fetch): Promise<ApiResult<Roster>> =>
    apiRequest('/characters', signal ? { signal } : {}, f),
  create: (input: CreateCharacterInput, f?: typeof fetch): Promise<CharacterResult> =>
    apiRequest('/characters', { method: 'POST', body: input }, f),
  select: (id: string, f?: typeof fetch): Promise<CharacterResult> =>
    apiRequest(`/characters/${encodeURIComponent(id)}/select`, { method: 'POST' }, f),
};

/** Form-level message for a failed create/select; field errors are shown inline instead. */
export function describeCharacterFailure(error: Pick<ApiFailure, 'code'>): string {
  switch (error.code) {
    case 'validation_failed':
    case 'character_name_taken':
      return 'Some choices need attention.';
    case 'no_free_slot':
      return 'Every character slot is taken.';
    case 'forbidden':
    case 'not_found':
      return 'That character is no longer available. The roster has been refreshed.';
    case 'unauthenticated':
      return 'Your session has ended. Log in again.';
    case 'network':
      return 'The server cannot be reached. Check your connection and try again.';
    default:
      return 'Something went wrong on our side. Try again in a moment.';
  }
}
