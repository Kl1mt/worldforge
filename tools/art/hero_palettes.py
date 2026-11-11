#!/usr/bin/env python3
"""Hero appearance palettes (ticket A.13): extract each class sprite's palette and design the
four themed swaps. No generations: this is palette work.

Every class portrait and its attack sheet share one palette (A.14 snapped the frames to the
portrait's colours), so one substitution list per class covers the still, the code idle and the
8 attack frames. Each colour gets a *role* (outline, kept, cloth, metal, leather, accent); a theme
maps a role to a hue and saturation and keeps the source colour's luma (times a factor), so
outlines, shading ramps and value contrast survive the swap.

  python3 tools/art/hero_palettes.py            # print the TS data block for palettes.ts
  python3 tools/art/hero_palettes.py --write    # rewrite the block in apps/web/src/content/palettes.ts
                                                # (then `pnpm format`)
  python3 tools/art/preview_cosmetics.py        # the contact sheet, art/preview-cosmetics.png
"""

from __future__ import annotations

import colorsys
import re
import sys
from collections import Counter
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
CHARS = ROOT / "apps/web/public/assets/characters"
TS = ROOT / "apps/web/src/content/palettes.ts"
CLASSES = ["warrior", "mage", "hunter", "warlock"]
PALETTES = ["ashen", "ember", "grave-moss", "midnight"]

# Colours deliberately left alone besides the near-black outline: faces and hands (skin), and the
# warlock's bone mask and skull, so every look is still the same hero.
KEPT = {
    "warrior": [],
    "mage": ["968b82", "6e6157"],
    "hunter": ["ab8973", "7d6445"],
    "warlock": ["d4c8a6", "bdb6a4", "fefdfe"],
}
# Small glints that carry the class's magic or edge: themed as accents.
ACCENTS = {
    "warrior": ["d7d5cf"],  # the blade's edge
    "mage": ["68819b", "809bab", "97adbd", "d7d5cf"],  # the staff's crystal
    "hunter": ["dfdedc", "cacac4"],  # fletching and buckles
    "warlock": ["7e7186", "8f8196", "a299a7"],  # the book's witchlight
}
# The class's signature cloth by hue (degrees, half-open ranges), saturation >= 0.12.
CLOTH_HUES = {
    "warrior": [(290, 360), (0, 12)],
    "mage": [(170, 250)],
    "hunter": [(60, 170)],
    "warlock": [(250, 335)],
}

LUMA = (0.299, 0.587, 0.114)


def hexrgb(h: str) -> tuple[int, int, int]:
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def luma(c) -> float:
    return sum(w * v for w, v in zip(LUMA, c)) / 255


def hsv(c):
    h, s, v = colorsys.rgb_to_hsv(*(x / 255 for x in c))
    return h * 360, s, v


def role(cls: str, c: tuple[int, int, int]) -> str:
    hx = "%02x%02x%02x" % c
    h, s, v = hsv(c)
    if v < 0.06:
        return "outline"
    if hx in KEPT[cls]:
        return "kept"
    if hx in ACCENTS[cls]:
        return "accent"
    if s >= 0.12 and any(a <= h < b for a, b in CLOTH_HUES[cls]):
        return "cloth"
    if s < 0.12:
        return "metal"
    return "leather"


def at_luma(h: float, s: float, target: float) -> tuple[int, int, int]:
    """The colour of hue h and saturation s whose luma is `target` (0..1), clipping toward white."""
    r, g, b = colorsys.hsv_to_rgb((h % 360) / 360, s, 1.0)
    base = luma((r * 255, g * 255, b * 255))
    k = target / base if base else 0
    rgb = [x * k for x in (r, g, b)]
    if max(rgb) > 1:  # too bright for this hue: fill toward white at the same luma
        over = target
        rgb = [min(1.0, x) for x in rgb]
        cur = luma([x * 255 for x in rgb])
        if cur < over:
            t = (over - cur) / (1 - cur)
            rgb = [x + (1 - x) * t for x in rgb]
    return tuple(max(0, min(255, round(x * 255))) for x in rgb)  # type: ignore[return-value]


def lerp(a, b, t):
    return a + (b - a) * t


# A theme: per role, (hue in shadow, hue in light, saturation in shadow, in light, luma factor).
# Hues shift along the ramp (cool or red shadows, warm highlights) like hand-drawn pixel art.
THEMES = {
    # Greyed steel and soot: cloth goes to soot, metal to cold grey steel.
    "ashen": {
        "cloth": (30, 35, 0.10, 0.05, 0.80),
        "metal": (215, 205, 0.06, 0.03, 1.00),
        "leather": (25, 30, 0.12, 0.08, 0.85),
        "accent": (40, 40, 0.04, 0.02, 1.05),
    },
    # Blackened iron with orange accents: dark iron, ember-orange cloth, hot glints.
    "ember": {
        "cloth": (4, 20, 0.60, 0.55, 0.80),
        "metal": (12, 22, 0.16, 0.32, 0.72),
        "leather": (10, 20, 0.30, 0.30, 0.70),
        "accent": (24, 38, 0.80, 0.70, 1.00),
    },
    # Green-bronze and lichen.
    "grave-moss": {
        "cloth": (110, 75, 0.35, 0.30, 0.95),
        "metal": (95, 52, 0.32, 0.30, 0.95),
        "leather": (60, 45, 0.30, 0.28, 0.85),
        "accent": (95, 80, 0.25, 0.18, 1.05),
    },
    # Deep blue-black with silver trim: darker cloth, metal lifted toward silver in the light.
    "midnight": {
        "cloth": (232, 220, 0.55, 0.40, 0.72),
        "metal": (222, 210, 0.14, 0.05, 1.00),
        "leather": (235, 225, 0.30, 0.20, 0.65),
        "accent": (205, 210, 0.10, 0.04, 1.15),
    },
}
# Midnight's silver trim: the bright half of the metal ramp is lifted, the dark half pressed down.
SILVER = {"midnight": (0.40, 0.85, 1.20)}


def themed(theme: str, r: str, c: tuple[int, int, int]) -> tuple[int, int, int]:
    h0, h1, s0, s1, k = THEMES[theme][r]
    L = luma(c)
    t = min(1.0, L / 0.75)
    if theme in SILVER and r == "metal":
        cut, lo, hi = SILVER[theme]
        k = lo if L < cut else hi
    target = min(0.97, L * k)
    return at_luma(lerp(h0, h1, t), lerp(s0, s1, t), target)


def class_colours(cls: str) -> list[tuple[int, int, int]]:
    cols: Counter = Counter()
    for f in (f"{cls}.png", f"{cls}-attack.png"):
        im = Image.open(CHARS / f).convert("RGBA")
        cols.update(p[:3] for p in im.get_flattened_data() if p[3])
    return sorted(cols, key=lambda c: (luma(c), c))


def build():
    data: dict[str, dict[str, list]] = {p: {} for p in PALETTES}
    kept: dict[str, list] = {}
    for cls in CLASSES:
        cols = class_colours(cls)
        kept[cls] = [c for c in cols if role(cls, c) in ("outline", "kept")]
        for p in PALETTES:
            data[p][cls] = [(c, themed(p, role(cls, c), c)) for c in cols if role(cls, c) not in ("outline", "kept")]
    return data, kept


def hx(c) -> str:
    return "#%02x%02x%02x" % tuple(c)


def ts_block(data, kept) -> str:
    out = ["// <generated by tools/art/hero_palettes.py: do not edit by hand>"]
    out.append("export const HERO_PALETTE_SWAPS: Readonly<")
    out.append("  Record<HeroPaletteId, Readonly<Record<ClassId, readonly ColourSwap[]>>>")
    out.append("> = {")
    for p in PALETTES:
        out.append(f"  '{p}': {{")
        for cls in CLASSES:
            out.append(f"    {cls}: [")
            for a, b in data[p][cls]:
                out.append(f"      ['{hx(a)}', '{hx(b)}'],")
            out.append("    ],")
        out.append("  },")
    out.append("};")
    out.append("")
    out.append("/** Colours every palette leaves alone on purpose: the near-black outline, skin and bone. */")
    out.append("export const HERO_KEPT_COLOURS: Readonly<Record<ClassId, readonly string[]>> = {")
    for cls in CLASSES:
        out.append(f"  {cls}: [")
        for c in kept[cls]:
            out.append(f"    '{hx(c)}',")
        out.append("  ],")
    out.append("};")
    out.append("// </generated>")
    return "\n".join(out)


def recolour(im: Image.Image, swaps) -> Image.Image:
    m = {a: b for a, b in swaps}
    im = im.convert("RGBA")
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if a and (r, g, b) in m:
                px[x, y] = (*m[(r, g, b)], a)
    return im



def main():
    data, kept = build()
    block = ts_block(data, kept)
    if "--write" in sys.argv:
        src = TS.read_text()
        new = re.sub(
            r"// <generated by tools/art/hero_palettes\.py.*?// </generated>",
            lambda _m: block,
            src,
            flags=re.S,
        )
        TS.write_text(new)
        print(f"wrote {TS.relative_to(ROOT)}")
    if len(sys.argv) == 1:
        print(block)
    for cls in CLASSES:
        n = len(class_colours(cls))
        roles = Counter(role(cls, c) for c in class_colours(cls))
        merged = {p: len(data[p][cls]) - len({b for _, b in data[p][cls]}) for p in PALETTES}
        print(f"# {cls}: {n} colours {dict(roles)} merged={merged}", file=sys.stderr)


if __name__ == "__main__":
    main()
