#!/usr/bin/env python3
"""Art ticket A.17: clean the ten tier-5 item icon picks and copy them into the web assets.

Usage (from the repo root): python3 tools/art/tier5_icons.py

Reads the raw picks from art/source/pixellab/icons-tier5-01/, writes each edit next to the raw
file (edits/NN-clean.png) and copies it to apps/web/public/assets/items/<name>.png. Spends no
generations.

The cleanup: alpha is snapped to 0/255 (the raw picks already are) and fully transparent pixels
get RGB 0. Colours are untouched: the ten picks already share one lighting (highlights peak at
0.93-1.00 value on the bone, the cold accents are small), unlike tier 4's embers.
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "art/source/pixellab/icons-tier5-01"
EDITS = RAW / "edits"
ITEMS = ROOT / "apps/web/public/assets/items"

# Asset name (manifest `item.<name>`, game-core base `icon`, ticket 8.1) -> raw variant.
PICKS = {
    "hollowsteel-greatblade": "00",
    "pale-choir-stave": "17",
    "reachstalker-longbow": "19",
    "hollow-aegis": "44",
    "hollowknight-helm": "32",
    "titanhusk-cuirass": "36",
    "palebone-gauntlets": "40",
    "reachwalker-sabatons": "41",
    "requiem-locket": "48",
    "hollow-signet": "53",
}


def clean(img: Image.Image) -> Image.Image:
    out = Image.new("RGBA", img.size)
    out.putdata(
        [(0, 0, 0, 0) if a < 128 else (r, g, b, 255) for r, g, b, a in img.convert("RGBA").get_flattened_data()]
    )
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
