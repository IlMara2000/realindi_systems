#!/usr/bin/env python3
"""Genera le immagini Open Graph (1200×630) di home e link-in-bio.

Il sito è statico: non c'è una route che produce immagini, quindi le due card si
generano una volta e si committano in public/assets/og/. Serve Pillow, non un
browser: così il risultato è deterministico anche su una macchina senza display.

Uso:
    python3 scripts/og-images.py            # scrive public/assets/og/{home,bio}.png
"""

from __future__ import annotations

import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover - dipende dall'ambiente
    sys.exit("Pillow non è installato: pip install pillow (oppure bash scripts/og-images.sh).")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "assets", "og")

# Font di sistema: il primo che esiste vince. Non serve distribuire font con il
# progetto, perché l'immagine finale viene committata.
FONTS = {
    "bold": [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/HelveticaNeue.ttc",
        "/System/Library/Fonts/SFNS.ttf",
    ],
    "regular": [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/HelveticaNeue.ttc",
        "/System/Library/Fonts/SFNS.ttf",
    ],
}

W, H, M = 1200, 630, 72


def font(kind: str, size: int):
    for path in FONTS[kind]:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def tracked(draw: ImageDraw.ImageDraw, xy, text: str, f, fill, tracking: float = 0) -> None:
    """Testo con spaziatura tra le lettere: Pillow non la supporta da sola."""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=f, fill=fill)
        x += f.getlength(ch) + tracking


def blend(fg, bg, alpha: float):
    return tuple(int(fg[i] * alpha + bg[i] * (1 - alpha)) for i in range(3))


def home() -> None:
    bg = (233, 237, 244)  # --surface
    ink = (20, 20, 24)  # --ink
    muted = (91, 100, 115)  # --muted
    accent = (255, 106, 26)  # --accent

    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)

    d.rectangle([M, 62, M + 44, 106], fill=accent)
    tracked(d, (M + 60, 72), "REALINDI SYSTEMS", font("bold", 22), ink, 3)
    tracked(d, (M, 236), "SVILUPPO SOFTWARE & AUTOMAZIONI", font("bold", 17), muted, 4)

    f_title = font("bold", 78)
    line1 = "SOFTWARE SU MISURA,"
    line2 = "FATTO PER ESSERE USATO."
    top = 282
    d.text((M, top), line1, font=f_title, fill=ink)

    # Evidenziatore sulla seconda riga, come `.hero h1 em` nel sito.
    width = f_title.getlength(line2)
    d.rectangle(
        [M - 4, top + 84 + 60, M + width + 4, top + 84 + 82],
        fill=blend(accent, bg, 0.38),
    )
    d.text((M, top + 84), line2, font=f_title, fill=ink)

    d.rectangle([M, 540, W - M, 542], fill=(195, 204, 219))
    f_small = font("regular", 19)
    d.text((M, 558), "Gestionali · CRM · Automazioni · Web app", font=f_small, fill=muted)
    right = "realindi.it"
    d.text((W - M - f_small.getlength(right), 558), right, font=f_small, fill=muted)

    img.save(os.path.join(OUT, "home.png"), optimize=True)


def bio() -> None:
    bg = (20, 20, 24)
    fg = (233, 237, 244)
    dim = (185, 190, 200)
    accent = (255, 140, 66)

    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)

    d.rectangle([M, 62, M + 44, 106], fill=(255, 106, 26))
    tracked(d, (M + 60, 72), "LINK IN BIO", font("bold", 19), accent, 4)

    d.text((M, 268), "REALINDI SYSTEMS", font=font("bold", 76), fill=fg)

    f_tag = font("regular", 27)
    d.text((M, 380), "Sviluppo software, gestionali, CRM,", font=f_tag, fill=dim)
    d.text((M, 418), "automazioni e consulenza su misura.", font=f_tag, fill=dim)

    d.rectangle([M, 540, W - M, 542], fill=(58, 63, 74))
    f_small = font("regular", 19)
    d.text((M, 558), "info@realindi.it", font=f_small, fill=(140, 146, 158))
    right = "realindi.it/bio"
    d.text((W - M - f_small.getlength(right), 558), right, font=f_small, fill=(140, 146, 158))

    img.save(os.path.join(OUT, "bio.png"), optimize=True)


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    home()
    bio()
    for name in ("home", "bio"):
        path = os.path.join(OUT, f"{name}.png")
        with Image.open(path) as check:
            print(f"scritto public/assets/og/{name}.png ({check.width}×{check.height})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
