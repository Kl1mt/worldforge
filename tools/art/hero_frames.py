#!/usr/bin/env python3
"""Build the hero attack sprite sheets (ticket A.14) from the PixelLab animation jobs.

Each sheet is one row of 128x128 frames: frame 0 is the class portrait itself (the rest pose),
frames 1-7 are the job's frames 1-7 snapped to the portrait's own palette (nearest colour), with
alpha forced to 0/255. The job's last frame is dropped: the loop returns to the portrait.

  python3 tools/art/hero_frames.py   # writes apps/web/public/assets/characters/<class>-attack.png
                                     # and art/preview-hero-frames.png
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
JOBS = {
    "warrior": "anim-warrior-02",
    "mage": "anim-mage-01",
    "hunter": "anim-hunter-01",
    "warlock": "anim-warlock-01",
}
FRAMES = 8
SIZE = 128


def palette(img: Image.Image) -> list[tuple[int, int, int]]:
    return sorted({p[:3] for p in img.getdata() if p[3] > 0})


def snap(frame: Image.Image, pal: list[tuple[int, int, int]]) -> Image.Image:
    out = Image.new("RGBA", frame.size, (0, 0, 0, 0))
    cache: dict[tuple[int, int, int], tuple[int, int, int]] = {}
    px = out.load()
    src = frame.load()
    for y in range(frame.height):
        for x in range(frame.width):
            r, g, b, a = src[x, y]
            if a < 128:
                continue
            key = (r, g, b)
            if key not in cache:
                # Weighted RGB distance (cheap perceptual approximation).
                cache[key] = min(
                    pal,
                    key=lambda c: 2 * (c[0] - r) ** 2 + 4 * (c[1] - g) ** 2 + 3 * (c[2] - b) ** 2,
                )
            px[x, y] = (*cache[key], 255)
    return out


def main() -> None:
    rows = []
    for cls, job in JOBS.items():
        portrait = Image.open(ROOT / f"apps/web/public/assets/characters/{cls}.png").convert("RGBA")
        pal = palette(portrait)
        sheet = Image.new("RGBA", (SIZE * FRAMES, SIZE), (0, 0, 0, 0))
        sheet.paste(portrait, (0, 0))
        for i in range(1, FRAMES):
            raw = Image.open(ROOT / f"art/source/pixellab/{job}/{i:02d}.png").convert("RGBA")
            sheet.paste(snap(raw, pal), (i * SIZE, 0))
        sheet.save(ROOT / f"apps/web/public/assets/characters/{cls}-attack.png")
        rows.append((job, sheet))

    # Contact sheet: raw job frames above the cleaned sheet, per class, at x2.
    s = 2
    pad = 8
    width = SIZE * FRAMES * s + 2 * pad
    canvas = Image.new("RGBA", (width, len(rows) * (2 * SIZE * s + pad) + pad), (36, 31, 27, 255))
    y = pad
    for job, sheet in rows:
        for i in range(FRAMES):
            raw = Image.open(ROOT / f"art/source/pixellab/{job}/{i:02d}.png").convert("RGBA")
            canvas.alpha_composite(raw.resize((SIZE * s, SIZE * s), Image.NEAREST), (pad + i * SIZE * s, y))
        y += SIZE * s
        canvas.alpha_composite(sheet.resize((sheet.width * s, SIZE * s), Image.NEAREST), (pad, y))
        y += SIZE * s + pad
    canvas.save(ROOT / "art/preview-hero-frames.png")


if __name__ == "__main__":
    main()
