"""Render web/icon.svg to web/icon.ico for the executable.

Run only when the icon changes. The .ico is committed, so a build needs nothing
but PyInstaller. Pillow cannot read SVG, so the three rectangles are redrawn
here; keep them in step with web/icon.svg by hand.
"""
import os
from PIL import Image, ImageDraw

SS = 16          # supersample factor, so the rounded corners come out clean
SIZES = [256, 128, 64, 48, 32, 24, 16]
SHAPES = [  # x, y, w, h, radius, fill  -- the viewBox is 32x32
    (1, 1, 18, 30, 3, "#3b82f6"),
    (21, 1, 10, 17, 3, "#f59e0b"),
    (21, 20, 10, 11, 3, "#10b981"),
]


def render(px):
    big = px * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    k = big / 32
    for x, y, w, h, r, fill in SHAPES:
        d.rounded_rectangle([x * k, y * k, (x + w) * k - 1, (y + h) * k - 1],
                            radius=r * k, fill=fill)
    return img.resize((px, px), Image.LANCZOS)


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web", "icon.ico")
    frames = [render(s) for s in SIZES]
    frames[0].save(out, format="ICO", sizes=[(s, s) for s in SIZES], append_images=frames[1:])
    print("wrote %s (%d bytes, sizes %s)" % (out, os.path.getsize(out), SIZES))
