import { describe, expect, it } from 'vitest';
import type { WorldState } from '../game/api';
import type { QuestBoard, QuestDto } from '../quests/api';
import { capText, guideStepCopy, observedSteps } from './guide';
import { levelNotice, questNotices, unlockNotices } from './notices';
import { newIds, questKeys, readSeen, writeSeen, type SeenStore } from './seen';

const memory = (): SeenStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) };
};

describe('first-session guide (web)', () => {
  it('reads the steps off the server state the client holds', () => {
    const base = { route: 'hub' as const, farming: false, itemCount: 0, equippedCount: 0 };
    expect(observedSteps(base)).toEqual(['character']);
    expect(observedSteps({ ...base, farming: true })).toEqual(['character', 'farm']);
    expect(observedSteps({ ...base, itemCount: 1 })).toEqual(['character', 'farm', 'drop']);
    expect(observedSteps({ ...base, itemCount: 1, equippedCount: 1, route: 'tavern' })).toEqual([
      'character',
      'farm',
      'drop',
      'equip',
      'tavern',
    ]);
  });

  it('points each open step somewhere', () => {
    expect(guideStepCopy('equip', 'Ash').go?.route).toBe('inventory');
    expect(guideStepCopy('tavern', 'Ash').go?.route).toBe('tavern');
    expect(guideStepCopy('farm', 'Ash').text).toContain('Ash');
  });

  it('words the offline cap', () => {
    expect(capText(3 * 60 * 60 * 1000)).toBe('3 hours');
    expect(capText(60 * 60 * 1000)).toBe('1 hour');
    expect(capText(90 * 60 * 1000)).toBe('90 min');
  });
});

const world = (open: string[], characterId = 'c1'): WorldState =>
  ({
    characterId,
    level: 1,
    progress: { gravewardenDefeated: false },
    current: null,
    areas: ['abandonedFields', 'crowwood'].map((id) => ({
      id,
      unlocked: open.includes(id),
      blockers: [],
    })),
    dungeons: [
      {
        id: 'namelessCrypt',
        unlocked: open.includes('namelessCrypt'),
        blockers: [],
        available: true,
      },
    ],
  }) as unknown as WorldState;

const quest = (id: string, status: QuestDto['status']): QuestDto => ({
  id,
  kind: 'contract',
  questId: 'bounty-wolves',
  contractDay: '2026-11-04',
  objectives: [{ kind: 'kill', enemyId: 'carrionWolf', count: 10 }] as QuestDto['objectives'],
  progress: [status === 'active' ? 3 : 10],
  reward: { xp: 10, gold: 5 } as QuestDto['reward'],
  status,
  acceptedAt: '',
  turnedInAt: null,
});

const board = (quests: QuestDto[], over: Partial<QuestBoard> = {}): QuestBoard => ({
  characterId: 'c1',
  day: '2026-11-04',
  quests,
  story: { next: null, completed: [] },
  contracts: { offers: [], perDay: 3, active: 0, maxActive: 3 },
  ...over,
});

describe('progression notices', () => {
  it('announces a level once per level', () => {
    expect(levelNotice('c1', 4)).toMatchObject({ id: 'level:c1:4', title: 'Level 4' });
  });

  it('announces places that opened, not the first load or another hero', () => {
    expect(unlockNotices(null, world(['abandonedFields']))).toEqual([]);
    const opened = unlockNotices(
      world(['abandonedFields']),
      world(['abandonedFields', 'crowwood']),
    );
    expect(opened.map((n) => n.id)).toEqual(['unlock:c1:crowwood']);
    expect(opened[0]!.title).toMatch(/is open$/);
    const crypt = unlockNotices(world([]), world(['namelessCrypt']));
    expect(crypt[0]!.text).toMatch(/does not continue offline/);
    expect(unlockNotices(world([], 'c2'), world(['crowwood']))).toEqual([]);
  });

  it('announces quests that just became ready', () => {
    expect(questNotices(null, board([quest('q1', 'ready')]))).toEqual([]);
    const done = questNotices(
      board([quest('q1', 'active'), quest('q2', 'active')]),
      board([quest('q1', 'ready'), quest('q2', 'active')]),
    );
    expect(done.map((n) => n.id)).toEqual(['quest:q1']);
    expect(done[0]!.href).toBe('#/tavern');
    // Already ready before: no second notice.
    expect(questNotices(board([quest('q1', 'ready')]), board([quest('q1', 'ready')]))).toEqual([]);
  });
});

describe('"new" markers', () => {
  it('stores seen ids per device and treats a first look as all seen', () => {
    const store = memory();
    expect(readSeen(store, 'k')).toBeNull();
    expect(newIds(['a', 'b'], null).size).toBe(0);
    writeSeen(store, 'k', ['a']);
    expect([...newIds(['a', 'b'], readSeen(store, 'k')!)]).toEqual(['b']);
    store.set('k', 'not json');
    expect(readSeen(store, 'k')).toEqual(new Set());
  });

  it('keys the story notice, untaken slips and ready quests', () => {
    const keys = questKeys(
      board([quest('q1', 'ready'), quest('q2', 'active')], {
        story: { next: { questId: 'ashesOnTheWind' as never, blockers: [] }, completed: [] },
        contracts: {
          offers: [
            { slot: 0, templateId: 't0', accepted: false } as never,
            { slot: 1, templateId: 't1', accepted: true } as never,
          ],
          perDay: 3,
          active: 1,
          maxActive: 3,
        },
      }),
    );
    expect(keys).toEqual(['story:ashesOnTheWind', 'offer:2026-11-04:0:t0', 'ready:q1']);
  });
});
