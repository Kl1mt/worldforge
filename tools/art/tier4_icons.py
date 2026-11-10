#!/usr/bin/env python3
"""Art ticket A.15: clean the ten tier-4 item icon picks and copy them into the web assets.

Usage (from the repo root): python3 tools/art/tier4_icons.py

Reads the raw picks from art/source/pixellab/icons-tier4-01/, writes each edit next to the raw
file (edits/NN-clean.png) and copies it to apps/web/public/assets/items/<name>.png. Spends no
generations.

The cleanup, the same for every icon so the ten share one lighting:
- alpha is snapped to 0/255 (the raw picks already are) and fully transparent pixels get RGB 0;
- ember highlights (warm, saturated pixels) brighter than EMBER_CEIL are compressed towards it,
  so no icon's ember outshines the others (the raw flames peak between 0.85 and 0.99 value)
  and orange stays an accent next to the Legendary frame. Hue, outline and greys are untouched.
"""

import colorsys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "art/source/pixellab/icons-tier4-01"
EDITS = RAW / "edits"
ITEMS = ROOT / "apps/web/public/assets/items"

# Asset name (manifest `item.<name>`, game-core base `icon`) → raw variant.
PICKS = {
    "cinderforged-blade": "03",
    "emberheart-scepter": "10",
    "slagbone-bow": "18",
    "obsidian-bulwark": "21",
    "revenant-visage": "24",
    "ashplate-hauberk": "35",
    "slagiron-gauntlets": "41",
    "cinderstride-greaves": "44",
    "ember-reliquary": "48",
    "wispfire-band": "53",
}

EMBER_CEIL = 0.86  # value above which an ember highlight is compressed
EMBER_KEEP = 0.35  # share of the excess kept, so flame cores stay the hottest pixel


def is_ember(h: float, s: float, v: float) -> bool:
    return (h < 0.13 or h > 0.95) and s > 0.45 and v > 0.3


def clean(img: Image.Image) -> Image.Image:
    out = Image.new("RGBA", img.size)
    px = []
    for r, g, b, a in img.convert("RGBA").get_flattened_data():
        if a < 128:
            px.append((0, 0, 0, 0))
            continue
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        if is_ember(h, s, v) and v > EMBER_CEIL:
            v = EMBER_CEIL + (v - EMBER_CEIL) * EMBER_KEEP
            r, g, b = (round(c * 255) for c in colorsys.hsv_to_rgb(h, s, v))
        px.append((r, g, b, 255))
    out.putdata(px)
    return out


def main() -> None:
    EDITS.mkdir(exist_ok=True)
    for name, n in PICKS.items():
        img = clean(Image.open(RAW / f"{n}.png"))
        assert img.size == (32, 32), name
        img.save(EDITS / f"{n}-clean.png", optimize=True)
        img.save(ITEMS / f"{name}.png", optimize=True)
        print(f"{name}: {n} -> edits/{n}-clean.png")


if __name__ == "__main__":
    main()
