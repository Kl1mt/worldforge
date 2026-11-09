#!/usr/bin/env python3
"""PixelLab frame-animation helper (ticket A.14).

Async flow only: POST /animate-with-text-v3 -> background_job_id, then poll
GET /background-jobs/{id} every 8 s. Saves each frame as `NN.png`, a
`_contact-sheet.png` (one row, ×2) and `_job.json` (action, source frame,
frame count, seed, job id; image data stripped). Auth is injected by the
cloud proxy, so the token is a dummy unless PIXELLAB_TOKEN is set.

  python3 tools/art/pixellab_animate.py generate \
      --first-frame apps/web/public/assets/characters/warrior.png \
      --action "breathes calmly, then slashes the sword forward" \
      --frames 12 --out art/source/pixellab/anim-warrior-01

  python3 tools/art/pixellab_animate.py collect --job <uuid> --first-frame ... --action ... --out ...
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

API = os.environ.get("PIXELLAB_API", "https://api.pixellab.ai/v2")
TOKEN = os.environ.get("PIXELLAB_TOKEN", "dummy")


def _request(method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(
        f"{API}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read())


def _b64(path: str) -> dict:
    return {"type": "base64", "base64": base64.b64encode(Path(path).read_bytes()).decode(), "format": "png"}


def _poll(job_id: str) -> dict:
    deadline = time.time() + 15 * 60
    while time.time() < deadline:
        job = _request("GET", f"/background-jobs/{job_id}")
        status = job.get("status")
        print(f"  {job_id}: {status}", file=sys.stderr)
        if status == "completed":
            return job
        if status == "failed":
            raise SystemExit(f"job failed: {json.dumps(job)[:500]}")
        time.sleep(8)
    raise SystemExit("timed out")


def _save(job: dict, args: argparse.Namespace) -> None:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    images = job.get("last_response", {}).get("images", [])
    for i, img in enumerate(images):
        (out / f"{i:02d}.png").write_bytes(base64.b64decode(img["base64"]))
    record = {
        "endpoint": "animate-with-text-v3",
        "action": args.action,
        "first_frame": args.first_frame,
        "frame_count": len(images),
        "job_id": job.get("id") or args.job,
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "seed": args.seed,
        "loop": getattr(args, "loop", False),
        "usage": job.get("usage") or job.get("last_response", {}).get("usage"),
    }
    (out / "_job.json").write_text(json.dumps(record, indent=2) + "\n")
    sheet(out)
    print(f"saved {len(images)} frames to {out}")


def sheet(folder: Path, scale: int = 2) -> None:
    from PIL import Image

    frames = [Image.open(p).convert("RGBA") for p in sorted(folder.glob("[0-9][0-9].png"))]
    if not frames:
        return
    w, h = frames[0].size
    pad = 4
    canvas = Image.new("RGBA", ((w * scale + pad) * len(frames) + pad, h * scale + 2 * pad), (36, 31, 27, 255))
    for i, f in enumerate(frames):
        big = f.resize((w * scale, h * scale), Image.NEAREST)
        canvas.alpha_composite(big, (pad + i * (w * scale + pad), pad))
    canvas.save(folder / "_contact-sheet.png")


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("generate", "collect"):
        p = sub.add_parser(name)
        p.add_argument("--first-frame", required=True)
        p.add_argument("--action", required=True)
        p.add_argument("--frames", type=int, default=8)
        p.add_argument("--seed", type=int, default=0)
        p.add_argument("--out", required=True)
        p.add_argument("--loop", action="store_true", help="send the first frame as last_frame too")
        if name == "collect":
            p.add_argument("--job", required=True)
    s = sub.add_parser("sheet")
    s.add_argument("folder")
    args = ap.parse_args()
    if args.cmd == "sheet":
        sheet(Path(args.folder))
        return
    if args.cmd == "generate":
        body = {
            "first_frame": _b64(args.first_frame),
            "action": args.action,
            "frame_count": args.frames,
            "seed": args.seed,
            "no_background": True,
        }
        if args.loop:
            body["last_frame"] = _b64(args.first_frame)
        res = _request("POST", "/animate-with-text-v3", body)
        args.job = res["background_job_id"]
        print(f"submitted {args.job}", file=sys.stderr)
    _save(_poll(args.job), args)


if __name__ == "__main__":
    main()
