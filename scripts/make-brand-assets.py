#!/usr/bin/env python3
"""Genera gli asset web del marchio a partire dai file originali REALINDI.

Sorgenti (in public/assets/brand/):
  logo-symbol.png      simbolo R nera + parallelogramma arancione, fondo trasparente
  logo-badge.png       simbolo sopra il logotipo REALINDI / SYSTEMS (quadrato)
  logo-horizontal.png  lockup orizzontale simbolo + logotipo

Output (in public/assets/):
  logo-realindi.png    simbolo ritagliato, quadrato, trasparente, 512px
  favicon-32.png       piastrella bianca arrotondata, 32px
  favicon-192.png      piastrella bianca arrotondata, 192px (Android/PWA)
  app-touch.png        piastrella bianca piena, 180px (iOS home screen)

Uso: python3 scripts/make-brand-assets.py
"""
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "public" / "assets" / "brand"
OUT = ROOT / "public" / "assets"


def trimmed_symbol(path: Path) -> Image.Image:
    """Ritaglia il margine attorno al simbolo, qualunque sia il fondo."""
    img = Image.open(path).convert("RGBA")
    corner = img.getpixel((0, 0))
    if corner[3] < 10:
        bbox = img.split()[3].getbbox()
    else:
        bg = Image.new("RGBA", img.size, corner)
        diff = ImageChops.difference(img, bg).convert("L").point(lambda v: 255 if v > 12 else 0)
        bbox = diff.getbbox()
    if not bbox:
        raise SystemExit(f"nessun segno trovato in {path}")
    return img.crop(bbox)


def squared(img: Image.Image, margin: float) -> Image.Image:
    """Porta il ritaglio a un quadrato con un margine uniforme (frazione del lato)."""
    w, h = img.size
    side = int(max(w, h) * (1 + 2 * margin))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(img, ((side - w) // 2, (side - h) // 2), img)
    return canvas


def resized(img: Image.Image, size: int) -> Image.Image:
    return img.resize((size, size), Image.LANCZOS)


def tile(symbol: Image.Image, size: int, *, radius_ratio: float, inset: float) -> Image.Image:
    """Piastrella bianca (arrotondata se radius_ratio > 0) con il simbolo centrato."""
    scale = 4  # disegna grande e riduci: bordi puliti anche a 32px
    big = size * scale
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    if radius_ratio > 0:
        draw.rounded_rectangle((0, 0, big - 1, big - 1), radius=int(big * radius_ratio), fill=(255, 255, 255, 255))
    else:
        draw.rectangle((0, 0, big - 1, big - 1), fill=(255, 255, 255, 255))
    inner = int(big * (1 - 2 * inset))
    mark = resized(symbol, inner)
    canvas.paste(mark, ((big - inner) // 2, (big - inner) // 2), mark)
    return resized(canvas, size)


def main() -> None:
    symbol = trimmed_symbol(SRC / "logo-symbol.png")

    # Marchio per header, /bio e CRM: quadrato trasparente e nitido a ogni misura.
    squared(symbol, 0.04).resize((512, 512), Image.LANCZOS).save(OUT / "logo-realindi.png", optimize=True)

    # Icone: piastrella bianca, simbolo dentro con aria attorno.
    tile(symbol, 32, radius_ratio=0.22, inset=0.10).save(OUT / "favicon-32.png", optimize=True)
    tile(symbol, 192, radius_ratio=0.22, inset=0.10).save(OUT / "favicon-192.png", optimize=True)
    tile(symbol, 180, radius_ratio=0.0, inset=0.13).save(OUT / "app-touch.png", optimize=True)

    for name in ("logo-realindi.png", "favicon-32.png", "favicon-192.png", "app-touch.png"):
        p = OUT / name
        with Image.open(p) as im:
            print(f"{name}: {im.size[0]}x{im.size[1]} {p.stat().st_size // 1024}KB")


if __name__ == "__main__":
    main()
