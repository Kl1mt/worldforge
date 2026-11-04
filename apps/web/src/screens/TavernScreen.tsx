import {
  findContractTemplate,
  getArea,
  getStoryQuest,
  type QuestObjective,
} from '@worldforge/game-core';
import { asset } from '../content/assets';
import { HUB_HOTSPOTS } from '../content/world';
import { useMediaQuery } from '../components/useMediaQuery';
import { PHONE_QUERY } from '../lib/pixel';
import { formatNumber } from '../lib/format';
import { routeHref } from '../lib/route';
import type { ContractOfferDto, QuestDto } from '../quests/api';
import { useQuests } from '../quests/useQuests';
import { useOnboarding } from '../onboarding/OnboardingProvider';
import { questKey } from '../onboarding/seen';
import {
  contractTitle,
  objectiveLabel,
  objectiveTarget,
  questTitle,
  rewardParts,
  storyBlockerText,
} from '../quests/text';
import './hub.css';
import './tavern.css';

const HUB = asset('hub.graumark');

function Rewards({ parts }: { parts: string[] }) {
  return (
    <p className="note__reward">
      <span className="caps">Reward</span> {parts.join(' · ')}
    </p>
  );
}

function ObjectiveRow({ objective, value }: { objective: QuestObjective; value: number }) {
  const target = objectiveTarget(objective);
  const done = value >= target;
  return (
    <li className={`objective${done ? ' objective--done' : ''}`}>
      <div className="meter-field__text">
        <span className="objective__label">
          <span className="objective__tick" aria-hidden="true">
            {done ? '✓' : '◇'}
          </span>
          {objectiveLabel(objective)}
        </span>
        <span className="meter-field__value">
          {formatNumber(value)} / {formatNumber(target)}
          <span className="visually-hidden">{done ? ', done' : ''}</span>
        </span>
      </div>
      <div className="meter meter--quest" aria-hidden="true">
        <span style={{ ['--value' as string]: `${Math.round((value / target) * 100)}%` }} />
      </div>
    </li>
  );
}

function NewTag() {
  return <span className="new-tag">New</span>;
}

function QuestEntry({
  quest,
  busy,
  isNew,
  onTurnIn,
}: {
  quest: QuestDto;
  busy: boolean;
  isNew: boolean;
  onTurnIn: () => void;
}) {
  const ready = quest.status === 'ready';
  const title = questTitle(quest.kind, quest.questId, quest.objectives[0]);
  return (
    <li className={`entry${ready ? ' entry--ready' : ''}`}>
      <div className="entry__head">
        <p className="caps entry__kind">
          {quest.kind === 'story' ? 'Story' : 'Contract'}
          {isNew ? (
            <>
              {' '}
              <NewTag />
            </>
          ) : null}
        </p>
        <h3 className="entry__title display">{title}</h3>
      </div>
      <ul className="entry__objectives">
        {quest.objectives.map((o, i) => (
          <ObjectiveRow key={i} objective={o} value={quest.progress[i] ?? 0} />
        ))}
      </ul>
      <Rewards parts={rewardParts(quest.reward)} />
      {ready ? (
        <button type="button" className="btn btn--brass" disabled={busy} onClick={onTurnIn}>
          {busy ? 'Collecting…' : 'Turn in'}
        </button>
      ) : (
        <p className="entry__hint">Progress comes from your hero’s fights and gathering.</p>
      )}
    </li>
  );
}

function ContractSlip({
  offer,
  full,
  busy,
  isNew,
  onAccept,
}: {
  offer: ContractOfferDto;
  full: boolean;
  busy: boolean;
  isNew: boolean;
  onAccept: () => void;
}) {
  const template = findContractTemplate(offer.templateId);
  const area = template ? getArea(template.areaId).name : null;
  return (
    <li className={`note note--slip${offer.accepted ? ' note--taken' : ''}`}>
      <span className="note__pin" aria-hidden="true" />
      <p className="caps note__from">
        Contract{area ? ` · ${area}` : ''}
        {isNew ? (
          <>
            {' '}
            <NewTag />
          </>
        ) : null}
      </p>
      <h3 className="note__title display">{contractTitle(offer.objective)}</h3>
      <p className="note__task">{objectiveLabel(offer.objective)}</p>
      <Rewards parts={rewardParts(offer.reward)} />
      {offer.accepted ? (
        <p className="note__stamp">Taken</p>
      ) : (
        <button
          type="button"
          className="btn"
          disabled={busy || full}
          title={full ? 'You carry three contracts already' : undefined}
          onClick={onAccept}
        >
          {busy ? 'Taking…' : 'Take contract'}
        </button>
      )}
    </li>
  );
}

/** The Tavern (ticket 2.4): the notice board with the story chain and daily contracts. */
export function TavernScreen() {
  const phone = useMediaQuery(PHONE_QUERY);
  const quests = useQuests();
  const { board, busy, error, lastReward } = quests;
  const { newQuests } = useOnboarding();
  const spot = HUB_HOTSPOTS.find((h) => h.id === 'tavern')!;
  const scale = phone ? 2 : 3;

  return (
    <section className="tavern" aria-labelledby="tavern-title">
      <header className="tavern__head">
        <figure className="building__niche tavern__niche">
          <span
            className="building__art"
            role="img"
            aria-label="The Tavern, seen from the street"
            style={{
              width: spot.width * scale,
              height: spot.height * scale,
              backgroundImage: `url(${HUB.path})`,
              backgroundSize: `${HUB.width * scale}px ${HUB.height * scale}px`,
              backgroundPosition: `${-spot.x * scale}px ${-spot.y * scale}px`,
            }}
          />
          <figcaption className="building__plaque">{spot.label}</figcaption>
        </figure>
        <div className="tavern__intro">
          <p className="caps tavern__where">Graumark · Notice board</p>
          <h1 id="tavern-title" className="display tavern__title">
            The Tavern
          </h1>
          <p className="tavern__text">
            Smoke, spilt ale and a board full of nails. Whoever needs a sword pins a note here; the
            keeper pays out when the work is done.
          </p>
          <a className="btn" href={routeHref('hub')}>
            Back to town
          </a>
        </div>
      </header>

      {lastReward ? (
        <div className="tavern__paid" role="status">
          <p>
            <span className="caps">Paid out</span>{' '}
            <strong>
              {lastReward.kind === 'story'
                ? questTitle('story', lastReward.questId)
                : 'Contract fulfilled'}
            </strong>
            : +{formatNumber(lastReward.xp)} XP, +{formatNumber(lastReward.gold)} gold
            {lastReward.levelsGained > 0 ? ` · level up!` : ''}
            {lastReward.item ? ' · the reward item is in your pack' : ''}
          </p>
          <button type="button" className="btn" onClick={quests.dismissReward}>
            Dismiss
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="tavern__alert" role="alert">
          {error}
        </p>
      ) : null}

      {board.kind === 'loading' ? (
        <p className="tavern__wait" role="status">
          The keeper is reading out the notices…
        </p>
      ) : board.kind === 'error' ? (
        <div className="tavern__alert" role="alert">
          <p>The board cannot be read right now. {board.message}</p>
          <button type="button" className="btn" onClick={quests.reload}>
            Try again
          </button>
        </div>
      ) : (
        <div className="tavern__grid">
          <section className="board" aria-labelledby="board-title">
            <h2 id="board-title" className="visually-hidden">
              Notices
            </h2>
            <div className="board__story">
              {board.value.story.next ? (
                (() => {
                  const next = board.value.story.next;
                  const def = getStoryQuest(next.questId);
                  const locked = next.blockers.length > 0;
                  return (
                    <article className={`note note--story${locked ? ' note--locked' : ''}`}>
                      <span className="note__pin" aria-hidden="true" />
                      <p className="caps note__from">
                        Story · {def.giver}
                        {newQuests.has(questKey.story(next.questId)) ? (
                          <>
                            {' '}
                            <NewTag />
                          </>
                        ) : null}
                      </p>
                      <h3 className="note__title display">{def.name}</h3>
                      <p className="note__text">{def.description}</p>
                      <ul className="note__tasks">
                        {def.objectives.map((o, i) => (
                          <li key={i}>{objectiveLabel(o)}</li>
                        ))}
                      </ul>
                      <Rewards parts={rewardParts(def.reward)} />
                      {locked ? (
                        <p className="note__blocked">
                          {next.blockers.map(storyBlockerText).join(' · ')}
                        </p>
                      ) : (
                        <button
                          type="button"
                          className="btn btn--brass"
                          disabled={busy === next.questId}
                          onClick={() =>
                            void quests.accept({ kind: 'story', questId: next.questId })
                          }
                        >
                          {busy === next.questId ? 'Taking…' : 'Take the quest'}
                        </button>
                      )}
                    </article>
                  );
                })()
              ) : (
                <article className="note note--story note--locked">
                  <span className="note__pin" aria-hidden="true" />
                  <p className="caps note__from">Story</p>
                  <h3 className="note__title display">No more pages, for now</h3>
                  <p className="note__text">
                    Graumark’s story notices are all taken. The keeper says new ones will come with
                    the roads that open.
                  </p>
                </article>
              )}
            </div>

            <div className="board__contracts">
              <p className="caps board__label">
                Today’s contracts · {board.value.contracts.active} of{' '}
                {board.value.contracts.maxActive} carried
              </p>
              <ul className="board__slips">
                {board.value.contracts.offers.map((offer) => (
                  <ContractSlip
                    key={offer.slot}
                    offer={offer}
                    full={board.value.contracts.active >= board.value.contracts.maxActive}
                    busy={busy === `slot:${offer.slot}`}
                    isNew={newQuests.has(
                      questKey.offer(board.value.day, offer.slot, offer.templateId),
                    )}
                    onAccept={() => void quests.accept({ kind: 'contract', slot: offer.slot })}
                  />
                ))}
              </ul>
              <p className="board__foot">New contracts are pinned up at dawn (UTC).</p>
            </div>
          </section>

          <section className="quests panel-ledger" aria-labelledby="quests-title">
            <h2 id="quests-title" className="rule-heading">
              Your quests
            </h2>
            {board.value.quests.length === 0 ? (
              <div className="quests__empty">
                <p className="display">Nothing in hand.</p>
                <p>
                  Take a notice from the board. Your hero works on it while fighting, even offline.
                </p>
              </div>
            ) : (
              <ul className="quests__list">
                {board.value.quests.map((q) => (
                  <QuestEntry
                    key={q.id}
                    quest={q}
                    busy={busy === q.id}
                    isNew={newQuests.has(questKey.ready(q.id))}
                    onTurnIn={() => void quests.turnIn(q.id)}
                  />
                ))}
              </ul>
            )}
            {board.value.story.completed.length > 0 ? (
              <div className="quests__deeds">
                <h3 className="caps">Deeds done</h3>
                <ul>
                  {board.value.story.completed.map((id) => (
                    <li key={id}>{getStoryQuest(id).name}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        </div>
      )}
    </section>
  );
}
