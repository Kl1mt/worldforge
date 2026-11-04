import type {
  DungeonEvent,
  DungeonId,
  DungeonRunProgress,
  EnemyId,
  GameEvent,
  MaterialId,
  RarityId,
  UnlockBlocker,
} from '@worldforge/game-core';
import { getEnemy } from '@worldforge/game-core';
import type { Character } from '../characters/api';
import { apiRequest, type ApiFailure, type ApiResult } from '../lib/api';

/** Server shapes of the dungeon endpoints (ticket 2.5, docs/API_CONVENTIONS.md). */

export interface DungeonRun {
  id: string;
  characterId: string;
  dungeonId: DungeonId;
  startedAt: string;
  endsAt: string;
  /** Server time of the view (the client clock may differ). */
  now: string;
  bossLootEligible: boolean;
  progress: DungeonRunProgress;
}

export interface DungeonEntry {
  id: DungeonId;
  unlocked: boolean;
  blockers: UnlockBlocker[];
  bossLootReadyAt: string | null;
}

export interface DungeonState {
  dungeons: DungeonEntry[];
  run: DungeonRun | null;
  busyCharacterId: string | null;
  character: Character;
}

export interface DungeonResult {
  runId: string;
  dungeonId: DungeonId;
  outcome: 'cleared' | 'failed';
  durationMs: number;
  roomsCleared: number;
  totalRooms: number;
  kills: number;
  xpGained: number;
  levelsGained: number;
  goldGained: number;
  goldSalvaged: number;
  items: { id: string; baseId: string; rarityId: RarityId; itemLevel: number }[];
  itemsSalvaged: number;
  materials: Partial<Record<MaterialId, number>>;
  bossDefeated: boolean;
  bossLoot: boolean;
  firstBossKill: boolean;
  questEvents: GameEvent[];
}

const d = (id: string) => `/characters/${encodeURIComponent(id)}/dungeon`;

export const dungeonApi = {
  state: (id: string, f?: typeof fetch): Promise<ApiResult<DungeonState>> =>
    apiRequest(d(id), {}, f),
  enter: (
    id: string,
    dungeonId: DungeonId,
    f?: typeof fetch,
  ): Promise<ApiResult<{ run: DungeonRun; character: Character }>> =>
    apiRequest(d(id), { method: 'POST', body: { dungeonId } }, f),
  settle: (id: string, f?: typeof fetch): Promise<ApiResult<{ run: DungeonRun }>> =>
    apiRequest(`${d(id)}/settle`, { method: 'POST' }, f),
  /** `key` must stay the same for retries of one claim (docs/API_CONVENTIONS.md). */
  claim: (
    id: string,
    key: string,
    f?: typeof fetch,
  ): Promise<ApiResult<{ result: DungeonResult; character: Character }>> =>
    apiRequest(`${d(id)}/claim`, { method: 'POST', headers: { 'idempotency-key': key } }, f),
};

/** One idempotency key per run, so a retried claim (lost response, double click) replays. */
export function claimKey(runId: string): string {
  return `claim-${runId}`;
}

export function describeDungeonFailure(error: Pick<ApiFailure, 'code'>): string {
  switch (error.code) {
    case 'dungeon_locked':
      return 'Your hero is not ready for the crypt yet.';
    case 'dungeon_run_open':
      return 'A run is already under way. Finish and claim it first.';
    case 'character_not_active':
      return 'Select this hero before sending it into the crypt.';
    case 'run_in_progress':
      return 'The fight is not over yet.';
    case 'no_dungeon_run':
      return 'There is nothing left to claim. The view has been refreshed.';
    case 'network':
      return 'The server cannot be reached. Check your connection and try again.';
    case 'unauthenticated':
      return 'Your session has ended. Log in again.';
    default:
      return 'Something went wrong on our side. Try again in a moment.';
  }
}

/** A combat-log line for a dungeon event, or null for events the log leaves out. */
export interface CryptLogLine {
  t: number;
  tone: 'note' | 'hit' | 'hurt' | 'kill' | 'level' | 'boss' | 'fall';
  text: string;
}

const name = (id: EnemyId) => getEnemy(id).name;

export function cryptLogLine(e: DungeonEvent, totalRooms: number): CryptLogLine | null {
  switch (e.type) {
    case 'enter':
      return e.room === null
        ? {
            t: e.t,
            tone: 'boss',
            text: 'The Gravewarden’s chamber. The door grinds shut behind you.',
          }
        : { t: e.t, tone: 'note', text: `Descending to chamber ${e.room + 1} of ${totalRooms}…` };
    case 'spawn':
      return {
        t: e.t,
        tone: 'note',
        text: `${name(e.enemyId)} (Lv ${e.enemyLevel}) blocks the way.`,
      };
    case 'attack':
      return e.crit || e.skill
        ? {
            t: e.t,
            tone: 'hit',
            text: `${e.skill ? 'Skill' : 'Strike'} for ${e.damage}${e.crit ? ' — critical!' : ''}`,
          }
        : null;
    case 'enemyAttack':
      return null;
    case 'enrage':
      return {
        t: e.t,
        tone: 'boss',
        text: 'The Gravewarden enrages! Its blows fall faster and harder.',
      };
    case 'kill':
      return { t: e.t, tone: 'kill', text: `${name(e.enemyId)} falls. +${e.xp} XP` };
    case 'levelUp':
      return { t: e.t, tone: 'level', text: `Level ${e.level}! Your wounds close.` };
    case 'death':
      return { t: e.t, tone: 'fall', text: `Slain by ${name(e.enemyId)}.` };
    case 'timeout':
      return { t: e.t, tone: 'fall', text: `${name(e.enemyId)} outlasts you. You retreat.` };
    case 'end':
      return e.outcome === 'cleared'
        ? { t: e.t, tone: 'boss', text: 'The Gravewarden is no more. The crypt falls silent.' }
        : {
            t: e.t,
            tone: 'fall',
            text: 'The crypt keeps its warden. You crawl back to the light.',
          };
  }
}
