#!/usr/bin/env python3
"""Art ticket A.19: the contact sheet, art/preview-shrine.png.

Usage (from the repo root): python3 tools/art/preview_shrine.py

1. The hub's right end, cold (A.2) and with the lit shrine drawn at its hotspot (x2), and the
   cut itself next to the cold one (x4).
2. The ten companions (ticket 9.5's ids), both idle frames at x2 and x1.
3. Companions beside the heroes in a scene, at the scene's ratio (backdrop x2, sprites x1): the
   companion stands at the hero's feet on the side of the foes.
4. The Shrine's palette variants: the Candlelight look on every class next to its own colours
   (the attack sheets share the portrait's palette, so the same swap covers them), the votive veil banner next to the Watch's flame (x4, x1), the
   votive ash crest next to the iron one (x2).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
import companions as cp  # noqa: E402
import hero_palettes as hp  # noqa: E402

ROOT = hp.ROOT
A = ROOT / "apps/web/public/assets"
OUT = ROOT / "art/preview-shrine.png"
BG = (30, 27, 24, 255)
INK = (200, 184, 150)
PAD = 16

try:
    FONT = ImageFont.load_default(size=14)
except TypeError:
    FONT = ImageFont.load_default()


def img(rel: str) -> Image.Image:
    return Image.open(A / rel).convert("RGBA")


def up(im: Image.Image, s: int) -> Image.Image:
    return im.resize((im.width * s, im.height * s), Image.NEAREST)


def frame(sheet: Image.Image, i: int, w: int) -> Image.Image:
    return sheet.crop((i * w, 0, (i + 1) * w, sheet.height))


def main() -> None:
    W = 1240
    sheet = Image.new("RGBA", (W, 1700), BG)
    d = ImageDraw.Draw(sheet)
    y = PAD

    # 1. The hub, cold and lit.
    hub = img("hub/graumark.png")
    lit = img("hub/shrine-lit.png")
    lit_hub = hub.copy()
    lit_hub.alpha_composite(lit, (366, 112))
    box = (264, 70, 384, 170)
    d.text((PAD, y), "hub.graumark cold | hub.shrine at its hotspot (x2)", fill=INK, font=FONT)
    d.text((PAD + 2 * 240 + 3 * PAD, y), "hub.shrine 18 x 34 (x4): cold | lit", fill=INK, font=FONT)
    y += 22
    sheet.alpha_composite(up(hub.crop(box), 2), (PAD, y))
    sheet.alpha_composite(up(lit_hub.crop(box), 2), (PAD + 240 + PAD, y))
    x = PAD + 2 * 240 + 3 * PAD
    sheet.alpha_composite(up(hub.crop((366, 112, 384, 146)), 4), (x, y))
    sheet.alpha_composite(up(lit, 4), (x + 72 + PAD, y))
    y += 200 + PAD

    # 2. The companions, both frames.
    d.text((PAD, y), "companion.<id>: the two idle frames at x2 (frame 0 | frame 1) and the sheet at x1", fill=INK, font=FONT)
    y += 22
    for i, cid in enumerate(cp.PICKS):
        cx = PAD + (i % 5) * 244
        cy = y + (i // 5) * 104
        s = img(f"companions/{cid}.png")
        sheet.alpha_composite(up(frame(s, 0, 32), 2), (cx, cy))
        sheet.alpha_composite(up(frame(s, 1, 32), 2), (cx + 68, cy))
        sheet.alpha_composite(s, (cx + 144, cy + 32))
        d.text((cx, cy + 70), cid, fill=INK, font=FONT)
    y += 2 * 104 + PAD

    # 3. In the scene: backdrop x2, sprites x1 (the reference composition), the companion at the
    #    hero's feet toward the foes.
    d.text((PAD, y), "in a scene (backdrop x2, hero, companion and foe x1): the companion beside the hero", fill=INK, font=FONT)
    y += 22
    scenes = [
        ("areas/crowwood.png", "warrior", "ash-raven", "enemy.wolf"),
        ("areas/hollow-reach.png", "warlock", "hollow-wisp", "enemy.hollow-knight"),
        ("areas/cinderwastes.png", "hunter", "cinder-pup", "enemy.ember-golem"),
        ("areas/sunken-abbey.png", "mage", "candle-wisp", "enemy.drowned-thrall"),
    ]
    entries = {a["id"]: a for a in json.loads((A / "manifest.json").read_text())["assets"]}
    for i, (bd, hero, cid, foe) in enumerate(scenes):
        crop = img(bd).crop((0, 76, 300, 216))
        panel = up(crop, 2)  # 600 x 280
        ground = panel.height - 18
        h = img(f"characters/{hero}.png")
        panel.alpha_composite(h, (40, ground - 128))
        c = frame(img(f"companions/{cid}.png"), 0, 32)
        panel.alpha_composite(c, (40 + 112, ground - 32))
        f = img(entries[foe]["path"].removeprefix("/assets/"))
        if entries[foe].get("facing") == "right":  # foes face the hero (left)
            f = f.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        panel.alpha_composite(f, (panel.width - 160, ground - 64))
        px = PAD + (i % 2) * (600 + PAD)
        py = y + (i // 2) * (280 + PAD)
        sheet.alpha_composite(panel, (px, py))
        d.text((px + 6, py + 4), f"{hero} + companion.{cid}", fill=INK, font=FONT)
    y += 2 * (280 + PAD)

    # 4. The palette variants.
    d.text((PAD, y), "appearance.candlelight on every class (x1): own colours | candlelight", fill=INK, font=FONT)
    y += 22
    data, _ = hp.build()
    for i, cls in enumerate(hp.CLASSES):
        x = PAD + i * 300
        still = img(f"characters/{cls}.png")
        swaps = data["candlelight"][cls]
        sheet.alpha_composite(still, (x, y))
        sheet.alpha_composite(hp.recolour(still, swaps), (x + 132, y))
        d.text((x, y + 130), cls, fill=INK, font=FONT)
    y += 156
    d.text((PAD, y), "banner.warden-flame | banner.votive-veil (x4, x1)", fill=INK, font=FONT)
    d.text((PAD + 420, y), "crest.iron | crest.votive-ash (x2)", fill=INK, font=FONT)
    y += 22
    for i, b in enumerate(["warden-flame", "votive-veil"]):
        bi = img(f"banners/{b}.png")
        sheet.alpha_composite(up(bi, 4), (PAD + i * 180, y))
        sheet.alpha_composite(bi, (PAD + i * 180 + 136, y + 96))
    for i, c in enumerate(["iron", "votive-ash"]):
        sheet.alpha_composite(up(img(f"crests/crest-{c}.png"), 2), (PAD + 420 + i * 120, y))
    y += 128 + PAD

    sheet = sheet.crop((0, 0, W, y))
    sheet.convert("RGB").save(OUT, optimize=True)
    print(OUT.relative_to(ROOT), sheet.size)


if __name__ == "__main__":
    main()
