#!/usr/bin/env python3
"""Enemy attack frames (ticket A.14b).

One PixelLab animation job animates one image, so six 64 px enemies share a job: `pack` lays
them out as a 3 x 2 grid of 85 px cells (256 x 170, each sprite feet-down with room on the left
for the strike) as the job's first frame; after the job, `build` cuts every enemy's 64 x 64
window back out of each frame, snaps it to that enemy's own palette (alpha 0/255) and writes an
8-frame sheet whose frame 0 is the sprite itself.

Right-facing sprites are mirrored before packing (every foe strikes toward the hero, on the
left), so their sheets are stored facing left and are not mirrored again at render time.

  python3 tools/art/enemy_frames.py pack <batch>      # writes art/source/pixellab/<job>/_first.png
  python3 tools/art/enemy_frames.py build             # every finished batch -> sheets + preview
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
CELL = 85
SIZE = 64
COLS, ROWS = 3, 2
CANVAS = (256, 170)
FRAMES = 8
# Left margin inside a cell: room for the strike toward the hero.
OFFSET = (CELL - SIZE - 3, CELL - SIZE)
# Sheet frames keep that room: LEAD px of strike space left of the 64 px sprite, so a pitchfork
# or a lunge isn't cut off. The UI pulls the sheet back by LEAD so the body stays where the
# still stood (manifest `lead`).
LEAD = OFFSET[0]
FRAME_W = LEAD + SIZE

# Batches (job folder -> enemies, row-major), most-seen enemies first (ticket A.14b).
BATCHES: dict[str, list[str]] = {
    "anim-enemies-01": [
        "undead-farmer", "wolf", "skeletal-scarecrow",
        "bandit-cutthroat", "corrupted-crow", "risen-skeleton",
    ],
    "anim-enemies-02": [
        "ash-wraith", "cinder-hound", "pyre-cultist",
        "ember-golem", "cinder-revenant", "slag-hound",
    ],
    "anim-enemies-03": [
        "ember-wisp", "ash-colossus", "grave-crawler",
        "drowned-thrall", "bog-horror", "fallen-knight",
    ],
    # The regeneration: the six whose frames failed the bar in 02/03 (fire bursts that flattened
    # into blobs once palette-snapped, a body that changed colour), asked again without effects.
    "anim-enemies-04": [
        "ash-wraith", "cinder-hound", "slag-hound",
        "ember-wisp", "cinder-revenant", "fallen-knight",
    ],
    # A.17: the Hollow Reach's four common foes; the last two cells stay empty.
    "anim-enemies-05": [
        "hollow-knight", "reach-stalker", "pale-choir",
        "husk-titan",
    ],
}

# Frames that miss the bar even after the regeneration (fire bursts that flatten into crude blobs
# once snapped to the sprite's palette): no sheet, these keep the code animation.
REJECTED = {"cinder-hound", "slag-hound", "ember-wisp"}

# A.17: batches whose frames get the burst clean-up (`clean_bursts`) before snapping. The
# animator drew white impact bursts around the choir and the titan at the strike; they are
# brighter than anything in the stills, so they are cut, and so are stray specks it left.
CLEANED_BATCHES = {"anim-enemies-05"}
BRIGHT_MARGIN = 8  # luma above the still's 99th-percentile pixel that counts as a burst
BRIGHT_FLOOR = 140  # a bright pixel this far from every colour of the still is a burst too
OFF_PALETTE = 40  # ... "this far": weighted RGB distance (as `snap`), square-rooted
SPECK_MAX = 24  # opaque fragments this small, apart from the body, are dropped


# Which batch each enemy's sheet comes from (later batches win: 04 replaces 02/03's failures).
def source_batches() -> dict[str, str]:
    out: dict[str, str] = {}
    for batch, names in BATCHES.items():
        if (ROOT / f"art/source/pixellab/{batch}/01.png").exists():
            for name in names:
                out[name] = batch
    return out


def manifest() -> dict:
    return json.loads((ROOT / "apps/web/public/assets/manifest.json").read_text())


def facing(name: str) -> str:
    for a in manifest()["assets"]:
        if a["id"] == f"enemy.{name}":
            return a.get("facing", "front")
    raise SystemExit(f"no manifest entry for enemy.{name}")


def sprite(name: str) -> Image.Image:
    img = Image.open(ROOT / f"apps/web/public/assets/enemies/{name}.png").convert("RGBA")
    return img.transpose(Image.FLIP_LEFT_RIGHT) if facing(name) == "right" else img


def origin(i: int) -> tuple[int, int]:
    return ((i % COLS) * CELL + OFFSET[0], (i // COLS) * CELL + OFFSET[1])


def pack(batch: str) -> Path:
    canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    for i, name in enumerate(BATCHES[batch]):
        canvas.alpha_composite(sprite(name), origin(i))
    out = ROOT / f"art/source/pixellab/{batch}"
    out.mkdir(parents=True, exist_ok=True)
    canvas.save(out / "_first.png")
    return out / "_first.png"


def palette(img: Image.Image) -> list[tuple[int, int, int]]:
    return sorted({p[:3] for p in img.get_flattened_data() if p[3] > 0})


def snap(frame: Image.Image, pal: list[tuple[int, int, int]]) -> Image.Image:
    out = Image.new("RGBA", frame.size, (0, 0, 0, 0))
    src, dst = frame.load(), out.load()
    cache: dict[tuple[int, int, int], tuple[int, int, int]] = {}
    for y in range(frame.height):
        for x in range(frame.width):
            r, g, b, a = src[x, y]
            if a < 128:
                continue
            if (r, g, b) not in cache:
                cache[(r, g, b)] = min(
                    pal, key=lambda c: 2 * (c[0] - r) ** 2 + 4 * (c[1] - g) ** 2 + 3 * (c[2] - b) ** 2
                )
            dst[x, y] = (*cache[(r, g, b)], 255)
    return out


def luma(p: tuple[int, ...]) -> float:
    return 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]


def clean_bursts(cell: Image.Image, still: Image.Image) -> Image.Image:
    """Cut burst pixels (brighter than the still, or bright and off its palette), then specks."""
    lumas = sorted(luma(p) for p in still.get_flattened_data() if p[3] > 0)
    ceiling = lumas[int(len(lumas) * 0.99)] + BRIGHT_MARGIN
    pal = palette(still)

    def off_palette(p: tuple[int, ...]) -> bool:
        d = min(2 * (c[0] - p[0]) ** 2 + 4 * (c[1] - p[1]) ** 2 + 3 * (c[2] - p[2]) ** 2 for c in pal)
        return d > 9 * OFF_PALETTE**2  # the weights sum to 9

    out = cell.copy()
    px = out.load()
    w, h = out.size
    for y in range(h):
        for x in range(w):
            q = px[x, y]
            if q[3] >= 128 and (luma(q) > ceiling or (luma(q) > BRIGHT_FLOOR and off_palette(q))):
                px[x, y] = (0, 0, 0, 0)
    seen: set[tuple[int, int]] = set()
    for y in range(h):
        for x in range(w):
            if (x, y) in seen or px[x, y][3] < 128:
                continue
            part, todo = [], [(x, y)]
            seen.add((x, y))
            while todo:
                cx, cy = todo.pop()
                part.append((cx, cy))
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        nx, ny = cx + dx, cy + dy
                        if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in seen and px[nx, ny][3] >= 128:
                            seen.add((nx, ny))
                            todo.append((nx, ny))
            if len(part) <= SPECK_MAX:
                for q in part:
                    px[q] = (0, 0, 0, 0)
    return out


def build() -> None:
    rows = []
    picks = source_batches()
    for batch, names in BATCHES.items():
        folder = ROOT / f"art/source/pixellab/{batch}"
        if not (folder / "01.png").exists():
            continue
        frames = [Image.open(folder / f"{i:02d}.png").convert("RGBA") for i in range(FRAMES)]
        for i, name in enumerate(names):
            if picks.get(name) != batch:
                continue  # replaced by a later batch (the raw frames stay in the preview)
            if name in REJECTED:
                (ROOT / f"apps/web/public/assets/enemies/{name}-attack.png").unlink(missing_ok=True)
                continue
            still = sprite(name)
            pal = palette(still)
            x, y = origin(i)
            sheet = Image.new("RGBA", (FRAME_W * FRAMES, SIZE), (0, 0, 0, 0))
            sheet.paste(still, (LEAD, 0))
            for f in range(1, FRAMES):
                cell = frames[f].crop((x - LEAD, y, x + SIZE, y + SIZE))
                if batch in CLEANED_BATCHES:
                    cell = clean_bursts(cell, still)
                sheet.paste(snap(cell, pal), (f * FRAME_W, 0))
            sheet.save(ROOT / f"apps/web/public/assets/enemies/{name}-attack.png")
            rows.append((batch, i, name, sheet))
    preview(rows)


def preview(rows) -> None:
    """Contact sheet: per batch the raw job frames (x1), then each enemy's cleaned sheet at x2."""
    s, pad = 2, 6
    width = max(FRAME_W * FRAMES * s, CANVAS[0] * FRAMES) + 2 * pad
    batches = sorted({b for b, *_ in rows})
    height = pad + sum(CANVAS[1] + pad for _ in batches) + len(rows) * (SIZE * s + pad)
    canvas = Image.new("RGBA", (width, height), (36, 31, 27, 255))
    y = pad
    for batch in batches:
        folder = ROOT / f"art/source/pixellab/{batch}"
        for f in range(FRAMES):
            raw = Image.open(folder / f"{f:02d}.png").convert("RGBA")
            canvas.alpha_composite(raw, (pad + f * CANVAS[0], y))
        y += CANVAS[1] + pad
        for b, _, _, sheet in rows:
            if b != batch:
                continue
            canvas.alpha_composite(sheet.resize((sheet.width * s, SIZE * s), Image.NEAREST), (pad, y))
            y += SIZE * s + pad
    canvas.save(ROOT / "art/preview-enemy-frames.png")


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "pack":
        print(pack(sys.argv[2]))
    elif len(sys.argv) >= 2 and sys.argv[1] == "build":
        build()
    else:
        raise SystemExit(__doc__)
