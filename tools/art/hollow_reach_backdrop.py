#!/usr/bin/env python3
"""Art ticket A.17: dim the Hollow Reach backdrop to the other areas' value range.

Usage (from the repo root): python3 tools/art/hollow_reach_backdrop.py

The raw pick (area-hollow-reach-01/00.png) averages luma 124 where every other backdrop sits at
34-59, so pale foes vanished on it and it glared next to the dark UI. Each colour's HSV value is
mapped through VALUE_SCALE * v ** VALUE_GAMMA (hue and saturation kept, one colour in -> one
colour out, so the palette size is unchanged); the bone-pale look stays, the sky stays its
brightest part. Writes edits/00-dimmed.png next to the raw file and copies it to the assets.
Spends no generations.
"""

import colorsys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "art/source/pixellab/area-hollow-reach-01"
OUT = ROOT / "apps/web/public/assets/areas/hollow-reach.png"
VALUE_SCALE = 0.85
VALUE_GAMMA = 1.6


def dim(rgb: tuple[int, int, int]) -> tuple[int, int, int]:
    h, s, v = colorsys.rgb_to_hsv(*(c / 255 for c in rgb))
    r, g, b = colorsys.hsv_to_rgb(h, s, VALUE_SCALE * v**VALUE_GAMMA)
    return round(r * 255), round(g * 255), round(b * 255)


def main() -> None:
    img = Image.open(RAW / "00.png").convert("RGB")
    out = Image.new("RGB", img.size)
    out.putdata([dim(p) for p in img.get_flattened_data()])
    (RAW / "edits").mkdir(exist_ok=True)
    out.save(RAW / "edits/00-dimmed.png", optimize=True)
    out.save(OUT, optimize=True)
    print(OUT.relative_to(ROOT))


if __name__ == "__main__":
    main()
