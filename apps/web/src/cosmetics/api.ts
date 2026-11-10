import type { ClassId, CosmeticKind, CosmeticSource } from '@worldforge/game-core';
import { apiRequest, type ApiResult } from '../lib/api';

/** Ticket 6.8: the collection book as the server shows it (docs/COSMETICS.md "API"). */
export interface CollectionEntry {
  id: string;
  kind: CosmeticKind;
  name: string;
  description: string;
  source: CosmeticSource;
  owned: boolean;
  /** The UTC day it was granted (null: locked, or owned by default). */
  grantedOn: string | null;
}

export interface CollectionHero {
  id: string;
  name: string;
  classId: ClassId;
  /** The hero's banner colour (chosen at creation). */
  banner: string;
  /** The appearance worn (null = the class's own colours). */
  palette: string | null;
}

export interface Collection {
  entries: CollectionEntry[];
  equipped: {
    banner: string | null;
    crest: string | null;
    titleColour: string | null;
    cosmeticTitle: string | null;
  };
  heroes: CollectionHero[];
}

export type AccountSlot = 'banner' | 'crest' | 'titleColour';

const key = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const cosmeticsApi = {
  collection: (signal?: AbortSignal): Promise<ApiResult<Collection>> =>
    apiRequest('/account/collection', signal ? { signal } : {}),
  /** One action = one key; pass the same key to retry the same action safely. */
  equip: (
    body: Partial<Record<AccountSlot, string | null>>,
    idempotencyKey: string = key(),
  ): Promise<ApiResult<Collection>> =>
    apiRequest('/account/cosmetics/equip', {
      method: 'POST',
      body,
      headers: { 'Idempotency-Key': idempotencyKey },
    }),
  wear: (
    characterId: string,
    appearance: string | null,
    idempotencyKey: string = key(),
  ): Promise<ApiResult<Collection>> =>
    apiRequest(`/characters/${characterId}/appearance`, {
      method: 'POST',
      body: { appearance },
      headers: { 'Idempotency-Key': idempotencyKey },
    }),
};
