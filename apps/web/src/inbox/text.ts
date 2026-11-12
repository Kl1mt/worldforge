import {
  AREAS,
  DUNGEONS,
  GUILD_HONOUR_TIERS,
  RARITIES,
  WORLD_ERAS,
  findCommunityProject,
  findCosmetic,
  findEventDefinition,
  findItemBase,
  findMythic,
  findPrestigeTier,
} from '@worldforge/game-core';
import { formatNumber } from '../lib/format';
import { arenaHref, routeHref } from '../lib/route';
import { versionLabel } from '../notes/unread';
import type { InboxEntry } from './api';

/** One inbox entry in plain words, with where to go about it. */
export interface InboxText {
  title: string;
  text: string;
  href: string;
  linkLabel: string;
  /** A short mark for the entry's kind (shape, not only colour). */
  sigil: string;
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const rarityName = (id: string) => RARITIES.find((r) => r.id === id)?.name ?? id;

function placeName(id: string): string {
  return (
    AREAS.find((a) => a.id === id)?.name ?? DUNGEONS.find((d) => d.id === id)?.name ?? 'the field'
  );
}

interface DropItem {
  baseId?: unknown;
  rarityId?: unknown;
  setId?: unknown;
  mythicId?: unknown;
  variant?: unknown;
}

/** "Void Legendary Iron Ring", "Mythic …", "Helm of the Drowned Vigil (set piece)". */
export function dropName(item: DropItem): string {
  const base = findItemBase(str(item.baseId));
  // A Mythic's base carries its name (the mythic id is also its base id).
  const mythic = item.mythicId ? findMythic(str(item.mythicId)) : undefined;
  const name =
    (mythic ? findItemBase(mythic.baseId)?.name : undefined) ?? base?.name ?? 'an unknown item';
  const variant =
    item.variant === 'void' ? 'Void ' : item.variant === 'prismatic' ? 'Prismatic ' : '';
  if (item.setId) {
    // A set piece's name already carries its set ("Helm of the Drowned Vigil").
    return `${variant}${name} (set piece)`;
  }
  return `${variant}${rarityName(str(item.rarityId))} ${name}`;
}

const VOID_REASON: Record<string, string> = {
  switch: 'the town closed that kind of trade for now',
  block: 'one of you blocked the other',
  sanction: 'a sanction stopped it',
  relation: 'you are no longer friends or guildmates',
  deletion: 'the hero was retired',
};

function list(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** The entry's words (data comes from the server; anything unexpected falls back safely). */
export function inboxText(entry: Pick<InboxEntry, 'kind' | 'data'>): InboxText {
  const d = entry.data;
  switch (entry.kind) {
    case 'drop': {
      const items = (Array.isArray(d.items) ? d.items : []) as DropItem[];
      const count = Math.max(num(d.count), items.length);
      const names = items.map(dropName);
      const more = count - items.length;
      const first = items[0];
      const title =
        count > 1
          ? `${count} finds worth keeping`
          : first?.setId
            ? 'A set piece'
            : first?.variant === 'void'
              ? 'A Void find'
              : first?.variant === 'prismatic'
                ? 'A Prismatic find'
                : `A ${rarityName(str(first?.rarityId, 'legendary'))} find`;
      const where =
        d.source === 'crypt'
          ? `from ${placeName(str(d.placeId))}`
          : `in ${placeName(str(d.placeId))}`;
      return {
        title,
        text: `${list(names)}${more > 0 ? ` and ${more} more` : ''}, ${where}.`,
        href: routeHref('inventory'),
        linkLabel: 'To the pack',
        sigil: '◆',
      };
    }
    case 'trade.received':
      return {
        title: 'A trade offer arrived',
        text: 'Someone offered you a trade. Look it over before it expires.',
        href: routeHref('trading'),
        linkLabel: 'To the trade desk',
        sigil: '⇄',
      };
    case 'trade.accepted':
      return {
        title: 'Your offer was accepted',
        text: 'The trade is done. What you asked for is on your hero, held for a while as every trade is.',
        href: routeHref('trading'),
        linkLabel: 'To the trade desk',
        sigil: '⇄',
      };
    case 'trade.voided': {
      const reason = VOID_REASON[str(d.reason)] ?? 'it could not go ahead';
      return {
        title: d.side === 'sent' ? 'Your offer was called off' : 'An offer to you was called off',
        text: `It was voided because ${reason}. Everything in it went back to the sender.`,
        href: routeHref('trading'),
        linkLabel: 'To the trade desk',
        sigil: '⇄',
      };
    }
    case 'trade.released': {
      const parts: string[] = [];
      if (num(d.items) > 0) parts.push(`${num(d.items)} ${num(d.items) === 1 ? 'item' : 'items'}`);
      if (num(d.gold) > 0) parts.push(`${formatNumber(num(d.gold))} gold`);
      return {
        title: 'Traded goods are yours',
        text: `The hold ended: ${parts.length > 0 ? list(parts) : 'what you received'} can be sold, stored and sent on now.`,
        href: routeHref('trading'),
        linkLabel: 'To the trade desk',
        sigil: '⇄',
      };
    }
    case 'duel.defence': {
      const outcome = str(d.outcome);
      const rating = num(d.rating);
      const kind = d.kind === 'rated' ? 'A rated duel' : 'A friendly duel';
      return {
        title:
          outcome === 'held'
            ? 'Your defence held'
            : outcome === 'fell'
              ? 'Your defence fell'
              : 'A draw at your defence',
        text: `${kind} was fought against your defence.${
          d.rating !== undefined ? ` Rating ${rating >= 0 ? '+' : '−'}${Math.abs(rating)}.` : ''
        }`,
        href: arenaHref({ duel: str(d.duelId) }),
        linkLabel: 'See the duel',
        sigil: '⚔',
      };
    }
    case 'event.reward': {
      const event = findEventDefinition(str(d.eventId));
      const cosmetic = findCosmetic(str(d.cosmeticId));
      return {
        title: `${event?.name ?? 'Event'}: tier ${num(d.tier)} reached`,
        text: cosmetic
          ? `${cosmetic.name} is in your collection book.`
          : 'Its keepsake is in your collection book.',
        href: routeHref('collection'),
        linkLabel: 'To the collection book',
        sigil: '✦',
      };
    }
    case 'season.honours': {
      const tiers = (Array.isArray(d.tiers) ? d.tiers : []).map(
        (t) => findPrestigeTier(str(t))?.name ?? str(t),
      );
      return {
        title: `Season ${num(d.season)} honours`,
        text:
          tiers.length > 0
            ? `You were named ${list([...new Set(tiers)])}.`
            : 'Your honours are in.',
        href: routeHref('account'),
        linkLabel: 'Choose a title',
        sigil: '♛',
      };
    }
    case 'guild.honours': {
      const tier = GUILD_HONOUR_TIERS.find((t) => t.id === d.tier);
      return {
        title: `Guild honours, season ${num(d.season)}`,
        text: `Your guild was named ${tier?.name ?? 'among the honoured'}. Its banner and crest are in your collection book.`,
        href: routeHref('guild'),
        linkLabel: 'To the Guild Hall',
        sigil: '♛',
      };
    }
    case 'world.stage': {
      const project = findCommunityProject(str(d.projectId));
      const stage = project?.stages.find((s) => s.id === d.stageId);
      return {
        title: `${project?.name ?? 'The town works'}: a stage is done`,
        text: stage
          ? `“${stage.name}” is finished. The town did it together.`
          : 'The town finished a stage together.',
        href: routeHref('works'),
        linkLabel: 'To the town works',
        sigil: '⚒',
      };
    }
    case 'world.era': {
      const era = WORLD_ERAS.find((e) => e.id === d.to);
      return {
        title: `A new era: ${era?.name ?? 'Graumark changes'}`,
        text: 'The town has changed. Walk its streets to see what is new.',
        href: routeHref('hub'),
        linkLabel: 'To the town',
        sigil: '☀',
      };
    }
    case 'release':
      return {
        title: `${versionLabel(str(d.version, '?'))} is out`,
        text: 'Graumark has changed. Read what is new.',
        href: routeHref('notes'),
        linkLabel: 'Read the notes',
        sigil: '✎',
      };
    default:
      return {
        title: 'News',
        text: 'Something happened while you were away.',
        href: routeHref('hub'),
        linkLabel: 'To the town',
        sigil: '•',
      };
  }
}
