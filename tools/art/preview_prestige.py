#!/usr/bin/env python3
"""Contact sheet for art ticket A.10 (season frames, title badges, arena backdrop).

Usage (from the repo root): python3 tools/art/preview_prestige.py

Writes art/preview-prestige.png and docs/screenshots/phase-5/a10-contact-sheet.png (the same
image). Only reads curated assets; it spends no generations.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "apps/web/public/assets"
OUTS = [ROOT / "art/preview-prestige.png", ROOT / "docs/screenshots/phase-5/a10-contact-sheet.png"]

INK_850 = (27, 21, 18, 255)
INK_900 = (19, 16, 14, 255)
BRASS_300 = (226, 197, 142, 255)
BRASS_700 = (90, 70, 40, 255)
CRIMSON_700 = (92, 40, 44, 255)
BONE_300 = (151, 140, 126, 255)
LABEL = (200, 186, 160, 255)

TIERS = ["champion", "exalted", "renowned", "veteran"]
METRICS = ["level", "gear-score", "power", "pve-progress"]
WINDOW = (14, 14, 36, 36)  # SEASON_FRAME_WINDOW in apps/web/src/content/assets.ts

FONT = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 13)


def load(rel: str) -> Image.Image:
    return Image.open(ASSETS / rel).convert("RGBA")


def scale(img: Image.Image, n: int) -> Image.Image:
    return img.resize((img.width * n, img.height * n), Image.NEAREST)


def sample_crest() -> Image.Image:
    """A 64×64 layer with a crest filling the frame window: a well, a dyed heater shield, a charge."""
    layer = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x, y, w, h = WINDOW
    d.rectangle([x, y, x + w - 1, y + h - 1], fill=INK_900)
    sx0, sx1, sy0, sy1 = x + 1, x + w - 2, y, y + h - 1
    mid = (sx0 + sx1) / 2
    shield = [(sx0, sy0), (sx1, sy0), (sx1, sy0 + 21), (mid, sy1), (sx0, sy0 + 21)]
    d.polygon(shield, fill=BRASS_700, outline=BRASS_300)
    inner = [(sx0 + 2, sy0 + 2), (sx1 - 2, sy0 + 2), (sx1 - 2, sy0 + 20), (mid, sy1 - 3), (sx0 + 2, sy0 + 20)]
    d.polygon(inner, fill=CRIMSON_700)
    layer.alpha_composite(load("guild-emblems/crown.png"), (16, 13))
    return layer


def framed(tier: str, n: int, content: Image.Image) -> Image.Image:
    img = scale(content, n)
    img.alpha_composite(scale(load(f"frames/season-frame-{tier}.png"), n))
    return img


def portrait_layer() -> Image.Image:
    """A 256×256 layer: the warrior portrait at ×1 in a well filling the frame window at ×4."""
    layer = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    x, y, w, h = (v * 4 for v in WINDOW)
    ImageDraw.Draw(layer).rectangle([x, y, x + w - 1, y + h - 1], fill=INK_900)
    layer.alpha_composite(load("characters/warrior.png"), (64, 64))
    return layer


def main() -> None:
    pad, gap = 16, 24
    width = 1240
    sheet = Image.new("RGBA", (width, 1600), INK_850)
    d = ImageDraw.Draw(sheet)
    yy = pad

    def heading(text: str) -> None:
        nonlocal yy
        d.text((pad, yy), text, font=FONT, fill=LABEL)
        yy += 22

    crest = sample_crest()
    heading("Season frames, best to least (champion, exalted, renowned, veteran): around a sample crest at x1 and x2")
    x = pad
    for tier in TIERS:
        sheet.alpha_composite(framed(tier, 1, crest), (x, yy + 32))
        sheet.alpha_composite(framed(tier, 2, crest), (x + 72, yy))
        d.text((x, yy + 134), tier, font=FONT, fill=BONE_300)
        x += 72 + 128 + gap
    yy += 160

    heading("Empty frames at x2: transparent opening; content fills the shared 36x36 window under the frame")
    x = pad
    for tier in TIERS:
        f = scale(load(f"frames/season-frame-{tier}.png"), 2)
        sheet.alpha_composite(f, (x, yy))
        x += 128 + gap
    yy += 128 + gap

    heading("Profile use: x4 around the 128 px class portrait")
    x = pad
    portrait = portrait_layer()
    for tier in TIERS:
        layer = portrait.copy()
        layer.alpha_composite(scale(load(f"frames/season-frame-{tier}.png"), 4))
        sheet.alpha_composite(layer, (x, yy))
        x += 256 + gap
    yy += 256 + gap

    heading("Title badges (level, gear score, power, PvE progress) at x2, x1, and shrunk to 24 and 16 px (smooth), next to a name")
    x = pad
    for metric in METRICS:
        b = load(f"badges/title-badge-{metric}.png")
        sheet.alpha_composite(scale(b, 2), (x, yy))
        sheet.alpha_composite(b, (x + 72, yy + 32))
        sheet.alpha_composite(b.resize((24, 24), Image.BOX), (x + 112, yy + 40))
        sheet.alpha_composite(b.resize((16, 16), Image.BOX), (x + 144, yy + 48))
        # next to a name line, as on a board row
        d.text((x + 164, yy + 48), metric, font=FONT, fill=BONE_300)
        x += 280
    yy += 64 + gap

    heading("Arena backdrop (new) at x2, next to the Ashen Pass and the Sunken Abbey at x1 for treatment")
    sheet.alpha_composite(scale(load("areas/arena.png"), 2), (pad, yy))
    sheet.alpha_composite(load("areas/ashen-pass.png"), (pad + 768 + gap, yy))
    sheet.alpha_composite(load("areas/sunken-abbey.png"), (pad + 768 + gap, yy + 216))
    yy += 432 + pad

    sheet = sheet.crop((0, 0, width, yy))
    for out in OUTS:
        out.parent.mkdir(parents=True, exist_ok=True)
        sheet.convert("RGB").save(out, optimize=True)
        print(out.relative_to(ROOT))


if __name__ == "__main__":
    main()
