/**
 * The first-session guide (ticket 2.7): the steps of the guided path, in order. The server only
 * stores which steps an account has seen done and whether it dismissed the guide; none of this
 * grants anything, so the client may report steps (docs/API_CONVENTIONS.md).
 */
export const GUIDE_STEP_IDS = ['character', 'farm', 'drop', 'equip', 'tavern'] as const;

export type GuideStepId = (typeof GUIDE_STEP_IDS)[number];

export interface GuideState {
  /** Steps done, in guide order, without duplicates. */
  steps: GuideStepId[];
  dismissed: boolean;
}

export const EMPTY_GUIDE: GuideState = { steps: [], dismissed: false };

export function isGuideStepId(value: unknown): value is GuideStepId {
  return typeof value === 'string' && (GUIDE_STEP_IDS as readonly string[]).includes(value);
}

/** Adds a step (idempotent), keeping guide order. Unknown stored ids are dropped. */
export function withGuideStep(state: GuideState, step: GuideStepId): GuideState {
  const done = new Set<string>([...state.steps, step]);
  return { ...state, steps: GUIDE_STEP_IDS.filter((s) => done.has(s)) };
}

/** The first step not done yet, or null when the path is complete. */
export function nextGuideStep(steps: readonly GuideStepId[]): GuideStepId | null {
  return GUIDE_STEP_IDS.find((s) => !steps.includes(s)) ?? null;
}

/** A stored value read back defensively (older rows, hand-edited data). */
export function normalizeGuide(value: unknown): GuideState {
  if (!value || typeof value !== 'object') return { ...EMPTY_GUIDE, steps: [] };
  const v = value as { steps?: unknown; dismissed?: unknown };
  const steps = Array.isArray(v.steps) ? v.steps.filter(isGuideStepId) : [];
  const done = new Set<string>(steps);
  return { steps: GUIDE_STEP_IDS.filter((s) => done.has(s)), dismissed: v.dismissed === true };
}
