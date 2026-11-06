import { validatePlayerText, type PlayerTextKind } from '@worldforge/game-core';
import { ApiError } from '../errors.js';

/**
 * Server side of the player-text module (ticket 4.1): normalises and checks `raw` as `kind` and
 * returns the value to store, or throws `400 validation_failed` with `details.fields[field]` (the
 * message) and `details.problems[field]` (game-core `PlayerTextProblem`).
 */
export function assertPlayerText(kind: PlayerTextKind, raw: string, field: string): string {
  const result = validatePlayerText(kind, raw);
  if (result.ok) return result.value;
  throw new ApiError(400, 'validation_failed', result.message, {
    fields: { [field]: result.message },
    problems: { [field]: result.problem },
  });
}
