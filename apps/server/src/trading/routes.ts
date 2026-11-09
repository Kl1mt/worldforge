import type { FastifyInstance } from 'fastify';
import {
  TRADE_CAPS,
  TRADE_CAP_METRICS,
  TRADE_ELIGIBILITY,
  TRADE_KINDS,
  TRADE_SANCTION_CHECK,
  counterKey,
  standingRefusals,
  tradeDecision,
  tradeRefusalText,
  tradeRelationKind,
  tradeWindows,
  visibleRelation,
  type TradeCapMetric,
  type TradeDirection,
  type TradeRefusal,
  type TradeStanding,
} from '@worldforge/game-core';
import { ApiError } from '../errors.js';
import { accountBy } from '../social/friends.js';
import { relationBetween } from '../social/relations.js';
import { loadTradeRelation, loadTradeStanding } from './standing.js';
import { readTradeCounters } from './counters.js';

/**
 * `GET /api/trading/eligibility[?handle=]` (ticket T.4, docs/TRADING.md "T.4 as built",
 * docs/API_CONVENTIONS.md): "can I trade, and with this player, and if not, why", in plain words.
 *
 * **What it may say about the other player.** Only what the relation already allows:
 * - unknown handle, or a player who blocks you: the same `404 not_found` as an unknown player
 *   (exactly like `GET /api/players/:handle/relation`, so it confirms nothing new);
 * - you block them: `blocked`; a stranger or a pending request: `no_relation`; friends or
 *   guildmates for under 7 days: `relation_too_new` with the day it qualifies (both players know
 *   when they became friends or joined the guild). In none of these is the other account's
 *   standing read at all;
 * - friends or guildmates for 7 days or more: one bit, `them_not_eligible`, never which rule they
 *   miss (age, level, email or a sanction stay theirs).
 * Your own standing is always shown in full. Nothing here is a write; it counts against 3.9's
 * per-account request limit like any read.
 */

const refusalSchema = {
  type: 'object',
  required: ['check', 'party', 'text'],
  properties: {
    check: { type: 'string' },
    party: { type: 'string' },
    text: { type: 'string' },
    metAt: { type: 'string' },
  },
} as const;

const responseSchema = {
  200: {
    type: 'object',
    required: ['trading', 'you', 'usage', 'with'],
    properties: {
      trading: {
        type: 'object',
        required: ['open', 'kinds'],
        properties: {
          open: { type: 'boolean' },
          kinds: {
            type: 'object',
            required: [...TRADE_KINDS],
            properties: Object.fromEntries(TRADE_KINDS.map((k) => [k, { type: 'boolean' }])),
          },
        },
      },
      you: {
        type: 'object',
        required: ['eligible', 'requirements'],
        properties: {
          eligible: { type: 'boolean' },
          requirements: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'met', 'label', 'text'],
              properties: {
                id: { type: 'string' },
                met: { type: 'boolean' },
                label: { type: 'string' },
                text: { type: 'string' },
                metAt: { type: 'string' },
                value: { type: 'integer' },
                required: { type: 'integer' },
                sanctions: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      usage: {
        type: 'object',
        required: ['dayResetsAt', 'weekResetsAt', 'caps'],
        properties: {
          dayResetsAt: { type: 'string' },
          weekResetsAt: { type: 'string' },
          caps: {
            type: 'array',
            items: {
              type: 'object',
              required: ['metric', 'direction', 'period', 'used', 'max'],
              properties: {
                metric: { type: 'string' },
                direction: { type: 'string' },
                period: { type: 'string' },
                used: { type: 'integer' },
                max: { type: 'integer' },
              },
            },
          },
        },
      },
      with: {
        type: ['object', 'null'],
        required: ['handle', 'relation', 'allowed', 'reasons'],
        properties: {
          handle: { type: 'string' },
          relation: { type: 'string', enum: ['self', 'blocked', 'friend', 'guildmate', 'none'] },
          allowed: { type: 'boolean' },
          reasons: { type: 'array', items: refusalSchema },
        },
      },
    },
  },
} as const;

export type TradeRequirementId = 'accountAge' | 'heroLevel' | 'email' | 'standing';

export interface TradeRequirementView {
  id: TradeRequirementId;
  met: boolean;
  label: string;
  text: string;
  metAt?: string;
  value?: number;
  required?: number;
  sanctions?: string[];
}

export interface TradeEligibilityView {
  trading: { open: boolean; kinds: Record<(typeof TRADE_KINDS)[number], boolean> };
  you: { eligible: boolean; requirements: TradeRequirementView[] };
  usage: {
    dayResetsAt: string;
    weekResetsAt: string;
    caps: {
      metric: TradeCapMetric;
      direction: TradeDirection;
      period: 'day' | 'week';
      used: number;
      max: number;
    }[];
  };
  with: {
    handle: string;
    relation: 'self' | 'blocked' | 'friend' | 'guildmate' | 'none';
    allowed: boolean;
    reasons: { check: string; party: string; text: string; metAt?: string }[];
  } | null;
}

/** Your own requirements, each met or not (the panel's list). */
export function requirementsOf(s: TradeStanding, now: Date): TradeRequirementView[] {
  const failing = standingRefusals(s, now);
  const fails = (c: string) => failing.find((f) => f.check === c);
  const age = fails('account_too_new');
  const blocking = s.sanctions.filter((k) => TRADE_SANCTION_CHECK[k] !== null);
  return [
    {
      id: 'accountAge',
      met: !age,
      label: `Account at least ${TRADE_ELIGIBILITY.minAccountAgeDays} days old`,
      text: age ? 'Your account is still too new to trade.' : 'Your account is old enough.',
      ...(age?.metAt ? { metAt: age.metAt } : {}),
      required: TRADE_ELIGIBILITY.minAccountAgeDays,
    },
    {
      id: 'heroLevel',
      met: !fails('hero_too_low'),
      label: `A hero at level ${TRADE_ELIGIBILITY.minHeroLevel} or higher`,
      text:
        s.highestHeroLevel === 0
          ? 'You have no hero yet.'
          : `Your best hero is level ${s.highestHeroLevel}.`,
      value: s.highestHeroLevel,
      required: TRADE_ELIGIBILITY.minHeroLevel,
    },
    {
      id: 'email',
      met: s.emailVerified,
      label: 'A verified email address',
      text: s.emailVerified
        ? 'Your email address is verified.'
        : 'Verify your email address in the security panel.',
    },
    {
      id: 'standing',
      met: blocking.length === 0,
      label: 'No mute, suspension or trade restriction',
      text:
        blocking.length === 0
          ? 'Nothing stops you from trading.'
          : 'A sanction stops you from sending or accepting offers until it ends.',
      sanctions: blocking,
    },
  ];
}

const reasonView = (r: TradeRefusal) => ({
  check: r.party === 'them' ? 'them_not_eligible' : r.check,
  party: r.party,
  text: tradeRefusalText(r),
  ...(r.metAt && r.party !== 'them' ? { metAt: r.metAt } : {}),
});

export async function registerTrading(app: FastifyInstance): Promise<void> {
  app.get(
    '/trading/eligibility',
    {
      preHandler: app.requireAccount,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { handle: { type: 'string', minLength: 1, maxLength: 64 } },
        },
        response: responseSchema,
      },
    },
    async (request): Promise<TradeEligibilityView> => {
      const me = request.auth!.account;
      const { handle } = request.query as { handle?: string };
      const now = app.authNow();
      const settings = await app.gameSettings.trading();
      const standing = (await loadTradeStanding(app.db, me.id, now))!;
      const requirements = requirementsOf(standing, now);
      const windows = tradeWindows(now);
      const used = await readTradeCounters(app.db, me.id, now);
      const caps = TRADE_CAP_METRICS.flatMap((metric) =>
        TRADE_CAPS[metric].directions.map((direction) => ({
          metric,
          direction,
          period: TRADE_CAPS[metric].period,
          used: used[counterKey(metric, direction)] ?? 0,
          max: settings.limits[TRADE_CAPS[metric].limit],
        })),
      );

      let withView: TradeEligibilityView['with'] = null;
      if (handle !== undefined) {
        const them = await accountBy(app.db, { handle }, now);
        // A player who blocks you is answered exactly like an unknown one.
        const visible = them
          ? visibleRelation(await relationBetween(app.db, me.id, them.id))
          : null;
        if (!them || !visible) throw new ApiError(404, 'not_found', 'No player by that name.');
        const relation = await loadTradeRelation(app.db, me.id, them.id);
        const kind = tradeRelationKind(relation);
        // The other account's standing is read only once the relation qualifies, and handed on
        // as one bit (`hidden-*`), so the decision cannot name the rule they miss.
        const probe = tradeDecision({
          action: 'send',
          settings,
          now,
          actor: standing,
          counterpart: null,
          relation,
        });
        const pairOk = !probe.refusals.some((r) => r.party === 'pair');
        let counterpart: 'hidden-eligible' | 'hidden-ineligible' | null = null;
        if (pairOk) {
          const theirs = await loadTradeStanding(app.db, them.id, now);
          counterpart =
            theirs && standingRefusals(theirs, now).length === 0
              ? 'hidden-eligible'
              : 'hidden-ineligible';
        }
        const decision = tradeDecision({
          action: 'send',
          settings,
          now,
          actor: standing,
          counterpart,
          relation,
        });
        withView = {
          handle: them.handle,
          relation: kind,
          allowed: decision.allowed,
          reasons: decision.refusals.map(reasonView),
        };
      }

      return {
        trading: { open: settings.trading, kinds: { ...settings.trade } },
        you: { eligible: requirements.every((r) => r.met), requirements },
        usage: {
          dayResetsAt: windows.day.endsAt.toISOString(),
          weekResetsAt: windows.week.endsAt.toISOString(),
          caps,
        },
        with: withView,
      };
    },
  );
}
