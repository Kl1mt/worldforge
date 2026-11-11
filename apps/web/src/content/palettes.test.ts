import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { CLASS_IDS } from '@worldforge/game-core';
import { classAttackSheet, classPortrait } from './assets';
import {
  APPEARANCE_IDS,
  HERO_KEPT_COLOURS,
  HERO_PALETTE_IDS,
  HERO_PALETTE_SWAPS,
  heroPaletteSwaps,
  recolourPixels,
} from './palettes';

/** Minimal decoder for the art's PNGs: 8-bit RGBA, not interlaced (asserted). */
function decodePng(path: string): { width: number; height: number; data: Uint8Array } {
  const buf = readFileSync(new URL(`../../public${path}`, import.meta.url));
  let off = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      expect([body[8], body[9], body[12]], `${path}: 8-bit RGBA, no interlace`).toEqual([8, 6, 0]);
    } else if (type === 'IDAT') idat.push(body);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? data[y * stride + x - 4]! : 0;
      const b = y > 0 ? data[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? data[(y - 1) * stride + x - 4]! : 0;
      let v = line[x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      data[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, data };
}

const hex = (d: Uint8Array, i: number) =>
  `#${[d[i]!, d[i + 1]!, d[i + 2]!].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

function opaqueColours(data: Uint8Array): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < data.length; i += 4) if (data[i + 3]) out.add(hex(data, i));
  return out;
}

describe('hero appearance palettes (A.13)', () => {
  // The ids ticket 6.8's collection book stores: keep them stable.
  it('keeps the collection book ids', () => {
    expect(APPEARANCE_IDS).toEqual([
      'appearance.default',
      'appearance.ashen',
      'appearance.ember',
      'appearance.grave-moss',
      'appearance.midnight',
    ]);
  });

  it('resolves every look for every class; the default and unknown ids change nothing', () => {
    for (const cls of CLASS_IDS) {
      expect(heroPaletteSwaps('appearance.default', cls)).toBeNull();
      expect(heroPaletteSwaps('appearance.unknown', cls)).toBeNull();
      expect(heroPaletteSwaps('ashen', cls)).toBeNull();
      for (const id of HERO_PALETTE_IDS) {
        expect(heroPaletteSwaps(`appearance.${id}`, cls)?.length, `${id} ${cls}`).toBeGreaterThan(
          0,
        );
      }
    }
  });

  for (const cls of CLASS_IDS) {
    const sheets = [classPortrait(cls), classAttackSheet(cls)!];
    const colours = new Set(sheets.flatMap((s) => [...opaqueColours(decodePng(s.path).data)]));

    it(`maps every colour of the ${cls}'s portrait and attack sheet, except the kept ones`, () => {
      const kept = new Set(HERO_KEPT_COLOURS[cls]);
      for (const id of HERO_PALETTE_IDS) {
        const sources = HERO_PALETTE_SWAPS[id][cls].map(([from]) => from);
        expect(new Set(sources).size, `${id}: one swap per colour`).toBe(sources.length);
        const unmapped = [...colours].filter((c) => !kept.has(c) && !sources.includes(c));
        expect(unmapped, `${id} ${cls}`).toEqual([]);
        // Nothing stale: every source and every kept colour is really in the art.
        for (const c of [...sources, ...kept]) expect(colours.has(c), `${id} ${c}`).toBe(true);
        for (const c of sources) expect(kept.has(c), `${c} both kept and swapped`).toBe(false);
      }
    });
  }

  it('recolours exactly the mapped opaque pixels and keeps alpha', () => {
    const px = new Uint8ClampedArray([
      ...[0x12, 0x34, 0x56, 255],
      ...[0x12, 0x34, 0x56, 0],
      ...[1, 2, 3, 255],
    ]);
    const out = recolourPixels(px, [['#123456', '#abcdef']]);
    expect([...out]).toEqual([0xab, 0xcd, 0xef, 255, 0x12, 0x34, 0x56, 0, 1, 2, 3, 255]);
    expect(px[0]).toBe(0x12); // pure: the input is untouched
  });

  it('turns a real sheet into one with no source colour left', () => {
    const { data } = decodePng(classAttackSheet('warrior')!.path);
    const swaps = heroPaletteSwaps('appearance.ember', 'warrior')!;
    const out = opaqueColours(recolourPixels(data, swaps) as unknown as Uint8Array);
    const targets = new Set(swaps.map(([, to]) => to));
    for (const [from] of swaps) if (!targets.has(from)) expect(out.has(from), from).toBe(false);
  });
});
