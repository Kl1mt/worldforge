import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useCharacters } from '../characters/CharactersProvider';
import { ActionKeys } from '../game/economy';
import { useGame, type Load } from '../game/GameProvider';
import {
  describeQuestFailure,
  questsApi,
  type AcceptIntent,
  type QuestBoard,
  type TurnInResult,
} from './api';

export interface QuestsState {
  board: Load<QuestBoard>;
  /** The quest row id or offer key an action is running for. */
  busy: string | null;
  error: string | null;
  /** The last successful turn-in, until dismissed. */
  lastReward: (TurnInResult['reward'] & { questId: string; kind: 'story' | 'contract' }) | null;
  accept: (intent: AcceptIntent) => Promise<void>;
  turnIn: (questRowId: string) => Promise<void>;
  dismissReward: () => void;
  reload: () => void;
}

/**
 * The character's quest board (ticket 2.4). Refetched whenever the server settles the activity
 * (progress only changes in settlements), so the tracker follows the fight. The client never
 * computes progress or rewards; it shows what the server returns.
 */
function useQuestsState(characterId: string): QuestsState {
  const { activity, reload: reloadGame } = useGame();
  const { updateCharacter } = useCharacters();
  const [board, setBoard] = useState<Load<QuestBoard>>({ kind: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastReward, setLastReward] = useState<QuestsState['lastReward']>(null);
  const [attempt, setAttempt] = useState(0);
  // One Idempotency-Key per turn-in until it gets a definite answer, so a retry after a lost
  // response replays instead of being refused (ticket 2.6's client helper).
  const keys = useRef(new ActionKeys());

  const settledAt = activity.kind === 'ready' ? (activity.value?.settledAt ?? null) : null;

  useEffect(() => {
    const ctrl = new AbortController();
    questsApi
      .get(characterId, { signal: ctrl.signal })
      .then((res) => {
        if (res.ok) setBoard({ kind: 'ready', value: res.value });
        else
          setBoard((prev) =>
            prev.kind === 'ready'
              ? prev
              : { kind: 'error', message: describeQuestFailure(res.error) },
          );
      })
      .catch(() => {
        /* aborted */
      });
    return () => ctrl.abort();
  }, [characterId, settledAt, attempt]);

  const accept = useCallback(
    async (intent: AcceptIntent) => {
      const tag = intent.kind === 'story' ? intent.questId : `slot:${intent.slot}`;
      setBusy(tag);
      setError(null);
      const res = await questsApi.accept(characterId, intent);
      setBusy(null);
      if (res.ok) {
        setBoard({ kind: 'ready', value: res.value });
      } else {
        setError(describeQuestFailure(res.error));
        setAttempt((n) => n + 1);
      }
    },
    [characterId],
  );

  const turnIn = useCallback(
    async (questRowId: string) => {
      const action = `turn-in:${questRowId}`;
      const key = keys.current.keyFor(action);
      const quest =
        board.kind === 'ready' ? board.value.quests.find((q) => q.id === questRowId) : undefined;
      setBusy(questRowId);
      setError(null);
      const res = await questsApi.turnIn(characterId, questRowId, key);
      setBusy(null);
      keys.current.settle(action, res.ok ? null : res.error);
      if (res.ok) {
        setBoard({ kind: 'ready', value: res.value.quests });
        updateCharacter(res.value.character);
        setLastReward({
          ...res.value.reward,
          questId: quest?.questId ?? '',
          kind: quest?.kind ?? 'story',
        });
        // Items and materials live in the game state; fetch them again.
        if (res.value.reward.item || Object.keys(res.value.reward.materials).length > 0) {
          reloadGame();
        }
        return;
      }
      setError(describeQuestFailure(res.error));
      setAttempt((n) => n + 1);
    },
    [board, characterId, reloadGame, updateCharacter],
  );

  const reload = useCallback(() => {
    setBoard({ kind: 'loading' });
    setAttempt((n) => n + 1);
  }, []);
  const dismissReward = useCallback(() => setLastReward(null), []);

  return { board, busy, error, lastReward, accept, turnIn, dismissReward, reload };
}

const QuestsContext = createContext<QuestsState | null>(null);

/**
 * One quest board per active character for the whole shell (ticket 2.7), so the Tavern, the
 * area tracker and the quest-complete notices share one fetch per settlement.
 */
export function QuestsProvider({
  characterId,
  children,
}: {
  characterId: string;
  children: ReactNode;
}) {
  const state = useQuestsState(characterId);
  return createElement(QuestsContext.Provider, { value: state }, children);
}

export function useQuests(): QuestsState {
  const ctx = useContext(QuestsContext);
  if (!ctx) throw new Error('useQuests must be used inside <QuestsProvider>');
  return ctx;
}
