import { useState } from 'react';
import { findGuildHonourTier } from '@worldforge/game-core';
import { formatNumber } from '../lib/format';
import { boardHref, guildHref } from '../lib/route';
import { describeHallFailure, guildHallApi, useLoad, type RollEntry } from '../social/guildHall';
import { HallCrest, guildNameClass } from '../social/HallLook';

/**
 * Ticket 8.4: the guild roll (`#/boards/guilds?season=<n>`): every guild's season score from the
 * published formula, parts shown, no player named. Past seasons read the archive with the honours.
 * Loading, error (Try again), empty, stale and success states.
 */
export function GuildRoll({ season, tabs }: { season: number | null; tabs: React.ReactNode }) {
  const [page, setPage] = useState(0);
  const { state, reload } = useLoad((s) => guildHallApi.roll(season, s), [season], 60_000);
  const size = 25;
  return (
    <section className="renown renown--guilds" aria-labelledby="renown-title">
      <header className="renown__head">
        <p className="caps renown__eyebrow">Graumark · The town hall</p>
        <h1 id="renown-title" className="display">
          Guild Roll
        </h1>
        <p className="renown__lede">
          The guilds of the town, by what they did together this season. Honours at its end are
          looks only.
        </p>
      </header>
      {tabs}
      {state.kind === 'loading' ? (
        <p role="status">The herald reads the guild roll…</p>
      ) : state.kind === 'error' ? (
        <div role="alert">
          <p>The guild roll cannot be read right now: {describeHallFailure(state.error)}</p>
          <button type="button" className="btn" onClick={reload}>
            Try again
          </button>
        </div>
      ) : (
        (() => {
          const roll = state.value;
          const w = roll.formula.weights;
          const entries = roll.entries.slice(page * size, page * size + size);
          return (
            <>
              <p className="groll-season">
                {roll.season
                  ? `Season ${roll.season.number}${roll.season.archivedAt ? ' · final standings' : ' · under way'}`
                  : 'No season has begun yet.'}
                {state.stale ? ' · could not refresh, showing the last roll' : ''}
                {roll.season && roll.season.number > 1 ? (
                  <>
                    {' · '}
                    <a href={boardHref('guilds', { season: roll.season.number - 1 })}>
                      Season {roll.season.number - 1}
                    </a>
                  </>
                ) : null}
              </p>
              {roll.mine ? (
                <div className="groll-mine panel-iron">
                  <p className="caps">Your guild</p>
                  <GuildRow e={roll.mine} />
                  {roll.mine.rank === null ? (
                    <p className="groll-fine">
                      Not on the roll yet: a guild needs {roll.formula.rules.minMembers} counted
                      members (each counts {roll.formula.rules.countAfterDays} days after joining).
                    </p>
                  ) : null}
                </div>
              ) : null}
              {roll.entries.length === 0 ? (
                <p className="groll-empty">No guild is on the roll yet this season.</p>
              ) : (
                <ol className="groll-list">
                  {entries.map((e) => (
                    <li key={`${e.rank}-${e.guild.tag}`}>
                      <GuildRow e={e} />
                    </li>
                  ))}
                </ol>
              )}
              {roll.total > size ? (
                <nav className="renown__pages" aria-label="Pages">
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={page === 0}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    Earlier places
                  </button>
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={(page + 1) * size >= roll.total}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Later places
                  </button>
                </nav>
              ) : null}
              <details className="groll-how panel-iron">
                <summary>How the roll is counted (version {roll.formula.version})</summary>
                <ul>
                  <li>
                    Guild boss: every stage the guild broke this season, Cracked {w.stagePoints[1]}{' '}
                    to Laid to Rest {w.stagePoints[5]} points.
                  </li>
                  <li>
                    Members&rsquo; PvE Progress: up to {w.pvePerMember} points a member, by their
                    best hero&rsquo;s share of the milestones; the best {w.countedMembers} count.
                  </li>
                  <li>
                    Town works: a whole need of one resource given is {w.communityPerNeed} points,
                    at most {w.communityPerMemberCap} a member; the best {w.countedMembers} count.
                  </li>
                  <li>
                    Members count {roll.formula.rules.countAfterDays} days after joining; gifts to
                    the town works count from the day after. Honours go to members of{' '}
                    {roll.formula.rules.honourAfterDays} days by the season&rsquo;s end who fought
                    the guild boss or gave to the works.
                  </li>
                </ul>
              </details>
            </>
          );
        })()
      )}
    </section>
  );
}

function GuildRow({ e }: { e: RollEntry }) {
  const name = (
    <span className={guildNameClass(e.guild.look.titleColour)}>
      {e.guild.name} <span className="groll-tag">[{e.guild.tag}]</span>
    </span>
  );
  return (
    <div className="groll-row">
      <span className="groll-rank">{e.rank ?? '—'}</span>
      <span className="groll-crest">
        <HallCrest frame={e.guild.look.crestFrame} emblem={e.guild.emblem} scale={1} />
      </span>
      <span className="groll-name">
        {e.guild.handle ? <a href={guildHref(e.guild.handle)}>{name}</a> : name}
        {e.tier ? (
          <span className={`groll-honour groll-honour--${e.tier}`}>
            {' '}
            · {findGuildHonourTier(e.tier)?.name ?? e.tier}
          </span>
        ) : null}
      </span>
      <span className="groll-parts">
        boss {formatNumber(e.parts.boss)} · PvE {formatNumber(e.parts.pve)} · works{' '}
        {formatNumber(e.parts.community)} · {e.members} counted
      </span>
      <span className="groll-value">{formatNumber(e.value)}</span>
    </div>
  );
}
