#!/usr/bin/env python
"""Generate the PNG app icons Chrome needs to install ScalpAI as a real app.

Chrome will not mint a WebAPK from an SVG-only manifest, so the icons have to
exist as raster PNGs at 192 and 512. Drawn here in code rather than committed
as binaries so the colours stay tied to the dashboard's own palette and the
set can be regenerated after a restyle:

    python scripts/make_icons.py

Two variants are produced, because Android treats them differently:

* **any** — what Chrome shows when it wants the icon as-is. Rounded corners
  are baked in, since nothing else will round them.
* **maskable** — Android clips this to whatever shape the launcher uses, which
  can be a circle. Anything outside the centre 80% may be cut off, so the
  artwork is drawn smaller against a full-bleed background. Using the rounded
  version here would get its corners shaved off.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[1] / "public" / "icons"

BG = (4, 8, 16)             # #040810, the dashboard background
UP = (0, 230, 118)          # #00e676, its green
DOWN = (255, 82, 82)        # #ff5252, its red
GRID = (24, 38, 58)

#: Drawn at 4x and downsampled, which is cheaper than antialiasing by hand.
SS = 4


def _candles(d: ImageDraw.ImageDraw, size: int, scale: float) -> None:
    """Three ascending candlesticks, centred, occupying `scale` of the canvas.

    Kept to bold blocks with no text: at 48px in a launcher any more detail
    turns to mud.
    """
    span = size * scale
    left = (size - span) / 2
    top = (size - span) / 2

    def x(f: float) -> float:
        return left + span * f

    def y(f: float) -> float:
        return top + span * f

    # baseline, a hint of a chart floor
    d.rounded_rectangle(
        [x(0.02), y(0.93), x(0.98), y(0.97)],
        radius=span * 0.02, fill=GRID,
    )

    # (body top, body bottom, wick top, wick bottom, colour)
    bars = [
        (0.60, 0.84, 0.52, 0.90, DOWN),
        (0.38, 0.64, 0.30, 0.72, UP),
        (0.10, 0.44, 0.04, 0.52, UP),
    ]
    body_w = span * 0.20
    wick_w = span * 0.055
    for i, (bt, bb, wt, wb, colour) in enumerate(bars):
        cx = x(0.19 + i * 0.31)
        d.rounded_rectangle(
            [cx - wick_w / 2, y(wt), cx + wick_w / 2, y(wb)],
            radius=wick_w / 2, fill=colour,
        )
        d.rounded_rectangle(
            [cx - body_w / 2, y(bt), cx + body_w / 2, y(bb)],
            radius=span * 0.025, fill=colour,
        )


def render(size: int, maskable: bool) -> Image.Image:
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if maskable:
        # Full bleed: the launcher supplies the shape.
        d.rectangle([0, 0, big, big], fill=BG)
        _candles(d, big, 0.52)
    else:
        d.rounded_rectangle([0, 0, big - 1, big - 1],
                            radius=big * 0.22, fill=BG)
        _candles(d, big, 0.66)

    return img.resize((size, size), Image.LANCZOS)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    written = []

    for size in (192, 512):
        for maskable in (False, True):
            name = f"{'maskable' if maskable else 'icon'}-{size}.png"
            render(size, maskable).save(OUT / name)
            written.append(name)

    # iOS ignores the manifest and uses this. It also refuses transparency,
    # so the alpha is flattened onto the background rather than left to iOS,
    # which would otherwise fill it with black.
    apple = Image.new("RGB", (180, 180), BG)
    icon = render(180, maskable=False)
    apple.paste(icon, (0, 0), icon)
    apple.save(OUT / "apple-touch-icon.png")
    written.append("apple-touch-icon.png")

    # Browser tabs and the Chrome "recent" grid.
    render(32, maskable=False).save(OUT / "favicon-32.png")
    written.append("favicon-32.png")

    for name in written:
        print(f"  {OUT.relative_to(OUT.parents[2])}/{name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
