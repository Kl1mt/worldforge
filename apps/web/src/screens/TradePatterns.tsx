import { useCallback } from 'react';
import {
  TRADE_PATTERN_TEXT,
  type TradeAccountFlag,
  type TradePairFlag,
} from '@worldforge/game-core';
import { formatNumber } from '../lib/format';
import { useLoad } from '../social/arena';
import {
  describeTradeModFailure,
  tradeModApi,
  type TradeFlow,
  type TradeWho,
} from '../social/tradeMod';
import './moderation.css';
import './trade-mod.css';

/**
 * Ticket T.6: the trade pattern report on the docket and in the admin panel (docs/TRADING.md
 * "T.6 as built"): pairs with one-way flows or no other partners, shared invites and sign-up
 * mailboxes; accounts that received a lot while new, reached a weekly cap in several weeks,
 * offered unprovenanced items or had trades reversed; invite clusters. Read-only: a flag points at
 * a case, it never sanctions. Names open the trade ledger on that player or pair.
 */

const FLAG_LABEL: Record<TradePairFlag | TradeAccountFlag, string> = {
  oneWay: 'One way',
  onlyEachOther: 'Only each other',
  sameInvite: 'Same invite',
  sameMailbox: 'Same mailbox',
  newAccountReceiving: 'New, receiving',
  atCap: 'At a cap',
  flaggedItems: 'Unprovenanced item',
  repeatedReversals: 'Reversals',
};

const flowLine = (f: TradeFlow) => {
  const parts: string[] = [];
  if (f.items) parts.push(`${f.items} item${f.items === 1 ? '' : 's'}`);
  if (f.gold) parts.push(`${formatNumber(f.gold)} gold`);
  if (f.materialUnits) parts.push(`${formatNumber(f.materialUnits)} materials`);
  return parts.length ? parts.join(', ') : 'nothing';
};

function Flags({ flags }: { flags: (TradePairFlag | TradeAccountFlag)[] }) {
  if (flags.length === 0) return null;
  return (
    <p className="patterns__flags">
      {flags.map((f) => (
        <span key={f} className="caps patterns__flag" title={TRADE_PATTERN_TEXT[f]}>
          {FLAG_LABEL[f]}
          <span className="visually-hidden">: {TRADE_PATTERN_TEXT[f]}</span>
        </span>
      ))}
    </p>
  );
}

export function TradePatterns({
  onLookUp,
}: {
  onLookUp: (handle: string, other?: string) => void;
}) {
  const report = useLoad(useCallback(() => tradeModApi.patterns(), []));
  const Name = ({ who }: { who: TradeWho }) => (
    <button
      type="button"
      className="tdesk__link patterns__name"
      onClick={() => onLookUp(who.handle)}
    >
      {who.displayName}
      {who.role !== 'player' ? <span className="caps patterns__role"> {who.role}</span> : null}
    </button>
  );
  return (
    <section className="patterns tpat panel-ledger" aria-labelledby="tpat-title">
      <header className="patterns__head">
        <div>
          <p className="caps">Wardens · Trading</p>
          <h2 id="tpat-title" className="display">
            Trade patterns
          </h2>
        </div>
        <button
          type="button"
          className="btn btn--small"
          onClick={report.reload}
          disabled={report.state.kind === 'loading'}
        >
          Refresh
        </button>
      </header>
      <p className="patterns__lede">
        Completed trades of the last{' '}
        {report.state.kind === 'ready' ? report.state.value.windowDays : 28} days that look like
        funnelling, gold selling or laundering. Two friends can look like one person with two
        accounts: a flag is a reason to look, not a verdict. Hover a flag for what it means.
      </p>
      {report.state.kind === 'loading' ? (
        <p className="patterns__wait" role="status">
          Reading the trade books…
        </p>
      ) : report.state.kind === 'error' ? (
        <div className="gate__alert" role="alert">
          <p>The pattern report could not be read. {describeTradeModFailure(report.state.error)}</p>
          <button type="button" className="btn btn--small" onClick={report.reload}>
            Try again
          </button>
        </div>
      ) : (
        <>
          <p className="tpat__totals">
            {report.state.value.totals.trades} completed trades ·{' '}
            {report.state.value.totals.reversed} reversed · {report.state.value.totals.flaggedItems}{' '}
            unprovenanced items refused
          </p>
          <h3 className="caps tpat__sub">Pairs</h3>
          {report.state.value.pairs.length === 0 ? (
            <p className="patterns__empty">No pair traded more than once or raised a flag.</p>
          ) : (
            <ul className="patterns__list">
              {report.state.value.pairs.map((p) => (
                <li
                  key={`${p.a.handle}-${p.b.handle}`}
                  className={`patterns__pair${p.flags.length ? ' patterns__pair--flagged' : ''}`}
                >
                  <p className="patterns__who">
                    <Name who={p.a} /> <span className="patterns__vs">and</span> <Name who={p.b} />
                  </p>
                  <Flags flags={p.flags} />
                  <dl className="patterns__facts">
                    <div>
                      <dt>Trades</dt>
                      <dd>
                        {p.trades}
                        {p.reversed ? ` (${p.reversed} reversed)` : ''}
                      </dd>
                    </div>
                    <div>
                      <dt>{p.a.displayName} gave</dt>
                      <dd>{flowLine(p.aToB)}</dd>
                    </div>
                    <div>
                      <dt>{p.b.displayName} gave</dt>
                      <dd>{flowLine(p.bToA)}</dd>
                    </div>
                    <div>
                      <dt>Between</dt>
                      <dd>
                        {p.firstOn} – {p.lastOn}
                      </dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    className="tdesk__link"
                    onClick={() => onLookUp(p.a.handle, p.b.handle)}
                  >
                    Their trades
                  </button>
                </li>
              ))}
            </ul>
          )}
          <h3 className="caps tpat__sub">Accounts</h3>
          {report.state.value.accounts.length === 0 ? (
            <p className="patterns__empty">No account raised a flag.</p>
          ) : (
            <ul className="patterns__list">
              {report.state.value.accounts.map((a) => (
                <li key={a.who.handle} className="patterns__pair patterns__pair--flagged">
                  <p className="patterns__who">
                    <Name who={a.who} />
                  </p>
                  <Flags flags={a.flags} />
                  <dl className="patterns__facts">
                    <div>
                      <dt>Trades</dt>
                      <dd>
                        {a.trades} with {a.partners} partner{a.partners === 1 ? '' : 's'}
                      </dd>
                    </div>
                    <div>
                      <dt>Received</dt>
                      <dd>{flowLine(a.received)}</dd>
                    </div>
                    <div>
                      <dt>Gave</dt>
                      <dd>{flowLine(a.given)}</dd>
                    </div>
                    <div>
                      <dt>Account age</dt>
                      <dd>{a.accountAgeDays} days</dd>
                    </div>
                    {a.weeksAtCap ? (
                      <div>
                        <dt>Weeks at a cap</dt>
                        <dd>{a.weeksAtCap}</dd>
                      </div>
                    ) : null}
                    {a.flaggedItems ? (
                      <div>
                        <dt>Unprovenanced items</dt>
                        <dd>{a.flaggedItems}</dd>
                      </div>
                    ) : null}
                    {a.reversals ? (
                      <div>
                        <dt>Reversed trades</dt>
                        <dd>{a.reversals}</dd>
                      </div>
                    ) : null}
                  </dl>
                </li>
              ))}
            </ul>
          )}
          <h3 className="caps tpat__sub">Invite clusters</h3>
          {report.state.value.inviteClusters.length === 0 ? (
            <p className="patterns__empty">No group from one invite trades among itself.</p>
          ) : (
            <ul className="patterns__list">
              {report.state.value.inviteClusters.map((c, n) => (
                <li key={n} className="patterns__pair patterns__pair--flagged">
                  <p className="patterns__who">
                    {c.members.map((m, i) => (
                      <span key={m.handle}>
                        {i > 0 ? ', ' : ''}
                        <Name who={m} />
                      </span>
                    ))}
                  </p>
                  <p className="tdesk__fine">
                    {c.members.length} accounts from one invite, {c.trades} trades among them.
                  </p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
