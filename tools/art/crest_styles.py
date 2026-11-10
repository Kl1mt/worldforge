#!/usr/bin/env python3
"""Crest styles (ticket A.13): four shield-shaped border frames drawn in code, no generations.

A guild crest (`social/Crest.tsx`, A.8) is a CSS heater shield, 40 px wide and 1.18x as tall at
`md` (36 px at `sm`, 76 px with a x2 charge at `lg`). A 32 px generation cannot hold a frame for a
40 px shield at the crest's own pixel scale, so the frames are drawn here, at native scale, on the
exact shield outline: 48x56 PNG, window {x 4, y 4, width 40, height 48} = the md crest's box. The
band reaches 2 px inside the window (it covers the crest's brass rim) and 4 px outside. Draw the
frame over the crest at x1 (md) or x2 (lg); the opening stays the crest's field and charge.

Palettes are sampled from the curated art: iron = the veteran season frame, gilt = the champion
frame plus the warrior's crimson, bone = the guild emblems' bone-white, ember = the Cinderwastes'
blackened iron and ember glow. Outline = the art's near-black #040302. Alpha 0/255.

  python3 tools/art/crest_styles.py   # writes apps/web/public/assets/crests/crest-<style>.png
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "apps/web/public/assets/crests"
W, H = 48, 56
WIN = (4, 4, 40, 48)
INNER, OUTER = 2.0, 4.0  # band depth inside and outside the window edge
OUTLINE = (4, 3, 2)


def hexc(h: str):
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


RAMPS = {
    "iron": ["282622", "3a3731", "4c4b48", "5d5d5a", "777677", "94928f"],
    "gilt": ["3e321a", "5b4925", "7f6636", "9b8044", "bda058", "e0c677"],
    "bone": ["4b4333", "6b624d", "998962", "c0b08a", "d7caa8", "ebe3ca"],
    "ember": ["151613", "1e1c1a", "2c2823", "343431", "464340", "52504c"],
}
CRIMSON = ["3f171f", "7a2a30", "b4524f"]
GLOW = ["7a3420", "c76536", "e89a4a"]


def shield():
    x, y, w, h = WIN
    sh = y + 0.58 * h
    return [(x, y), (x + w, y), (x + w, sh), (x + w / 2, y + h), (x, sh)]


POLY = shield()
SEGS = list(zip(POLY, POLY[1:] + POLY[:1]))
PERIM = sum(math.dist(a, b) for a, b in SEGS)


def inside(px, py) -> bool:
    c = False
    for (x1, y1), (x2, y2) in SEGS:
        if (y1 > py) != (y2 > py) and px < (x2 - x1) * (py - y1) / (y2 - y1) + x1:
            c = not c
    return c


def nearest(px, py):
    """(signed distance, outward normal, arc length of the nearest point)."""
    best = None
    arc = 0.0
    for (x1, y1), (x2, y2) in SEGS:
        dx, dy = x2 - x1, y2 - y1
        L = math.hypot(dx, dy)
        t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / (L * L)))
        qx, qy = x1 + t * dx, y1 + t * dy
        d = math.hypot(px - qx, py - qy)
        if best is None or d < best[0]:
            # outward normal of a clockwise polygon in screen space
            best = (d, (dy / L, -dx / L), arc + t * L)
        arc += L
    d, n, s = best
    return (-d if inside(px, py) else d), n, s


LIGHT = (-0.6, -0.8)  # light from the top left, like the rest of the art


def draw(style: str) -> Image.Image:
    ramp = [hexc(c) for c in RAMPS[style]]
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    px = im.load()
    band = {}
    for y in range(H):
        for x in range(W):
            d, n, s = nearest(x + 0.5, y + 0.5)
            if -INNER - 0.5 < d <= OUTER:
                band[(x, y)] = (d, n, s)
    for (x, y), (d, n, s) in band.items():
        if d > OUTER - 1 or d <= -INNER + 0.5:
            px[x, y] = (*OUTLINE, 255)
            continue
        facing = n[0] * LIGHT[0] + n[1] * LIGHT[1]  # >0: the edge faces the light
        t = (d + INNER) / (INNER + OUTER)  # 0 inner .. 1 outer
        outer_half = t > 0.5
        lvl = 2 + (1 if facing > 0.3 else -1 if facing < -0.3 else 0) * (1 if outer_half else -1)
        if abs(t - 0.5) < 0.17 and facing > 0.3:  # the ridge catches the light
            lvl += 1
        px[x, y] = (*ramp[max(0, min(len(ramp) - 2, lvl))], 255)

    def put(x, y, c):
        if (x, y) in band:
            px[x, y] = (*c, 255)

    # Points along the band's middle, every `step` px of the perimeter.
    def ridge_points(step, offset=0.0):
        pts = []
        for (x, y), (d, n, s) in band.items():
            if 0.0 <= d < 1.0 and (s - offset) % step < 1.0:
                pts.append((x, y, s))
        return pts

    top_mid = (W // 2, WIN[1] + 1)
    if style == "iron":
        for x, y, _ in ridge_points(9, 4):
            put(x, y, ramp[5])
            put(x + 1, y + 1, ramp[0])
        for cx, cy in [(WIN[0] + 1, WIN[1] + 1), (WIN[0] + WIN[2] - 2, WIN[1] + 1), top_mid]:
            plate(px, cx, cy, ramp)
    elif style == "gilt":
        for x, y, _ in ridge_points(4, 2):
            put(x, y, ramp[1])  # engraving
        for cx, cy in [top_mid, (WIN[0] + 1, WIN[1] + 1), (WIN[0] + WIN[2] - 2, WIN[1] + 1), (W // 2, WIN[1] + WIN[3] - 1)]:
            gem(px, cx, cy, [hexc(c) for c in CRIMSON])
    elif style == "bone":
        for (x, y), (d, n, s) in band.items():
            if -INNER + 0.5 < d <= OUTER - 1 and s % 6 < 1.0:
                px[x, y] = (*ramp[0], 255)  # the joints between the bones
        for x, y, _ in ridge_points(6, 3):
            put(x, y, ramp[5])
        skull(px, *top_mid, ramp)
    elif style == "ember":
        glow = [hexc(c) for c in GLOW]
        rng = 7
        for x, y, s in ridge_points(5, 1):
            rng = (rng * 1103515245 + 12345) & 0x7FFFFFFF
            if rng % 5 == 0:
                continue
            put(x, y, glow[1])
            nx, ny = (x + 1, y) if rng % 2 else (x, y + 1)
            put(nx, ny, glow[0])
            if rng % 3 == 0:
                put(x, y, glow[2])
        gem(px, *top_mid, glow)
    return im


def plate(px, cx, cy, ramp):
    """A 5x5 riveted square plate."""
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            edge = max(abs(dx), abs(dy)) == 2
            px[cx + dx, cy + dy] = (*(OUTLINE if edge else ramp[3]), 255)
    px[cx - 1, cy - 1] = (*ramp[4], 255)
    px[cx + 1, cy + 1] = (*ramp[1], 255)
    px[cx, cy] = (*ramp[5], 255)


SKULL = [
    ".#####.",
    "#hbbbb#",
    "#bobob#",
    "#bbbbb#",
    ".#b#b#.",
    "..###..",
]


def skull(px, cx, cy, ramp):
    """A 7x6 skull boss at the top of the bone frame."""
    for j, row in enumerate(SKULL):
        for i, ch in enumerate(row):
            x, y = cx - 3 + i, cy - 2 + j
            if ch == "#":
                px[x, y] = (*OUTLINE, 255)
            elif ch == "o":
                px[x, y] = (*ramp[0], 255)
            elif ch == "h":
                px[x, y] = (*ramp[5], 255)
            elif ch == "b":
                px[x, y] = (*ramp[4], 255)


def gem(px, cx, cy, cols):
    """A 5x5 diamond stud: outline, body, one highlight pixel (top left)."""
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            if abs(dx) + abs(dy) == 2:
                px[cx + dx, cy + dy] = (*OUTLINE, 255)
            elif abs(dx) + abs(dy) < 2:
                px[cx + dx, cy + dy] = (*cols[1], 255)
    px[cx - 1, cy] = (*cols[2], 255)
    px[cx + 1, cy] = (*cols[0], 255)
    px[cx, cy + 1] = (*cols[0], 255)


STYLES = ["iron", "gilt", "bone", "ember"]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for s in STYLES:
        draw(s).save(OUT / f"crest-{s}.png")
        print(f"wrote {(OUT / f'crest-{s}.png').relative_to(ROOT)}")


if __name__ == "__main__":
    main()
