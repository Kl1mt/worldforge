#!/usr/bin/env python3
"""Contact sheet for art ticket A.17 (the Hollow Reach: backdrops, enemies, frames, region boss).

Usage (from the repo root): python3 tools/art/preview_hollow_reach.py

Writes art/preview-hollow-reach.png. Only reads curated assets; it spends no generations.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "apps/web/public/assets"
OUT = ROOT / "art/preview-hollow-reach.png"

INK_850 = (27, 21, 18, 255)
LABEL = (200, 186, 160, 255)
BONE_300 = (151, 140, 126, 255)

FONT = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 13)

EXISTING = ["cinder-revenant", "ash-colossus"]  # Cinderwastes enemies, for scale
NEW = ["hollow-knight", "reach-stalker", "pale-choir", "husk-titan"]


def load(rel: str) -> Image.Image:
    return Image.open(ASSETS / rel).convert("RGBA")


def scale(img: Image.Image, n: int) -> Image.Image:
    return img.resize((img.width * n, img.height * n), Image.NEAREST)


def main() -> None:
    pad, gap = 16, 24
    width = pad * 2 + 768 * 2 + gap
    sheet = Image.new("RGBA", (width, 3000), INK_850)
    d = ImageDraw.Draw(sheet)
    yy = pad

    def heading(text: str) -> None:
        nonlocal yy
        d.text((pad, yy), text, font=FONT, fill=LABEL)
        yy += 22

    def enemy_row(n: int) -> None:
        nonlocal yy
        x = pad
        for name in EXISTING + NEW:
            sheet.alpha_composite(scale(load(f"enemies/{name}.png"), n), (x, yy))
            d.text((x, yy + 64 * n + 4), name + (" (existing)" if name in EXISTING else ""), font=FONT, fill=BONE_300)
            x += max(64 * n, 150) + gap
        yy += 64 * n + 22 + gap

    heading("Enemies x1: two existing Cinderwastes enemies for scale, then hollow knight, reach stalker, pale choir, husk titan")
    enemy_row(1)
    heading("Enemies x2")
    enemy_row(2)

    heading("Attack frames x2 (8 frames of 82 x 64, frame 0 = the still; stored facing left)")
    for name in NEW:
        strip = load(f"enemies/{name}-attack.png")
        sheet.alpha_composite(scale(strip, 2), (pad, yy))
        d.text((pad + strip.width * 2 + 8, yy + 56), name, font=FONT, fill=BONE_300)
        yy += 128 + 8
    yy += gap

    heading("Region boss x2: Forge Tyrant (existing) | Hollow Sovereign (new, 8.2) | husk titan x2 for scale")
    sheet.alpha_composite(scale(load("enemies/forge-tyrant.png"), 2), (pad, yy))
    sheet.alpha_composite(scale(load("enemies/hollow-sovereign.png"), 2), (pad + 256 + gap, yy))
    sheet.alpha_composite(scale(load("enemies/husk-titan.png"), 2), (pad + 512 + gap * 2, yy + 128))
    yy += 256 + gap

    heading("Backdrops x2: Cinderwastes (existing) | Hollow Reach (new, 8.1)")
    sheet.alpha_composite(scale(load("areas/cinderwastes.png"), 2), (pad, yy))
    sheet.alpha_composite(scale(load("areas/hollow-reach.png"), 2), (pad + 768 + gap, yy))
    yy += 432 + gap

    heading("Backdrops x2: Cinder Depths (existing) | Hollow Depths (new, 8.2)")
    sheet.alpha_composite(scale(load("areas/cinder-depths.png"), 2), (pad, yy))
    sheet.alpha_composite(scale(load("areas/hollow-depths.png"), 2), (pad + 768 + gap, yy))
    yy += 432 + gap

    heading("Scenes x2: the Hollow Reach enemies over the Hollow Reach | the Hollow Sovereign over the Hollow Depths")
    scene = load("areas/hollow-reach.png")
    for i, name in enumerate(NEW):
        scene.alpha_composite(load(f"enemies/{name}.png"), (150 + i * 56, 140))
    sheet.alpha_composite(scale(scene, 2), (pad, yy))
    deep = load("areas/hollow-depths.png")
    deep.alpha_composite(load("enemies/hollow-sovereign.png"), (200, 84))
    sheet.alpha_composite(scale(deep, 2), (pad + 768 + gap, yy))
    yy += 432 + pad

    sheet = sheet.crop((0, 0, width, yy))
    sheet.convert("RGB").save(OUT, optimize=True)
    print(OUT.relative_to(ROOT))


if __name__ == "__main__":
    main()
