"""Ticket A.12: the Prismatic overlays, drawn in code (no generations).

Usage (from the repo root): python3 tools/art/prismatic_overlays.py

Writes two native-resolution overlays to apps/web/public/assets/overlays/:
- prismatic-tint.png (32x32): diagonal opal bands, 4 art pixels wide, in a ping-pong cycle of five
  muted opal hues. Its period is 32 along both axes, so it tiles, and sliding it by whole art
  pixels gives the slow palette drift.
- prismatic-sheen.png (96x32): transparent except one 3-pixel diagonal glint (amber, pearl, sky:
  a little dispersion). At offset 0 the glint sits outside the 32-pixel window, so a frozen sheen
  shows nothing.
The UI clips both to the icon's alpha and scales them by the icon's integer scale (pixelated).
Alpha is 0 or 255 only.
"""

from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parents[2] / "apps/web/public/assets/overlays"

# Muted opal: rose, amber, mint, sky, lilac (docs/DESIGN_SYSTEM.md "Prismatic").
OPAL = ["#d9a0b4", "#e3c98a", "#9fd2b4", "#93b9de", "#b7a0dc"]
CYCLE = [0, 1, 2, 3, 4, 3, 2, 1]  # ping-pong, 8 bands x 4 px = period 32
GLINT = ["#e3c98a", "#f4eee0", "#93b9de"]


def rgb(hex_colour: str) -> tuple[int, int, int, int]:
    h = hex_colour.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255)


def tint() -> Image.Image:
    img = Image.new("RGBA", (32, 32))
    for y in range(32):
        for x in range(32):
            band = ((x + y) % 32) // 4
            img.putpixel((x, y), rgb(OPAL[CYCLE[band]]))
    return img


def sheen() -> Image.Image:
    img = Image.new("RGBA", (96, 32), (0, 0, 0, 0))
    start = 70  # x + y of the glint's first pixel: x >= 39 everywhere, outside the 0..31 window
    for y in range(32):
        for x in range(96):
            d = x + y - start
            if 0 <= d < len(GLINT):
                img.putpixel((x, y), rgb(GLINT[d]))
    return img


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    tint().save(OUT / "prismatic-tint.png", optimize=True)
    sheen().save(OUT / "prismatic-sheen.png", optimize=True)
    print(f"wrote {OUT}/prismatic-tint.png, prismatic-sheen.png")
