import type {
  DungeonEvent,
  DungeonId,
  DungeonTier,
  DungeonRunProgress,
  EnemyId,
  MaterialId,
  QuestEvent,
  UnlockBlocker,
} from '@worldforge/game-core';
import { AUTO_SKILLS, getEnemy, type ClassId } from '@worldforge/game-core';
import type { Character } from '../characters/api';
import { formatNumber } from '../lib/format';
import { apiRequest, type ApiFailure, type ApiResult } from '../lib/api';
import type { SummaryItem } from './api';

/** Server shapes of the dungeon endpoints (ticket 2.5, docs/API_CONVENTIONS.md). */

export interface DungeonRun {
  id: string;
  characterId: string;
  dungeonId: DungeonId;
  /** Ticket 3.6. */
  tier: DungeonTier;
  startedAt: string;
  endsAt: string;
  /** Server time of the view (the client clock may differ). */
  now: string;
  bossLootEligible: boolean;
  progress: DungeonRunProgress;
}

/** One tier of a dungeon (ticket 3.6). */
export interface DungeonTierEntry {
  tier: DungeonTier;
  name: string;
  unlocked: boolean;
  blockers: UnlockBlocker[];
  minLevel: number;
  maxLevel: number;
  bossLevel: number;
  lootFocus: { id: string; name: string; description: string } | null;
}

export interface DungeonEntry {
  id: DungeonId;
  /** Tier I. */
  unlocked: boolean;
  blockers: UnlockBlocker[];
  /** Boss loot cooldown, shared by every tier. */
  bossLootReadyAt: string | null;
  tiers: DungeonTierEntry[];
  /** Deepest tier cleared (0 = none). */
  tierCleared: number;
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
  /** Ticket 3.6; absent in results stored before it (tier I). */
  tier?: DungeonTier;
  outcome: 'cleared' | 'failed';
  durationMs: number;
  roomsCleared: number;
  totalRooms: number;
  kills: number;
  xpGained: number;
  levelsGained: number;
  goldGained: number;
  goldSalvaged: number;
  /** Since ticket 3.5 with effect, set and variant (older stored results have none). */
  items: SummaryItem[];
  itemsSalvaged: number;
  materials: Partial<Record<MaterialId, number>>;
  bossDefeated: boolean;
  bossLoot: boolean;
  firstBossKill: boolean;
  /** Ticket 3.6: the first clear of this tier (the next one may open). */
  firstTierClear?: boolean;
  questEvents: QuestEvent[];
}

const d = (id: string) => `/characters/${encodeURIComponent(id)}/dungeon`;

export const dungeonApi = {
  state: (id: string, f?: typeof fetch): Promise<ApiResult<DungeonState>> =>
    apiRequest(d(id), {}, f),
  enter: (
    id: string,
    dungeonId: DungeonId,
    tier: DungeonTier = 1,
    f?: typeof fetch,
  ): Promise<ApiResult<{ run: DungeonRun; character: Character }>> =>
    apiRequest(d(id), { method: 'POST', body: { dungeonId, tier } }, f),
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
      return 'Your hero is not ready for this depth of the crypt yet.';
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

/** The foe as the object of a sentence: "the Crypt Ghoul", "the Gravewarden". */
export function foeObject(id: EnemyId): string {
  const n = name(id);
  return n.startsWith('The ') ? `the ${n.slice(4)}` : `the ${n}`;
}

/** Who the hero is fighting and with what, for the hit lines (the events carry neither). */
export interface CryptLogContext {
  totalRooms: number;
  classId: ClassId;
  /** The foe of the current encounter (from the last `spawn`). */
  foe: EnemyId | null;
}

/**
 * The combat log of a run, oldest first: hit lines name the class skill (or "Your strike") and
 * the foe, like the area Chronicle ("Heavy Strike hits the Gravewarden for 156").
 */
export function cryptLog(
  events: readonly DungeonEvent[],
  totalRooms: number,
  classId: ClassId,
): CryptLogLine[] {
  const ctx: CryptLogContext = { totalRooms, classId, foe: null };
  const lines: CryptLogLine[] = [];
  for (const e of events) {
    if (e.type === 'spawn') ctx.foe = e.enemyId;
    const line = cryptLogLine(e, ctx);
    if (line) lines.push(line);
  }
  return lines;
}

export function cryptLogLine(e: DungeonEvent, ctx: CryptLogContext): CryptLogLine | null {
  const { totalRooms } = ctx;
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
    case 'attack': {
      if (!e.crit && !e.skill) return null;
      const subject = e.skill ? AUTO_SKILLS[ctx.classId].name : 'Your strike';
      const target = ctx.foe ? foeObject(ctx.foe) : 'the foe';
      const verb = e.crit ? 'crits' : 'hits';
      return {
        t: e.t,
        tone: 'hit',
        text: `${subject} ${verb} ${target} for ${formatNumber(e.damage)}${e.crit ? '!' : '.'}`,
      };
    }
    case 'enemyAttack':
      return null;
    case 'thorns':
      // Ticket 3.2: only the blow that finishes the foe is worth a line.
      return e.enemyHealth > 0
        ? null
        : {
            t: e.t,
            tone: 'hit',
            text: `Your thorns finish ${ctx.foe ? foeObject(ctx.foe) : 'the foe'}.`,
          };
    case 'heal':
      return { t: e.t, tone: 'note', text: `The kill restores ${formatNumber(e.amount)} health.` };
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
