import type { ShrineRarity } from '@worldforge/game-core';
import { apiRequest, type ApiResult } from '../lib/api';

/** Ticket 9.5: the Reward Shrine as the server shows it (docs/SHRINE.md "API"). */
export interface ShrineView {
  unspent: { daily: number; play: number; shop: number };
  draws: number;
  bankLimit: number;
  nextFreeAt: string | null;
  marks: number;
  paidDraws: false;
  rarities: { rarity: ShrineRarity; chance: number; duplicateMarks: number; price: number }[];
  pool: {
    cosmeticId: string;
    kind: string;
    name: string;
    description: string;
    rarity: ShrineRarity;
    chance: number;
    price: number;
    owned: boolean;
  }[];
  recent: {
    id: string;
    cosmeticId: string;
    rarity: ShrineRarity;
    outcome: 'grant' | 'marks';
    marks: number;
    spentSource: 'daily' | 'play' | 'shop';
    seed: string;
    drawnAt: string;
  }[];
}

export interface ShrineDrawResult {
  drawId: string;
  seed: string;
  spentSource: 'daily' | 'play' | 'shop';
  cosmeticId: string;
  rarity: ShrineRarity;
  outcome: 'grant' | 'marks';
  marks: number;
}

const key = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const shrineApi = {
  view: (signal?: AbortSignal): Promise<ApiResult<ShrineView>> =>
    apiRequest('/account/shrine', signal ? { signal } : {}),
  /** One action = one key; pass the same key to retry the same draw safely. */
  draw: (
    idempotencyKey: string = key(),
  ): Promise<ApiResult<{ draw: ShrineDrawResult; shrine: ShrineView }>> =>
    apiRequest('/account/shrine/draw', {
      method: 'POST',
      body: {},
      headers: { 'Idempotency-Key': idempotencyKey },
    }),
  buy: (
    cosmeticId: string,
    idempotencyKey: string = key(),
  ): Promise<ApiResult<{ bought: { cosmeticId: string; price: number }; shrine: ShrineView }>> =>
    apiRequest('/account/shrine/buy', {
      method: 'POST',
      body: { cosmeticId },
      headers: { 'Idempotency-Key': idempotencyKey },
    }),
};

export { key as newShrineKey };
