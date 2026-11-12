import { describe, expect, it } from 'vitest';
import {
  LOOT_FILTER_AFFIX_IDS,
  LOOT_FILTER_CATEGORIES,
  LOOT_FILTER_EFFECT_IDS,
  LOOT_FILTER_MAX_WANTED,
  type LootFilterRules,
} from './lootFilter.js';
import {
  LOOT_FILTER_CODE_MAX_LENGTH,
  decodeLootFilterCode,
  encodeLootFilterCode,
  normalisePresetName,
} from './lootFilterCode.js';
import { RARITY_IDS } from '../rarity.js';
import { createRng } from '../rng.js';

const sample: LootFilterRules = {
  action: 'sell',
  belowRarity: 'rare',
  wantedAffixes: LOOT_FILTER_AFFIX_IDS.slice(0, 3),
  wantedEffects: LOOT_FILTER_EFFECT_IDS.slice(0, 2),
  include: ['set', 'void'],
};

/** Rebuilds a code around a payload text (a valid checksum), as a forger could. */
function forge(payload: string, version = 'wf1'): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let bits = '';
  for (const ch of payload) bits += ch.charCodeAt(0).toString(2).padStart(8, '0');
  let body = '';
  for (let i = 0; i < bits.length; i += 6)
    body += abc[parseInt(bits.slice(i, i + 6).padEnd(6, '0'), 2)];
  // FNV-1a of the payload text, as documented in docs/LOOT.md.
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${version}.${body}.${h.toString(36)}`;
}

describe('loot filter share codes (ticket 8.5)', () => {
  it('round-trips rules exactly', () => {
    const code = encodeLootFilterCode(sample);
    expect(code.startsWith('wf1.')).toBe(true);
    expect(decodeLootFilterCode(code)).toEqual({ ok: true, rules: sample });
    // Surrounding whitespace (a pasted code) is fine.
    expect(decodeLootFilterCode(`  ${code}\n`)).toEqual({ ok: true, rules: sample });
  });

  it('round-trips random valid rules, every rarity and category', () => {
    const rng = createRng(85);
    for (let n = 0; n < 500; n++) {
      const pick = <T>(list: readonly T[], max: number) =>
        list.filter(() => rng.next() < max / Math.max(1, list.length));
      const rules: LootFilterRules = {
        action: rng.next() < 0.5 ? 'sell' : 'salvage',
        belowRarity: rng.next() < 0.2 ? null : RARITY_IDS[Math.floor(rng.next() * 6)]!,
        wantedAffixes: pick(LOOT_FILTER_AFFIX_IDS, 4),
        wantedEffects: pick(LOOT_FILTER_EFFECT_IDS, 3),
        include: LOOT_FILTER_CATEGORIES.filter(() => rng.next() < 0.4),
      };
      const decoded = decodeLootFilterCode(encodeLootFilterCode(rules));
      expect(decoded).toEqual({ ok: true, rules });
    }
  });

  it('keeps the longest legal filter under the length cap', () => {
    const longest: LootFilterRules = {
      action: 'salvage',
      belowRarity: 'legendary',
      wantedAffixes: LOOT_FILTER_AFFIX_IDS.slice(0, LOOT_FILTER_MAX_WANTED),
      wantedEffects: LOOT_FILTER_EFFECT_IDS.slice(0, LOOT_FILTER_MAX_WANTED),
      include: [...LOOT_FILTER_CATEGORIES],
    };
    const code = encodeLootFilterCode(longest);
    expect(code.length).toBeLessThan(LOOT_FILTER_CODE_MAX_LENGTH);
    expect(decodeLootFilterCode(code)).toEqual({ ok: true, rules: longest });
  });

  it('encodes "no filter" as the empty rules', () => {
    const decoded = decodeLootFilterCode(encodeLootFilterCode(null));
    expect(decoded).toEqual({
      ok: true,
      rules: {
        action: 'salvage',
        belowRarity: null,
        wantedAffixes: [],
        wantedEffects: [],
        include: [],
      },
    });
  });

  it('refuses other versions without guessing', () => {
    const code = encodeLootFilterCode(sample);
    expect(decodeLootFilterCode(code.replace(/^wf1/, 'wf2'))).toEqual({
      ok: false,
      error: 'version',
    });
    expect(decodeLootFilterCode(code.replace(/^wf1/, 'wf0'))).toMatchObject({ error: 'version' });
  });

  it('refuses a changed or mistyped code', () => {
    const code = encodeLootFilterCode(sample);
    const [v, body, check] = code.split('.') as [string, string, string];
    const flipped = body.slice(0, 5) + (body[5] === 'A' ? 'B' : 'A') + body.slice(6);
    expect(decodeLootFilterCode(`${v}.${flipped}.${check}`)).toMatchObject({ error: 'checksum' });
    expect(decodeLootFilterCode(`${v}.${body}.zzzz`)).toMatchObject({ error: 'checksum' });
  });

  it('refuses malformed and hostile input', () => {
    const bad: unknown[] = [
      undefined,
      null,
      42,
      {},
      ['wf1'],
      '',
      '   ',
      'hello',
      'wf1',
      'wf1..',
      'wf1.abc',
      'wf1.a.b.c',
      'wf1.<script>.1',
      'wf1.YQ==.1',
      `wf1.${'A'.repeat(LOOT_FILTER_CODE_MAX_LENGTH)}.1`,
      'WF1.abc.def',
      'wf99999.abc.def',
    ];
    for (const input of bad) {
      const r = decodeLootFilterCode(input);
      expect(r.ok, String(input)).toBe(false);
    }
  });

  it('refuses forged payloads with a valid checksum', () => {
    const cases: [string, string][] = [
      ['s|rare|||', 'ok'],
      ['x|rare|||', 'malformed'],
      ['s|rare||', 'malformed'],
      ['s|rare||||', 'malformed'],
      ['s|godly|||', 'invalid'],
      ['s||no-such-affix||', 'invalid'],
      ['s|||no-such-effect|', 'invalid'],
      [`s||${LOOT_FILTER_AFFIX_IDS[0]},${LOOT_FILTER_AFFIX_IDS[0]}||`, 'malformed'],
      ['s|||| ', 'malformed'],
      ['s||||ll', 'malformed'],
      ['s||||x', 'malformed'],
      ['s||Physical||', 'malformed'],
      ['s||a b||', 'malformed'],
      ['s||__proto__||', 'malformed'],
      [`s||${LOOT_FILTER_AFFIX_IDS.concat(LOOT_FILTER_AFFIX_IDS).join(',')}||`, 'invalid'],
    ];
    for (const [payload, want] of cases) {
      const r = decodeLootFilterCode(forge(payload));
      if (want === 'ok') expect(r.ok, payload).toBe(true);
      else expect(r, payload).toMatchObject({ ok: false, error: want });
    }
    // Over the list cap (the parser's own limit), even with known ids.
    const many = Array.from({ length: LOOT_FILTER_MAX_WANTED + 1 }, (_, i) => `a${i}`).join(',');
    expect(decodeLootFilterCode(forge(`s||${many}||`))).toMatchObject({ ok: false });
  });

  it('trims and checks preset names', () => {
    expect(normalisePresetName('  Crypt   run ')).toBe('Crypt run');
    expect(normalisePresetName('')).toBeNull();
    expect(normalisePresetName('   ')).toBeNull();
    expect(normalisePresetName('x'.repeat(25))).toBeNull();
    expect(normalisePresetName('x'.repeat(24))).toBe('x'.repeat(24));
    expect(normalisePresetName('a‮b')).toBeNull();
    expect(normalisePresetName(7)).toBeNull();
  });
});
