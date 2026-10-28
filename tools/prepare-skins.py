"""
Build or validate the whale widget's skin assets.

This is the portable version of the tool: it takes ordinary image files (PNG /
WebP / JPEG / GIF) and turns them into widget frames — trimmed to the artwork,
centred on a square transparent canvas, resized, and saved as an optimised PNG
next to a `skin.json` the widget discovers.

usage:
  python prepare-skins.py --list
  python prepare-skins.py --check
  python prepare-skins.py --skin maid-blue --name "女仆小鲸鱼" --accent "#4D6BFE" \
      --frame idle=raw/idle.png --frame happy=raw/happy.png --frame work=raw/work.png
  python prepare-skins.py --skin my-skin --name "我的皮肤" --from-dir ./my-art

Notes:
  * A frame that is fully opaque gets its flat border colour keyed out with a
    border flood fill (only the region reachable from the edge, so interior dark
    areas survive). Pass --opaque to keep the background instead.
  * Mood names the widget understands: idle, happy, work, excited, worried,
    sleep, error. A missing mood falls back to idle in the widget.
  * --from-dir maps files literally named <mood>.<ext>; a lone image becomes idle.
  * Without --assets the package's assets directory is located by probing, so the
    tool works from the shipped kit layout (tools/ next to the package) as well as
    from a source checkout (tools/ inside the package). BALANCE_WHALE_DIR wins.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import deque
from glob import glob

import numpy as np
from PIL import Image, ImageFilter

MOODS = ("idle", "happy", "work", "excited", "worried", "sleep", "error")
IMAGE_EXTENSIONS = (".png", ".webp", ".jpg", ".jpeg", ".gif")
DEFAULT_CANVAS = 256
MARGIN_RATIO = 0.045
HERE = os.path.dirname(os.path.abspath(__file__))


def looks_like_package(path: str) -> bool:
    return (os.path.isfile(os.path.join(path, "package.json"))
            and os.path.isfile(os.path.join(path, "index.js")))


def default_assets_dir() -> str:
    """Find <package>/assets the same way the smoke script finds the package.

    An explicit BALANCE_WHALE_DIR wins; then the shipped kit layout (this file in
    `tools/` *next to* the package) and a source checkout (this file in `tools/`
    *inside* the package) are probed by manifest.
    """
    env = os.environ.get("BALANCE_WHALE_DIR", "").strip()
    candidates = [env] if env else []
    candidates += [
        os.path.join(HERE, "..", "dsh-balance-whale"),
        os.path.join(HERE, ".."),
        os.path.join(HERE, "..", "..", "dsh-balance-whale"),
    ]
    for candidate in candidates:
        package = os.path.normpath(candidate)
        if looks_like_package(package):
            return os.path.join(package, "assets")
    return os.path.normpath(os.path.join(HERE, "..", "dsh-balance-whale", "assets"))


DEFAULT_ASSETS = default_assets_dir()


# --------------------------------------------------------------------------- #
# image work


def border_colour(array: np.ndarray) -> tuple[int, int, int] | None:
    """The dominant opaque border colour, or None when the border is not flat.

    Most uploads are already cut out; an opaque one is a character on a flat
    plate, which is what this detects so the plate can be keyed out.
    """
    height, width = array.shape[:2]
    edge = np.concatenate([
        array[0, :, :],
        array[height - 1, :, :],
        array[:, 0, :],
        array[:, width - 1, :],
    ]).astype(np.int16)
    opaque = edge[edge[:, 3] > 200][:, :3]
    if len(opaque) == 0:
        return None
    median = np.median(opaque, axis=0)
    close = np.abs(opaque - median).max(axis=1) <= 12
    if close.mean() < 0.9:
        return None
    return int(median[0]), int(median[1]), int(median[2])


def key_out_background(image: Image.Image, colour: tuple[int, int, int], tolerance: int = 58) -> Image.Image:
    """Make a flat background transparent with a border flood fill.

    Only the region reachable from the border within `tolerance` is removed, so a
    dark interior (hair, ribbons) survives. The matte is then pulled in by one
    pixel and softened, because a crisp cut against dark lineart leaves a rim.
    """
    rgba = image.convert("RGBA")
    array = np.asarray(rgba).astype(np.int16)
    height, width = array.shape[:2]
    distance = np.abs(array[:, :, :3] - np.array(colour, dtype=np.int16)).max(axis=2)
    flat = distance <= tolerance
    reachable = np.zeros((height, width), dtype=bool)
    queue: deque[tuple[int, int]] = deque()

    def seed(y: int, x: int) -> None:
        if flat[y, x] and not reachable[y, x]:
            reachable[y, x] = True
            queue.append((y, x))

    for x in range(width):
        seed(0, x)
        seed(height - 1, x)
    for y in range(height):
        seed(y, 0)
        seed(y, width - 1)

    while queue:
        y, x = queue.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < height and 0 <= nx < width and flat[ny, nx] and not reachable[ny, nx]:
                reachable[ny, nx] = True
                queue.append((ny, nx))

    alpha = np.asarray(rgba.split()[-1]).astype(np.int16)
    alpha[reachable] = 0
    matte = Image.fromarray(alpha.astype(np.uint8), mode="L")
    matte = matte.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.6))
    out = rgba.copy()
    out.putalpha(matte)
    return out


def trim_and_fit(image: Image.Image, canvas: int) -> Image.Image:
    """Trim to the visible art, centre it on a square transparent canvas, resize."""
    rgba = image.convert("RGBA")
    box = rgba.split()[-1].point(lambda value: 255 if value > 8 else 0).getbbox()
    if box is not None:
        rgba = rgba.crop(box)
    width, height = rgba.size
    side = max(width, height)
    margin = int(round(side * MARGIN_RATIO))
    total = side + margin * 2
    plate = Image.new("RGBA", (total, total), (0, 0, 0, 0))
    plate.paste(rgba, ((total - width) // 2, (total - height) // 2))
    return plate.resize((canvas, canvas), Image.LANCZOS)


def prepare_frame(path: str, canvas: int, opaque: bool) -> tuple[Image.Image, str]:
    """Turn one source image into a frame; also report what was done to it."""
    with Image.open(path) as opened:
        image = opened.convert("RGBA")
    note = "kept as is"
    if image.split()[-1].getextrema() == (255, 255) and not opaque:
        colour = border_colour(np.asarray(image).astype(np.int16))
        if colour is not None:
            image = key_out_background(image, colour)
            note = "keyed out background rgb" + str(colour)
        else:
            note = "opaque with a non-flat border; kept as is"
    return trim_and_fit(image, canvas), note


# --------------------------------------------------------------------------- #
# manifest work


def load_manifest(skin_dir: str) -> dict:
    """Read a skin manifest, or an empty one when the skin is new."""
    path = os.path.join(skin_dir, "skin.json")
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except Exception as error:  # noqa: BLE001 - reported to the user
        print("  ! could not read " + path + ": " + str(error))
        return {}


def write_manifest(skin_dir: str, manifest: dict) -> None:
    """Write a skin manifest with a stable key order."""
    ordered = {
        "id": manifest.get("id"),
        "name": manifest.get("name"),
        "accent": manifest.get("accent", "#4D6BFE"),
        "plate": manifest.get("plate"),
        "order": manifest.get("order", 60),
        "frames": manifest.get("frames", {}),
    }
    with open(os.path.join(skin_dir, "skin.json"), "w", encoding="utf-8") as handle:
        json.dump(ordered, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def parse_frames(pairs: list[str]) -> dict[str, str]:
    """Parse repeated --frame mood=path arguments."""
    frames: dict[str, str] = {}
    for pair in pairs:
        if "=" not in pair:
            raise SystemExit("--frame expects mood=path, got: " + pair)
        mood, path = pair.split("=", 1)
        mood = mood.strip().lower()
        if mood not in MOODS:
            raise SystemExit("unknown mood '" + mood + "'; known moods: " + ", ".join(MOODS))
        if not os.path.exists(path):
            raise SystemExit("frame file not found: " + path)
        frames[mood] = path
    return frames


def frames_from_dir(directory: str) -> dict[str, str]:
    """Map a directory of images onto moods by file name."""
    found: dict[str, str] = {}
    images = sorted(
        path for path in glob(os.path.join(directory, "*"))
        if os.path.splitext(path)[1].lower() in IMAGE_EXTENSIONS
    )
    for path in images:
        stem = os.path.splitext(os.path.basename(path))[0].lower()
        if stem in MOODS:
            found[stem] = path
    if not found and images:
        found["idle"] = images[0]
    return found


# --------------------------------------------------------------------------- #
# commands


def discover(assets: str, problems: list[str] | None = None) -> list[dict]:
    """Read every skin directory's manifest, sorted the way the host sorts them."""
    skins: list[dict] = []
    if not os.path.isdir(assets):
        if problems is not None:
            problems.append("assets directory not found: " + assets)
        return skins
    for name in sorted(os.listdir(assets)):
        skin_dir = os.path.join(assets, name)
        if not os.path.isdir(skin_dir):
            continue
        manifest_path = os.path.join(skin_dir, "skin.json")
        if not os.path.exists(manifest_path):
            continue
        try:
            with open(manifest_path, "r", encoding="utf-8") as handle:
                manifest = json.load(handle)
        except Exception as error:  # noqa: BLE001
            if problems is not None:
                problems.append(manifest_path + ": invalid JSON (" + str(error) + ")")
            continue
        if not isinstance(manifest, dict):
            if problems is not None:
                problems.append(manifest_path + ": manifest is not an object")
            continue
        frames = manifest.get("frames") if isinstance(manifest.get("frames"), dict) else {}
        if not frames and problems is not None:
            problems.append(manifest_path + ": no frames declared")
        skins.append({
            "id": name,
            "name": manifest.get("name") or name,
            "accent": manifest.get("accent") or "#4D6BFE",
            "order": manifest.get("order") if isinstance(manifest.get("order"), (int, float)) else 60,
            "frames": {mood: file for mood, file in frames.items() if isinstance(file, str)},
        })
    skins.sort(key=lambda skin: (skin["order"], skin["id"]))
    return skins


def command_list(assets: str) -> int:
    """Print the registry as a table."""
    skins = discover(assets)
    if not skins:
        print("no skins under " + assets)
        return 1
    print(f"{'id':<16}{'name':<20}{'order':>6}  frames")
    for skin in skins:
        print(f"{skin['id']:<16}{skin['name']:<20}{skin['order']:>6}  " + ", ".join(sorted(skin["frames"])))
    print("\n" + str(len(skins)) + " skin(s) under " + assets)
    return 0


def command_check(assets: str) -> int:
    """Validate every manifest and its frames; non-zero exit on any problem."""
    problems: list[str] = []
    skins = discover(assets, problems)
    if not skins and not problems:
        # A clean checkout ships no art on purpose (only the built-in SVG whale),
        # so an empty assets/ is valid: nothing to validate.
        print("no local skins under " + assets + " (the built-in whale-classic needs no files)")
        print("all manifests and frames are valid")
        return 0
    for skin in skins:
        skin_dir = os.path.join(assets, skin["id"])
        manifest_path = os.path.join(skin_dir, "skin.json")
        for mood, file in sorted(skin["frames"].items()):
            if mood not in MOODS:
                problems.append(manifest_path + ": unknown mood '" + mood + "'")
            target = os.path.join(skin_dir, file)
            if not os.path.exists(target):
                problems.append(manifest_path + ": frame file missing: " + file)
                continue
            try:
                with Image.open(target) as image:
                    if image.width != image.height:
                        problems.append(target + ": not square (" + str(image.width) + "x" + str(image.height) + ")")
                    if image.width < 64:
                        problems.append(target + ": too small for a widget frame (" + str(image.width) + "px)")
                    if image.mode not in ("RGBA", "LA", "P"):
                        problems.append(target + ": no alpha channel (mode " + image.mode + ")")
            except Exception as error:  # noqa: BLE001
                problems.append(target + ": cannot open (" + str(error) + ")")
    print("checked " + str(len(skins)) + " skin(s): "
          + ", ".join([skin["id"] for skin in skins] + ["whale-classic (built in)"]))
    if problems:
        print("\nproblems:")
        for problem in problems:
            print("  ! " + problem)
        return 1
    print("all manifests and frames are valid")
    return 0


def command_build(args: argparse.Namespace) -> int:
    """Build one skin from explicit frames or a directory of images."""
    skin_id = args.skin.strip()
    if not skin_id or "/" in skin_id or "\\" in skin_id:
        raise SystemExit("--skin must be a plain directory name, e.g. my-skin")
    frames = parse_frames(args.frame or [])
    if args.from_dir:
        for mood, path in frames_from_dir(args.from_dir).items():
            frames.setdefault(mood, path)
    if not frames:
        raise SystemExit("nothing to build: pass --frame mood=path or --from-dir <directory>")

    skin_dir = os.path.join(args.assets, skin_id)
    os.makedirs(skin_dir, exist_ok=True)
    manifest = {} if args.replace else load_manifest(skin_dir)
    manifest["id"] = skin_id
    manifest["name"] = args.name or manifest.get("name") or skin_id
    manifest["accent"] = args.accent or manifest.get("accent") or "#4D6BFE"
    manifest["plate"] = args.plate if args.plate is not None else manifest.get("plate")
    manifest["order"] = args.order if args.order is not None else manifest.get("order", 60)
    stored = {} if args.replace else dict(manifest.get("frames", {}))

    print("building skin '" + skin_id + "' in " + skin_dir)
    for mood, source in sorted(frames.items()):
        image, note = prepare_frame(source, args.canvas, args.opaque)
        target = os.path.join(skin_dir, mood + ".png")
        image.save(target, "PNG", optimize=True)
        stored[mood] = mood + ".png"
        print("  " + mood.ljust(8) + " " + os.path.basename(source).ljust(24)
              + " -> " + mood + ".png  " + f"{os.path.getsize(target) / 1024:6.1f} KiB  ({note})")
    ordered_frames = {mood: stored[mood] for mood in MOODS if mood in stored}
    for mood, file in stored.items():
        ordered_frames.setdefault(mood, file)
    manifest["frames"] = ordered_frames
    write_manifest(skin_dir, manifest)
    print("wrote " + os.path.join(skin_dir, "skin.json") + " with moods: " + ", ".join(ordered_frames))
    print("the widget discovers it on the next /skins read (reload the page)")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build or validate whale widget skin assets.")
    parser.add_argument("--assets", default=DEFAULT_ASSETS,
                        help="assets directory (default: " + DEFAULT_ASSETS + ")")
    parser.add_argument("--list", action="store_true", help="list the discovered skins")
    parser.add_argument("--check", action="store_true", help="validate manifests and frames")
    parser.add_argument("--skin", help="skin directory name to build")
    parser.add_argument("--name", help="display name for the skin")
    parser.add_argument("--accent", help="accent colour used by the widget, e.g. #4D6BFE")
    parser.add_argument("--plate", help="optional plate colour behind the artwork")
    parser.add_argument("--order", type=int, help="picker order (lower comes first)")
    parser.add_argument("--frame", action="append", metavar="MOOD=PATH", help="one frame (repeatable)")
    parser.add_argument("--from-dir", help="map <mood>.<ext> files from a directory")
    parser.add_argument("--canvas", type=int, default=DEFAULT_CANVAS,
                        help="output size (default: " + str(DEFAULT_CANVAS) + ")")
    parser.add_argument("--opaque", action="store_true", help="keep an opaque background instead of keying it out")
    parser.add_argument("--replace", action="store_true", help="replace the manifest instead of merging into it")
    args = parser.parse_args(argv)

    if args.list:
        return command_list(args.assets)
    if args.check:
        return command_check(args.assets)
    if args.skin:
        return command_build(args)
    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
