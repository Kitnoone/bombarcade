"""Builds the casing layers from design/reference-terminal.png (sketch No. 2).

Only metal, bezels, aquila, lamps and the wax seal are taken from the sketch. Every glass
area is cut out: the field, text, timers and keys are live HTML/SVG in the app.

    python3 tools/build_assets.py
Requires Pillow, NumPy and OpenCV. The outputs in public/img/ are committed, so players
never need Python.
"""
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
REF = Image.open(ROOT / 'design' / 'reference-terminal.png').convert('RGBA')
OUT = ROOT / 'public' / 'img'
OUT.mkdir(parents=True, exist_ok=True)


def rounded(size, box, radius, feather=1.2):
    mask = Image.new('L', size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=radius, fill=255)
    return mask.filter(ImageFilter.GaussianBlur(feather)) if feather else mask


def cut_glass(img, box, radius):
    alpha = np.array(img.getchannel('A'), dtype=np.float32)
    hole = np.array(rounded(img.size, box, radius), dtype=np.float32) / 255
    img.putalpha(Image.fromarray((alpha * (1 - hole)).astype(np.uint8)))
    return img


def fade_edges(img, width=26):
    w, h = img.size
    ramp = lambda n: np.clip(np.minimum(np.arange(n), np.arange(n)[::-1]) / width, 0, 1)
    edge = np.outer(ramp(h), ramp(w))
    alpha = np.array(img.getchannel('A'), dtype=np.float32) * edge
    img.putalpha(Image.fromarray(alpha.astype(np.uint8)))
    return img


def tile(strip, extra, mirror=True, blend=14):
    """Fills `extra` columns from a plain bezel strip: mirrored tiles, or straight tiles with soft seams."""
    out = strip.astype(np.float32)
    flip = True
    while out.shape[1] < extra + blend:
        piece = (strip[:, ::-1] if (mirror and flip) else strip).astype(np.float32)
        flip = not flip
        if mirror or blend == 0:
            out = np.concatenate([out, piece], axis=1)
        else:
            k = np.linspace(0, 1, blend)[None, :, None]
            seam = out[:, -blend:] * (1 - k) + piece[:, :blend] * k
            out = np.concatenate([out[:, :-blend], seam, piece[:, blend:]], axis=1)
    return out[:, :extra].astype(np.uint8)


def widen(img, bands):
    """Widens the casing band by band, so the top and bottom bezels each stretch where they are plain.

    bands: list of (y0, y1, [(insert_x, (seg_a, seg_b), extra, mirror), ...]); inserts sorted by x.
    Every band must insert the same total number of columns so the side bezels stay aligned.
    """
    src = np.array(img)
    rows = []
    for y0, y1, inserts in bands:
        part, pieces, last = src[y0:y1], [], 0
        for at, (a, b), extra, mirror in sorted(inserts):
            pieces += [part[:, last:at], tile(part[:, a:b], extra, mirror)]
            last = at
        pieces.append(part[:, last:])
        rows.append(np.concatenate(pieces, axis=1))
    assert len({r.shape[1] for r in rows}) == 1, 'bands must widen equally'
    return Image.fromarray(np.concatenate(rows, axis=0))


def sharpen(img):
    return img.filter(ImageFilter.UnsharpMask(radius=1.4, percent=55, threshold=2))


# ---------------------------------------------------------------- TV casing (1920 x 1080 stage)
X0, Y0, X1, Y1 = 0, 70, 1246, 941
GLASS = (96, 152, 1164, 798)                     # glass inside the rim, in sketch pixels
tv = REF.crop((X0, Y0, X1, Y1))
tv = cut_glass(tv, (GLASS[0] - X0, GLASS[1] - Y0, GLASS[2] - X0, GLASS[3] - Y0), 24)
# The sketch casing is slightly asymmetric; the splits below put the aquila and the brass
# plate on the centre line of the 16:9 stage.
EXTRA_L, EXTRA_R = 116, 174             # top bezel, around the aquila plate
EXTRA_BL, EXTRA_BR = 133, 157           # bottom bezel, around the BOMBARCADE plate
TOP_BAND, BOTTOM_BAND = 140, 700        # crop rows: both band edges lie inside the glass
tv = widen(tv, [
    (0, TOP_BAND, [(345, (315, 375), EXTRA_L, True), (874, (858, 890), EXTRA_R, True)]),
    (TOP_BAND, BOTTOM_BAND, [(600, (600, 640), EXTRA_L + EXTRA_R, True)]),
    (BOTTOM_BAND, Y1 - Y0, [(437, (340, 435), EXTRA_BL, False), (874, (858, 890), EXTRA_BR, True)]),
])
scale = 1080 / tv.height
tv = tv.resize((round(tv.width * scale), 1080), Image.LANCZOS)
tv = fade_edges(sharpen(tv))
tv.save(OUT / 'tv-casing.webp', quality=90, method=6)
glass = {
    'width': tv.width, 'height': tv.height,
    'left': round((GLASS[0] - X0) * scale), 'top': round((GLASS[1] - Y0) * scale),
    'right': round((GLASS[2] - X0 + EXTRA_L + EXTRA_R) * scale), 'bottom': round((GLASS[3] - Y0) * scale),
    'radius': round(24 * scale),
    # Lamp centres for the CSS glow layers.
    'lamps': [[round((162 - X0) * scale), round((113 - Y0) * scale)], [round((1098 - X0 + EXTRA_L + EXTRA_R) * scale), round((113 - Y0) * scale)]],
}

# ---------------------------------------------------------------- phone casing (9-slice + overlays)
PX0, PY0, PX1, PY1 = 1253, 95, 1647, 880
PGLASS = (1301, 144, 1599, 775)
phone = REF.crop((PX0, PY0, PX1, PY1))
phone = cut_glass(phone, (PGLASS[0] - PX0, PGLASS[1] - PY0, PGLASS[2] - PX0, PGLASS[3] - PY0), 18)
p = np.array(phone)
SIDE, TOP, BOTTOM, MID = 137, 80, 115, 60
w, h = phone.size
corner_tl, corner_tr = p[:TOP, :SIDE], p[:TOP, w - SIDE:]
corner_bl, corner_br = p[h - BOTTOM:, :SIDE], p[h - BOTTOM:, w - SIDE:]
plain_top = p[:TOP, SIDE - 52:SIDE - 2]            # plain bar left of the aquila
plain_bottom = p[h - BOTTOM:, SIDE - 40:SIDE - 2]  # plain panel left of the vent grille
plain_side = p[330:390]                            # a stretch of side bezel without buttons
grid = np.zeros((TOP + MID + BOTTOM, SIDE * 2 + MID, 4), np.uint8)
fit = lambda a, width, height: np.array(Image.fromarray(a).resize((width, height), Image.LANCZOS))
grid[:TOP, :SIDE] = corner_tl
grid[:TOP, SIDE + MID:] = corner_tr
grid[TOP + MID:, :SIDE] = corner_bl
grid[TOP + MID:, SIDE + MID:] = corner_br
grid[:TOP, SIDE:SIDE + MID] = fit(plain_top, MID, TOP)
grid[TOP + MID:, SIDE:SIDE + MID] = fit(plain_bottom, MID, BOTTOM)
grid[TOP:TOP + MID, :SIDE] = fit(plain_side[:, :SIDE], SIDE, MID)
grid[TOP:TOP + MID, SIDE + MID:] = fit(plain_side[:, w - SIDE:], SIDE, MID)
Image.fromarray(grid).save(OUT / 'phone-casing.png', optimize=True)
REF.crop((1388, 102, 1512, 154)).save(OUT / 'phone-aquila.png', optimize=True)
REF.crop((1384, 790, 1516, 868)).save(OUT / 'phone-vent.png', optimize=True)
phone_meta = {
    'slice': [TOP, SIDE, BOTTOM, SIDE],
    'glass': [PGLASS[1] - PY0, PX1 - PGLASS[2], PY1 - PGLASS[3], PGLASS[0] - PX0],
}

# ---------------------------------------------------------------- aquila and wax seal cut-outs
def cutout(box, keep, min_area=40):
    crop = REF.crop(box).convert('RGB')
    arr = np.array(crop).astype(np.int16)
    mask = keep(arr).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask)
    for i in range(1, count):
        if stats[i, cv2.CC_STAT_AREA] < min_area: mask[labels == i] = 0
    mask = cv2.GaussianBlur(mask, (3, 3), 0)
    out = crop.convert('RGBA'); out.putalpha(Image.fromarray(mask))
    return out


gold = lambda a: (a[..., 0] > 95) & (a[..., 0] > a[..., 2] + 35) & (a[..., 1] > 60)
cutout((588, 95, 712, 146), gold, 60).save(OUT / 'aquila.png', optimize=True)


def seal_mask(a):
    h, w = a.shape[:2]
    yy, xx = np.mgrid[:h, :w]
    r2 = (xx - 38) ** 2 + (yy - 40) ** 2
    red = (a[..., 0] > a[..., 1] + 18) & (a[..., 0] > 50)
    wax = (r2 < 31 ** 2) | ((r2 < 38 ** 2) & red)
    ribbon_zone = (yy > 62) & (xx > 20) & (xx < 64)
    tan = (a[..., 0] > 80) & (a[..., 1] > 60) & (a[..., 2] < a[..., 0] - 5)
    return wax | (ribbon_zone & tan)
cutout((992, 797, 1069, 935), seal_mask, 25).save(OUT / 'seal.png', optimize=True)

(OUT / 'casing.json').write_text(json.dumps({'tv': glass, 'phone': phone_meta}, indent=2))
print(json.dumps({'tv': glass, 'phone': phone_meta}))
