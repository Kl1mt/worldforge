#!/usr/bin/env python3
"""Art ticket A.19: Shrine-only banner and crest styles, palette variants of A.13's art.

Usage (from the repo root): python3 tools/art/shrine_variants.py

No generations. Each variant recolours an existing style pixel by pixel by role (within a role, one
colour in, one colour out), so the drawing, the outline and the shading ramp are A.13's; only hue and
saturation change, and each colour keeps its luma (times a factor), the method of
`hero_palettes.py`. Unlike the CSS-tinted styles (6.11, 8.3, 8.4) these are real files, so they
resolve by id like any style and look the same everywhere (the book, the profile, the portrait's
device, the contact sheet).

Roles: the near-black outline (HSV value < 0.06) is always kept. Banners: the cloth (the slate
greys of the hanging cloth) and the device (everything else lighter than value 0.2 below the
crossbar); the crossbar and its finials (rows above the cloth) keep A.13's iron and brass.
Crests: the band and the bright plates and bolts (value >= 0.45; the votive iron turns them to candle brass).

The two hero appearances that go with them (`wisplight`, `votive`) are palettes in
`hero_palettes.py`.
"""

from __future__ import annotations

import colorsys
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hero_palettes import at_luma, lerp, luma  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "apps/web/public/assets"
# A.13's banners hang from a crossbar in rows 6-9; the cloth starts below it.
CLOTH_TOP = 10

# (hue in shadow, hue in light, saturation in shadow, in light, luma factor), as in hero_palettes.
# The Shrine's veils: A.13's slate cloth lifted to a warm ash grey, like linen gone grey with smoke.
VEIL_CLOTH = (28, 34, 0.10, 0.07, 1.9)
# The Shrine's offering candles: a flame in candle gold.
CANDLE_GOLD = (32, 46, 0.62, 0.40, 1.08)
# Ash: iron gone pale and warm grey under a dusting of ash; the plates and bolts candle brass.
ASH_BAND = (30, 36, 0.07, 0.04, 1.6)
CANDLE_BRASS = (34, 44, 0.56, 0.42, 1.0)

# Ticket 9.5's ids (the Shrine's pool) -> (source file, kind, {role: theme})
VARIANTS = {
    "banner.votive-veil": ("banners/warden-flame.png", "banner", {"cloth": VEIL_CLOTH, "device": CANDLE_GOLD}),
    "crest.votive-ash": ("crests/crest-iron.png", "crest", {"band": ASH_BAND, "plate": CANDLE_BRASS}),
}


def hsv(c):
    h, s, v = colorsys.rgb_to_hsv(*(x / 255 for x in c))
    return h * 360, s, v


def themed(theme, c):
    h0, h1, s0, s1, k = theme
    L = luma(c)
    t = min(1.0, L / 0.75)
    return at_luma(lerp(h0, h1, t), lerp(s0, s1, t), min(0.97, L * k))


def role(kind: str, c, y: int) -> str | None:
    h, s, v = hsv(c)
    if v < 0.06:
        return None
    if kind == "banner":
        if y < CLOTH_TOP:
            return None
        # The cloth is A.13's slate: cool, dark, nearly grey.
        if v <= 0.2 and (s < 0.2 or 120 <= h <= 250):
            return "cloth"
        return "device"
    return "plate" if v >= 0.45 else "band"


def variant(src: Image.Image, kind: str, themes) -> Image.Image:
    img = src.convert("RGBA")
    out = img.copy()
    px, opx = img.load(), out.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            if not a:
                continue
            ro = role(kind, (r, g, b), y)
            if ro:
                opx[x, y] = (*themed(themes[ro], (r, g, b)), a)
    return out


def main() -> None:
    for vid, (src, kind, themes) in VARIANTS.items():
        img = variant(Image.open(ASSETS / src), kind, themes)
        name = vid.split(".", 1)[1]
        dest = ASSETS / ("banners" if kind == "banner" else "crests") / (name if kind == "banner" else f"crest-{name}")
        dest = dest.with_suffix(".png")
        img.save(dest, optimize=True)
        print(f"{vid}: {src} -> {dest.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
