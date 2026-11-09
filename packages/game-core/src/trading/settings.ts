import { TRADE_CATEGORIES, type TradeCategory, type TradingSwitches } from './binding.js';

/**
 * Trading settings (ticket T.2, docs/TRADING.md "Admin switches" and "Per-account limits"). Pure
 * data and rules: the typed schema, its defaults, the hard maxima, the validator and the
 * plain-language text the admin panel shows. The server stores them in `game_settings` (key
 * `trading`) and caches them; nothing here reads a clock or a database.
 *
 * - **Defaults** are the "Admin switches" table: the master switch, every "Trade: …" and every
 *   "Shelf: …" switch start off; "Tradeable: Epic / Legendary / set pieces" start on (they only
 *   matter once the master and "Trade: items" are on), Mythic and Void start off. The limits are
 *   the "Per-account limits" defaults. So nothing is tradeable until the owner opens trading.
 * - **Hard maxima** live here, in code: an admin can't store a number above its maximum, so a typo
 *   can't open the floodgates. **Writes are refused** (`validateTradingSettings` names the field);
 *   **reads are clamped** (`normaliseTradingSettings`): a stored value that is out of range (an
 *   older build with a higher maximum, a hand-edited row) is pulled to the nearest bound, and a
 *   missing or malformed field falls back to its default. Reading never throws.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepFreeze<T>(value: T): T {
  if (isRecord(value)) for (const v of Object.values(value)) deepFreeze(v);
  return Object.freeze(value);
}

/** "Trade: …" and "Shelf: …" kinds. */
export const TRADE_KINDS = ['items', 'materials', 'gold'] as const;
export type TradeKind = (typeof TRADE_KINDS)[number];

/** The numbers in "Per-account limits", each with a hard maximum. */
export const TRADING_LIMIT_IDS = [
  'openOffersSent',
  'openOffersReceived',
  'itemsPerSide',
  'tradesPerDay',
  'legendarySetPerWeek',
  'mythicVoidPerWeek',
  'epicPerWeek',
  'goldPerOffer',
  'goldPerWeek',
  'commonMaterialsPerWeek',
  'soulShardsPerWeek',
  'abbeySilverPerWeek',
] as const;
export type TradingLimitId = (typeof TRADING_LIMIT_IDS)[number];
export type TradingLimits = Record<TradingLimitId, number>;

export interface TradingSettings {
  /** "Trading" (master). */
  trading: boolean;
  /** "Trade: items / materials / gold". */
  trade: Record<TradeKind, boolean>;
  /** "Tradeable: …", one per item category. */
  tradeable: Record<TradeCategory, boolean>;
  /** "Shelf: items / materials / gold" (the shared account shelf, T.3). */
  shelf: Record<TradeKind, boolean>;
  /** Weekly and per-offer limits (T.4 and T.5 enforce them). */
  limits: TradingLimits;
}

export interface TradingLimitInfo {
  label: string;
  /** What one unit is, for the panel ("offers", "gold", "units"). */
  unit: string;
  default: number;
  /** The hard maximum: never stored above it. */
  max: number;
  /** One plain sentence. */
  explains: string;
}

/** The limits' defaults and hard maxima (docs/TRADING.md "Per-account limits"). Minimum is 0. */
export const TRADING_LIMITS: Readonly<Record<TradingLimitId, Readonly<TradingLimitInfo>>> = {
  openOffersSent: {
    label: 'Open offers sent',
    unit: 'offers',
    default: 3,
    max: 10,
    explains: 'How many offers one account can have waiting for an answer at once.',
  },
  openOffersReceived: {
    label: 'Open offers received',
    unit: 'offers',
    default: 10,
    max: 30,
    explains: 'How many offers can wait in one account’s inbox at once.',
  },
  itemsPerSide: {
    label: 'Items per side of one offer',
    unit: 'items',
    default: 6,
    max: 12,
    explains: 'The most items either player can put into a single offer.',
  },
  tradesPerDay: {
    label: 'Completed trades per day',
    unit: 'trades',
    default: 5,
    max: 20,
    explains: 'Accepted offers per account each day (UTC midnight to midnight).',
  },
  legendarySetPerWeek: {
    label: 'Legendary and set pieces per week',
    unit: 'items',
    default: 3,
    max: 10,
    explains: 'Given and received are counted separately. Mythic and Void items count here too.',
  },
  mythicVoidPerWeek: {
    label: 'Mythic or Void items per week',
    unit: 'items',
    default: 1,
    max: 3,
    explains: 'Given and received separately. A Void Mythic counts once.',
  },
  epicPerWeek: {
    label: 'Epic items per week',
    unit: 'items',
    default: 10,
    max: 30,
    explains: 'Given and received are counted separately.',
  },
  goldPerOffer: {
    label: 'Gold per offer',
    unit: 'gold',
    default: 5_000,
    max: 25_000,
    explains: 'The most gold either side of one offer can hold.',
  },
  goldPerWeek: {
    label: 'Gold per week',
    unit: 'gold',
    default: 10_000,
    max: 50_000,
    explains: 'About six hours of a Sunken Abbey hero’s income: help for a friend, not a living.',
  },
  commonMaterialsPerWeek: {
    label: 'Common materials per week',
    unit: 'units',
    default: 300,
    max: 1_500,
    explains: 'Timber, ashwort, raw hide and iron ore together: about a day of gathering.',
  },
  soulShardsPerWeek: {
    label: 'Soul shards per week',
    unit: 'shards',
    default: 40,
    max: 200,
    explains: 'About one item’s whole upgrade track.',
  },
  abbeySilverPerWeek: {
    label: 'Abbey silver per week',
    unit: 'silver',
    default: 10,
    max: 50,
    explains: 'Rare and gates the Ashen Pass project: a gift, not a supply.',
  },
};

export const DEFAULT_TRADING_SETTINGS: Readonly<TradingSettings> = deepFreeze({
  trading: false,
  trade: { items: false, materials: false, gold: false },
  tradeable: { epic: true, legendary: true, set: true, mythic: false, void: false },
  shelf: { items: false, materials: false, gold: false },
  limits: Object.fromEntries(
    TRADING_LIMIT_IDS.map((id) => [id, TRADING_LIMITS[id].default]),
  ) as TradingLimits,
});

/** Every switch of the settings, as a dotted path (`trading`, `trade.items`, `tradeable.epic`…). */
export type TradingSwitchPath =
  'trading' | `trade.${TradeKind}` | `tradeable.${TradeCategory}` | `shelf.${TradeKind}`;

export const TRADING_SWITCH_PATHS: readonly TradingSwitchPath[] = [
  'trading',
  ...TRADE_KINDS.map((k) => `trade.${k}` as const),
  ...TRADE_CATEGORIES.map((c) => `tradeable.${c}` as const),
  ...TRADE_KINDS.map((k) => `shelf.${k}` as const),
];

export interface TradingSwitchInfo {
  label: string;
  /** What it controls, in plain words. */
  controls: string;
  /** What happens to players when it is switched off. */
  whenOff: string;
}

const VOIDED = 'are voided; everything in escrow goes back to its sender.';

/** The panel's words for each switch (docs/TRADING.md "Admin switches", last column). */
export const TRADING_SWITCHES: Readonly<Record<TradingSwitchPath, Readonly<TradingSwitchInfo>>> = {
  trading: {
    label: 'Trading',
    controls: 'Whether players can trade with each other at all. Nothing below matters while off.',
    whenOff: `Every open offer is voided at once; everything in escrow goes back to its sender.`,
  },
  'trade.items': {
    label: 'Trade: items',
    controls: 'Whether offers may contain items.',
    whenOff: `Open offers with an item can’t be accepted and ${VOIDED}`,
  },
  'trade.materials': {
    label: 'Trade: materials',
    controls: 'Whether offers may contain materials.',
    whenOff: `Open offers with materials ${VOIDED}`,
  },
  'trade.gold': {
    label: 'Trade: gold',
    controls: 'Whether offers may contain gold.',
    whenOff: `Open offers with gold ${VOIDED}`,
  },
  'tradeable.epic': {
    label: 'Tradeable: Epic',
    controls: 'Fresh (never worn, never forged) Epic items.',
    whenOff: `Open offers with an Epic ${VOIDED} The items stay tradeable for later.`,
  },
  'tradeable.legendary': {
    label: 'Tradeable: Legendary',
    controls: 'Fresh Legendary items that are not set pieces.',
    whenOff: `Open offers with a Legendary ${VOIDED} The items stay tradeable for later.`,
  },
  'tradeable.set': {
    label: 'Tradeable: set pieces',
    controls: 'Fresh set pieces.',
    whenOff: `Open offers with a set piece ${VOIDED} The items stay tradeable for later.`,
  },
  'tradeable.mythic': {
    label: 'Tradeable: Mythic',
    controls: 'Fresh Mythic items.',
    whenOff: `Open offers with a Mythic ${VOIDED} The items stay tradeable for later.`,
  },
  'tradeable.void': {
    label: 'Tradeable: Void',
    controls: 'Fresh Void items. A Void set piece or Mythic needs this switch and its own.',
    whenOff: `Open offers with a Void item ${VOIDED} The items stay tradeable for later.`,
  },
  'shelf.items': {
    label: 'Shelf: items',
    controls: 'Moving items between your own heroes through the account shelf.',
    whenOff: 'No new deposits; anything on the shelf can still be taken out to any hero.',
  },
  'shelf.materials': {
    label: 'Shelf: materials',
    controls: 'Moving materials through the account shelf.',
    whenOff: 'No new deposits; anything on the shelf can still be taken out to any hero.',
  },
  'shelf.gold': {
    label: 'Shelf: gold',
    controls: 'Moving gold through the account shelf.',
    whenOff: 'No new deposits; anything on the shelf can still be taken out to any hero.',
  },
};

/** What lowering a limit does (the "Weekly limits" row). */
export const TRADING_LIMITS_WHEN_LOWERED =
  'Lowering a limit never voids an offer: an offer that would now go over it can’t be accepted (the player is told why) and expires as usual.';

/** The suggested launch order (docs/TRADING.md, below the switch table), as guidance. */
export const TRADING_LAUNCH_ORDER: readonly string[] = [
  'Turn on Trading with Trade: items (Epic, Legendary and set pieces are already on) and Shelf: items.',
  'After a few weeks of clean telemetry, add Trade: materials and Shelf: materials.',
  'Add gold, Mythic and Void last, one at a time.',
];

export function readSwitch(s: Readonly<TradingSettings>, path: TradingSwitchPath): boolean {
  if (path === 'trading') return s.trading;
  const [group, key] = path.split('.') as ['trade' | 'tradeable' | 'shelf', string];
  return (s[group] as Record<string, boolean>)[key]!;
}

/** The switches item binding reads (T.1's `itemBinding(item, switches)`). */
export function tradingSwitchesOf(s: Readonly<TradingSettings>): TradingSwitches {
  return {
    trading: s.trading,
    items: s.trade.items,
    categories: { ...s.tradeable },
  };
}

/** Switches that were on in `before` and are off in `after` (the seam T.5 voids offers from). */
export function switchedOff(
  before: Readonly<TradingSettings>,
  after: Readonly<TradingSettings>,
): TradingSwitchPath[] {
  return TRADING_SWITCH_PATHS.filter((p) => readSwitch(before, p) && !readSwitch(after, p));
}

/** One changed field, for the audit row and the history (`path` is dotted, e.g. `limits.goldPerWeek`). */
export interface TradingSettingsChange {
  path: string;
  old: boolean | number;
  new: boolean | number;
}

export function diffTradingSettings(
  before: Readonly<TradingSettings>,
  after: Readonly<TradingSettings>,
): TradingSettingsChange[] {
  const out: TradingSettingsChange[] = [];
  for (const p of TRADING_SWITCH_PATHS) {
    const a = readSwitch(before, p);
    const b = readSwitch(after, p);
    if (a !== b) out.push({ path: p, old: a, new: b });
  }
  for (const id of TRADING_LIMIT_IDS) {
    if (before.limits[id] !== after.limits[id]) {
      out.push({ path: `limits.${id}`, old: before.limits[id], new: after.limits[id] });
    }
  }
  return out;
}

function boolGroup<K extends string>(
  raw: unknown,
  keys: readonly K[],
  fallback: Readonly<Record<K, boolean>>,
): Record<K, boolean> {
  const r = isRecord(raw) ? raw : {};
  return Object.fromEntries(
    keys.map((k) => [k, typeof r[k] === 'boolean' ? r[k] : fallback[k]]),
  ) as Record<K, boolean>;
}

/** Clamps a stored limit into `[0, max]`; non-numbers fall back to the default. */
export function clampLimit(id: TradingLimitId, raw: unknown): number {
  const info = TRADING_LIMITS[id];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return info.default;
  return Math.min(info.max, Math.max(0, Math.floor(raw)));
}

/**
 * The settings from a stored value (any JSON, or nothing): missing or malformed fields take their
 * default, numbers are clamped to `[0, max]`, unknown fields are dropped. Never throws.
 */
export function normaliseTradingSettings(raw: unknown): TradingSettings {
  const r = isRecord(raw) ? raw : {};
  const d = DEFAULT_TRADING_SETTINGS;
  const limits = isRecord(r.limits) ? r.limits : {};
  return {
    trading: typeof r.trading === 'boolean' ? r.trading : d.trading,
    trade: boolGroup(r.trade, TRADE_KINDS, d.trade),
    tradeable: boolGroup(r.tradeable, TRADE_CATEGORIES, d.tradeable),
    shelf: boolGroup(r.shelf, TRADE_KINDS, d.shelf),
    limits: Object.fromEntries(
      TRADING_LIMIT_IDS.map((id) => [id, clampLimit(id, limits[id])]),
    ) as TradingLimits,
  };
}

export type TradingSettingsValidation =
  { ok: true; value: TradingSettings } | { ok: false; fields: Record<string, string> };

/**
 * Validates a full settings object an admin submits. Refuses (never clamps) anything off-schema:
 * a missing or extra field, a non-boolean switch, a limit that is not a whole number in
 * `[0, max]`. `fields` maps each dotted path to a plain message for the panel.
 */
export function validateTradingSettings(input: unknown): TradingSettingsValidation {
  const fields: Record<string, string> = {};
  if (!isRecord(input))
    return { ok: false, fields: { settings: 'Send the whole settings object.' } };
  const allowed = new Set(['trading', 'trade', 'tradeable', 'shelf', 'limits']);
  for (const k of Object.keys(input)) if (!allowed.has(k)) fields[k] = 'Unknown setting.';
  if (typeof input.trading !== 'boolean') fields.trading = 'Must be on or off.';
  const groups: [string, readonly string[]][] = [
    ['trade', TRADE_KINDS],
    ['tradeable', TRADE_CATEGORIES],
    ['shelf', TRADE_KINDS],
  ];
  for (const [group, keys] of groups) {
    const g = input[group];
    if (!isRecord(g)) {
      fields[group] = 'Missing.';
      continue;
    }
    for (const k of Object.keys(g))
      if (!keys.includes(k)) fields[`${group}.${k}`] = 'Unknown setting.';
    for (const k of keys) {
      if (typeof g[k] !== 'boolean') fields[`${group}.${k}`] = 'Must be on or off.';
    }
  }
  const limits = input.limits;
  if (!isRecord(limits)) {
    fields.limits = 'Missing.';
  } else {
    for (const k of Object.keys(limits)) {
      if (!(TRADING_LIMIT_IDS as readonly string[]).includes(k))
        fields[`limits.${k}`] = 'Unknown limit.';
    }
    for (const id of TRADING_LIMIT_IDS) {
      const v = limits[id];
      const { max } = TRADING_LIMITS[id];
      if (typeof v !== 'number' || !Number.isInteger(v)) {
        fields[`limits.${id}`] = 'Must be a whole number.';
      } else if (v < 0) {
        fields[`limits.${id}`] = 'Can’t be negative.';
      } else if (v > max) {
        fields[`limits.${id}`] = `The hard maximum is ${max.toLocaleString('en-GB')}.`;
      }
    }
  }
  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return { ok: true, value: normaliseTradingSettings(input) };
}
