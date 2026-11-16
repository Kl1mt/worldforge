#!/usr/bin/env python3
"""Art ticket A.19: the Summoning Shrine lit, drawn over the hub's cold one.

Usage (from the repo root): python3 tools/art/shrine_lit.py

The hub (`hub.graumark`, A.2) has a small stone shrine with unlit candle stubs at its right edge,
inside the `summoningShrine` hotspot (x 366, y 112, 18 x 34). This script cuts exactly that
rectangle out of the hub and lights it, so the result can be drawn on top of the hub at the
hotspot's position at the hub's own integer scale (`hub.shrine`, 18 x 34, opaque):

- every candle stub and wax speck gets a flame (a pale core, an amber tip above it);
- the stone, the ground and the wood around them catch warm light that falls off with distance
  (value lifted, hue pulled toward amber), fading out before the rectangle's left and bottom
  edges so the cut does not show against the cold hub beside it;
- the slab's carved recess glows a dim violet (restrained violet = magic, GDD 3.3), the summoning.

It spends no generations: a 32 px generation could not match the hub's pixel scale in an
18-pixel-wide cut. Writes edits/shrine-lit.png next to the raw hub and copies it to the assets.
"""

from __future__ import annotations

import colorsys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "art/source/pixellab/hub-graumark-01"
HUB = ROOT / "apps/web/public/assets/hub/graumark.png"
OUT = ROOT / "apps/web/public/assets/hub/shrine-lit.png"

# The manifest's summoningShrine hotspot, in hub pixels.
X, Y, W, H = 366, 112, 18, 34

# Flames in hub pixels: (x, y of the core). The two candles (x 375, 379) and the wax specks on the
# shrine's step, each given a small flame.
FLAMES = [(379, 131), (375, 137), (370, 133), (372, 134), (367, 136)]
CORE = (244, 220, 156)
TIP = (214, 138, 62)
WICK = (232, 176, 96)
# The carved recess in the slab's face (hub pixels), lit violet, brightest in the middle.
# A three-pronged rune (an algiz, "the call") cut into the recess: arms dim, stem bright.
RUNE_ARMS = [(369, 123), (371, 123)]
RUNE_STEM = [(370, 124), (370, 125), (370, 126)]
RUNE_HALO = [(369, 124), (371, 124), (369, 125), (371, 125), (369, 126), (371, 126), (370, 127)]
VIOLET = [(52, 46, 80), (92, 82, 140), (132, 120, 182)]
# Light is drawn in a few steps, so the cut keeps a small palette like the rest of the hub.
STEPS = 3


def luma(c) -> float:
    return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]


def warm(c: tuple[int, int, int], w: float) -> tuple[int, int, int]:
    """Light a colour by `w` (0..1): value up, hue toward amber, a little saturation."""
    h, s, v = colorsys.rgb_to_hsv(*(x / 255 for x in c))
    v2 = min(0.9, v * (1 + 1.5 * w) + 0.08 * w)
    s2 = s + (0.42 - s) * 0.7 * w
    h2 = h + ((30 / 360) - h) * 0.8 * w
    r, g, b = colorsys.hsv_to_rgb(h2, s2, v2)
    return round(r * 255), round(g * 255), round(b * 255)


def light_at(x: int, y: int) -> float:
    w = 0.0
    for i, (fx, fy) in enumerate(FLAMES):
        strength = 1.0 if i < 2 else 0.45
        d2 = (x - fx) ** 2 + ((y - fy) * 1.3) ** 2
        w += strength / (1 + d2 / 9.0)
    # Fade toward the left and bottom edges (the right edge is the hub's own edge, the top is far).
    edge = min(1.0, (x - X) / 4, (Y + H - 1 - y) / 4)
    return max(0.0, min(1.0, w) * max(0.0, edge))


def main() -> None:
    hub = Image.open(HUB).convert("RGB")
    out = hub.crop((X, Y, X + W, Y + H))
    px = out.load()
    for y in range(Y, Y + H):
        for x in range(X, X + W):
            w = light_at(x, y)
            step = round(w * STEPS) / STEPS
            if step > 0:
                px[x - X, y - Y] = warm(px[x - X, y - Y], step)
    for x, y in RUNE_HALO:
        px[x - X, y - Y] = VIOLET[0]
    for x, y in RUNE_ARMS:
        px[x - X, y - Y] = VIOLET[1]
    for x, y in RUNE_STEM:
        px[x - X, y - Y] = VIOLET[2]
    for x, y in FLAMES:
        px[x - X, y - Y] = CORE
        px[x - X, y - 1 - Y] = TIP
        if luma(hub.getpixel((x, y + 1))) < 100:
            px[x - X, y + 1 - Y] = WICK
    (RAW / "edits").mkdir(exist_ok=True)
    out.save(RAW / "edits/shrine-lit.png", optimize=True)
    out.save(OUT, optimize=True)
    print(OUT.relative_to(ROOT), out.size, len(set(out.get_flattened_data())), "colours")


if __name__ == "__main__":
    main()
