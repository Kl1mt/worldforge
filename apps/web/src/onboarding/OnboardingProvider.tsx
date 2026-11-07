import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from '../auth/AuthProvider';
import { useActiveCharacter } from '../characters/CharactersProvider';
import { useGame } from '../game/GameProvider';
import type { WorldState } from '../game/api';
import { GAME_VERSION, nextGuideStep, type WorldFlags } from '@worldforge/game-core';
import type { GameRoute } from '../lib/route';
import type { QuestBoard } from '../quests/api';
import { useQuests } from '../quests/useQuests';
import { observedSteps } from './guide';
import { levelNotice, questNotices, unlockNotices, worldNotices, type Notice } from './notices';
import { useWorldView } from '../community/api';
import { browserStore, newIds, questKeys, readSeen, seenKey, writeSeen } from './seen';
import { notesSeenKey, notesUnread, releaseNotice, releaseNoticeId } from '../notes/unread';
import {
  isReloadNoticeId,
  readReloadLater,
  reloadNotice,
  reloadOffer,
  writeReloadLater,
} from '../notes/update';
import { watchChunkErrors } from '../notes/chunks';
import { useHealthPoll } from '../shell/healthPoll';

/** How long a notice stays before it fades on its own. */
export const NOTICE_MS = 8_000;
/** Notices on screen at once; older ones give way. */
const MAX_NOTICES = 3;

interface OnboardingValue {
  notices: Notice[];
  dismissNotice: (id: string) => void;
  /** Pack items this device has not shown yet. */
  newItems: ReadonlySet<string>;
  /** Marks items seen (all current pack items when called without ids). */
  markItemsSeen: (ids?: readonly string[]) => void;
  /** Quest keys (`questKeys`) this device has not shown yet. */
  newQuests: ReadonlySet<string>;
  markQuestsSeen: () => void;
  /**
   * Ticket 4.7: the global world flags from the 120 s world poll (null until the first answer).
   * The server checks them on every route; screens read them only to show what is open.
   */
  worldFlags: WorldFlags | null;
  /** Ticket F.3: the patch notes have a release this player has not read yet. */
  notesUnread: boolean;
  /**
   * The version the player had read before opening the notes this visit (null: none), so the
   * notes screen can mark what is new to them after the marker has cleared.
   */
  notesSeenBefore: string | null;
}

const OnboardingContext = createContext<OnboardingValue | null>(null);

/**
 * Progression feedback and the first-session guide's bookkeeping (ticket 2.7). Everything here
 * is derived from server state the client already holds; nothing is granted or computed.
 */
export function OnboardingProvider({ route, children }: { route: GameRoute; children: ReactNode }) {
  const auth = useAuth();
  const { updateGuide } = auth;
  const guide = auth.state.kind === 'authenticated' ? auth.state.account.guide : null;
  const hero = useActiveCharacter();
  const { activity, inventory, world, tally } = useGame();
  const { board } = useQuests();
  const store = useMemo(() => browserStore(), []);

  // --- Guide steps: report what the server state shows done, once per step.
  const farming = (activity.kind === 'ready' && activity.value !== null) || tally.kills > 0;
  const pack = inventory.kind === 'ready' ? inventory.value : null;
  const itemCount = pack ? pack.items.length + pack.equipped.length : 0;
  const equippedCount = pack ? pack.equipped.length : 0;
  const reported = useRef(new Set<string>());
  useEffect(() => {
    if (!guide) return;
    const done = observedSteps({ route, farming, itemCount, equippedCount });
    for (const step of done) {
      if (guide.steps.includes(step) || reported.current.has(step)) continue;
      reported.current.add(step);
      updateGuide({ step });
    }
  }, [guide, route, farming, itemCount, equippedCount, updateGuide]);

  // --- Notices.
  const [notices, setNotices] = useState<Notice[]>([]);
  const shown = useRef(new Set<string>());
  const push = useCallback((fresh: Notice[]) => {
    const unseen = fresh.filter((n) => !shown.current.has(n.id));
    if (unseen.length === 0) return;
    for (const n of unseen) shown.current.add(n.id);
    setNotices((list) => [...list, ...unseen].slice(-MAX_NOTICES));
  }, []);
  // Ticket F.4: the reload hint's "Later" (kept for that version) and a failed load this visit.
  const [reloadLater, setReloadLater] = useState(() => readReloadLater(store));
  const [chunkFailed, setChunkFailed] = useState(false);
  const dismissNotice = useCallback(
    (id: string) => {
      if (isReloadNoticeId(id)) {
        const version = id.slice('reload:'.length);
        setChunkFailed(false);
        if (version !== 'unknown') {
          writeReloadLater(store, version);
          setReloadLater(version);
        }
        return;
      }
      setNotices((list) => list.filter((n) => n.id !== id));
    },
    [store],
  );

  const lastLevel = useRef(hero.level);
  useEffect(() => {
    if (hero.level > lastLevel.current) push([levelNotice(hero.id, hero.level)]);
    lastLevel.current = hero.level;
  }, [hero.id, hero.level, push]);

  const lastWorld = useRef<WorldState | null>(null);
  useEffect(() => {
    if (world.kind !== 'ready') return;
    push(unlockNotices(lastWorld.current, world.value));
    lastWorld.current = world.value;
  }, [world, push]);

  // Ticket 4.6: a community project finished (shown once per device and account).
  const worldView = useWorldView();
  const accountId = auth.state.kind === 'authenticated' ? auth.state.account.id : null;
  useEffect(() => {
    if (!worldView || !accountId) return;
    const key = `wf.seen.world.${accountId}`;
    const seen = readSeen(store, key) ?? new Set<string>();
    const fresh = worldNotices(worldView, seen, Date.now());
    if (fresh.length === 0) return;
    push(fresh);
    writeSeen(store, key, [...seen, ...fresh.map((n) => n.id)]);
  }, [worldView, accountId, store, push]);

  const lastBoard = useRef<QuestBoard | null>(null);
  useEffect(() => {
    if (board.kind !== 'ready') return;
    push(questNotices(lastBoard.current, board.value));
    lastBoard.current = board.value;
  }, [board, push]);

  // --- Ticket F.3: "What's new". The slip never shows while the first-steps guide runs, and a
  // player who has not read the notes since a release gets the status bar's "New" tag until
  // they open `#/notes`.
  const notesKey = accountId ? notesSeenKey(accountId) : null;
  const [notesSeen, setNotesSeen] = useState(() => (notesKey ? store.get(notesKey) : null));
  const [notesSeenBefore, setNotesSeenBefore] = useState<string | null>(null);
  const guideActive = !!guide && !guide.dismissed && nextGuideStep(guide.steps) !== null;
  const notes = notesUnread(notesSeen, guideActive);
  // Adjusted during render (React's pattern for state derived from props), persisted below.
  if (notes.baseline) setNotesSeen(GAME_VERSION);
  else if (route === 'notes' && notes.unread) {
    setNotesSeenBefore(notesSeen);
    setNotesSeen(GAME_VERSION);
  }
  useEffect(() => {
    if (notesKey && notesSeen) store.set(notesKey, notesSeen);
  }, [notesKey, notesSeen, store]);
  const announceNotes = notes.announce && route !== 'notes';
  useEffect(() => {
    if (announceNotes) push([releaseNotice()]);
  }, [announceNotes, push]);
  // --- Ticket F.4: a newer version is live (the shared health poll) or a part of this build
  // failed to load. Not in `notices`: it never fades and is not crowded out by MAX_NOTICES.
  const { serverVersion } = useHealthPoll();
  useEffect(() => watchChunkErrors(window, () => setChunkFailed(true)), []);
  const offer = reloadOffer({ serverVersion, later: reloadLater, guideActive, chunkFailed });
  const offerVersion = offer.show ? offer.version : null;
  const offerReason = offer.show ? offer.reason : null;
  const reloadSlip = useMemo(
    () => (offerReason ? reloadNotice({ version: offerVersion, reason: offerReason }) : null),
    [offerVersion, offerReason],
  );

  // Read (or read elsewhere): the slip goes with the marker.
  const shownNotices = useMemo(() => {
    const list = notes.unread ? notices : notices.filter((n) => n.id !== releaseNoticeId());
    return reloadSlip ? [...list, reloadSlip] : list;
  }, [notes.unread, notices, reloadSlip]);

  // --- "New" markers. A hero that has never fought starts with an empty seen list, so its
  // first drops and the Tavern's notices are marked; an older hero on a new device is not.
  const [fresh] = useState(() => hero.level === 1 && hero.experience === 0);
  const itemsKey = seenKey(hero.id, 'items');
  const questsKey = seenKey(hero.id, 'quests');
  const [seenItems, setSeenItems] = useState(() => readSeen(store, itemsKey));
  const [seenQuests, setSeenQuests] = useState(() => readSeen(store, questsKey));

  const packIds = useMemo(() => (pack ? pack.items.map((i) => i.id) : null), [pack]);
  const boardKeys = useMemo(
    () => (board.kind === 'ready' ? questKeys(board.value) : null),
    [board],
  );

  // First look on this device: take a baseline (state adjusted during render, React's pattern
  // for state derived from props), then persist every change of the seen lists.
  if (packIds && seenItems === null) setSeenItems(new Set(fresh ? [] : packIds));
  if (boardKeys && seenQuests === null) setSeenQuests(new Set(fresh ? [] : boardKeys));
  useEffect(() => {
    if (seenItems) writeSeen(store, itemsKey, seenItems);
  }, [seenItems, store, itemsKey]);
  useEffect(() => {
    if (seenQuests) writeSeen(store, questsKey, seenQuests);
  }, [seenQuests, store, questsKey]);

  const newItems = useMemo(() => newIds(packIds ?? [], seenItems), [packIds, seenItems]);
  const newQuests = useMemo(() => newIds(boardKeys ?? [], seenQuests), [boardKeys, seenQuests]);

  const markItemsSeen = useCallback(
    (ids?: readonly string[]) => {
      setSeenItems((prev) => {
        const add = ids ?? packIds ?? [];
        if (add.every((id) => prev?.has(id))) return prev;
        return new Set([...(prev ?? []), ...add]);
      });
    },
    [packIds],
  );
  const markQuestsSeen = useCallback(() => {
    setSeenQuests((prev) => {
      const add = boardKeys ?? [];
      if (add.every((k) => prev?.has(k))) return prev;
      return new Set([...(prev ?? []), ...add]);
    });
  }, [boardKeys]);

  // Leaving the Pack or the Tavern counts as having seen what it showed. Watched here, on the
  // route, rather than in the screens' unmount effects (StrictMode replays those on mount).
  const lastRoute = useRef(route);
  useEffect(() => {
    const left = lastRoute.current;
    lastRoute.current = route;
    if (left === route) return;
    if (left === 'inventory') markItemsSeen();
    if (left === 'tavern') markQuestsSeen();
  }, [route, markItemsSeen, markQuestsSeen]);

  const value = useMemo<OnboardingValue>(
    () => ({
      notices: shownNotices,
      dismissNotice,
      newItems,
      markItemsSeen,
      newQuests,
      markQuestsSeen,
      worldFlags: worldView?.flags ?? null,
      notesUnread: notes.unread,
      notesSeenBefore,
    }),
    [
      shownNotices,
      dismissNotice,
      newItems,
      markItemsSeen,
      newQuests,
      markQuestsSeen,
      worldView,
      notes.unread,
      notesSeenBefore,
    ],
  );
  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

export function useOnboarding(): OnboardingValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error('useOnboarding must be used inside <OnboardingProvider>');
  return ctx;
}
