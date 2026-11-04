#!/usr/bin/env python3
"""PixelLab generate-and-poll helper for Worldforge art.

Uses only the async flow (synchronous endpoints time out at the cloud proxy):
POST /generate-image-v2 -> background_job_id, then poll
GET /background-jobs/{id} until it completes. Every image is saved as a
numbered PNG plus a `_contact-sheet.png` (row-major grid, index labels) and a
`_job.json` record (prompt, size, seed, job id; image data stripped).

Auth is injected by the environment proxy, so the bearer token is a dummy
unless PIXELLAB_TOKEN is set.

Examples:
  # new generation (costs generations; be frugal)
  python3 tools/art/pixellab_gen.py generate \
      --prompt "dark fantasy pixel art, rusted iron lantern, item icon" \
      --width 32 --height 32 --out art/source/pixellab/icons-batch-02

  # collect an already-submitted job (free)
  python3 tools/art/pixellab_gen.py collect --job <uuid> \
      --out art/source/pixellab/some-batch --prompt "what was asked"

  # rebuild a contact sheet from a folder of PNGs
  python3 tools/art/pixellab_gen.py sheet art/source/pixellab/icons-batch-01

Requires Python 3.10+ and Pillow (only for contact sheets).
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = os.environ.get("PIXELLAB_API", "https://api.pixellab.ai/v2")
TOKEN = os.environ.get("PIXELLAB_TOKEN", "dummy")
POLL_SECONDS = 8
TIMEOUT_SECONDS = 15 * 60


def _request(method: str, path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{API}{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")[:500]
        raise SystemExit(f"{method} {path} failed: HTTP {err.code}: {detail}") from err


def submit(prompt: str, width: int, height: int, seed: int | None, no_background: bool) -> str:
    body: dict = {
        "description": prompt,
        "image_size": {"width": width, "height": height},
        "no_background": no_background,
    }
    if seed is not None:
        body["seed"] = seed
    resp = _request("POST", "/generate-image-v2", body)
    job_id = resp.get("background_job_id")
    if not job_id:
        raise SystemExit(f"No background_job_id in response: {json.dumps(resp)[:500]}")
    print(f"submitted job {job_id}", file=sys.stderr)
    return job_id


def poll(job_id: str) -> dict:
    deadline = time.monotonic() + TIMEOUT_SECONDS
    while True:
        job = _request("GET", f"/background-jobs/{job_id}")
        status = job.get("status")
        if status == "completed":
            return job
        if status in {"failed", "error", "cancelled", "expired"}:
            raise SystemExit(f"job {job_id} ended with status {status}: {json.dumps(job)[:500]}")
        if time.monotonic() > deadline:
            raise SystemExit(f"job {job_id} still {status} after {TIMEOUT_SECONDS}s")
        progress = (job.get("last_response") or {}).get("progress")
        print(f"job {job_id}: {status} {progress or ''}", file=sys.stderr)
        time.sleep(POLL_SECONDS)


def save(job: dict, out: Path, meta: dict) -> list[Path]:
    out.mkdir(parents=True, exist_ok=True)
    images = (job.get("last_response") or {}).get("images") or []
    if not images:
        raise SystemExit(f"job {job.get('id')} completed without images")
    pad = max(2, len(str(len(images) - 1)))
    paths = []
    for i, img in enumerate(images):
        path = out / f"{i:0{pad}d}.png"
        path.write_bytes(base64.b64decode(img["base64"]))
        paths.append(path)
    last = job.get("last_response") or {}
    record = {
        **meta,
        "job_id": job.get("id"),
        "created_at": job.get("created_at"),
        "seed": last.get("seed"),
        "generations": (job.get("usage") or {}).get("generations"),
        "count": len(images),
        "width": images[0].get("width"),
        "height": images[0].get("height"),
    }
    (out / "_job.json").write_text(json.dumps(record, indent=2) + "\n")
    return paths


def contact_sheet(paths: list[Path], dest: Path, max_cell: int = 128) -> Path:
    """Row-major grid with index labels; small sprites are integer-upscaled."""
    from PIL import Image, ImageDraw

    imgs = [Image.open(p).convert("RGBA") for p in paths]
    w = max(i.width for i in imgs)
    h = max(i.height for i in imgs)
    scale = max(1, max_cell // max(w, h))
    cols = math.ceil(math.sqrt(len(imgs)))
    rows = math.ceil(len(imgs) / cols)
    label_h, gap = 12, 4
    cw, ch = w * scale, h * scale
    sheet = Image.new(
        "RGBA",
        (cols * (cw + gap) + gap, rows * (ch + label_h + gap) + gap),
        (24, 21, 19, 255),
    )
    draw = ImageDraw.Draw(sheet)
    for n, (img, p) in enumerate(zip(imgs, paths)):
        x = gap + (n % cols) * (cw + gap)
        y = gap + (n // cols) * (ch + label_h + gap)
        draw.rectangle([x, y + label_h, x + cw - 1, y + label_h + ch - 1], fill=(44, 39, 35, 255))
        big = img.resize((img.width * scale, img.height * scale), Image.NEAREST)
        sheet.alpha_composite(big, (x, y + label_h))
        draw.text((x + 1, y), p.stem, fill=(200, 170, 110, 255))
    sheet.save(dest)
    return dest


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("generate", help="submit a new job, poll, save, contact sheet")
    g.add_argument("--prompt", required=True)
    g.add_argument("--width", type=int, required=True)
    g.add_argument("--height", type=int, required=True)
    g.add_argument("--seed", type=int)
    g.add_argument("--keep-background", action="store_true", help="do not request transparency")
    g.add_argument("--out", type=Path, required=True)

    c = sub.add_parser("collect", help="poll an existing job id, save, contact sheet")
    c.add_argument("--job", required=True)
    c.add_argument("--prompt", default=None, help="record the prompt used (API does not return it)")
    c.add_argument("--out", type=Path, required=True)

    s = sub.add_parser("sheet", help="(re)build _contact-sheet.png from NN.png files in a folder")
    s.add_argument("folder", type=Path)

    args = ap.parse_args()
    if args.cmd == "sheet":
        paths = sorted(p for p in args.folder.glob("*.png") if not p.name.startswith("_"))
        print(contact_sheet(paths, args.folder / "_contact-sheet.png"))
        return
    if args.cmd == "generate":
        job_id = submit(args.prompt, args.width, args.height, args.seed, not args.keep_background)
        meta = {"prompt": args.prompt}
    else:
        job_id = args.job
        meta = {"prompt": args.prompt}
    job = poll(job_id)
    paths = save(job, args.out, meta)
    if len(paths) > 1:
        contact_sheet(paths, args.out / "_contact-sheet.png")
    print(args.out)


if __name__ == "__main__":
    main()
