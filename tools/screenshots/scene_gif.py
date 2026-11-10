#!/usr/bin/env python3
"""Ticket A.14: turns the frames from scene-motion.mjs into a GIF and a strip per viewport.

  python3 tools/screenshots/scene_gif.py docs/screenshots/phase-6

Writes `a14-scene-<vp>.gif` (real capture timing) and `a14-scene-<vp>-strip.png` (8 frames picked
across the run, scaled down to fit), then deletes the numbered frames.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image


def build(folder: Path, vp: str) -> None:
    frames = sorted(folder.glob(f"scene-{vp}-[0-9][0-9]*.png"))
    if not frames:
        return
    times = json.loads((folder / f"scene-{vp}.json").read_text())["times"]
    images = [Image.open(f).convert("RGB") for f in frames]
    # GIF: halve wide captures so the file stays small; nearest keeps pixels crisp.
    scale = 2 if images[0].width > 900 else 1
    small = [im.resize((im.width // scale, im.height // scale), Image.NEAREST) for im in images]
    durations = [max(40, b - a) for a, b in zip([0, *times], times)]
    small[0].save(
        folder / f"a14-scene-{vp}.gif",
        save_all=True,
        append_images=small[1:],
        duration=durations,
        loop=0,
        optimize=True,
    )
    picks = [small[round(i * (len(small) - 1) / 7)] for i in range(8)]
    # Long runs (A.14b films 5+ kills) keep the GIF light: half-size frames for wide captures.
    cols = 4 if vp == "desktop" else 8
    rows = (len(picks) + cols - 1) // cols
    w, h = picks[0].size
    strip = Image.new("RGB", (cols * w + (cols + 1) * 4, rows * h + (rows + 1) * 4), (12, 10, 9))
    for i, im in enumerate(picks):
        strip.paste(im, (4 + (i % cols) * (w + 4), 4 + (i // cols) * (h + 4)))
    strip.save(folder / f"a14-scene-{vp}-strip.png")
    for f in frames:
        f.unlink()
    (folder / f"scene-{vp}.json").unlink()
    print(f"{vp}: {len(images)} frames -> a14-scene-{vp}.gif, a14-scene-{vp}-strip.png")


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "docs/screenshots/phase-6")
    for vp in ("desktop", "mobile"):
        build(out, vp)
