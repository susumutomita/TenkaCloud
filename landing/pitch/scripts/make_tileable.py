#!/usr/bin/env python3
"""Make a PNG horizontally tileable by crossfade-blending the left and right edges.

This intentionally avoids third-party dependencies (stdlib only: struct, zlib).
It imports read_png / write_png from remove_bg in the same directory, or
reimplements them inline if the import fails.

Usage:
    python3 make_tileable.py --input <in.png> --output <out.png> [--blend-pct 0.08]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def _import_helpers():
    """Try to import read_png/write_png from remove_bg sibling script."""
    here = Path(__file__).parent
    rb = here / "remove_bg.py"
    if rb.exists():
        import importlib.util
        spec = importlib.util.spec_from_file_location("remove_bg", rb)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.read_png, mod.write_png
    return None, None


def _inline_read_png(path: Path):
    import struct, zlib
    PNG_SIG = b"\x89PNG\r\n\x1a\n"
    data = path.read_bytes()
    if not data.startswith(PNG_SIG):
        raise ValueError(f"{path} is not a PNG")
    pos = len(PNG_SIG)
    width = height = color_type = bit_depth = None
    compressed = bytearray()
    while pos < len(data):
        length = struct.unpack(">I", data[pos:pos+4])[0]; pos += 4
        chunk_type = data[pos:pos+4]; pos += 4
        chunk = data[pos:pos+length]; pos += length + 4
        if chunk_type == b"IHDR":
            width, height, bit_depth, color_type, comp, filt, intl = struct.unpack(">IIBBBBB", chunk)
        elif chunk_type == b"IDAT":
            compressed.extend(chunk)
        elif chunk_type == b"IEND":
            break
    channels = 4 if color_type == 6 else 3
    stride = width * channels
    raw = zlib.decompress(bytes(compressed))
    rows, offset, prev = [], 0, [0]*stride
    for _ in range(height):
        ft = raw[offset]; offset += 1
        row_data = list(raw[offset:offset+stride]); offset += stride
        recon = row_data[:]
        if ft == 1:
            for i in range(channels, len(recon)): recon[i] = (recon[i] + recon[i-channels]) & 0xFF
        elif ft == 2:
            for i in range(len(recon)): recon[i] = (recon[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(len(recon)):
                a = recon[i-channels] if i >= channels else 0
                recon[i] = (recon[i] + (a + prev[i])//2) & 0xFF
        elif ft == 4:
            for i in range(len(recon)):
                a = recon[i-channels] if i >= channels else 0
                b_ = prev[i]; c_ = prev[i-channels] if i >= channels else 0
                p = a + b_ - c_; pa = abs(p-a); pb = abs(p-b_); pc = abs(p-c_)
                pr = a if pa<=pb and pa<=pc else (b_ if pb<=pc else c_)
                recon[i] = (recon[i] + pr) & 0xFF
        prev = recon
        pixels = []
        for x in range(width):
            base = x * channels
            if channels == 4:
                pixels.append(list(recon[base:base+4]))
            else:
                pixels.append(list(recon[base:base+3]) + [255])
        rows.append(pixels)
    return width, height, rows


def _inline_write_png(path: Path, width: int, height: int, rows):
    import struct, zlib
    PNG_SIG = b"\x89PNG\r\n\x1a\n"
    raw = bytearray()
    for row in rows:
        raw.append(0)
        for r, g, b, a in row:
            raw.extend([r, g, b, a])
    def chunk(kind, payload):
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind+payload)&0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = PNG_SIG + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    path.write_bytes(png)


def make_tileable(input_path: Path, output_path: Path, blend_pct: float = 0.08) -> None:
    read_png, write_png = _import_helpers()
    if read_png is None:
        read_png = _inline_read_png
        write_png = _inline_write_png

    width, height, rows = read_png(input_path)
    blend_w = max(1, int(width * blend_pct))

    out_rows = []
    for row in rows:
        new_row = [list(p) for p in row]

        for i in range(blend_w):
            # Weight: 0.0 at the outer edge, 1.0 at blend_w boundary
            t = i / blend_w  # left side: i=0 is leftmost edge

            left_px = new_row[i]
            right_px = new_row[width - blend_w + i]

            # Crossfade RGB: left edge blends in right-edge pixels for continuity
            for c in range(3):
                left_px[c] = round(left_px[c] * t + right_px[c] * (1.0 - t))

            # Alpha fade: outer edge (i=0) fades to 0
            left_px[3] = round(left_px[3] * t)

        for i in range(blend_w):
            t = i / blend_w  # i=0 is start of right blend zone (inner), i=blend_w-1 is rightmost

            right_i = width - blend_w + i
            left_px = new_row[i]
            right_px = new_row[right_i]

            # Crossfade RGB: right edge blends in left-edge pixels for continuity
            fade = 1.0 - t  # 1.0 at inner edge, 0.0 at outer (rightmost) edge
            for c in range(3):
                right_px[c] = round(right_px[c] * fade + left_px[c] * (1.0 - fade))

            # Alpha fade: rightmost pixel (t=1.0) fades to 0
            right_px[3] = round(right_px[3] * fade)

        out_rows.append(new_row)

    write_png(output_path, width, height, out_rows)
    print(f"Saved: {output_path} ({width}x{height})", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description="Make a PNG horizontally tileable via edge crossfade.")
    parser.add_argument("--input", required=True, help="Input RGBA PNG path")
    parser.add_argument("--output", required=True, help="Output RGBA PNG path")
    parser.add_argument("--blend-pct", type=float, default=0.08, help="Blend width as fraction of image width (default: 0.08)")
    args = parser.parse_args()
    make_tileable(Path(args.input), Path(args.output), args.blend_pct)


if __name__ == "__main__":
    main()
