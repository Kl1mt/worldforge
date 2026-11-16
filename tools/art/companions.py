#!/usr/bin/env python3
"""Art ticket A.19: the Reward Shrine's companions, each a 32 x 32 two-frame idle.

Usage (from the repo root): python3 tools/art/companions.py

Three 32 px jobs returned eight variants of each subject asked for:
`companions-animals-01` (style image `enemies/corrupted-crow.png`), `companions-wisps-01`
(`enemies/abbey-wraith.png`) and `companions-cinder-01` (`enemies/slag-hound.png`; the ember newt
and the cinder pup, the two of ticket 9.5's companions the first two jobs had no subject for).
`PICKS` lists the one kept per companion. For each pick this script:

- forces alpha to 0/255 with RGB 0 under transparent pixels;
- recolours three picks to their 9.5 description (`recolour`: the grey cat to the crypt's black
  cat with a torn ear, the grey rat to bone, the raven to ash grey); the rest keep raw colours;
- stores it facing **right** (toward the foes: the companion stands beside the hero, who stands on
  the left), mirroring any pick drawn facing left, so it is never mirrored at render time;
- centres it in the 32 x 32 cell: walkers with their feet on the bottom row, floaters with one row
  of air above (the bob) and at least two below (they hover);
- draws the second idle frame in code (no animation generations): walkers **breathe** (everything
  above the feet sinks one pixel onto them), floaters **bob** (the whole sprite rises one pixel).

Writes `edits/NN-idle.png` (the 64 x 32 sheet) next to each raw pick, copies it to
`apps/web/public/assets/companions/<name>.png` and rewrites the `companion.*` entries of the
manifest. The ids are ticket 9.5's companion cosmetic ids (`companion.<name>`).
"""

from __future__ import annotations

import colorsys
import json
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hero_palettes import at_luma, luma  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "art/source/pixellab"
OUT = ROOT / "apps/web/public/assets/companions"
MANIFEST = ROOT / "apps/web/public/assets/manifest.json"
SIZE = 32
FRAMES = 2
# Rows at the bottom of a walker's sprite that stay put while the body above breathes.
FEET = 4

ANIMALS = "companions-animals-01"
WISPS = "companions-wisps-01"
CINDER = "companions-cinder-01"
BATCHES = (ANIMALS, WISPS, CINDER)

# Ticket 9.5's companion cosmetics (`companion.<name>` in game-core `COSMETICS`) ->
# (batch, raw index, drawn facing, idle: walk | float, recolour or None, what it shows)
PICKS: dict[str, tuple[str, int, str, str, str | None, str]] = {
    "grave-moth": (ANIMALS, 57, "right", "float", None, "a pale dusk moth"),
    "bone-rat": (ANIMALS, 51, "right", "walk", "bone", "a lean rat, paled to bone"),
    "bog-toad": (ANIMALS, 33, "right", "walk", None, "a warty marsh toad"),
    "ash-raven": (ANIMALS, 3, "right", "walk", "ash", "a raven, its black greyed to ash"),
    "candle-wisp": (WISPS, 10, "front", "float", None, "an amber candle-flame wisp"),
    "crypt-cat": (ANIMALS, 10, "right", "walk", "black-cat", "the grey cat turned black, one ear torn"),
    "ember-newt": (CINDER, 27, "right", "walk", None, "an ember newt"),
    "barrow-owl": (ANIMALS, 24, "right", "walk", None, "a barn owl"),
    "hollow-wisp": (WISPS, 0, "front", "float", None, "a pale blue-white will-o'-wisp"),
    "cinder-pup": (CINDER, 5, "left", "walk", None, "a slag-hound whelp"),
}


def _hsv(c):
    return colorsys.rgb_to_hsv(*(x / 255 for x in c))


def recolour(img: Image.Image, how: str) -> Image.Image:
    """Recolour a raw pick to its 9.5 description, keeping the outline's darks and the shading."""
    img = img.copy()
    px = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            if not a:
                continue
            c = (r, g, b)
            h, s, v = _hsv(c)
            L = luma(c)
            if how == "black-cat":
                if s > 0.4 and v > 0.35:  # the amber eyes stay
                    continue
                px[x, y] = (*at_luma(250, 0.10, L * 0.5), 255)
            elif how == "bone":
                if s > 0.2 and (h > 0.85 or h < 0.05):  # pink ears, nose and tail stay
                    continue
                px[x, y] = (*at_luma(40, 0.12, min(0.9, L * 1.45)), 255)
            elif how == "ash":
                if v < 0.08:  # the outline
                    continue
                px[x, y] = (*at_luma(30, 0.05, min(0.9, L * 1.55 + 0.03)), 255)
    if how == "black-cat":
        # The torn ear: a notch out of the near ear's tip (raw pixels), its floor outlined.
        px[29, 7] = (0, 0, 0, 0)
        px[29, 8] = (0, 0, 0, 0)
        px[29, 9] = (*at_luma(250, 0.10, 0.02), 255)
    return img


def clean(img: Image.Image) -> Image.Image:
    img = img.convert("RGBA")
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.putdata([(r, g, b, 255) if a >= 128 else (0, 0, 0, 0) for r, g, b, a in img.get_flattened_data()])
    return out


def place(img: Image.Image, idle: str) -> Image.Image:
    """Centre horizontally; walkers stand on the bottom row, floaters hover."""
    x0, y0, x1, y1 = img.getbbox()
    body = img.crop((x0, y0, x1, y1))
    w, h = body.size
    assert w <= SIZE and h <= SIZE, (w, h)
    left = (SIZE - w) // 2
    if idle == "walk":
        top = SIZE - h
    else:
        top = max(1, SIZE - 3 - h)
        assert top + h <= SIZE, "a floater needs a row of air above it to bob"
    cell = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    cell.paste(body, (left, top))
    return cell


def second_frame(still: Image.Image, idle: str) -> Image.Image:
    frame = Image.new("RGBA", still.size, (0, 0, 0, 0))
    if idle == "float":
        frame.paste(still, (0, -1))
        return frame
    _, _, _, bottom = still.getbbox()
    split = bottom - FEET
    feet = still.crop((0, split, SIZE, SIZE))
    upper = still.crop((0, 0, SIZE, split))
    frame.paste(feet, (0, split))
    frame.alpha_composite(upper, (0, 1))
    return frame


def build() -> dict[str, Image.Image]:
    OUT.mkdir(parents=True, exist_ok=True)
    sheets: dict[str, Image.Image] = {}
    for cid, (batch, n, facing, idle, how, _) in PICKS.items():
        raw = Image.open(RAW / batch / f"{n:02d}.png")
        assert raw.size == (SIZE, SIZE), cid
        still = clean(raw)
        if how:
            still = recolour(still, how)
        if facing == "left":
            still = still.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        still = place(still, idle)
        sheet = Image.new("RGBA", (SIZE * FRAMES, SIZE), (0, 0, 0, 0))
        sheet.paste(still, (0, 0))
        sheet.paste(second_frame(still, idle), (SIZE, 0))
        (RAW / batch / "edits").mkdir(exist_ok=True)
        sheet.save(RAW / batch / "edits" / f"{n:02d}-idle.png", optimize=True)
        sheet.save(OUT / f"{cid}.png", optimize=True)
        sheets[cid] = sheet
        mirrored = ", mirrored" if facing == "left" else ""
        print(f"companion.{cid}: {batch}/{n:02d} ({idle}{mirrored}) -> companions/{cid}.png")
    return sheets


def register() -> None:
    manifest = json.loads(MANIFEST.read_text())
    jobs = {b: json.loads((RAW / b / "_job.json").read_text()) for b in BATCHES}
    assets = [a for a in manifest["assets"] if a["kind"] != "companion"]
    for cid, (batch, n, facing, idle, recoloured, what) in PICKS.items():
        how = "breathing (the body above the feet sinks 1 px)" if idle == "walk" else "bobbing (the sprite rises 1 px)"
        edits = ("mirrored" if facing == "left" else "") + (f"recoloured ({recoloured})" if recoloured else "")
        assets.append(
            {
                "id": f"companion.{cid}",
                "path": f"/assets/companions/{cid}.png",
                "kind": "companion",
                "size": {"width": SIZE, "height": SIZE},
                "frames": FRAMES,
                "prompt": jobs[batch]["prompt"],
                "source": (
                    f"art/source/pixellab/{batch}/edits/{n:02d}-idle.png ({what}: raw {n:02d}.png"
                    f"{', ' + edits if edits else ''}; frame 1 {how}; tools/art/companions.py)"
                ),
                "facing": "right",
            }
        )
    manifest["assets"] = assets
    MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(f"manifest: {len(PICKS)} companion entries")


if __name__ == "__main__":
    build()
    register()
