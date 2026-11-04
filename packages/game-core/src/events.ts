import type { EnemyId } from './world/enemies.js';

/**
 * Game events that quests listen to (ticket 2.4 owns quest progress). Emitted only by
 * server-side rules — settlement and dungeon claims — never accepted from the client.
 *
 * Ticket 2.5 defines the dungeon event; ticket 2.4 may merge this union into its own quest event
 * type, keeping the shape below unchanged.
 */
export type BossDefeatedEvent = { type: 'bossDefeated'; bossId: EnemyId };

export type GameEvent = BossDefeatedEvent;
