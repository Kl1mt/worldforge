#!/usr/bin/env python3
"""Contact sheet for the cosmetic art (ticket A.13): art/preview-cosmetics.png.

1. Each class in all five looks (appearance.default + the four palettes of
   apps/web/src/content/palettes.ts, via tools/art/hero_palettes.py) at x2: the still and attack
   frame 4.
2. The six banner styles at x4 and x1.
3. The four crest styles around two sample guild crests (anvil on ash, crown on crimson) at x1
   (md) and x2, the crest emulating social/crest.css.
4. The Forgeward builder deed at x4 next to A.8's anvil deed.

  python3 tools/art/preview_cosmetics.py
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
import hero_palettes as hp  # noqa: E402

ROOT = hp.ROOT
A = ROOT / "apps/web/public/assets"
OUT = ROOT / "art/preview-cosmetics.png"
BG = (30, 27, 24, 255)
INK = (200, 184, 150)
BANNERS = ["harvest-sheaf", "forgeward", "crypt-seal", "season-laurel", "warden-flame", "ember-standard"]
CRESTS = ["iron", "gilt", "bone", "ember"]
SAMPLES = [("anvil", (0x5D, 0x56, 0x50)), ("crown", (0x3F, 0x17, 0x1F))]

try:
    FONT = ImageFont.load_default(size=14)
except TypeError:
    FONT = ImageFont.load_default()


def up(im: Image.Image, s: int) -> Image.Image:
    return im.resize((im.width * s, im.height * s), Image.NEAREST)


def crest(emblem: str, dye, s: int) -> Image.Image:
    """The md guild crest (40 px wide, 1.18x tall) as social/crest.css draws it, at x s."""
    w = 40 * s
    h = round(w * 1.18)
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)

    def poly(i):
        return [(i, i), (w - 1 - i, i), (w - 1 - i, 0.58 * h), (w / 2, h - 1 - i), (i, 0.58 * h)]

    d.polygon(poly(0), fill=(160, 128, 80, 255))
    d.polygon(poly(2), fill=(*dye, 255))
    ch = up(Image.open(A / f"guild-emblems/{emblem}.png").convert("RGBA"), s)
    im.alpha_composite(ch, ((w - ch.width) // 2, int((h - ch.height) / 2 - w * 0.12)))
    return im


def framed(emblem, dye, style, s) -> Image.Image:
    fr = Image.open(A / f"crests/crest-{style}.png").convert("RGBA")
    out = Image.new("RGBA", (fr.width * s, fr.height * s), (0, 0, 0, 0))
    out.alpha_composite(crest(emblem, dye, s), (4 * s, 4 * s))
    out.alpha_composite(up(fr, s), (0, 0))
    return out


def main():
    data, _ = hp.build()
    looks = ["default", *hp.PALETTES]
    pad, lab = 12, 20
    cell = 256
    W = pad + len(looks) * (2 * cell + 2 * pad)
    hero_h = lab + len(hp.CLASSES) * (cell + lab)
    H = hero_h + 3 * (lab + 2 * pad) + 32 * 4 + 56 * 2 * 2 + 32 * 4 + 4 * pad
    sheet = Image.new("RGBA", (W, H), BG)
    d = ImageDraw.Draw(sheet)

    for i, look in enumerate(looks):
        d.text((pad + i * (2 * cell + 2 * pad), 4), f"appearance.{look} (still | attack frame 4)", fill=INK, font=FONT)
    for r, cls in enumerate(hp.CLASSES):
        y = lab + r * (cell + lab)
        d.text((pad, y), cls, fill=INK, font=FONT)
        still = Image.open(hp.CHARS / f"{cls}.png").convert("RGBA")
        attack = Image.open(hp.CHARS / f"{cls}-attack.png").convert("RGBA").crop((512, 0, 640, 128))
        for i, look in enumerate(looks):
            swaps = [] if look == "default" else data[look][cls]
            for j, src in enumerate((still, attack)):
                sheet.alpha_composite(up(hp.recolour(src.copy(), swaps), 2), (pad + i * (2 * cell + 2 * pad) + j * cell, y + 4))

    y = hero_h + pad
    d.text((pad, y), "banner.<id> at x4 and x1", fill=INK, font=FONT)
    y += lab
    x = pad
    for b in BANNERS:
        im = Image.open(A / f"banners/{b}.png").convert("RGBA")
        sheet.alpha_composite(up(im, 4), (x, y))
        sheet.alpha_composite(im, (x + 132, y + 96))
        d.text((x, y + 130), b, fill=INK, font=FONT)
        x += 190
    y += 128 + lab + pad

    d.text((pad, y), "crest.<id> around the anvil and crown crests at x1 (md) and x2", fill=INK, font=FONT)
    y += lab
    x = pad
    for style in CRESTS:
        for emblem, dye in SAMPLES:
            sheet.alpha_composite(framed(emblem, dye, style, 1), (x, y))
            sheet.alpha_composite(framed(emblem, dye, style, 2), (x + 56, y))
            x += 56 + 96 + pad
        d.text((x - 2 * (56 + 96 + pad), y + 114), style, fill=INK, font=FONT)
        x += pad
    y += 112 + lab + pad

    d.text((pad, y), "achievement.forgeward-builder (x4, x1) next to achievement.forge-plus-10", fill=INK, font=FONT)
    y += lab
    icon = Image.open(A / "achievements/forgeward-builder.png").convert("RGBA")
    ref = Image.open(A / "achievements/forge-plus-10.png").convert("RGBA")
    sheet.alpha_composite(up(icon, 4), (pad, y))
    sheet.alpha_composite(icon, (pad + 136, y + 96))
    sheet.alpha_composite(up(ref, 4), (pad + 190, y))
    sheet.convert("RGB").crop((0, 0, W, y + 128 + pad)).save(OUT)
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
