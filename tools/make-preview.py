#!/usr/bin/env python3
"""Render docs/preview.html into the README preview GIF with a headless browser.

Why a browser: the widget's artwork is an inline SVG with CSS keyframes, so the
only faithful way to show it is to let a real engine run it. This script drives
Chromium/Edge headless once per frame (`--virtual-time-budget` advances the
animation clock), then assembles the frames into a looping GIF.

Typical use, from the repository root:

    python tools/make-preview.py                       # auto-detects a browser
    python tools/make-preview.py --browser "/path/to/chrome"
    python tools/make-preview.py --width 800 --frames 16

The frames are cropped to the widget stage (900x520 CSS px at 2x device scale)
so window chrome never leaks in. Requires Pillow; a browser with --headless=new
(Edge 79+, Chrome 112+, Chromium).
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover - friendly hint beats a traceback
    raise SystemExit("Pillow is required: pip install pillow")

# The stage is 900x520 CSS px and we render at device scale 2, then crop to that.
STAGE_CSS = (900, 520)
DEVICE_SCALE = 2
# Outer window height adds ~89 px of window decoration above the 520 px viewport.
WINDOW_DECORATION = 89

BROWSER_CANDIDATES = (
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
)


def find_browser(explicit: str | None) -> str:
    if explicit:
        if Path(explicit).exists() or shutil.which(explicit):
            return explicit
        raise SystemExit("browser not found: " + explicit)
    for candidate in BROWSER_CANDIDATES:
        if Path(candidate).exists():
            return candidate
        found = shutil.which(candidate)
        if found:
            return found
    raise SystemExit("no Chromium-based browser found; pass --browser")


def render_frames(browser: str, html: Path, out_dir: Path, count: int, step_ms: int) -> list[Path]:
    width = STAGE_CSS[0] * DEVICE_SCALE
    height = (STAGE_CSS[1] + WINDOW_DECORATION) * DEVICE_SCALE
    profile = out_dir / "profile"
    paths = []
    for index in range(count):
        budget = step_ms * (index + 1)
        shot = out_dir / ("f%02d.png" % (index + 1))
        command = [
            browser,
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--no-first-run",
            "--user-data-dir=" + str(profile),
            "--force-device-scale-factor=%d" % DEVICE_SCALE,
            "--window-size=%d,%d" % ((STAGE_CSS[0]),
                                     STAGE_CSS[1] + WINDOW_DECORATION),
            "--virtual-time-budget=%d" % budget,
            "--screenshot=" + str(shot),
            html.as_uri(),
        ]
        subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        if not shot.exists():
            raise SystemExit("frame %d failed to render (budget %d ms)" % (index + 1, budget))
        paths.append(shot)
    return paths


def build_gif(frames: list[Path], out_path: Path, width: int, colors: int, duration_ms: int) -> None:
    box = (0, 0, STAGE_CSS[0] * DEVICE_SCALE, STAGE_CSS[1] * DEVICE_SCALE)
    height = round(width * STAGE_CSS[1] / STAGE_CSS[0])
    images = [
        Image.open(path).convert("RGB").crop(box).resize((width, height), Image.LANCZOS)
        for path in frames
    ]

    # One palette learned from every frame together, so the background gradient
    # does not starve the artwork's colours (the gold coin, the blush).
    strip = Image.new("RGB", (width, height * len(images)))
    for index, image in enumerate(images):
        strip.paste(image, (0, height * index))
    reference = strip.quantize(colors=colors, method=Image.MEDIANCUT)

    # Flat cartoon shapes read better without dithering noise.
    paletted = [image.quantize(palette=reference, dither=Image.Dither.NONE) for image in images]
    paletted[0].save(
        out_path,
        save_all=True,
        append_images=paletted[1:],
        duration=duration_ms,
        loop=0,
        optimize=True,
        disposal=2,
    )


def main() -> int:
    repo = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="Render the README preview GIF.")
    parser.add_argument("--browser", default=None, help="Chromium-based browser executable")
    parser.add_argument("--html", default=str(repo / "docs" / "preview.html"))
    parser.add_argument("--out", default=str(repo / "docs" / "preview.gif"))
    parser.add_argument("--frames", type=int, default=12, help="number of frames (default 12)")
    parser.add_argument("--step", type=int, default=300, help="ms between frames (default 300)")
    parser.add_argument("--width", type=int, default=640, help="output width in px (default 640)")
    parser.add_argument("--colors", type=int, default=256, help="palette size (default 256)")
    args = parser.parse_args()

    html = Path(args.html).resolve()
    if not html.exists():
        raise SystemExit("html not found: " + str(html))
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    browser = find_browser(args.browser)
    with tempfile.TemporaryDirectory(prefix="bw-preview-") as tmp:
        frames = render_frames(browser, html, Path(tmp), args.frames, args.step)
        build_gif(frames, out_path, args.width, args.colors, args.step)

    size_kb = os.path.getsize(out_path) / 1024
    print("%d frames -> %s (%.1f KB)" % (len(range(args.frames)), out_path, size_kb))
    return 0


if __name__ == "__main__":
    sys.exit(main())
