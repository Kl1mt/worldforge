import { describe, expect, it } from 'vitest';
import { worldNotices } from '../onboarding/notices';
import { maxGift, projectProgress, stageProgress, type ProjectView, type StageView } from './api';

const stage = (delivered: [number, number]): StageView => ({
  id: 's',
  name: 'S',
  description: '',
  status: 'current',
  needs: [
    { resource: 'gold', required: 1000, delivered: delivered[0], cap: 200, givenToday: 0 },
    { resource: 'timber', required: 100, delivered: delivered[1], cap: 20, givenToday: 0 },
  ],
});

const project = (over: Partial<ProjectView>): ProjectView => ({
  id: 'restoreWarehouse',
  name: 'Restore the Graumark Warehouse',
  description: '',
  status: 'open',
  requires: null,
  grantsFlag: 'warehouseRestored',
  completedOn: null,
  stageIndex: 0,
  stages: [stage([0, 0]), stage([0, 0])],
  contributors: 0,
  yours: [],
  reward: { achievementId: 'warehouseRestorer', earned: false },
  ...over,
});

describe('community board helpers (ticket 4.6)', () => {
  it('weighs each need of a stage and each stage of a project equally', () => {
    expect(stageProgress(stage([500, 100]))).toBe(0.75);
    expect(
      projectProgress(project({ stageIndex: 1, stages: [stage([1000, 100]), stage([1000, 0])] })),
    ).toBe(0.75);
    expect(projectProgress(project({ status: 'complete' }))).toBe(1);
    expect(projectProgress(project({ status: 'locked' }))).toBe(0);
  });

  it('suggests at most what is held, what the stage needs and the cap left', () => {
    const n = {
      resource: 'gold' as const,
      required: 1000,
      delivered: 950,
      cap: 200,
      givenToday: 100,
    };
    expect(maxGift(n, 10)).toBe(10);
    expect(maxGift(n, 1000)).toBe(50);
    expect(maxGift({ ...n, delivered: 0 }, 1000)).toBe(100);
    expect(maxGift({ ...n, givenToday: 200 }, 1000)).toBe(0);
  });

  it('announces a project finished in the last week once per device', () => {
    const view = {
      flags: { warehouseRestored: true, ashenPassCleared: false },
      completed: [{ projectId: 'restoreWarehouse', completedOn: '2031-03-10' }],
    };
    const now = Date.parse('2031-03-12T09:00:00Z');
    const [n] = worldNotices(view, new Set(), now);
    expect(n).toMatchObject({ id: 'world:restoreWarehouse', kind: 'world', href: '#/works' });
    expect(n!.text).toContain('The Graumark Warehouse');
    expect(worldNotices(view, new Set(['world:restoreWarehouse']), now)).toEqual([]);
    expect(worldNotices(view, new Set(), Date.parse('2031-03-30T00:00:00Z'))).toEqual([]);
  });
});
