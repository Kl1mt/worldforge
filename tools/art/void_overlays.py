"""Ticket A.12b: the Void motes overlay, drawn in code (no generations).

Usage (from the repo root): python3 tools/art/void_overlays.py

Writes apps/web/public/assets/overlays/void-motes.png: a 16-frame strip of 32x32 frames (512x32).
Eight motes of voidlight are pulled from the socket's edge toward the icon's centre, one art pixel
per frame, each with a dim pixel trailing behind; their phases are staggered so the inflow never
stops. The UI draws the strip behind the icon (the icon hides the centre) and steps it frame by
frame at the icon's integer scale. Alpha is 0 or 255 only; colours are the Void tokens' family.
"""

import math
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parents[2] / "apps/web/public/assets/overlays"
FRAMES = 16
SIZE = 32
BRIGHT = (185, 195, 224, 255)  # --void-light #b9c3e0
DIM = (93, 101, 133, 255)  # voidlight sunk into the rift
START, END = 15, 4  # radius in art pixels: socket edge -> under the icon


def mote_at(k: int, frame: int) -> tuple[int, int, int] | None:
    """Radius and position of mote k at a frame, or None while it is between trips."""
    step = (frame + 2 * k) % FRAMES
    r = START - step
    if r < END:
        return None
    angle = math.radians(22.5 + 45 * k)
    x = round(15.5 + r * math.cos(angle))
    y = round(15.5 + r * math.sin(angle))
    return r, x, y


def strip() -> Image.Image:
    img = Image.new("RGBA", (SIZE * FRAMES, SIZE), (0, 0, 0, 0))
    for f in range(FRAMES):
        for k in range(8):
            now = mote_at(k, f)
            if not now:
                continue
            prev = mote_at(k, f - 1)
            if prev and prev[0] == now[0] + 1:
                img.putpixel((f * SIZE + prev[1], prev[2]), DIM)
            img.putpixel((f * SIZE + now[1], now[2]), BRIGHT if now[0] <= 11 else DIM)
    return img


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    strip().save(OUT / "void-motes.png", optimize=True)
    print(f"wrote {OUT}/void-motes.png")
