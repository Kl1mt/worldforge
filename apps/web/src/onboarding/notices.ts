import { getArea, getDungeon, type AreaId, type DungeonId } from '@worldforge/game-core';
import type { WorldState } from '../game/api';
import type { QuestBoard } from '../quests/api';
import { questTitle } from '../quests/text';

/** A progression notice (ticket 2.7): level-up, a place opening, a quest done. */
export interface Notice {
  /** Stable per event, so the same notice is never shown twice. */
  id: string;
  kind: 'level' | 'unlock' | 'quest';
  title: string;
  text: string;
  /** Where to go about it. */
  href?: string;
  linkLabel?: string;
}

/**
 * Render order, least important first. Phones show only the last slip (onboarding.css), so a
 * quest completing in the same update as a level-up must not be hidden behind it.
 */
const KIND_RANK: Record<Notice['kind'], number> = { level: 0, unlock: 1, quest: 2 };

/** Notices in render order: by importance, then by arrival (`sort` is stable). */
export function orderNotices(notices: readonly Notice[]): Notice[] {
  return [...notices].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
}

export function levelNotice(characterId: string, level: number): Notice {
  return {
    id: `level:${characterId}:${level}`,
    kind: 'level',
    title: `Level ${level}`,
    text: 'Health and damage rise with the level. New places may open on the map.',
  };
}

type PlaceId = AreaId | DungeonId;

function unlockedIds(w: WorldState): Set<PlaceId> {
  const ids = new Set<PlaceId>();
  for (const a of w.areas) if (a.unlocked) ids.add(a.id);
  for (const d of w.dungeons) if (d.unlocked) ids.add(d.id);
  return ids;
}

/** Places open in `next` that were closed in `prev` (same character only). */
export function unlockNotices(prev: WorldState | null, next: WorldState): Notice[] {
  if (!prev || prev.characterId !== next.characterId) return [];
  const before = unlockedIds(prev);
  const out: Notice[] = [];
  for (const a of next.areas) {
    if (a.unlocked && !before.has(a.id)) {
      const area = getArea(a.id);
      out.push({
        id: `unlock:${next.characterId}:${a.id}`,
        kind: 'unlock',
        title: `${area.name} is open`,
        text: `Levels ${area.minLevel}–${area.maxLevel}. Choose it on the map to farm there.`,
        href: '#/map',
        linkLabel: 'Open the map',
      });
    }
  }
  for (const d of next.dungeons) {
    if (d.unlocked && !before.has(d.id)) {
      const dungeon = getDungeon(d.id);
      const first = dungeon.tiers[0]!;
      out.push({
        id: `unlock:${next.characterId}:${d.id}`,
        kind: 'unlock',
        title: `${dungeon.name} is open`,
        text: `Levels ${first.minLevel}–${first.maxLevel}. A run needs you here; it does not continue offline.`,
        href: '#/crypt',
        linkLabel: 'To the crypt',
      });
    }
  }
  return out;
}

/** Quests that became ready to turn in between two boards of the same character. */
export function questNotices(prev: QuestBoard | null, next: QuestBoard): Notice[] {
  if (!prev || prev.characterId !== next.characterId) return [];
  const was = new Map(prev.quests.map((q) => [q.id, q.status]));
  return next.quests
    .filter((q) => q.status === 'ready' && was.has(q.id) && was.get(q.id) === 'active')
    .map((q) => ({
      id: `quest:${q.id}`,
      kind: 'quest' as const,
      title: 'Quest complete',
      text: `${questTitle(q.kind, q.questId, q.objectives[0])}. Turn it in at the Tavern for the reward.`,
      href: '#/tavern',
      linkLabel: 'To the Tavern',
    }));
}
