#!/usr/bin/env python3
"""Contact sheet for art ticket A.11 (the Cinderwastes: backdrops, enemies, region boss).

Usage (from the repo root): python3 tools/art/preview_cinderwastes.py

Writes art/preview-cinderwastes.png. Only reads curated assets; it spends no generations.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "apps/web/public/assets"
OUT = ROOT / "art/preview-cinderwastes.png"

INK_850 = (27, 21, 18, 255)
LABEL = (200, 186, 160, 255)
BONE_300 = (151, 140, 126, 255)

FONT = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 13)

EXISTING = ["cinder-hound", "ember-golem"]  # late-game Ashen Pass enemies, for scale
NEW = ["cinder-revenant", "ash-colossus", "ember-wisp", "slag-hound"]


def load(rel: str) -> Image.Image:
    return Image.open(ASSETS / rel).convert("RGBA")


def scale(img: Image.Image, n: int) -> Image.Image:
    return img.resize((img.width * n, img.height * n), Image.NEAREST)


def main() -> None:
    pad, gap = 16, 24
    width = pad * 2 + 768 * 2 + gap
    sheet = Image.new("RGBA", (width, 2200), INK_850)
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

    heading("Enemies x1: two existing Ashen Pass enemies for scale, then cinder revenant, ash colossus, ember wisp, slag hound")
    enemy_row(1)
    heading("Enemies x2")
    enemy_row(2)

    heading("Region boss x2: Ashen Warden (existing) | Forge Tyrant (new) | ember golem x2 for scale")
    sheet.alpha_composite(scale(load("enemies/ashen-warden.png"), 2), (pad, yy))
    sheet.alpha_composite(scale(load("enemies/forge-tyrant.png"), 2), (pad + 256 + gap, yy))
    sheet.alpha_composite(scale(load("enemies/ember-golem.png"), 2), (pad + 512 + gap * 2, yy + 128))
    yy += 256 + gap

    heading("Backdrops x2: Ashen Pass (existing) | Cinderwastes (new, 6.1)")
    sheet.alpha_composite(scale(load("areas/ashen-pass.png"), 2), (pad, yy))
    sheet.alpha_composite(scale(load("areas/cinderwastes.png"), 2), (pad + 768 + gap, yy))
    yy += 432 + gap

    heading("Backdrops x2: Cinder Depths (new, 6.2) | the Cinderwastes enemies and the Forge Tyrant over the Cinderwastes")
    sheet.alpha_composite(scale(load("areas/cinder-depths.png"), 2), (pad, yy))
    scene = load("areas/cinderwastes.png")
    for i, name in enumerate(NEW):
        scene.alpha_composite(load(f"enemies/{name}.png"), (150 + i * 56, 140))
    scene.alpha_composite(load("enemies/forge-tyrant.png"), (40, 84))
    sheet.alpha_composite(scale(scene, 2), (pad + 768 + gap, yy))
    yy += 432 + pad

    sheet = sheet.crop((0, 0, width, yy))
    sheet.convert("RGB").save(OUT, optimize=True)
    print(OUT.relative_to(ROOT))


if __name__ == "__main__":
    main()
