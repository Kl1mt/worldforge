#!/usr/bin/env python3
"""Art ticket A.18: clean the 48 skill icon picks, copy them into the web assets, build the sheet.

Usage (from the repo root): python3 tools/art/skill_icons.py

Reads the raw picks from art/source/pixellab/icons-skills-<class>-01/, writes each edit next to
the raw file (edits/NN-clean.png), copies it to apps/web/public/assets/skills/<kebab-id>.png and
rebuilds art/preview-skill-icons.png. Spends no generations.

The cleanup, the same for every icon (A.15's, so the skills share the item icons' lighting):
- alpha is snapped to 0/255 and fully transparent pixels get RGB 0;
- ember highlights (warm, saturated pixels) brighter than EMBER_CEIL are compressed towards it,
  so the Mage's fire doesn't outshine the rest of the set. Hue, outline and greys are untouched.

The skill ids are game-core's (`ACTIVE_SKILLS`, `PASSIVE_SKILLS`, `docs/SKILLS.md`); the web app
finds an icon by `skill.<kebab-id>` (`skillIcon` in apps/web/src/content/assets.ts).
"""

import colorsys
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "art/source/pixellab"
SKILLS = ROOT / "apps/web/public/assets/skills"
SHEET = ROOT / "art/preview-skill-icons.png"

# Per class, in docs/SKILLS.md order: six actives by level, the Tyrant's active, four passives by
# level, the Sovereign's passive. Skill id → raw variant of icons-skills-<class>-01.
PICKS: dict[str, dict[str, str]] = {
    "warrior": {
        "heavyStrike": "04",
        "shieldSlam": "11",
        "charge": "20",
        "rend": "25",
        "execute": "33",
        "earthsplitter": "30",
        "forgebreaker": "42",
        "unyielding": "49",
        "berserker": "53",
        "battleRhythm": "56",
        "juggernaut": "59",
        "hollowWrath": "62",
    },
    "mage": {
        "firebolt": "02",
        "arcaneBolt": "08",
        "pyroblast": "04",
        "scorch": "07",
        "shatter": "34",
        "meteor": "17",
        "emberstorm": "25",
        "manaWell": "56",
        "arcanePower": "41",
        "manaShield": "51",
        "deepReserves": "50",
        "kindling": "59",
    },
    "hunter": {
        "aimedShot": "08",
        "quickShot": "09",
        "firstBlood": "39",
        "serratedArrow": "11",
        "killShot": "12",
        "volley": "13",
        "trueShot": "14",
        "steadyAim": "32",
        "predator": "33",
        "skirmisher": "16",
        "eagleEye": "34",
        "hollowMark": "44",
    },
    "warlock": {
        "shadowBolt": "05",
        "corruption": "12",
        "soulBurn": "16",
        "agony": "26",
        "drainSoul": "28",
        "doom": "33",
        "soulHarvest": "37",
        "darkPact": "42",
        "malice": "53",
        "demonSkin": "30",
        "soulSiphon": "58",
        "hollowCovenant": "59",
    },
}

EMBER_CEIL = 0.86  # value above which an ember highlight is compressed (A.15)
EMBER_KEEP = 0.35  # share of the excess kept, so flame cores stay the hottest pixel


def kebab(skill_id: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "-", skill_id).lower()


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


GROUND = (36, 31, 27, 255)  # the UI's panel ground
CELL_GROUND = (46, 40, 35, 255)
INK = (200, 184, 150, 255)
DIM = (140, 128, 110, 255)


def sheet(icons: dict[str, list[tuple[str, Image.Image]]]) -> Image.Image:
    """Per class: the twelve icons at x2 over their names, then the same row at x1."""
    font = ImageFont.load_default()
    cell, pad, label = 32 * 2 + 12, 8, 14
    cols = 12
    row_h = 18 + cell + label + 32 + 10
    ref = [
        Image.open(ROOT / "apps/web/public/assets/items" / f"{n}.png").convert("RGBA")
        for n in ("longsword", "skull-staff", "hunting-bow", "raven-talisman")
    ] + [
        Image.open(ROOT / "apps/web/public/assets/achievements" / f"{n}.png").convert("RGBA")
        for n in ("first-legendary", "crypt-tier-3")
    ]
    width = pad * 2 + cols * cell
    height = pad + row_h * len(icons) + 18 + cell + pad
    img = Image.new("RGBA", (width, height), GROUND)
    d = ImageDraw.Draw(img)
    y = pad
    for cls, row in icons.items():
        d.text((pad, y), f"{cls.capitalize()}: six actives, the Tyrant's, four passives, the Sovereign's", fill=INK, font=font)
        y += 18
        for i, (skill_id, icon) in enumerate(row):
            x = pad + i * cell
            d.rectangle([x, y, x + cell - 4, y + cell - 4], fill=CELL_GROUND)
            big = icon.resize((64, 64), Image.NEAREST)
            img.alpha_composite(big, (x + (cell - 4 - 64) // 2, y + (cell - 4 - 64) // 2))
            d.text((x, y + cell), kebab(skill_id)[:12], fill=DIM, font=font)
            img.alpha_composite(icon, (x + (cell - 4 - 32) // 2, y + cell + label))
        y += row_h - 18
    d.text((pad, y), "Reference (x2): item icons and achievement icons", fill=INK, font=font)
    y += 18
    for i, icon in enumerate(ref):
        x = pad + i * cell
        d.rectangle([x, y, x + cell - 4, y + cell - 4], fill=CELL_GROUND)
        img.alpha_composite(icon.resize((64, 64), Image.NEAREST), (x + (cell - 4 - 64) // 2, y + (cell - 4 - 64) // 2))
    return img


def main() -> None:
    SKILLS.mkdir(parents=True, exist_ok=True)
    rows: dict[str, list[tuple[str, Image.Image]]] = {}
    for cls, picks in PICKS.items():
        raw = RAW / f"icons-skills-{cls}-01"
        edits = raw / "edits"
        edits.mkdir(exist_ok=True)
        rows[cls] = []
        for skill_id, n in picks.items():
            icon = clean(Image.open(raw / f"{n}.png"))
            assert icon.size == (32, 32), skill_id
            icon.save(edits / f"{n}-clean.png", optimize=True)
            icon.save(SKILLS / f"{kebab(skill_id)}.png", optimize=True)
            rows[cls].append((skill_id, icon))
            print(f"{cls} {skill_id}: {n} -> skills/{kebab(skill_id)}.png")
    sheet(rows).convert("RGB").save(SHEET, optimize=True)
    print(f"sheet -> {SHEET.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
