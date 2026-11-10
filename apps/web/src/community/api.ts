import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectResource, WorldFlags } from '@worldforge/game-core';
import { apiRequest, type ApiFailure, type ApiResult } from '../lib/api';
import type { Character } from '../characters/api';

/** Ticket 4.6: the community project board (`GET /api/community/projects`). */
export interface NeedView {
  resource: ProjectResource;
  required: number;
  delivered: number;
  /** Your cap per window on this need (all your heroes together). */
  cap: number;
  /** What you gave to this need in the current window. */
  givenToday: number;
}

export interface StageView {
  id: string;
  name: string;
  description: string;
  status: 'done' | 'current' | 'upcoming';
  needs: NeedView[];
}

export interface ProjectView {
  id: string;
  name: string;
  description: string;
  status: 'locked' | 'open' | 'complete';
  requires: string | null;
  grantsFlag: string;
  completedOn: string | null;
  stageIndex: number;
  stages: StageView[];
  contributors: number;
  yours: { resource: ProjectResource; amount: number }[];
  reward: { achievementId: string; earned: boolean };
}

export interface ProjectBoard {
  window: { day: string; resetsAt: string };
  projects: ProjectView[];
}

export interface WorldView {
  flags: WorldFlags;
  completed: { projectId: string; completedOn: string }[];
  /** Ticket 6.7: the world era (the web derives the same from `flags` with game-core). */
  era?: { id: string; index: number; name: string; title: string; crier: string };
}

export interface ContributeResult {
  accepted: { resource: ProjectResource; amount: number }[];
  limited: Partial<Record<ProjectResource, 'stage' | 'cap'>>;
  stagesCompleted: string[];
  projectCompleted: boolean;
  character: Character;
}

export const communityApi = {
  board: (signal?: AbortSignal): Promise<ApiResult<ProjectBoard>> =>
    apiRequest('/community/projects', signal ? { signal } : {}),
  world: (signal?: AbortSignal): Promise<ApiResult<WorldView>> =>
    apiRequest('/world', signal ? { signal } : {}),
  /** A value operation: keep `key` for retries of the same gift. */
  contribute: (
    projectId: string,
    input: {
      characterId: string;
      stageId: string;
      offer: { resource: ProjectResource; amount: number }[];
    },
    key: string,
  ): Promise<ApiResult<ContributeResult>> =>
    apiRequest(`/community/projects/${encodeURIComponent(projectId)}/contribute`, {
      method: 'POST',
      body: input,
      headers: { 'idempotency-key': key },
    }),
};

/** Plain words for a failed gift. */
export function describeContributionFailure(error: ApiFailure): string {
  switch (error.code) {
    case 'contribution_capped':
      return 'You have given your full share to this stage today. Your share renews at midnight (UTC).';
    case 'stage_changed':
      return 'The workers moved on to the next stage just now. Nothing was taken; look again.';
    case 'project_complete':
      return 'This work is already finished. Nothing was taken.';
    case 'project_locked':
      return 'This work has not begun yet.';
    case 'insufficient_gold':
      return 'Your hero’s purse is lighter than that.';
    case 'insufficient_materials':
      return 'Your hero does not carry that much.';
    case 'not_needed':
      return 'The workers do not need that for this stage.';
    case 'rate_limited':
      return 'Too many requests in a short time. Wait a moment and try again.';
    case 'network':
      return 'The town cannot be reached right now. Nothing was taken; try again.';
    default:
      return error.message;
  }
}

export type BoardState =
  | { kind: 'loading' }
  | { kind: 'ready'; board: ProjectBoard; stale: boolean }
  | { kind: 'error'; error: ApiFailure };

/**
 * The project board, polled while mounted (every 60 s; the server's `ETag` turns an unchanged
 * board into a `304`). A failed poll keeps the last board and marks it stale.
 */
export function useProjectBoard(pollMs = 60_000) {
  const [state, setState] = useState<BoardState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const last = useRef<ProjectBoard | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      communityApi.board(controller.signal).then(
        (res) => {
          if (res.ok) {
            last.current = res.value;
            setState({ kind: 'ready', board: res.value, stale: false });
          } else if (last.current) {
            setState({ kind: 'ready', board: last.current, stale: true });
          } else {
            setState({ kind: 'error', error: res.error });
          }
          if (pollMs > 0) timer = setTimeout(load, pollMs);
        },
        () => {
          /* aborted */
        },
      );
    };
    load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [attempt, pollMs]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, reload };
}

/**
 * The global world state, polled every 2 minutes on every game screen (for the world notice and
 * the hub). One request per tab every 120 s, far below the per-account limits.
 */
export function useWorldView(pollMs = 120_000): WorldView | null {
  const [view, setView] = useState<WorldView | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      communityApi.world(controller.signal).then(
        (res) => {
          if (res.ok) setView(res.value);
          if (pollMs > 0) timer = setTimeout(load, pollMs);
        },
        () => {
          /* aborted */
        },
      );
    };
    load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [pollMs]);
  return view;
}

/** Share of a stage done, 0–1 (each need counts by its share of the stage). */
export function stageProgress(stage: StageView): number {
  if (stage.needs.length === 0) return 0;
  return (
    stage.needs.reduce((s, n) => s + Math.min(1, n.delivered / n.required), 0) / stage.needs.length
  );
}

/** Share of a project done, 0–1 (stages weigh the same). */
export function projectProgress(p: ProjectView): number {
  if (p.status === 'complete') return 1;
  const current = p.stages[p.stageIndex];
  return (
    (p.stageIndex + (current && p.status === 'open' ? stageProgress(current) : 0)) / p.stages.length
  );
}

/** What a hero can give to a need now: held, the stage's remainder and your cap left. */
export function maxGift(need: NeedView, held: number): number {
  return Math.max(0, Math.min(held, need.required - need.delivered, need.cap - need.givenToday));
}
