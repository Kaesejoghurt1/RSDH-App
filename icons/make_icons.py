"""One-off generator for the PWA icons (ticket 04).

Draws a simple fog/mist glyph (three rounded bars) on a dark background.
Uses only the Python standard library (no Pillow): builds the PNG with
zlib + struct by hand.
"""

import struct
import sys
import zlib


def png_chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def make_png(size: int, path: str) -> None:
    bg = (26, 26, 46)        # #1a1a2e
    bar = (79, 140, 255)     # #4f8cff
    edge = size // 32 or 1

    rows = []
    for y in range(size):
        row = bytearray()
        row.append(0)  # filter: none
        for x in range(size):
            color = bg
            for i, (y0f, y1f, x0f, x1f) in enumerate(
                [(0.30, 0.42, 0.18, 0.72), (0.46, 0.58, 0.10, 0.82), (0.62, 0.74, 0.22, 0.66)]
            ):
                y0, y1 = int(y0f * size), int(y1f * size)
                x0, x1 = int(x0f * size), int(x1f * size)
                if y0 <= y < y1 and x0 <= x < x1:
                    # rounded ends: skip corner pixels
                    r = (y1 - y0) // 2
                    dy = min(abs(y - y0), abs(y - (y1 - 1)))
                    dx = min(abs(x - x0), abs(x - (x1 - 1)))
                    if dy + dx >= r + edge:
                        continue
                    color = bar
                    break
            row.extend(color)
        rows.append(bytes(row))

    raw = b"".join(rows)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", ihdr)
        + png_chunk(b"IDAT", zlib.compress(raw, 9))
        + png_chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)
    print(f"{path}: {size}x{size}, {len(png)} bytes")


if __name__ == "__main__":
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    make_png(192, f"{out_dir}/icon-192.png")
    make_png(512, f"{out_dir}/icon-512.png")
